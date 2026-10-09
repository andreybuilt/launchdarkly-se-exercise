#!/usr/bin/env node
// scripts/setup-launchdarkly.mjs
//
// Creates everything Parts 1 and 2 need in your LaunchDarkly project, using
// the REST API v2 (https://launchdarkly.com/docs/api). Safe to re-run: each
// piece is compared with the desired state and only what differs is changed,
// so a half-configured or outdated project is brought up to date.
//
//   1. Flag "release-new-checkout-banner" (boolean, starts OFF), available to
//      client-side SDKs.
//   2. Flag "landing-hero-redesign" (string: "control" | "redesign"), available
//      to client-side SDKs, ON in the environment.
//   3. Individual target: context key "demo-eli" gets "redesign".
//   4. Rules, in this order:
//        organization plan is "enterprise"  -> redesign
//        user betaTester is true             -> redesign
//        user key starts with "demo-"        -> control  (keeps the demo users
//                                                         out of the experiment,
//                                                         so the demo is
//                                                         predictable)
//      Everyone else falls through to the default rule, which is where the
//      experiment (scripts/setup-experiment.mjs) runs.
//   5. A flag trigger on the banner flag whose only action is "turn the flag
//      off". Its URL is printed once; LaunchDarkly shows it masked afterwards.
//
// Environment:
//   LD_API_TOKEN         access token with Writer role (Organization settings >
//                        Authorization). Never commit it.
//   LD_PROJECT_KEY       default "default"
//   LD_ENV_KEY           default "test"
//   LD_TRIGGER_URL_FILE  optional: write the trigger URL to this file (mode
//                        600) instead of printing it, for shared screens.
//
// Usage: npm run setup:ld
//        npm run setup:ld -- --reset-demo   (also reset the banner flag to the
//                                            demo's starting state, see below)

import { writeFileSync } from 'node:fs';

const API_BASE = 'https://app.launchdarkly.com/api/v2';
const API_TOKEN = process.env.LD_API_TOKEN;
const PROJECT_KEY = process.env.LD_PROJECT_KEY || 'default';
const ENV_KEY = process.env.LD_ENV_KEY || 'test';

const FLAG_RELEASE_BANNER = 'release-new-checkout-banner';
const FLAG_HERO_REDESIGN = 'landing-hero-redesign';
// Must match the demo users in server/contexts.mjs.
const INDIVIDUAL_TARGET_KEY = 'demo-eli';
const DEMO_KEY_PREFIX = 'demo-';

if (!API_TOKEN) {
  console.error(
    'LD_API_TOKEN is not set. Create an access token with the Writer role in ' +
      'LaunchDarkly (Organization settings > Authorization) and put it in .env.',
  );
  process.exit(1);
}

// One helper for every call. 404 means "does not exist" and returns null;
// any other non-2xx response stops the script with LaunchDarkly's message.
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
  if (!res.ok) {
    throw new Error(`${method} ${path} failed: ${res.status} ${data?.message ?? text}`);
  }
  return data;
}

const getFlag = (key) => ldApi('GET', `/flags/${PROJECT_KEY}/${key}?env=${ENV_KEY}`);

// Creates the flag if missing. If it exists, checks it has the variations this
// app expects (fails clearly if not) and makes sure client-side SDKs can see it.
async function ensureFlag({ key, name, description, values, defaults, temporary, tags }) {
  let flag = await getFlag(key);
  if (!flag) {
    console.log(`Creating flag "${key}"...`);
    // LaunchDarkly infers the flag type from the variations: two booleans make
    // a boolean flag, strings make a multivariate flag. clientSideAvailability
    // usingEnvironmentId exposes the flag to the browser SDK (client-side ID).
    await ldApi('POST', `/flags/${PROJECT_KEY}`, {
      key,
      name,
      description,
      variations: values.map((value) => ({ value, name: String(value) })),
      defaults,
      temporary,
      tags,
      clientSideAvailability: { usingEnvironmentId: true, usingMobileKey: false },
    });
    return getFlag(key);
  }

  const actual = flag.variations.map((v) => v.value);
  if (JSON.stringify(actual) !== JSON.stringify(values)) {
    throw new Error(
      `Flag "${key}" already exists with variations ${JSON.stringify(actual)}, ` +
        `but this app expects ${JSON.stringify(values)}. Rename or delete it, then re-run.`,
    );
  }
  if (!flag.clientSideAvailability?.usingEnvironmentId) {
    console.log(`Making "${key}" available to client-side SDKs...`);
    await ldApi('PATCH', `/flags/${PROJECT_KEY}/${key}`, {
      comment: 'Expose to the browser SDK (setup-launchdarkly.mjs)',
      patch: [{ op: 'replace', path: '/clientSideAvailability/usingEnvironmentId', value: true }],
    });
    flag = await getFlag(key);
  } else {
    console.log(`Flag "${key}" exists and has the expected variations.`);
  }
  return flag;
}

// Desired rules, in order. A rule's clauses are AND'ed, so "enterprise OR beta
// tester" is two rules serving the same variation. Plan lives on the
// organization context, beta-tester status on the user. The demo-user rule is
// last: Ana and Dana are enterprise and must match the enterprise rule first.
const DESIRED_RULES = [
  { contextKind: 'organization', attribute: 'plan', op: 'in', values: ['enterprise'],
    serve: 'redesign', description: 'Enterprise organizations get the redesign' },
  { contextKind: 'user', attribute: 'betaTester', op: 'in', values: [true],
    serve: 'redesign', description: 'Beta testers get the redesign' },
  { contextKind: 'user', attribute: 'key', op: 'startsWith', values: [DEMO_KEY_PREFIX],
    serve: 'control', description: 'Demo users stay on control (not in the experiment)' },
];

const ruleSignature = (contextKind, attribute, op, values, variationIndex) =>
  `${contextKind || 'user'}|${attribute}|${op}|${JSON.stringify(values)}|${variationIndex}`;

async function ensureHeroTargeting(flag) {
  const env = flag.environments[ENV_KEY];
  const index = (value) => flag.variations.findIndex((v) => v.value === value);
  const variationId = (value) => flag.variations[index(value)]._id;
  const instructions = [];

  // 1. Individual target. User targets appear in "targets" (other context
  //    kinds in "contextTargets"), so look in both.
  const targeted = [...(env.targets || []), ...(env.contextTargets || [])].some(
    (t) => t.variation === index('redesign') && (t.values || []).includes(INDIVIDUAL_TARGET_KEY),
  );
  if (!targeted) {
    instructions.push({
      kind: 'addTargets',
      contextKind: 'user',
      values: [INDIVIDUAL_TARGET_KEY],
      variationId: variationId('redesign'),
    });
  }

  // 2. Rules: compare the whole ordered list (clause, context kind, served
  //    variation). Any difference, including an older rule shape, is replaced
  //    with the desired list in one instruction.
  const current = (env.rules || []).map((r) =>
    r.clauses.length === 1
      ? ruleSignature(r.clauses[0].contextKind, r.clauses[0].attribute, r.clauses[0].op, r.clauses[0].values, r.variation)
      : `multi-clause:${r._id}`,
  );
  const desired = DESIRED_RULES.map((r) =>
    ruleSignature(r.contextKind, r.attribute, r.op, r.values, index(r.serve)),
  );
  if (JSON.stringify(current) !== JSON.stringify(desired)) {
    instructions.push({
      kind: 'replaceRules',
      rules: DESIRED_RULES.map((r) => ({
        description: r.description,
        clauses: [{ contextKind: r.contextKind, attribute: r.attribute, op: r.op, values: r.values, negate: false }],
        variationId: variationId(r.serve),
      })),
    });
  }

  // 3. Targeting only applies while the flag is ON (an OFF flag serves its off
  //    variation to everyone).
  if (!env.on) instructions.push({ kind: 'turnFlagOn' });

  if (instructions.length === 0) {
    console.log(`Targeting on "${FLAG_HERO_REDESIGN}" is already as expected.`);
    return;
  }
  console.log(`Applying ${instructions.map((x) => x.kind).join(', ')} on "${FLAG_HERO_REDESIGN}"...`);
  await ldApi(
    'PATCH',
    `/flags/${PROJECT_KEY}/${FLAG_HERO_REDESIGN}`,
    { environmentKey: ENV_KEY, comment: 'Part 2 targeting (setup-launchdarkly.mjs)', instructions },
    { semantic: true },
  );
}

// Reuses an enabled trigger only if its single action is "turn the flag off";
// any other trigger on the flag is left alone and a new one is created.
async function ensureRemediationTrigger() {
  const path = `/flags/${PROJECT_KEY}/${FLAG_RELEASE_BANNER}/triggers/${ENV_KEY}`;
  const list = await ldApi('GET', path);
  const reusable = (list?.items || []).find(
    (t) =>
      (t._integrationKey ?? t.integrationKey) === 'generic-trigger' &&
      t.enabled !== false &&
      t.instructions?.length === 1 &&
      t.instructions[0].kind === 'turnFlagOff',
  );
  if (reusable) {
    console.log('A "turn flag off" trigger already exists. Its URL was shown when it was created;');
    console.log('if you no longer have it, delete the trigger in LaunchDarkly and re-run.');
    return;
  }

  const created = await ldApi('POST', path, {
    integrationKey: 'generic-trigger',
    instructions: [{ kind: 'turnFlagOff' }],
    comment: 'Remediation: turn the new checkout banner off',
  });
  const url = created?.triggerURL;
  if (!url) throw new Error('Trigger created but no URL was returned; check it in LaunchDarkly.');

  const outFile = process.env.LD_TRIGGER_URL_FILE;
  if (outFile) {
    writeFileSync(outFile, url + '\n', { mode: 0o600 });
    console.log(`Trigger created. URL written to ${outFile} (not printed).`);
  } else {
    console.log(`Trigger created. URL (shown once, treat it like a password):\n${url}`);
  }
  console.log('Use it as LD_TRIGGER_URL for scripts/remediate.sh.');
}

// --reset-demo puts the banner flag back to the demo's starting point: OFF,
// with its default rule serving the new banner, so "turn it on" releases the
// new banner again. Run it after the guarded rollout demo has finished; it is
// opt-in because a normal re-run must never undo a release in progress.
async function resetBannerForDemo(flag) {
  const env = flag.environments[ENV_KEY];
  const newBanner = flag.variations.find((v) => v.value === true);
  const newIndex = flag.variations.indexOf(newBanner);
  const instructions = [];
  if (env.on) instructions.push({ kind: 'turnFlagOff' });
  if (env.fallthrough?.variation !== newIndex) {
    instructions.push({ kind: 'updateFallthroughVariationOrRollout', variationId: newBanner._id });
  }
  if (instructions.length === 0) {
    console.log(`"${FLAG_RELEASE_BANNER}" is already OFF with the new banner as its default.`);
    return;
  }
  console.log(`Resetting "${FLAG_RELEASE_BANNER}" for the demo: ${instructions.map((x) => x.kind).join(', ')}...`);
  await ldApi(
    'PATCH',
    `/flags/${PROJECT_KEY}/${FLAG_RELEASE_BANNER}`,
    { environmentKey: ENV_KEY, comment: 'Reset for the demo (setup-launchdarkly.mjs --reset-demo)', instructions },
    { semantic: true },
  );
}

async function main() {
  console.log(`Project "${PROJECT_KEY}", environment "${ENV_KEY}"`);
  const banner = await ensureFlag({
    key: FLAG_RELEASE_BANNER,
    name: 'Release: new checkout banner',
    description: 'Wraps the new Fall Launch checkout banner. Part 1: release, rollback, remediation.',
    values: [true, false],
    defaults: { onVariation: 0, offVariation: 1 }, // ON serves the new banner
    temporary: true,
    tags: ['demo', 'part-1'],
  });
  const hero = await ensureFlag({
    key: FLAG_HERO_REDESIGN,
    name: 'Landing hero redesign',
    description: 'Wraps the landing page hero. Part 2: individual and rule-based targeting.',
    values: ['control', 'redesign'],
    defaults: { onVariation: 0, offVariation: 0 }, // default rule serves control
    temporary: true,
    tags: ['demo', 'part-2'],
  });
  await ensureHeroTargeting(hero);
  await ensureRemediationTrigger();
  if (process.argv.includes('--reset-demo')) await resetBannerForDemo(banner);
  console.log('Done.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
