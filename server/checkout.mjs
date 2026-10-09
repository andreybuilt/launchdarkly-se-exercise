// server/checkout.mjs
//
// Extra credit: guarded rollout. This is the checkout signal a guarded
// rollout watches: a click that either succeeds or fails, tracked back to
// LaunchDarkly as a custom metric event, joined to the variation of
// release-new-checkout-banner that visitor was served.
//
// Pulled out of server/index.mjs into its own function, createCheckout(),
// so test/checkout.test.mjs can exercise the decision logic (regression on
// or off, which variation, which event gets tracked) directly, with an
// injected random() instead of the real Math.random, and no Express app or
// LaunchDarkly client needed.
//
// How a guarded rollout uses this: when the flag's default rule is set to
// "Serve > Guarded rollout" in the LaunchDarkly UI, LaunchDarkly ramps the
// percentage of contexts served the new (true) variation on the schedule
// configured there, watching the checkout-error metric below as it goes.
// If the error rate on the new variation regresses against the baseline by
// enough to trip the guard, LaunchDarkly rolls the flag back to the old
// variation on its own, no one has to be watching. This module only has to
// produce a believable regression on demand; the rollback itself is a
// LaunchDarkly platform behaviour, not something this app implements.

import { FLAG_RELEASE_BANNER } from './ldClient.mjs';

export const EVENT_CHECKOUT_COMPLETED = 'checkout-completed';
export const EVENT_CHECKOUT_ERROR = 'checkout-error';

// When the regression toggle is on, this fraction of checkouts on the NEW
// (true) variation fail. Chosen to be a large, obvious step up from the
// variation's normal 0% failure rate, so a guarded rollout watching
// checkout-error has an unmistakable signal to catch during a short demo
// window, rather than a borderline one it might miss.
const REGRESSION_FAILURE_RATE = 0.4;

/**
 * Builds the checkout handler used by POST /api/checkout.
 *
 * @param {object} opts
 * @param {import('@launchdarkly/node-server-sdk').LDClient} opts.ldClient
 * @param {() => boolean} opts.isRegressionOn - reads the current regression
 *   toggle (CHECKOUT_REGRESSION env var, or the /api/demo/regression switch
 *   in server/index.mjs). Read fresh on every call rather than captured
 *   once, so flipping the toggle mid-demo takes effect on the very next
 *   checkout with no restart.
 * @param {() => number} [opts.random] - defaults to Math.random; tests
 *   inject a fixed value so the failure branch is deterministic instead of
 *   depending on luck.
 * @returns {(context: object) => Promise<{ok: boolean, variationServed: boolean}>}
 */
export function createCheckout({ ldClient, isRegressionOn, random = Math.random } = {}) {
  if (!ldClient) {
    throw new Error('createCheckout requires an ldClient');
  }
  if (typeof isRegressionOn !== 'function') {
    throw new Error('createCheckout requires isRegressionOn, a function returning the current toggle state');
  }

  return async function checkout(context) {
    // Same flag the banner itself uses: whichever variation this context
    // would see on the page is the one its simulated checkout runs under.
    const variationServed = await ldClient.variation(FLAG_RELEASE_BANNER, context, false);

    // The old banner (false) has no button in the UI, so a real click
    // never reaches this path for it; it is kept simple and reliable here
    // only so a direct API call against the old variation still behaves
    // sensibly. The regression is deliberately scoped to the NEW variation
    // only, because the whole point of the demo is that the new release
    // (not the old, already-trusted code) is the one misbehaving.
    const shouldFail = variationServed === true && isRegressionOn() && random() < REGRESSION_FAILURE_RATE;

    if (shouldFail) {
      ldClient.track(EVENT_CHECKOUT_ERROR, context);
      return { ok: false, variationServed };
    }

    ldClient.track(EVENT_CHECKOUT_COMPLETED, context);
    return { ok: true, variationServed };
  };
}
