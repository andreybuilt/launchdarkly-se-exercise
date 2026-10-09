// server/contexts.mjs
//
// The five preset demo contexts shared by the server (for /api/flags) and
// the browser bundle (for the context switcher panel). Keeping one source
// of truth here means the server-side evaluation in /api/flags and the
// client-side evaluation in the browser are always looking at the exact
// same context attributes.
//
// Context kind is "user" throughout, per the brief. Custom attributes:
//   plan: "free" | "pro" | "enterprise"
//   region: "us-west" | "us-east" | "eu"
//   betaTester: boolean
//   company: string
//
// These attributes are what the Part 2 targeting rule in
// scripts/setup-launchdarkly.mjs reads (plan == enterprise OR betaTester == true).

export const DEMO_CONTEXTS = [
  {
    key: 'demo-ana',
    label: 'Ana (enterprise, us-west, beta)',
    kind: 'user',
    name: 'Ana Rodriguez',
    plan: 'enterprise',
    region: 'us-west',
    betaTester: true,
    company: 'Globex Logistics',
  },
  {
    key: 'demo-ben',
    label: 'Ben (free, eu)',
    kind: 'user',
    name: 'Ben Okafor',
    plan: 'free',
    region: 'eu',
    betaTester: false,
    company: 'Initech Supplies',
  },
  {
    key: 'demo-chen',
    label: 'Chen (pro, us-east, beta)',
    kind: 'user',
    name: 'Chen Wu',
    plan: 'pro',
    region: 'us-east',
    betaTester: true,
    company: 'Umbrella Retail',
  },
  {
    key: 'demo-dana',
    label: 'Dana (enterprise, eu)',
    kind: 'user',
    name: 'Dana Whitfield',
    plan: 'enterprise',
    region: 'eu',
    betaTester: false,
    company: 'Soylent Foods',
  },
  {
    // This is the individually targeted user set up by setup-launchdarkly.mjs
    // (an "individual target" on landing-hero-redesign -> "redesign"), on
    // purpose a free/non-beta/non-enterprise user who would otherwise fall
    // through to "control". Demonstrates individual targeting beating the
    // rule-based fallthrough.
    key: 'demo-eli',
    label: 'Eli (free, us-west, individually targeted)',
    kind: 'user',
    name: 'Eli Stern',
    plan: 'free',
    region: 'us-west',
    betaTester: false,
    company: 'Hooli Freight',
  },
];

export function findDemoContext(key) {
  return DEMO_CONTEXTS.find((c) => c.key === key);
}

/**
 * Builds an LD context object (the shape the SDKs expect) from one of the
 * preset demo users above.
 */
export function toLdContext(preset) {
  return {
    kind: preset.kind,
    key: preset.key,
    name: preset.name,
    plan: preset.plan,
    region: preset.region,
    betaTester: preset.betaTester,
    company: preset.company,
  };
}
