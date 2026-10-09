#!/usr/bin/env node
// scripts/simulate-checkout.mjs
//
// SIMULATED traffic for the guarded rollout, clearly labelled as such, in
// the same spirit as scripts/simulate-traffic.mjs for the experiment: a
// trial account has no real checkouts, so this script plays the part of
// visitors clicking "Check out now" so the guarded rollout has something
// to watch.
//
// Each simulated visitor is a multi-context, the same shape
// server/contexts.mjs builds for the real app: a "user" kind (key
// "chk-<run>-<n>", simulated: true) and an "organization" kind (a random
// plan of free or pro). None of these are demo- keys, so every simulated
// visitor is evaluated on release-new-checkout-banner's default rule,
// exactly where the guarded rollout ramps the new variation.
//
// IMPORTANT: for this script to mean anything, the flag's default rule
// must actually be serving traffic to both the old and new checkout
// variation (that is what a guarded rollout in progress does). If the
// default rule is simply ON/OFF, every simulated visitor gets the same
// variation and the "per variation" breakdown below collapses to one row.
// This does not disturb the Part 1 demo: the individual-free demo users
// (Ana, Ben, etc.) are addressed by their own demo- keys, never these
// generated chk- keys, so switching them in the context switcher still
// shows the flag's targeted behaviour untouched by this traffic.
//
// For each simulated visitor it:
//   1. builds the multi-context above;
//   2. evaluates release-new-checkout-banner with the server SDK, exactly
//      as a real page load would (this is the exposure the rollout's
//      ramp percentage is measured against);
//   3. "checks out" with an ASSUMED error rate that depends on the
//      variation served and whether --regression was passed:
//        old banner (false):            2% errors, always
//        new banner (true), no flag:    2% errors (normal, healthy release)
//        new banner (true), --regression: 30% errors (the injected regression)
//   4. tracks checkout-completed or checkout-error, the event
//      scripts/setup-guarded-rollout.mjs's metric reads.
//
// These rates are ASSUMPTIONS chosen for the demo, not a measurement of
// anything real; the point is to give the guarded rollout's metric a
// before/after step it can actually detect within a short demo window.
//
// Usage:
//   LD_SDK_KEY=sdk-... node scripts/simulate-checkout.mjs [visitors] [perMinute] [--regression]
//   defaults: 2000 visitors at 60 per minute (about 33 minutes), no regression

import { init } from '@launchdarkly/node-server-sdk';

const SDK_KEY = process.env.LD_SDK_KEY;
const args = process.argv.slice(2);
const regression = args.includes('--regression');
const positional = args.filter((a) => !a.startsWith('--'));
const TOTAL = Number(positional[0] || 2000);
const PER_MINUTE = Number(positional[1] || 60);
const FLAG = 'release-new-checkout-banner';

// Baseline error rate for both variations when nothing is wrong, and the
// regressed rate the new variation jumps to when --regression is passed.
// See the header comment for why these numbers, not a measurement.
const BASELINE_ERROR_RATE = 0.02;
const REGRESSED_ERROR_RATE = 0.3;

if (!SDK_KEY) {
  console.error('LD_SDK_KEY is not set.');
  process.exit(1);
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const client = init(SDK_KEY, { diagnosticOptOut: true });
await client.waitForInitialization({ timeout: 10 });

if (regression) {
  console.log('Running WITH the injected regression: the new (true) variation fails at '
    + `${Math.round(REGRESSED_ERROR_RATE * 100)}% instead of its normal ${Math.round(BASELINE_ERROR_RATE * 100)}%.`);
} else {
  console.log(`Running WITHOUT the regression: both variations fail at their normal ${Math.round(BASELINE_ERROR_RATE * 100)}%.`);
}

const runId = Date.now().toString(36);
const served = { true: 0, false: 0 };
const errors = { true: 0, false: 0 };

for (let i = 1; i <= TOTAL; i++) {
  const context = {
    kind: 'multi',
    user: {
      key: `chk-${runId}-${i}`,
      name: `Simulated checkout ${i}`,
      betaTester: false,
      simulated: true,
    },
    organization: {
      key: `org-sim-${i % 50}`,
      name: `Simulated Org ${i % 50}`,
      plan: pick(['free', 'free', 'pro']),
    },
  };

  const variation = await client.variation(FLAG, context, false);
  served[variation] = (served[variation] || 0) + 1;

  const errorRate = variation === true && regression ? REGRESSED_ERROR_RATE : BASELINE_ERROR_RATE;
  if (Math.random() < errorRate) {
    client.track('checkout-error', context);
    errors[variation] = (errors[variation] || 0) + 1;
  } else {
    client.track('checkout-completed', context);
  }

  if (i % 100 === 0) {
    await client.flush();
    console.log(
      `${new Date().toISOString()} ${i}/${TOTAL} served=${JSON.stringify(served)} errors=${JSON.stringify(errors)}`,
    );
  }
  await sleep(60000 / PER_MINUTE);
}

await client.flush();
client.close();
console.log('Done.', { served, errors });
