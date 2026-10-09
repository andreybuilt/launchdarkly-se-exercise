// test/checkout.test.mjs
//
// Offline tests for the guarded rollout checkout logic in
// server/checkout.mjs, using the same TestData approach as
// test/flags.test.mjs: no network calls to LaunchDarkly, flag state is
// fed in from memory. random() is injected too, so the failure branch is
// deterministic instead of depending on actual randomness.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createLdClient, TestData, FLAG_RELEASE_BANNER } from '../server/ldClient.mjs';
import { toLdContext, DEMO_CONTEXTS } from '../server/contexts.mjs';
import { createCheckout, EVENT_CHECKOUT_COMPLETED, EVENT_CHECKOUT_ERROR } from '../server/checkout.mjs';

// A tiny ldClient.track() spy: records every (eventKey, context) pair so
// tests can assert which event fired, without touching the real SDK's
// track() (which only buffers for a later flush() and has no return value
// to assert on).
function trackingLdClient(client) {
  const tracked = [];
  const originalTrack = client.track.bind(client);
  client.track = (eventKey, context) => {
    tracked.push({ eventKey, context });
    return originalTrack(eventKey, context);
  };
  return tracked;
}

const anyUser = toLdContext(DEMO_CONTEXTS[0]);

describe('createCheckout (extra credit: guarded rollout checkout signal)', () => {
  let client;
  let td;
  let tracked;

  before(async () => {
    td = new TestData();
    client = await createLdClient({ updateProcessor: td.getFactory() });
    tracked = trackingLdClient(client);
  });

  after(async () => {
    await client.close();
  });

  describe('new variation (flag true), regression off', () => {
    before(() => {
      td.update(td.flag(FLAG_RELEASE_BANNER).booleanFlag().variationForAll(true));
    });

    test('always succeeds and tracks checkout-completed, regardless of random()', async () => {
      // random() pinned at 0, the value most likely to trigger a failure if
      // the "regression off" guard were broken, and it still must succeed.
      const checkout = createCheckout({ ldClient: client, isRegressionOn: () => false, random: () => 0 });
      tracked.length = 0;

      const result = await checkout(anyUser);

      assert.deepEqual(result, { ok: true, variationServed: true });
      assert.equal(tracked.length, 1);
      assert.equal(tracked[0].eventKey, EVENT_CHECKOUT_COMPLETED);
    });
  });

  describe('new variation (flag true), regression on', () => {
    before(() => {
      td.update(td.flag(FLAG_RELEASE_BANNER).booleanFlag().variationForAll(true));
    });

    test('random() below the failure threshold fails and tracks checkout-error', async () => {
      const checkout = createCheckout({ ldClient: client, isRegressionOn: () => true, random: () => 0.1 });
      tracked.length = 0;

      const result = await checkout(anyUser);

      assert.deepEqual(result, { ok: false, variationServed: true });
      assert.equal(tracked.length, 1);
      assert.equal(tracked[0].eventKey, EVENT_CHECKOUT_ERROR);
    });

    test('random() above the failure threshold still succeeds and tracks checkout-completed', async () => {
      const checkout = createCheckout({ ldClient: client, isRegressionOn: () => true, random: () => 0.9 });
      tracked.length = 0;

      const result = await checkout(anyUser);

      assert.deepEqual(result, { ok: true, variationServed: true });
      assert.equal(tracked.length, 1);
      assert.equal(tracked[0].eventKey, EVENT_CHECKOUT_COMPLETED);
    });
  });

  describe('old variation (flag false)', () => {
    before(() => {
      td.update(td.flag(FLAG_RELEASE_BANNER).booleanFlag().variationForAll(false));
    });

    test('never fails even with regression on and random() pinned at 0', async () => {
      const checkout = createCheckout({ ldClient: client, isRegressionOn: () => true, random: () => 0 });
      tracked.length = 0;

      const result = await checkout(anyUser);

      assert.deepEqual(result, { ok: true, variationServed: false });
      assert.equal(tracked.length, 1);
      assert.equal(tracked[0].eventKey, EVENT_CHECKOUT_COMPLETED);
    });
  });

  test('the tracked event is attributed to the context passed in', async () => {
    td.update(td.flag(FLAG_RELEASE_BANNER).booleanFlag().variationForAll(true));
    const checkout = createCheckout({ ldClient: client, isRegressionOn: () => false, random: () => 0 });
    tracked.length = 0;

    await checkout(anyUser);

    assert.equal(tracked[0].context, anyUser);
  });
});

describe('createCheckout constructor guards', () => {
  test('throws without an ldClient', () => {
    assert.throws(() => createCheckout({ isRegressionOn: () => false }));
  });

  test('throws without isRegressionOn', () => {
    assert.throws(() => createCheckout({ ldClient: {} }));
  });
});
