#!/usr/bin/env node
// scripts/setup-guarded-rollout.mjs
//
// Extra credit: guarded rollout. A guarded rollout is started from the
// LaunchDarkly UI, on purpose: it is the one part of this exercise the
// brief asks a presenter to trigger by hand, so the audience watches it
// happen rather than a script doing it off-screen. This script does
// everything that can be done ahead of time instead:
//   1. creates (idempotently) the custom metric checkout-error, the
//      regression signal a guarded rollout watches;
//   2. prints the exact UI steps to start the rollout itself;
//   3. prints the command to start scripts/simulate-checkout.mjs, the
//      traffic that gives the rollout something to measure.
//
// Required env: LD_API_TOKEN (writer). Optional: LD_PROJECT_KEY (default
// "default"), LD_ENV_KEY (default "test"). The flag release-new-checkout-banner
// must already exist (run scripts/setup-launchdarkly.mjs first).
//
// Usage: LD_API_TOKEN=api-... node scripts/setup-guarded-rollout.mjs

const API = 'https://app.launchdarkly.com/api/v2';
const TOKEN = process.env.LD_API_TOKEN;
const PROJECT = process.env.LD_PROJECT_KEY || 'default';
const ENV = process.env.LD_ENV_KEY || 'test';
const FLAG = 'release-new-checkout-banner';
const METRIC = 'checkout-error';
const METRIC_NAME = 'Checkout error rate';

if (!TOKEN) {
  console.error('LD_API_TOKEN is not set (a writer access token is required).');
  process.exit(1);
}

// Same api() helper as scripts/setup-experiment.mjs: a GET that 404s
// returns null instead of throwing (that is the "does this already exist"
// check every ensure* function below uses), and anything else that is not
// a 2xx throws with the response body attached, so a bad call fails loudly
// instead of leaving the project half configured.
async function api(method, path, body, semantic = false) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: TOKEN,
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
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function ensureMetric() {
  if (await api('GET', `/metrics/${PROJECT}/${METRIC}`)) {
    console.log(`Metric "${METRIC}" exists.`);
    return;
  }
  // A custom, non-numeric (did-it-happen) metric, lower is better: fewer
  // checkout-error events per exposure is the improvement a guarded
  // rollout is protecting the new variation's chance to prove. No
  // maintainer lookup here (unlike scripts/setup-experiment.mjs's
  // experiment, a metric by itself does not need one).
  await api('POST', `/metrics/${PROJECT}`, {
    key: METRIC,
    name: METRIC_NAME,
    description: 'Checkout attempt failed after being served a checkout variation.',
    kind: 'custom',
    eventKey: METRIC,
    isNumeric: false,
    successCriteria: 'LowerThanBaseline',
    tags: ['demo', 'guarded-rollout'],
  });
  console.log(`Created metric "${METRIC}" (${METRIC_NAME}).`);
}

async function confirmFlagExists() {
  const flag = await api('GET', `/flags/${PROJECT}/${FLAG}?env=${ENV}`);
  if (!flag) {
    throw new Error(`Flag ${FLAG} not found; run scripts/setup-launchdarkly.mjs first.`);
  }
  return flag;
}

function printUiSteps() {
  console.log('');
  console.log('Metric is ready. A guarded rollout itself is started from the LaunchDarkly');
  console.log('UI, on purpose, so a presenter triggers it live instead of a script doing');
  console.log('it off-screen. Exact steps:');
  console.log('');
  console.log(`  1. Open the ${FLAG} flag in the ${ENV} environment.`);
  console.log('  2. Confirm the flag is ON and its default rule serves the OLD banner');
  console.log('     (the "false" variation). This is the state the rollout ramps away from.');
  console.log('  3. On the default rule, change "Serve" to "Guarded rollout".');
  console.log('  4. Variation to ramp to: the NEW banner ("true").');
  console.log(`  5. Metric: "${METRIC_NAME}" (${METRIC}). Check "Automatic rollback".`);
  console.log('  6. Randomization unit: user.');
  console.log('  7. Schedule: the shortest custom schedule the UI allows, so the rollout');
  console.log('     and any rollback are visible inside a short demo window.');
  console.log('  8. Save, then start sending traffic (next command below) and watch the');
  console.log('     Monitoring tab on the flag.');
  console.log('');
  console.log('Traffic simulator, once the rollout is running:');
  console.log('  npm run simulate:checkout -- 2000 60              # normal traffic, no regression');
  console.log('  npm run simulate:checkout -- 2000 60 --regression # inject the regression');
  console.log('');
}

async function main() {
  await ensureMetric();
  await confirmFlagExists();
  printUiSteps();
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
