#!/usr/bin/env node
// scripts/setup-ai-config.mjs
//
// Extra credit: AI Configs. Creates, or brings up to date, everything the
// support chat needs, using the LaunchDarkly REST API v2. Safe to re-run: each
// piece is compared with the desired state below and only what differs changes.
//
//   1. Two model configs (provider "ollama"): gemma4:e4b and gemma4:26b.
//   2. The AI Config "support-chat" (completion mode).
//   3. Two variations:
//        concise-small   short friendly prompt, small model
//        detailed-large  step-by-step prompt that uses the visitor's plan,
//                        large model, reasoning_effort "none"
//   4. Targeting: everyone gets concise-small; organizations on the
//      enterprise plan get detailed-large. AI Config targeting is enabled by
//      default, so there is no "turn on" step.
//
// Environment: LD_API_TOKEN (Writer role; Organization settings >
// Authorization), LD_PROJECT_KEY (default "default"), LD_ENV_KEY (default
// "test"), LD_MAINTAINER_ID (optional member ID; defaults to the account owner).
//
// Usage: npm run setup:ai

const API_BASE = 'https://app.launchdarkly.com/api/v2';
const API_TOKEN = process.env.LD_API_TOKEN;
const PROJECT_KEY = process.env.LD_PROJECT_KEY || 'default';
const ENV_KEY = process.env.LD_ENV_KEY || 'test';
const AI_CONFIG_KEY = 'support-chat';
const BASE = `/projects/${PROJECT_KEY}/ai-configs`;

const MODEL_CONFIGS = [
  { key: 'ollama-gemma4-e4b', id: 'gemma4:e4b' },
  { key: 'ollama-gemma4-26b', id: 'gemma4:26b' },
];

const VARIATIONS = [
  {
    key: 'concise-small',
    name: 'Concise (small model)',
    modelConfigKey: 'ollama-gemma4-e4b',
    model: { modelName: 'gemma4:e4b', parameters: {} },
    prompt:
      'You are a concise support assistant for {{companyName}}. Answer {{userName}} in at ' +
      'most two sentences. Be friendly but brief. Reply in plain text, no Markdown.',
  },
  {
    key: 'detailed-large',
    name: 'Detailed (large model)',
    modelConfigKey: 'ollama-gemma4-26b',
    // reasoning_effort "none" stops the model emitting hidden reasoning tokens:
    // on the trial account an answer went from about 13 s to under 2 s.
    model: { modelName: 'gemma4:26b', parameters: { reasoning_effort: 'none' } },
    prompt:
      'You are a thorough support assistant for {{companyName}}. Answer {{userName}} step by ' +
      'step, and mention that their account is on the {{plan}} plan where it is relevant to the ' +
      'answer. Keep the whole answer to at most 120 words. Reply in plain text, no Markdown.',
  },
];

// Served to everyone by default; the rule below overrides it for enterprise.
const FALLTHROUGH_VARIATION = 'concise-small';
const RULES = [
  { contextKind: 'organization', attribute: 'plan', op: 'in', values: ['enterprise'],
    serve: 'detailed-large', description: 'Enterprise organizations get the detailed answer' },
];

if (!API_TOKEN) {
  console.error(
    'LD_API_TOKEN is not set. Create an access token with the Writer role in ' +
      'LaunchDarkly (Organization settings > Authorization) and put it in .env.',
  );
  process.exit(1);
}

// 404 returns null; any other non-2xx response stops the script.
async function ldApi(method, path, body, { semantic = false } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: API_TOKEN, // the token itself, no "Bearer" prefix
      'LD-API-Version': '20240415',
      'Content-Type': semantic
        ? 'application/json; domain-model=launchdarkly.semanticpatch'
        : 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) return null;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${data?.message ?? text}`);
  return data;
}

// A service token is not a member, so model configs and the AI Config need a
// named maintainer: LD_MAINTAINER_ID, else the account owner.
async function resolveMaintainerId() {
  if (process.env.LD_MAINTAINER_ID) return process.env.LD_MAINTAINER_ID;
  const members = await ldApi('GET', '/members?limit=100');
  const owner = members?.items?.find((m) => m.role === 'owner');
  if (!owner) throw new Error('No account owner found; set LD_MAINTAINER_ID to a member ID.');
  return owner._id;
}

async function ensureModelConfig({ key, id }, maintainerId) {
  const existing = await ldApi('GET', `${BASE}/model-configs/${key}`);
  if (existing) {
    if (existing.id !== id) {
      throw new Error(`Model config "${key}" exists but points at "${existing.id}", expected "${id}".`);
    }
    console.log(`Model config "${key}" exists.`);
    return;
  }
  console.log(`Creating model config "${key}" (${id})...`);
  await ldApi('POST', `${BASE}/model-configs`, { key, id, name: id, provider: 'ollama', maintainerId });
}

async function ensureAiConfig(maintainerId) {
  if (await ldApi('GET', `${BASE}/${AI_CONFIG_KEY}`)) {
    console.log(`AI Config "${AI_CONFIG_KEY}" exists.`);
    return;
  }
  console.log(`Creating AI Config "${AI_CONFIG_KEY}"...`);
  await ldApi('POST', BASE, {
    key: AI_CONFIG_KEY,
    name: 'Support chat',
    description: 'Prompt and model for the ABC Company support chat.',
    mode: 'completion',
    maintainerId,
    tags: ['demo', 'ai-configs'],
  });
}

// Creates the variation, or updates its prompt and model settings if they
// drifted (for example after an edit in the UI during a demo).
async function ensureVariation(v) {
  const path = `${BASE}/${AI_CONFIG_KEY}/variations/${v.key}`;
  let current = await ldApi('GET', path);
  current = current?.items ? current.items[0] : current;
  const messages = [{ role: 'system', content: v.prompt }];

  if (!current) {
    console.log(`Creating variation "${v.key}"...`);
    await ldApi('POST', `${BASE}/${AI_CONFIG_KEY}/variations`, {
      key: v.key,
      name: v.name,
      modelConfigKey: v.modelConfigKey,
      messages,
    });
    await ldApi('PATCH', path, { model: v.model, comment: 'Model settings (setup-ai-config.mjs)' });
    return;
  }

  const promptMatches = current.messages?.[0]?.content === v.prompt;
  const paramsMatch =
    JSON.stringify(current.model?.parameters ?? {}) === JSON.stringify(v.model.parameters);
  if (promptMatches && paramsMatch && current.modelConfigKey === v.modelConfigKey) {
    console.log(`Variation "${v.key}" is up to date.`);
    return;
  }
  console.log(`Updating variation "${v.key}" (prompt or model settings differed)...`);
  await ldApi('PATCH', path, {
    messages,
    modelConfigKey: v.modelConfigKey,
    model: v.model,
    comment: 'Restore the demo prompt and model settings (setup-ai-config.mjs)',
  });
}

// Compares the environment's default variation and rules with the desired
// state and replaces them when they differ. The targeting API does not return
// rule IDs, so rules are replaced as a list rather than edited one by one.
async function ensureTargeting() {
  const targeting = await ldApi('GET', `${BASE}/${AI_CONFIG_KEY}/targeting`);
  const env = targeting.environments[ENV_KEY];
  const byKey = Object.fromEntries(
    targeting.variations.map((v, i) => [v.value?._ldMeta?.variationKey, { id: v._id, index: i }]),
  );
  const instructions = [];

  if (env.fallthrough?.variation !== byKey[FALLTHROUGH_VARIATION].index) {
    instructions.push({
      kind: 'updateFallthroughVariationOrRollout',
      variationId: byKey[FALLTHROUGH_VARIATION].id,
    });
  }

  // The targeting response omits each clause's context kind, so rules are
  // compared on attribute, operator and values. (The kind is still sent when
  // rules are replaced: Ana's enterprise plan lives only on her organization
  // context, and she gets detailed-large.)
  const signature = (c) => `${c.attribute}|${c.op}|${JSON.stringify(c.values)}`;
  const current = (env.rules || []).map((r) => r.clauses.map(signature).join('&'));
  const desired = RULES.map((r) => signature(r));
  if (JSON.stringify(current) !== JSON.stringify(desired)) {
    instructions.push({
      kind: 'replaceRules',
      rules: RULES.map((r) => ({
        description: r.description,
        clauses: [{ contextKind: r.contextKind, attribute: r.attribute, op: r.op, values: r.values, negate: false }],
        variationId: byKey[r.serve].id,
      })),
    });
  }

  if (instructions.length === 0) {
    console.log(`Targeting on "${AI_CONFIG_KEY}" is already as expected.`);
    return;
  }
  console.log(`Applying ${instructions.map((x) => x.kind).join(', ')} on "${AI_CONFIG_KEY}"...`);
  await ldApi(
    'PATCH',
    `${BASE}/${AI_CONFIG_KEY}/targeting`,
    { environmentKey: ENV_KEY, comment: 'Support chat targeting (setup-ai-config.mjs)', instructions },
    { semantic: true },
  );
}

async function main() {
  console.log(`Project "${PROJECT_KEY}", environment "${ENV_KEY}"`);
  const maintainerId = await resolveMaintainerId();
  for (const m of MODEL_CONFIGS) await ensureModelConfig(m, maintainerId);
  await ensureAiConfig(maintainerId);
  for (const v of VARIATIONS) await ensureVariation(v);
  await ensureTargeting();
  console.log('Done.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
