#!/usr/bin/env node
// scripts/simulate-traffic.mjs
//
// SIMULATED traffic for the experiment, clearly labelled as such. A trial
// account has no real visitors, so this script plays the part of the 40,000
// daily visitors in the brief, at a much smaller scale, so the experiment has
// data to analyse.
//
// Each simulated visitor is a multi-context, the same shape
// server/contexts.mjs builds for the real app: a "user" kind (key
// "sim-<run>-<n>", betaTester: false, simulated: true) and an
// "organization" kind (key "org-sim-<n % 50>", a random plan of free or
// pro). Neither kind is a demo- key and neither matches the enterprise or
// betaTester rules, so every simulated visitor falls through to the
// experiment rather than the Part 2 targeting rules.
//
// For each simulated visitor it:
//   1. builds the multi-context above;
//   2. evaluates landing-hero-redesign with the server SDK, exactly as a real
//      page view would (this records the experiment exposure);
//   3. "clicks" the hero CTA with a probability that depends on the variation
//      served, and sends the hero-cta-click event with track().
//
// The two click rates are ASSUMPTIONS chosen for the demo (8% control, 11%
// redesign). The experiment's job is to recover the difference from noisy
// data; the result says nothing about real visitors.
//
// Usage:
//   LD_SDK_KEY=sdk-... node scripts/simulate-traffic.mjs [visitors] [perMinute]
//   defaults: 3000 visitors at 20 per minute (about 2.5 hours)

import { init } from '@launchdarkly/node-server-sdk';

const SDK_KEY = process.env.LD_SDK_KEY;
const TOTAL = Number(process.argv[2] || 3000);
const PER_MINUTE = Number(process.argv[3] || 20);
const CLICK_RATE = { control: 0.08, redesign: 0.11 }; // assumed, see header
const FLAG = 'landing-hero-redesign';

if (!SDK_KEY) {
  console.error('LD_SDK_KEY is not set.');
  process.exit(1);
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const client = init(SDK_KEY, { diagnosticOptOut: true });
await client.waitForInitialization({ timeout: 10 });

const runId = Date.now().toString(36);
const served = { control: 0, redesign: 0 };
const clicks = { control: 0, redesign: 0 };

for (let i = 1; i <= TOTAL; i++) {
  const context = {
    kind: 'multi',
    user: {
      key: `sim-${runId}-${i}`,
      name: `Simulated visitor ${i}`,
      betaTester: false,
      simulated: true,
      region: pick(['us-west', 'us-east', 'eu']),
    },
    organization: {
      key: `org-sim-${i % 50}`,
      name: `Simulated Org ${i % 50}`,
      plan: pick(['free', 'free', 'pro']),
    },
  };
  const variation = await client.variation(FLAG, context, 'control');
  served[variation] = (served[variation] || 0) + 1;
  if (Math.random() < (CLICK_RATE[variation] ?? 0)) {
    client.track('hero-cta-click', context);
    clicks[variation] = (clicks[variation] || 0) + 1;
  }
  if (i % 100 === 0) {
    await client.flush();
    console.log(`${new Date().toISOString()} ${i}/${TOTAL} served=${JSON.stringify(served)} clicks=${JSON.stringify(clicks)}`);
  }
  await sleep(60000 / PER_MINUTE);
}

await client.flush();
client.close();
console.log('Done.', { served, clicks });
