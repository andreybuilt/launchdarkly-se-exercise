// server/contexts.mjs
//
// The preset demo contexts shared by the server (for /api/flags and
// /api/chat) and the browser bundle (for the context switcher panel).
// Keeping one source of truth here means the server-side evaluation and
// the client-side evaluation are always looking at the exact same context.
//
// Every context built here is a MULTI-CONTEXT: a "user" kind for the
// person and an "organization" kind for the account they belong to. This
// is the shape to reach for once an app has both a person and an account
// worth targeting on independently; the Part 2 targeting rules in
// scripts/setup-launchdarkly.mjs match whichever kind actually owns the
// attribute (plan lives on the organization, betaTester on the user).
//
//   user:         key, name, betaTester: boolean, region
//   organization: key, name, plan: "free" | "pro" | "enterprise"
//
// `name` is marked a private attribute on both kinds: sent to LaunchDarkly
// for evaluation, but not indexed/stored, a reasonable default for
// anything that reads as PII in a demo.

import { randomBytes } from 'node:crypto';

export const DEMO_CONTEXTS = [
  {
    key: 'demo-ana',
    label: 'Ana (enterprise, us-west, beta)',
    name: 'Ana Rodriguez',
    betaTester: true,
    region: 'us-west',
    orgKey: 'org-globex',
    company: 'Globex Logistics',
    plan: 'enterprise',
  },
  {
    key: 'demo-ben',
    label: 'Ben (free, eu)',
    name: 'Ben Okafor',
    betaTester: false,
    region: 'eu',
    orgKey: 'org-initech',
    company: 'Initech Supplies',
    plan: 'free',
  },
  {
    key: 'demo-chen',
    label: 'Chen (pro, us-east, beta)',
    name: 'Chen Wu',
    betaTester: true,
    region: 'us-east',
    orgKey: 'org-umbrella',
    company: 'Umbrella Retail',
    plan: 'pro',
  },
  {
    key: 'demo-dana',
    label: 'Dana (enterprise, eu)',
    name: 'Dana Whitfield',
    betaTester: false,
    region: 'eu',
    orgKey: 'org-soylent',
    company: 'Soylent Foods',
    plan: 'enterprise',
  },
  {
    // This is the individually targeted user set up by setup-launchdarkly.mjs
    // (an "individual target" on landing-hero-redesign -> "redesign"), on
    // purpose a free/non-beta user at a free-plan organization, who would
    // otherwise fall through to "control". Demonstrates individual
    // targeting beating the rule-based fallthrough. Individual targets are
    // scoped to a context kind, so this one still targets demo-eli's user
    // key directly, unchanged by the move to a multi-context.
    key: 'demo-eli',
    label: 'Eli (free, us-west, individually targeted)',
    name: 'Eli Stern',
    betaTester: false,
    region: 'us-west',
    orgKey: 'org-hooli',
    company: 'Hooli Freight',
    plan: 'free',
  },
];

// The sixth preset: "New visitor". Unlike the five above, it is not a fixed
// row in DEMO_CONTEXTS, its user key is generated fresh (see
// generateVisitorKey() below), once per page load, so it is never one of
// the demo- keys and always falls through the "key starts with demo-" rule
// into the default rule, where the experiment (scripts/setup-experiment.mjs)
// actually runs.
export const NEW_VISITOR_LABEL = 'New visitor (enters the experiment)';
export const VISITOR_ORG_KEY = 'org-visitor';
export const VISITOR_ORG_NAME = 'New Visitor Co';
export const VISITOR_PLAN = 'free';

// Matches exactly what generateVisitorKey() produces: "visitor-" plus 8
// lowercase hex characters. The server validates an incoming visitor key
// against this before building a context from it (see server/index.mjs),
// so a request can't smuggle an arbitrary key through the visitor path.
export const VISITOR_KEY_PATTERN = /^visitor-[0-9a-f]{8}$/;

export function isVisitorKey(key) {
  return typeof key === 'string' && VISITOR_KEY_PATTERN.test(key);
}

// 8 random hex characters from Node's crypto. src/client.mjs generates its
// own key with the Web Crypto API instead of importing this server-only
// module, but produces the identical "visitor-XXXXXXXX" shape
// VISITOR_KEY_PATTERN expects.
export function generateVisitorKey() {
  return `visitor-${randomBytes(4).toString('hex')}`;
}

export function findDemoContext(key) {
  return DEMO_CONTEXTS.find((c) => c.key === key);
}

/**
 * Builds an LD multi-context (the shape the SDKs expect) from one of the
 * preset demo users above: a "user" kind for the person, an "organization"
 * kind for the account they belong to.
 */
export function toLdContext(preset) {
  return {
    kind: 'multi',
    user: {
      key: preset.key,
      name: preset.name,
      betaTester: preset.betaTester,
      region: preset.region,
      _meta: { privateAttributes: ['name'] },
    },
    organization: {
      key: preset.orgKey,
      name: preset.company,
      plan: preset.plan,
      _meta: { privateAttributes: ['name'] },
    },
  };
}

/**
 * Builds the multi-context for the "New visitor" preset from a visitor key
 * (validate with isVisitorKey() first). Always org-visitor / free /
 * non-beta, so it never matches the enterprise or betaTester rules and
 * reaches the default rule where the experiment runs.
 */
export function toVisitorLdContext(visitorKey) {
  return {
    kind: 'multi',
    user: {
      key: visitorKey,
      name: 'New visitor',
      betaTester: false,
      _meta: { privateAttributes: ['name'] },
    },
    organization: {
      key: VISITOR_ORG_KEY,
      name: VISITOR_ORG_NAME,
      plan: VISITOR_PLAN,
      _meta: { privateAttributes: ['name'] },
    },
  };
}

/**
 * Resolves any key the browser might send (a fixed demo- key or a
 * generated visitor- key) to its LD multi-context, or undefined if it is
 * neither. The one place server/index.mjs needs to check before trusting a
 * `user` value out of a request.
 */
export function resolveLdContext(key) {
  const preset = findDemoContext(key);
  if (preset) return toLdContext(preset);
  if (isVisitorKey(key)) return toVisitorLdContext(key);
  return undefined;
}
