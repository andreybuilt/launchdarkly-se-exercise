// server/aiChat.mjs
//
// Extra credit: AI Configs. Wraps the LaunchDarkly AI SDK
// (@launchdarkly/server-sdk-ai) so the support chat's prompt and model are
// pulled from a LaunchDarkly AI Config ("support-chat") instead of being
// hard-coded, and resolved server-side the same way the two demo flags are
// resolved in server/ldClient.mjs.
//
// The AI SDK's public surface used here (see
// node_modules/@launchdarkly/server-sdk-ai/dist/index.d.ts for the full
// API):
//   - initAi(ldClient): wraps the server SDK client in an LDAIClient.
//   - LDAIClient.completionConfig(key, context, defaultValue, variables):
//     resolves the AI Config, with {{variables}} already interpolated into
//     the messages.
//   - The resolved config exposes model, messages, and createTracker().
//   - The tracker records duration, token usage, success/error, and
//     feedback; its resumptionToken lets a later request reconstruct the
//     same tracker via LDAIClient.createTracker(token, context), so
//     feedback sent after the fact still lands on the original run.
//
// MODEL PROVIDER: calls go to an OpenAI-compatible /v1/chat/completions
// endpoint, POSTing the model name and messages the AI Config resolved.
// LLM_BASE_URL (falling back to OLLAMA_BASE_URL, default
// http://localhost:11434) picks the endpoint; a local Ollama install needs
// no API key, a hosted OpenAI-compatible provider is used by setting
// LLM_API_KEY, sent as "Authorization: Bearer <key>". Nothing about the
// app's logic changes either way, because the model name and prompt both
// come from LaunchDarkly, not from this file.

import { initAi, LDFeedbackKind } from '@launchdarkly/server-sdk-ai';

export const AI_CONFIG_KEY = 'support-chat';

// Fallback value used when LaunchDarkly cannot provide the AI Config: the
// SDK never finished initializing, the key doesn't exist yet, or (in
// tests) TestData has nothing configured for it. `enabled: false` is the
// deliberate choice here, not `true`: if LaunchDarkly can't tell this app
// what to say, the safest default is to say nothing to a model at all,
// rather than guess a prompt. reply() below checks config.enabled before
// ever reaching the fetch call, so this fallback never calls a model.
const DEFAULT_AI_CONFIG = {
  enabled: false,
  model: { name: 'gemma4:e4b' },
  messages: [
    {
      role: 'system',
      content: 'You are a helpful support assistant for {{companyName}}. Keep answers short.',
    },
  ],
};

const CHAT_TIMEOUT_MS = 60_000;

/**
 * Builds the support chat helper. Everything the chat needs to talk to
 * LaunchDarkly and to the model provider is injected here, so tests can
 * swap in a fake `ldClient` (via TestData, see server/ldClient.mjs) and a
 * fake `fetchImpl` with no network calls.
 *
 * @param {object} opts
 * @param {import('@launchdarkly/node-server-sdk').LDClient} opts.ldClient
 * @param {typeof fetch} [opts.fetchImpl] - defaults to the global fetch
 * @param {string} [opts.baseUrl] - defaults to LLM_BASE_URL, then
 *   OLLAMA_BASE_URL, then localhost
 * @param {string} [opts.apiKey] - defaults to LLM_API_KEY; sent as
 *   "Authorization: Bearer <key>" when set, omitted entirely otherwise
 *   (Ollama does not need one)
 */
// OpenAI-compatible request parameters an AI Config may set. Ollama, OpenAI
// and most gateways accept these names on /v1/chat/completions.
const FORWARDED_PARAMS = ['temperature', 'top_p', 'max_tokens', 'reasoning_effort'];

function pickModelParams(parameters) {
  const out = {};
  for (const k of FORWARDED_PARAMS) {
    if (parameters && parameters[k] !== undefined) out[k] = parameters[k];
  }
  return out;
}

export function createSupportChat({ ldClient, fetchImpl = fetch, baseUrl, apiKey } = {}) {
  if (!ldClient) {
    throw new Error('createSupportChat requires an ldClient');
  }
  // LLM_BASE_URL is the preferred env var name; OLLAMA_BASE_URL is kept as a
  // fallback for a local Ollama install (see .env.example).
  const llmBaseUrl =
    baseUrl ?? process.env.LLM_BASE_URL ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
  // Optional: only set for a hosted OpenAI-compatible provider that requires
  // auth. Never logged, and only ever read into a request header below.
  const llmApiKey = apiKey ?? process.env.LLM_API_KEY;

  // initAi(ldClient) wraps the already-initialized server SDK client, see
  // the d.ts line referenced above. One AI client is reused across requests,
  // the same pattern as the single ldClient from server/ldClient.mjs.
  const aiClient = initAi(ldClient);

  /**
   * Resolves the AI Config for `context`, calls the model, and tracks the
   * run. Returns everything the browser needs to show which variation and
   * model answered, plus a resumption token so a later thumbs up/down can
   * be attached to this exact run.
   *
   * @param {object} context - an LD multi-context (see server/contexts.mjs
   *   toLdContext/toVisitorLdContext): a "user" kind and an "organization" kind
   * @param {string} userMessage
   */
  async function reply(context, userMessage) {
    // plan lives on the organization kind, the visitor's name on the user
    // kind, since server/contexts.mjs moved both into a multi-context.
    const variables = {
      companyName: 'ABC Company',
      userName: context.user?.name,
      plan: context.organization?.plan,
    };

    const config = await aiClient.completionConfig(
      AI_CONFIG_KEY,
      context,
      DEFAULT_AI_CONFIG,
      variables,
    );

    if (!config.enabled) {
      return {
        reply: 'Support chat is turned off right now.',
        variationKey: undefined,
        model: undefined,
        durationMs: 0,
        tokens: undefined,
        resumptionToken: undefined,
        enabled: false,
      };
    }

    const tracker = config.createTracker();
    const modelName = config.model?.name ?? DEFAULT_AI_CONFIG.model.name;
    const messages = [...(config.messages ?? []), { role: 'user', content: userMessage }];

    const started = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);

      const headers = { 'Content-Type': 'application/json' };
      // Only sent when a key is configured; Ollama doesn't need one, and an
      // empty/undefined header value would otherwise be sent as the literal
      // string "undefined".
      if (llmApiKey) {
        headers.Authorization = `Bearer ${llmApiKey}`;
      }

      let res;
      try {
        res = await fetchImpl(`${llmBaseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers,
          signal: controller.signal,
          body: JSON.stringify({
            model: modelName,
            messages,
            // Model parameters come from the AI Config too, so they change
            // without a redeploy: temperature, max_tokens, reasoning_effort, ...
            // Only the keys in this allowlist are forwarded; anything else in
            // the config is ignored rather than sent to the provider.
            ...pickModelParams(config.model?.parameters),
            stream: false,
          }),
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!res.ok) {
        throw new Error(`Model endpoint returned ${res.status}`);
      }

      const data = await res.json();
      const durationMs = Date.now() - started;
      const content = data?.choices?.[0]?.message?.content ?? '(no response)';
      const usage = data?.usage;

      tracker.trackDuration(durationMs);
      if (usage) {
        tracker.trackTokens({
          total: usage.total_tokens ?? 0,
          input: usage.prompt_tokens ?? 0,
          output: usage.completion_tokens ?? 0,
        });
      }
      tracker.trackSuccess();

      return {
        reply: content,
        variationKey: tracker.getTrackData().variationKey,
        model: modelName,
        durationMs,
        tokens: usage
          ? {
              total: usage.total_tokens ?? 0,
              input: usage.prompt_tokens ?? 0,
              output: usage.completion_tokens ?? 0,
            }
          : undefined,
        resumptionToken: tracker.resumptionToken,
        enabled: true,
      };
    } catch (err) {
      // Computed once and reused below, rather than calling Date.now() a
      // second time for the response (which would record a slightly
      // different, and wrong, number of the two).
      const durationMs = Date.now() - started;
      tracker.trackDuration(durationMs);
      tracker.trackError();
      return {
        reply: "Sorry, I couldn't reach the support assistant right now. Please try again.",
        variationKey: undefined,
        model: modelName,
        durationMs,
        tokens: undefined,
        resumptionToken: tracker.resumptionToken,
        enabled: true,
        error: err.message,
      };
    }
  }

  // Feedback arrives from the browser as a token and a thumb, well after the
  // original request's context is out of scope (a second HTTP round trip).
  // aiClient.createTracker(token, context) needs the context to attribute
  // the event to the right contact in LaunchDarkly's AI monitoring, so the
  // caller (server/index.mjs) passes the actual visitor's context, the same
  // one /api/chat used, rather than an anonymous placeholder. Falls back to
  // an anonymous context if none is given, so this still works if called
  // without one.
  const ANONYMOUS_FEEDBACK_CONTEXT = { kind: 'user', key: 'support-chat-feedback', anonymous: true };

  /**
   * Records thumbs up/down feedback against a previous run, reconstructing
   * the tracker from its resumption token (aiClient.createTracker()).
   *
   * @param {string} resumptionToken
   * @param {boolean} positive
   * @param {object} [context] - the visitor's LD context (see
   *   server/contexts.mjs toLdContext); defaults to an anonymous context
   */
  function feedback(resumptionToken, positive, context = ANONYMOUS_FEEDBACK_CONTEXT) {
    const tracker = aiClient.createTracker(resumptionToken, context);
    tracker.trackFeedback({ kind: positive ? LDFeedbackKind.Positive : LDFeedbackKind.Negative });
  }

  return { reply, feedback };
}
