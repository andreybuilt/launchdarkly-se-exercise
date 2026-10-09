// server/ldClient.mjs
//
// Wraps the LaunchDarkly Node (server-side) SDK so the rest of the app
// just imports a ready-to-use client. The server SDK keeps a full local
// copy of flag state in memory and streams updates, so evaluations here
// are fast, synchronous-feeling, local calls (no network round trip per
// evaluation).
//
// SDK KEY: this is the one place the server-side SDK key is read. It must
// be a LaunchDarkly *SDK key* (server-side), never the client-side ID.
// Supply it via the LD_SDK_KEY environment variable (see .env.example).

import * as LaunchDarkly from '@launchdarkly/node-server-sdk';

// For offline tests we swap in the TestData data source instead of talking
// to LaunchDarkly at all. See test/*.test.mjs for how this is wired up.
import { TestData } from '@launchdarkly/node-server-sdk/integrations';

export const FLAG_RELEASE_BANNER = 'release-new-checkout-banner';
export const FLAG_HERO_REDESIGN = 'landing-hero-redesign';

/**
 * Creates and initializes a LaunchDarkly server-side client.
 *
 * @param {object} [opts]
 * @param {string} [opts.sdkKey] - overrides LD_SDK_KEY env var (used by tests)
 * @param {object} [opts.updateProcessor] - a custom data source (TestData.getFactory()), used by tests
 * @returns {Promise<LaunchDarkly.LDClient>}
 */
export async function createLdClient(opts = {}) {
  const sdkKey = opts.sdkKey ?? process.env.LD_SDK_KEY;

  if (!opts.updateProcessor && !sdkKey) {
    // No key and no test data source: we cannot talk to LaunchDarkly.
    // Fail loudly and early rather than silently falling back to defaults,
    // so a missing .env is obvious instead of confusing.
    throw new Error(
      'LD_SDK_KEY is not set. Copy .env.example to .env and fill in a server-side SDK key, ' +
        'or pass a test updateProcessor (see test/).',
    );
  }

  const ldOptions = {};
  if (opts.updateProcessor) {
    ldOptions.updateProcessor = opts.updateProcessor;
  }

  // In offline/test mode there is no real SDK key, so use a harmless
  // placeholder; the TestData updateProcessor bypasses the network anyway.
  const client = LaunchDarkly.init(sdkKey ?? 'test-sdk-key-placeholder', ldOptions);

  try {
    await client.waitForInitialization({ timeout: 10 });
  } catch (err) {
    // waitForInitialization() rejects on an unrecoverable error (for
    // example an invalid SDK key) or times out before the first connect.
    // Either way, the client itself is still usable: it serves the default
    // value passed to each variation() call, and keeps retrying the
    // connection in the background, so the app recovers on its own once
    // LaunchDarkly is reachable. Degrade instead of crashing the server.
    // eslint-disable-next-line no-console
    console.warn(
      'LaunchDarkly client did not finish initializing, serving default flag values until it does:',
      err.message,
    );
  }
  return client;
}

// Re-export TestData so other modules (and tests) don't need to know the
// exact subpath the integrations live under.
export { TestData };
