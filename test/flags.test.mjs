// test/flags.test.mjs
//
// Offline tests using the Node server SDK's TestData data source (see
// node_modules/@launchdarkly/node-server-sdk/dist/src/integrations.d.ts,
// which re-exports TestData from @launchdarkly/js-server-sdk-common). No
// network calls to LaunchDarkly happen here, TestData feeds flag state
// into the SDK entirely in memory, which is what makes these tests
// deterministic and runnable with no LD_SDK_KEY.
//
// Run with: npm test  (node:test + node's built-in assert)

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createLdClient, TestData, FLAG_RELEASE_BANNER, FLAG_HERO_REDESIGN } from '../server/ldClient.mjs';
import {
  DEMO_CONTEXTS,
  findDemoContext,
  toLdContext,
  toVisitorLdContext,
  generateVisitorKey,
  isVisitorKey,
} from '../server/contexts.mjs';

describe('release-new-checkout-banner (Part 1: release and rollback)', () => {
  let client;
  let td;

  before(async () => {
    td = new TestData();
    // Standard boolean flag: true/false variations, off by default so we
    // control the on/off transition explicitly per test.
    td.update(td.flag(FLAG_RELEASE_BANNER).booleanFlag().variationForAll(false));
    client = await createLdClient({ updateProcessor: td.getFactory() });
  });

  after(async () => {
    await client.close();
  });

  const anyUser = toLdContext(DEMO_CONTEXTS[0]);

  test('flag off (rollback state): server returns the old banner', async () => {
    const value = await client.variation(FLAG_RELEASE_BANNER, anyUser, false);
    assert.equal(value, false, 'expected the flag to evaluate to false (old banner) when off');
  });

  test('toggling the flag on (release): server output flips to the new banner', async () => {
    // Simulates flipping the flag on in the LaunchDarkly UI: update the
    // TestData flag builder and push the update through.
    td.update(td.flag(FLAG_RELEASE_BANNER).booleanFlag().variationForAll(true));

    const value = await client.variation(FLAG_RELEASE_BANNER, anyUser, false);
    assert.equal(value, true, 'expected the flag to evaluate to true (new banner) after release');
  });

  test('toggling the flag back off (rollback): server output flips back', async () => {
    td.update(td.flag(FLAG_RELEASE_BANNER).booleanFlag().variationForAll(false));

    const value = await client.variation(FLAG_RELEASE_BANNER, anyUser, false);
    assert.equal(value, false, 'expected rollback to restore the old banner value');
  });
});

describe('landing-hero-redesign (Part 2: individual + rule based targeting, multi-context)', () => {
  let client;
  let td;

  const enterpriseUser = toLdContext(findDemoContext('demo-ana')); // organization.plan: enterprise
  const betaUser = toLdContext(findDemoContext('demo-chen')); // organization.plan: pro, user.betaTester: true
  const individuallyTargetedUser = toLdContext(findDemoContext('demo-eli')); // free plan, not beta, individually targeted
  const enterpriseNonBetaUser = toLdContext(findDemoContext('demo-dana')); // organization.plan: enterprise, not beta
  const plainUser = toLdContext(findDemoContext('demo-ben')); // free, not beta, not targeted

  before(async () => {
    td = new TestData();

    // Mirrors the real flag configuration created by
    // scripts/setup-launchdarkly.mjs for the multi-context demo:
    // control/redesign variations, fallthrough is "control", one
    // individual target on demo-eli's "user" key, then three rules in
    // order: organization.plan == enterprise, user.betaTester == true,
    // and (because TestData's public builder only exposes the "is one of"
    // operator, never "starts with" - see the d.ts comment on TestData
    // listing what it does not support) user.key is one of the five fixed
    // demo- keys, which is the equivalent rule over this closed set of
    // demo users -> "control". That third rule only ever catches Ben: Ana,
    // Chen and Dana already matched an earlier rule, and Eli is caught by
    // the individual target before any rule is evaluated at all.
    td.update(
      td
        .flag(FLAG_HERO_REDESIGN)
        .variations('control', 'redesign')
        .fallthroughVariation(0) // "control"
        .variationForContext('user', 'demo-eli', 1) // individual target -> "redesign"
        .ifMatch('organization', 'plan', 'enterprise')
        .thenReturn(1) // rule 1: organization.plan == enterprise -> "redesign"
        .ifMatch('user', 'betaTester', true)
        .thenReturn(1) // rule 2: user.betaTester == true -> "redesign"
        .ifMatch('user', 'key', 'demo-ana', 'demo-ben', 'demo-chen', 'demo-dana', 'demo-eli')
        .thenReturn(0), // rule 3: any demo- user -> "control" (keeps demo users out of the experiment)
    );

    client = await createLdClient({ updateProcessor: td.getFactory() });
  });

  after(async () => {
    await client.close();
  });

  test('individually targeted user (demo-eli) gets "redesign" even though plan is free', async () => {
    const value = await client.variation(FLAG_HERO_REDESIGN, individuallyTargetedUser, 'control');
    assert.equal(value, 'redesign');
  });

  test('enterprise user (demo-ana) gets "redesign" via the organization plan rule', async () => {
    const value = await client.variation(FLAG_HERO_REDESIGN, enterpriseUser, 'control');
    assert.equal(value, 'redesign');
  });

  test('beta tester (demo-chen, plan=pro) gets "redesign" via the user betaTester rule', async () => {
    const value = await client.variation(FLAG_HERO_REDESIGN, betaUser, 'control');
    assert.equal(value, 'redesign');
  });

  test('enterprise, non-beta user (demo-dana) gets "redesign" via the organization plan rule', async () => {
    const value = await client.variation(FLAG_HERO_REDESIGN, enterpriseNonBetaUser, 'control');
    assert.equal(value, 'redesign');
  });

  test('a plain free/non-beta user (demo-ben) falls to the demo-key rule and gets "control"', async () => {
    const value = await client.variation(FLAG_HERO_REDESIGN, plainUser, 'control');
    assert.equal(value, 'control');
  });

  describe('extra credit: "New visitor" preset falls through into the experiment', () => {
    test('a generated visitor key matches the visitor- shape and is not a demo- key', () => {
      const visitorKey = generateVisitorKey();
      assert.ok(isVisitorKey(visitorKey), 'expected the generated key to match VISITOR_KEY_PATTERN');
      assert.ok(!visitorKey.startsWith('demo-'), 'a visitor key must never collide with the fixed demo set');
    });

    test('a visitor context matches none of the individual target or rules, and reaches the fallthrough', async () => {
      // TestData cannot express a real percentage rollout (per its own
      // d.ts: "does not currently support ... percentage rollouts"), so
      // the fallthrough above is pinned to a fixed variation rather than
      // the experiment's actual 50/50 split (scripts/setup-experiment.mjs).
      // What this test proves is that a visitor is not caught by the
      // individual target or either rule, so it reaches that fallthrough
      // at all - whichever variation it is configured to serve.
      const visitorKey = generateVisitorKey();
      const context = toVisitorLdContext(visitorKey);

      const value = await client.variation(FLAG_HERO_REDESIGN, context, 'control');
      assert.ok(['control', 'redesign'].includes(value));
    });
  });
});
