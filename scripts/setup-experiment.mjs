#!/usr/bin/env node
// scripts/setup-experiment.mjs
//
// Extra credit: Experimentation. Creates (idempotently) and starts:
//   1. A custom conversion metric "hero-cta-click" (did the visitor click the
//      hero's call-to-action?). The app sends it with client.track().
//   2. An experiment "hero-redesign-conversion" on the SAME flag as Part 2,
//      landing-hero-redesign, measuring that metric.
//
// Which audience is in the experiment: the flag's DEFAULT rule ("fallthrough").
// The individually targeted user and the enterprise / beta-tester rules from
// Part 2 keep getting "redesign" and are NOT in the experiment; everyone else
// is split 50/50 between control and redesign. That is the usual pattern:
// committed cohorts get the new design, the general audience is measured.
//
// Required env: LD_API_TOKEN (writer). Optional: LD_PROJECT_KEY (default
// "default"), LD_ENV_KEY (default "test"), LD_MAINTAINER_ID (a member ID;
// defaults to the account owner). The flag must already exist and be
// ON (run scripts/setup-launchdarkly.mjs first).
//
// Usage: LD_API_TOKEN=api-... node scripts/setup-experiment.mjs

const API = 'https://app.launchdarkly.com/api/v2';
const TOKEN = process.env.LD_API_TOKEN;
const PROJECT = process.env.LD_PROJECT_KEY || 'default';
const ENV = process.env.LD_ENV_KEY || 'test';
const FLAG = 'landing-hero-redesign';
const METRIC = 'hero-cta-click';
const EXPERIMENT = 'hero-redesign-conversion';

if (!TOKEN) {
  console.error('LD_API_TOKEN is not set (a writer access token is required).');
  process.exit(1);
}

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
  // A custom conversion (binary) metric: each context either clicked or not.
  await api('POST', `/metrics/${PROJECT}`, {
    key: METRIC,
    name: 'Hero CTA click',
    description: 'Visitor clicked the call-to-action in the landing page hero.',
    kind: 'custom',
    eventKey: METRIC,
    isNumeric: false,
    tags: ['demo', 'experimentation'],
  });
  console.log(`Created metric "${METRIC}".`);
}

async function ensureExperiment() {
  const existing = await api('GET', `/projects/${PROJECT}/environments/${ENV}/experiments/${EXPERIMENT}`);
  if (existing) {
    console.log(`Experiment "${EXPERIMENT}" exists (status: ${existing.currentIteration?.status}).`);
    return existing;
  }
  const flag = await api('GET', `/flags/${PROJECT}/${FLAG}?env=${ENV}`);
  if (!flag) throw new Error(`Flag ${FLAG} not found; run scripts/setup-launchdarkly.mjs first.`);
  const byValue = Object.fromEntries(flag.variations.map((v) => [v.value, v._id]));
  const envConfig = flag.environments[ENV];
  if (!envConfig.on) throw new Error(`Flag ${FLAG} is OFF in ${ENV}; an experiment needs it ON.`);

  // Experiments need a maintainer (a member). A service token is not a member,
  // so use LD_MAINTAINER_ID if set, otherwise the account owner.
  let maintainerId = process.env.LD_MAINTAINER_ID;
  if (!maintainerId) {
    const members = await api('GET', '/members?limit=100');
    const owner = members?.items?.find((m) => m.role === 'owner');
    maintainerId = owner?._id;
  }
  if (!maintainerId) throw new Error('No maintainer found; set LD_MAINTAINER_ID to a member ID.');

  const created = await api('POST', `/projects/${PROJECT}/environments/${ENV}/experiments`, {
    key: EXPERIMENT,
    maintainerId,
    name: 'Hero redesign: CTA conversion',
    description: 'Does the redesigned hero get more call-to-action clicks than the original?',
    methodology: 'bayesian',
    iteration: {
      hypothesis: 'The redesigned hero increases CTA clicks compared with the original hero.',
      canReshuffleTraffic: true,
      randomizationUnit: 'user',
      metrics: [{ key: METRIC, isGroup: false }],
      primarySingleMetricKey: METRIC,
      treatments: [
        { name: 'Control', baseline: true, allocationPercent: '50',
          parameters: [{ flagKey: FLAG, variationId: byValue.control }] },
        { name: 'Redesign', baseline: false, allocationPercent: '50',
          parameters: [{ flagKey: FLAG, variationId: byValue.redesign }] },
      ],
      // "fallthrough" = the flag's default rule, i.e. everyone not matched by
      // the Part 2 individual target or rules.
      flags: { [FLAG]: { ruleId: 'fallthrough', flagConfigVersion: envConfig._version } },
    },
  });
  console.log(`Created experiment "${EXPERIMENT}".`);
  return created;
}

async function ensureRunning(exp) {
  const fresh = await api('GET', `/projects/${PROJECT}/environments/${ENV}/experiments/${EXPERIMENT}`);
  const status = fresh?.currentIteration?.status;
  if (status === 'running') {
    console.log('Experiment is running.');
    return;
  }
  // A stopped iteration holds results someone may still be reading. Starting a
  // new one is a decision, so it needs an explicit --restart.
  if (status === 'stopped' && !process.argv.includes('--restart')) {
    console.log('Experiment is stopped. Re-run with --restart to start a new iteration.');
    return;
  }
  await api('PATCH', `/projects/${PROJECT}/environments/${ENV}/experiments/${EXPERIMENT}`,
    { instructions: [{ kind: 'startIteration' }] }, true);
  console.log('Experiment started.');
}

async function main() {
  await ensureMetric();
  const exp = await ensureExperiment();
  await ensureRunning(exp);
  console.log('Done. Results: LaunchDarkly > Experiments > "Hero redesign: CTA conversion".');
}

main().catch((err) => { console.error(err.message || err); process.exit(1); });
