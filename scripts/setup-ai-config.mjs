#!/usr/bin/env node
// scripts/setup-ai-config.mjs
//
// One-time (idempotent) provisioning script for the AI Configs extra
// credit, using the LaunchDarkly REST API v2 directly, the same pattern as
// scripts/setup-launchdarkly.mjs.
//
// It creates, or skips if already present:
//   1. Two model configs: "ollama-gemma4-e4b" (id "gemma4:e4b") and
//      "ollama-gemma4-26b" (id "gemma4:26b"), provider "ollama".
//   2. An AI Config "support-chat" (completion mode).
//   3. Two variations on it: "concise-small" (the small model, a short
//      friendly system prompt) and "detailed-large" (the large model, a
//      thorough step-by-step prompt that mentions the visitor's plan).
//   4. Targeting in environment LD_ENV_KEY: fallthrough -> concise-small,
//      a rule plan == "enterprise" -> detailed-large.
//
// Required env vars:
//   LD_API_TOKEN   - a LaunchDarkly personal/service access token with
//                    writer permissions on the target project. NEVER
//                    commit this. Read from the environment only.
//   LD_PROJECT_KEY - defaults to "default"
//   LD_ENV_KEY     - defaults to "test"
//   LD_MAINTAINER_ID - optional, a member ID. AI Config model configs and
//                    the AI Config itself accept a maintainerId the same
//                    way experiments do (see scripts/setup-experiment.mjs);
//                    a service token is not itself a member, so this falls
//                    back to the account owner from GET /members.
//
// Usage:
//   LD_API_TOKEN=xxx node scripts/setup-ai-config.mjs
//   (or: npm run setup:ai, which loads .env automatically)
//
// Field names and instruction kinds follow LaunchDarkly's OpenAPI spec
// (https://app.launchdarkly.com/api/v2/openapi.json).

const API_BASE = 'https://app.launchdarkly.com/api/v2';

const API_TOKEN = process.env.LD_API_TOKEN;
const PROJECT_KEY = process.env.LD_PROJECT_KEY || 'default';
const ENV_KEY = process.env.LD_ENV_KEY || 'test';

const AI_CONFIG_KEY = 'support-chat';
const MODEL_CONFIG_SMALL = 'ollama-gemma4-e4b';
const MODEL_CONFIG_LARGE = 'ollama-gemma4-26b';
const VARIATION_SMALL = 'concise-small';
const VARIATION_LARGE = 'detailed-large';

if (!API_TOKEN) {
  console.error(
    'LD_API_TOKEN is not set. This script talks to the LaunchDarkly REST API and ' +
      'needs a personal or service access token with write access to the project ' +
      '(LaunchDarkly > Organization settings > Authorization). Copy .env.example to ' +
      '.env, fill it in, and re-run, or run with: LD_API_TOKEN=xxx npm run setup:ai',
  );
  process.exit(1);
}

async function ldApi(method, pathSuffix, body, semantic = false) {
  const res = await fetch(`${API_BASE}${pathSuffix}`, {
    method,
    headers: {
      // LaunchDarkly's v2 API takes the token directly in the
      // Authorization header, no "Bearer " prefix.
      Authorization: API_TOKEN,
      'Content-Type': semantic
        ? 'application/json; domain-model=launchdarkly.semanticpatch'
        : 'application/json',
      // Pinned API version, same one scripts/setup-launchdarkly.mjs uses.
      'LD-API-Version': '20240415',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 404) return null;

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    throw new Error(`LD API ${method} ${pathSuffix} failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

// Model configs and the AI Config both accept maintainerId, mirroring the
// experiment pattern in scripts/setup-experiment.mjs: a service token is
// not itself a member, so a maintainer must be named explicitly or
// resolved from the account owner.
async function resolveMaintainerId() {
  let maintainerId = process.env.LD_MAINTAINER_ID;
  if (!maintainerId) {
    const members = await ldApi('GET', '/members?limit=50');
    const owner = members?.items?.find((m) => m.role === 'owner') ?? members?.items?.[0];
    maintainerId = owner?._id;
  }
  if (!maintainerId) {
    throw new Error('No maintainer found; set LD_MAINTAINER_ID to a member ID.');
  }
  return maintainerId;
}

/**
 * Creates a model config if it doesn't exist.
 * Required fields (ModelConfigPost in the OpenAPI spec): id, key, name.
 * "id" is the identifier passed to the provider (here, the Ollama
 * model name); "key" is the AI Config system's own key for referencing it
 * from a variation's modelConfigKey.
 */
async function ensureModelConfig(key, id, maintainerId) {
  const existing = await ldApi('GET', `/projects/${PROJECT_KEY}/ai-configs/model-configs/${key}`);
  if (existing) {
    console.log(`Model config "${key}" already exists, skipping create.`);
    return existing;
  }

  console.log(`Creating model config "${key}" (${id})...`);
  return ldApi('POST', `/projects/${PROJECT_KEY}/ai-configs/model-configs`, {
    id,
    key,
    name: id,
    provider: 'ollama',
    maintainerId,
  });
}

/**
 * Creates the "support-chat" AI Config if it doesn't exist.
 * Required fields (AIConfigPost): key, name. mode defaults to
 * "completion" but is passed explicitly since that is the whole point of
 * this config (prompt/model for a chat completion, not an agent or judge).
 */
async function ensureAiConfig(maintainerId) {
  const existing = await ldApi('GET', `/projects/${PROJECT_KEY}/ai-configs/${AI_CONFIG_KEY}`);
  if (existing) {
    console.log(`AI Config "${AI_CONFIG_KEY}" already exists, skipping create.`);
    return existing;
  }

  console.log(`Creating AI Config "${AI_CONFIG_KEY}"...`);
  return ldApi('POST', `/projects/${PROJECT_KEY}/ai-configs`, {
    key: AI_CONFIG_KEY,
    name: 'Support chat',
    description: 'Prompt and model for the ABC Company support chatbot (AI Configs extra credit).',
    mode: 'completion',
    maintainerId,
    tags: ['demo', 'extra-credit'],
  });
}

/**
 * Creates a variation on "support-chat" if it doesn't already exist.
 * Fields (AIConfigVariationPost): key, name required; messages
 * (array of {role, content}) and modelConfigKey (the model config's own
 * "key", not its provider "id") match what server/aiChat.mjs expects back
 * from the SDK (LDMessage[], LDModelConfig.name).
 */
async function ensureVariation(key, name, modelConfigKey, systemPrompt, model) {
  const existing = await ldApi(
    'GET',
    `/projects/${PROJECT_KEY}/ai-configs/${AI_CONFIG_KEY}/variations/${key}`,
  );
  if (existing) {
    console.log(`Variation "${key}" already exists, skipping create.`);
    return existing;
  }

  console.log(`Creating variation "${key}" on "${AI_CONFIG_KEY}"...`);
  const created = await ldApi('POST', `/projects/${PROJECT_KEY}/ai-configs/${AI_CONFIG_KEY}/variations`, {
    key,
    name,
    modelConfigKey,
    messages: [{ role: 'system', content: systemPrompt }],
  });
  if (model) {
    // Model parameters (for example reasoning_effort) are set on the
    // variation, so they can be changed later in the UI without a redeploy.
    // server/aiChat.mjs forwards an allowlist of them to the provider.
    await ldApi('PATCH', `/projects/${PROJECT_KEY}/ai-configs/${AI_CONFIG_KEY}/variations/${key}`, {
      model,
      comment: 'Model parameters (setup-ai-config.mjs)',
    });
  }
  return created;
}

/**
 * Sets fallthrough -> concise-small and a rule plan == "enterprise" ->
 * detailed-large, in environment ENV_KEY. A new AI Config's targeting is
 * already enabled in each environment by default, so there is no separate
 * "turn targeting on" step here (unlike a flag, which starts off).
 *
 * PATCH /projects/{projectKey}/ai-configs/{configKey}/targeting takes a
 * semantic patch (same Content-Type convention as flags):
 *   - "addRule": clauses + variationId, identical clause shape to flags
 *     (contextKind, attribute, op, negate, values).
 *   - "updateFallthroughVariationOrRollout": variationId.
 */
async function ensureTargeting() {
  console.log(`Setting targeting on "${AI_CONFIG_KEY}" in environment "${ENV_KEY}"...`);

  const config = await ldApi('GET', `/projects/${PROJECT_KEY}/ai-configs/${AI_CONFIG_KEY}`);
  if (!config) {
    throw new Error(`AI Config ${AI_CONFIG_KEY} not found after ensureAiConfig()`);
  }

  // Idempotency: if this environment's targeting already has our rule, do
  // nothing (an "addRule" instruction would otherwise add a duplicate rule
  // on re-run), same check scripts/setup-launchdarkly.mjs makes for flags.
  const targeting = await ldApi(
    'GET',
    `/projects/${PROJECT_KEY}/ai-configs/${AI_CONFIG_KEY}/targeting`,
  );
  const envTargeting = targeting?.environments?.[ENV_KEY] || {};
  const hasOurRule = (envTargeting.rules || []).some((r) =>
    (r.clauses || []).some((c) => c.attribute === 'plan'),
  );
  if (hasOurRule) {
    console.log(`Targeting already configured on "${AI_CONFIG_KEY}" in "${ENV_KEY}", skipping.`);
    return null;
  }

  const variations = config.variations ?? [];
  const smallVariationId = variations.find((v) => v.key === VARIATION_SMALL)?._id;
  const largeVariationId = variations.find((v) => v.key === VARIATION_LARGE)?._id;
  if (!smallVariationId || !largeVariationId) {
    throw new Error(
      `Could not find variation ids for "${VARIATION_SMALL}"/"${VARIATION_LARGE}" on ${AI_CONFIG_KEY}`,
    );
  }

  const fallthroughInstruction = {
    kind: 'updateFallthroughVariationOrRollout',
    variationId: smallVariationId,
  };

  const enterpriseRuleInstruction = {
    kind: 'addRule',
    clauses: [
      {
        contextKind: 'user',
        attribute: 'plan',
        op: 'in',
        values: ['enterprise'],
        negate: false,
      },
    ],
    variationId: largeVariationId,
  };

  const data = await ldApi(
    'PATCH',
    `/projects/${PROJECT_KEY}/ai-configs/${AI_CONFIG_KEY}/targeting`,
    {
      environmentKey: ENV_KEY,
      instructions: [fallthroughInstruction, enterpriseRuleInstruction],
      comment: 'Set up AI Configs extra credit targeting (setup-ai-config.mjs)',
    },
    true,
  );

  console.log('Targeting configured.');
  return data;
}

async function main() {
  console.log(
    `Provisioning AI Configs extra credit in project "${PROJECT_KEY}", environment "${ENV_KEY}"...`,
  );
  const maintainerId = await resolveMaintainerId();
  await ensureModelConfig(MODEL_CONFIG_SMALL, 'gemma4:e4b', maintainerId);
  await ensureModelConfig(MODEL_CONFIG_LARGE, 'gemma4:26b', maintainerId);
  await ensureAiConfig(maintainerId);
  await ensureVariation(
    VARIATION_SMALL,
    'Concise (small model)',
    MODEL_CONFIG_SMALL,
    'You are a concise support assistant for {{companyName}}. Answer {{userName}} in at ' +
      'most two sentences. Be friendly but brief.',
  );
  await ensureVariation(
    VARIATION_LARGE,
    'Detailed (large model)',
    MODEL_CONFIG_LARGE,
    'You are a thorough support assistant for {{companyName}}. Answer {{userName}} step by ' +
      'step, and mention that their account is on the {{plan}} plan where it is relevant to the answer. ' +
      'Keep the whole answer to at most 120 words.',
    // reasoning_effort "none" keeps gemma4:26b fast by skipping its hidden
    // reasoning tokens. Remove it in the LaunchDarkly UI to see the slower,
    // more deliberate behaviour, with no redeploy needed either way.
    { modelName: 'gemma4:26b', parameters: { reasoning_effort: 'none' } },
  );
  await ensureTargeting();
  console.log('Done. Re-run any time, this script is idempotent (skips existing resources).');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
