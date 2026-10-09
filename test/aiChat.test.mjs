// test/aiChat.test.mjs
//
// Offline tests for the AI Configs extra credit (server/aiChat.mjs). Like
// test/flags.test.mjs, uses the Node server SDK's TestData data source, no
// network calls to LaunchDarkly. The model provider call is faked too, via
// a fetchImpl that createSupportChat() takes as a constructor option
// instead of the global fetch, so no network call happens there either.
//
// The AI Config flag value shape (`_ldMeta`, `model`, `provider`,
// `messages`) is what the AI SDK's completionConfig() expects a raw flag
// value to look like, and turns into the LDAICompletionConfig object
// server/aiChat.mjs consumes. Tracker event names ($ld:ai:generation:success,
// $ld:ai:generation:error, $ld:ai:duration:total, $ld:ai:tokens:*) are the
// SDK's own names for duration, token, success, error and feedback tracking.
//
// Run with: npm test  (node:test + node's built-in assert)

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createLdClient, TestData } from '../server/ldClient.mjs';
import { toLdContext, findDemoContext } from '../server/contexts.mjs';
import { createSupportChat, AI_CONFIG_KEY } from '../server/aiChat.mjs';

const enterpriseContext = toLdContext(findDemoContext('demo-ana')); // organization.plan: enterprise
const freeContext = toLdContext(findDemoContext('demo-ben')); // organization.plan: free

// Mirrors what scripts/setup-ai-config.mjs provisions: two variations, the
// small model for everyone by default, the large model for plan ==
// "enterprise". This is the same shape the real LaunchDarkly service would
// hand the SDK for this AI Config.
function aiConfigFlagValue(variationKey, modelName, systemPrompt, parameters = { temperature: 0.2 }) {
  return {
    _ldMeta: { variationKey, version: 1, enabled: true, mode: 'completion' },
    model: { name: modelName, parameters },
    provider: { name: 'ollama' },
    messages: [{ role: 'system', content: systemPrompt }],
  };
}

const CONCISE_VALUE = aiConfigFlagValue(
  'concise-small',
  'gemma4:e4b',
  'You are a concise support assistant for {{companyName}}. Answer {{userName}} briefly.',
);
const DETAILED_VALUE = aiConfigFlagValue(
  'detailed-large',
  'gemma4:26b',
  'You are a thorough support assistant for {{companyName}}. {{userName}} is on the {{plan}} plan.',
  // reasoning_effort is what the live demo uses to keep the large model fast;
  // not_a_model_param must NOT be forwarded to the provider.
  { reasoning_effort: 'none', max_tokens: 400, not_a_model_param: 'x' },
);

function okFetch(content, usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }], usage }),
  });
}

function failingFetch() {
  return async () => ({ ok: false, status: 500, json: async () => ({}) });
}

describe('support chat AI Config (extra credit)', () => {
  let client;
  let td;
  // Records every event the SDK's tracker sends, so success/error/duration/
  // token tracking can be asserted without reaching into SDK internals.
  let trackedEvents;

  before(async () => {
    td = new TestData();
    td.update(
      td
        .flag(AI_CONFIG_KEY)
        .variations(CONCISE_VALUE, DETAILED_VALUE)
        .fallthroughVariation(0) // concise-small by default
        .ifMatch('organization', 'plan', 'enterprise')
        .thenReturn(1), // detailed-large for enterprise
    );
    client = await createLdClient({ updateProcessor: td.getFactory() });

    trackedEvents = [];
    const originalTrack = client.track.bind(client);
    client.track = (key, context, data, metricValue) => {
      trackedEvents.push({ key, context, data, metricValue });
      return originalTrack(key, context, data, metricValue);
    };
  });

  after(async () => {
    await client.close();
  });

  test('enterprise context gets the detailed-large variation and its model', async () => {
    const chat = createSupportChat({ ldClient: client, fetchImpl: okFetch('Here is a detailed answer.') });
    const result = await chat.reply(enterpriseContext, 'How do I reset my password?');

    assert.equal(result.enabled, true);
    assert.equal(result.variationKey, 'detailed-large');
    assert.equal(result.model, 'gemma4:26b');
    assert.equal(result.reply, 'Here is a detailed answer.');
  });

  test('free-plan context gets the concise-small variation and its model', async () => {
    const chat = createSupportChat({ ldClient: client, fetchImpl: okFetch('Short answer.') });
    const result = await chat.reply(freeContext, 'How do I reset my password?');

    assert.equal(result.enabled, true);
    assert.equal(result.variationKey, 'concise-small');
    assert.equal(result.model, 'gemma4:e4b');
    assert.equal(result.reply, 'Short answer.');
  });

  test('model parameters from the AI Config are forwarded, unknown keys are not', async () => {
    let body;
    const chat = createSupportChat({
      ldClient: client,
      fetchImpl: async (url, init) => {
        body = JSON.parse(init.body);
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
      },
    });
    await chat.reply(enterpriseContext, 'hi');
    assert.equal(body.reasoning_effort, 'none');
    assert.equal(body.max_tokens, 400);
    assert.equal(body.not_a_model_param, undefined);
    assert.equal(body.temperature, undefined);
  });

  test('variables are interpolated into the system message before it reaches the model', async () => {
    let capturedBody;
    const chat = createSupportChat({
      ldClient: client,
      fetchImpl: async (url, init) => {
        capturedBody = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: undefined }),
        };
      },
    });

    await chat.reply(enterpriseContext, 'What plan am I on?');

    const systemMessage = capturedBody.messages.find((m) => m.role === 'system');
    assert.ok(systemMessage, 'expected a system message to be sent to the model');
    assert.match(systemMessage.content, /ABC Company/);
    assert.match(systemMessage.content, /Ana Rodriguez/);
    assert.match(systemMessage.content, /enterprise/);
    // The template placeholders should be gone, not left as literal {{...}}.
    assert.doesNotMatch(systemMessage.content, /\{\{/);
  });

  test('a successful call tracks duration, token usage, and success', async () => {
    trackedEvents.length = 0;
    const chat = createSupportChat({ ldClient: client, fetchImpl: okFetch('Reply text.') });
    await chat.reply(freeContext, 'Help me.');

    const eventKeys = trackedEvents.map((e) => e.key);
    assert.ok(eventKeys.includes('$ld:ai:generation:success'), 'expected trackSuccess() to fire');
    assert.ok(eventKeys.includes('$ld:ai:duration:total'), 'expected trackDuration() to fire');
    assert.ok(eventKeys.includes('$ld:ai:tokens:total'), 'expected trackTokens() to fire');
    assert.ok(!eventKeys.includes('$ld:ai:generation:error'), 'did not expect trackError() on success');
  });

  test('a failing model call returns a friendly message and tracks an error', async () => {
    trackedEvents.length = 0;
    const chat = createSupportChat({ ldClient: client, fetchImpl: failingFetch() });
    const result = await chat.reply(freeContext, 'Help me.');

    assert.equal(result.enabled, true);
    assert.match(result.reply, /couldn't reach|try again/i);
    assert.ok(result.resumptionToken, 'expected a resumptionToken even on failure, for feedback');

    const eventKeys = trackedEvents.map((e) => e.key);
    assert.ok(eventKeys.includes('$ld:ai:generation:error'), 'expected trackError() to fire');
    assert.ok(!eventKeys.includes('$ld:ai:generation:success'), 'did not expect trackSuccess() on failure');
  });

  test('feedback() reconstructs the tracker from a resumption token and tracks sentiment', async () => {
    trackedEvents.length = 0;
    const chat = createSupportChat({ ldClient: client, fetchImpl: okFetch('Reply text.') });
    const result = await chat.reply(freeContext, 'Help me.');

    trackedEvents.length = 0;
    chat.feedback(result.resumptionToken, true);

    const eventKeys = trackedEvents.map((e) => e.key);
    assert.ok(eventKeys.includes('$ld:ai:feedback:user:positive'), 'expected positive feedback to be tracked');
  });

  test('feedback() attributes the event to the context it is given, not an anonymous one', async () => {
    trackedEvents.length = 0;
    const chat = createSupportChat({ ldClient: client, fetchImpl: okFetch('Reply text.') });
    const result = await chat.reply(enterpriseContext, 'Help me.');

    trackedEvents.length = 0;
    chat.feedback(result.resumptionToken, true, enterpriseContext);

    const feedbackEvent = trackedEvents.find((e) => e.key === '$ld:ai:feedback:user:positive');
    assert.ok(feedbackEvent, 'expected positive feedback to be tracked');
    assert.equal(feedbackEvent.context.user.key, enterpriseContext.user.key);
  });

  test('feedback() falls back to an anonymous context when none is given', async () => {
    trackedEvents.length = 0;
    const chat = createSupportChat({ ldClient: client, fetchImpl: okFetch('Reply text.') });
    const result = await chat.reply(freeContext, 'Help me.');

    trackedEvents.length = 0;
    chat.feedback(result.resumptionToken, true);

    const feedbackEvent = trackedEvents.find((e) => e.key === '$ld:ai:feedback:user:positive');
    assert.ok(feedbackEvent, 'expected positive feedback to be tracked');
    assert.equal(feedbackEvent.context.anonymous, true);
  });

  test('a bearer header is sent only when an LLM API key is configured', async () => {
    let headersWithKey;
    const chatWithKey = createSupportChat({
      ldClient: client,
      apiKey: 'test-key-123',
      fetchImpl: async (url, init) => {
        headersWithKey = init.headers;
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
      },
    });
    await chatWithKey.reply(freeContext, 'hi');
    assert.equal(headersWithKey.Authorization, 'Bearer test-key-123');

    let headersWithoutKey;
    const chatWithoutKey = createSupportChat({
      ldClient: client,
      fetchImpl: async (url, init) => {
        headersWithoutKey = init.headers;
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
      },
    });
    await chatWithoutKey.reply(freeContext, 'hi');
    assert.equal(headersWithoutKey.Authorization, undefined);
  });
});

describe('AI Config fallback when LaunchDarkly cannot provide one', () => {
  let client;

  before(async () => {
    // No flag named AI_CONFIG_KEY is ever defined on this TestData
    // instance, so completionConfig() has nothing to resolve and falls
    // back to the DEFAULT_AI_CONFIG passed in by server/aiChat.mjs, the
    // same path taken if the SDK never finished initializing. That
    // default's `enabled` is false on purpose (see the comment on
    // DEFAULT_AI_CONFIG): LaunchDarkly being unreachable is not a safe
    // moment to guess a system prompt.
    const td = new TestData();
    client = await createLdClient({ updateProcessor: td.getFactory() });
  });

  after(async () => {
    await client.close();
  });

  test('reply() returns a clear "turned off" message and never calls the model', async () => {
    let fetchCalled = false;
    const chat = createSupportChat({
      ldClient: client,
      fetchImpl: async () => {
        fetchCalled = true;
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'should not happen' } }] }) };
      },
    });

    const result = await chat.reply(freeContext, 'Are you there?');

    assert.equal(result.enabled, false);
    assert.equal(result.reply, 'Support chat is turned off right now.');
    assert.equal(result.model, undefined);
    assert.equal(fetchCalled, false, 'the model endpoint must not be called when the AI Config is disabled');
  });
});
