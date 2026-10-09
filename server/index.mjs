// server/index.mjs
//
// ABC Company demo server. Serves the static landing page and bundle, a
// small JSON API that evaluates flags server-side (demonstrating the
// LaunchDarkly Node server SDK), a /config.js endpoint that hands the
// browser its LaunchDarkly client-side ID at runtime (never hard-coded in
// the bundle), /api/chat + /api/chat/feedback for the AI Configs extra
// credit (see server/aiChat.mjs), /api/checkout + /api/demo/regression for
// the guarded rollout extra credit (see server/checkout.mjs), and
// /healthz for basic liveness checks.
//
// Run with: npm start  (builds the client bundle first, then starts this)

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { createLdClient, FLAG_RELEASE_BANNER, FLAG_HERO_REDESIGN } from './ldClient.mjs';
import { DEMO_CONTEXTS, toLdContext, resolveLdContext } from './contexts.mjs';
import { createSupportChat } from './aiChat.mjs';
import { createCheckout } from './checkout.mjs';

// `npm start`/`npm run dev` already load .env via `node --env-file-if-exists`
// (see package.json). This is a fallback for running `node server/index.mjs`
// directly on a Node version where that flag is unavailable: `loadEnvFile`
// does the same thing from inside the process. It is a no-op if the method
// doesn't exist or .env is missing, so the server still starts (env vars
// just have to be set another way, for example by the shell).
try {
  process.loadEnvFile?.();
} catch {
  // .env is missing or unreadable; fall through to whatever is already in
  // process.env.
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;

// Chat abuse limits (no new dependency): a small in-memory limiter, applied
// as Express middleware in front of POST /api/chat only. Two separate
// limits, because they protect against two different things:
//   - per-IP request rate: a visitor hammering the endpoint.
//   - total concurrency: several visitors at once each triggering a slow
//     model call, which would otherwise pile up unbounded.
// Exported as a factory (rather than wired up as a closure inline) so
// test/chatLimiter.test.mjs can exercise it directly against fake
// req/res objects, with no Express app and no network calls.
export function createChatRequestLimiter({ windowMs = 60_000, maxPerWindow = 10, maxConcurrent = 2 } = {}) {
  const hitsByIp = new Map();
  let inFlight = 0;

  function recentHits(ip, now) {
    const hits = (hitsByIp.get(ip) ?? []).filter((t) => now - t < windowMs);
    hitsByIp.set(ip, hits);
    return hits;
  }

  return function chatRequestLimiter(req, res, next) {
    const now = Date.now();
    const ip = req.ip ?? 'unknown';
    const hits = recentHits(ip, now);

    if (hits.length >= maxPerWindow) {
      res.status(429).json({ error: 'Too many chat requests from this address. Try again in a minute.' });
      return;
    }
    if (inFlight >= maxConcurrent) {
      res.status(429).json({ error: 'Support chat is busy. Try again shortly.' });
      return;
    }

    hits.push(now);
    inFlight += 1;
    // A request can end by finishing normally or by the connection closing
    // early; either way the concurrency slot must be released exactly
    // once, so both are wired to the same guarded release.
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      inFlight -= 1;
    };
    res.on('finish', release);
    res.on('close', release);
    next();
  };
}

// Extra credit: guarded rollout. Whether the NEW checkout variation should
// fail some fraction of the time, read by server/checkout.mjs on every
// request rather than once at boot, so flipping it mid-demo (via the
// protected toggle route below) takes effect on the very next checkout.
// Starts from CHECKOUT_REGRESSION=on in the environment, so a demo can also
// be scripted entirely from .env with no API call at all. Module-level
// state (not per-request) on purpose: the regression is a property of "is
// the new release currently misbehaving," shared by every visitor, not of
// any one request.
let checkoutRegressionOn = process.env.CHECKOUT_REGRESSION === 'on';

async function main() {
  const app = express();

  // The server-side SDK key is read once, here, by createLdClient(). See
  // server/ldClient.mjs for the comment on where LD_SDK_KEY comes from.
  const ldClient = await createLdClient();
  const supportChat = createSupportChat({ ldClient });
  const checkout = createCheckout({ ldClient, isRegressionOn: () => checkoutRegressionOn });
  const chatRequestLimiter = createChatRequestLimiter();
  // Checkout events feed the guarded rollout's metric, so they are rate
  // limited too: an open endpoint could otherwise flood the metric. (A real
  // checkout would record the outcome from trusted server state, not from a
  // request a browser can repeat.)
  const checkoutRequestLimiter = createChatRequestLimiter({ maxPerWindow: 30, maxConcurrent: 5 });

  app.use(express.static(PUBLIC_DIR));
  // Small limit: chat messages are capped at 500 chars (validated below),
  // there is no reason this app should ever accept a large JSON body.
  app.use(express.json({ limit: '10kb' }));

  // Escapes a value for embedding inside an inline <script>: JSON.stringify
  // it, then neutralize "<" so nothing in the data (for example a "</script>"
  // substring) can break out of the script tag.
  const toInlineScript = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

  // /config.js: the ONLY place the browser learns the LaunchDarkly
  // client-side ID. It is read from the server's environment
  // (LD_CLIENT_SIDE_ID) and injected at request time, so the ID never
  // needs to be baked into the committed bundle. To point the page at a
  // different environment, update LD_CLIENT_SIDE_ID (and LD_SDK_KEY) in
  // .env and restart the server, nothing to rebuild.
  //
  // It also emits window.__LD_BOOTSTRAP__: the flag state for the first
  // preset demo context, computed server-side with the already-initialized
  // server SDK client. src/client.mjs passes this to client.start() so the
  // page can render the right banner/hero on the very first paint instead
  // of a default value that flips once the browser SDK connects.
  app.get('/config.js', async (req, res) => {
    const clientSideId = process.env.LD_CLIENT_SIDE_ID ?? '';

    // allFlagsState() never throws for a normal evaluation, but guard it
    // anyway: if the LD client never finished initializing (see
    // server/ldClient.mjs's graceful degradation), this must still produce
    // valid JS, just with an empty bootstrap, rather than take the page down.
    let bootstrap = {};
    try {
      const context = toLdContext(DEMO_CONTEXTS[0]);
      const state = await ldClient.allFlagsState(context, { clientSideOnly: true });
      bootstrap = state.toJSON();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('Could not compute bootstrap flag state for /config.js:', err.message);
    }

    if (!clientSideId) {
      // Fail visibly in the browser console rather than silently running
      // with an empty ID (which the LD SDK would reject at init time).
      res.type('application/javascript').send(
        `console.error('LD_CLIENT_SIDE_ID is not set on the server. Copy .env.example to .env and fill it in.');\n` +
          `window.__LD_CLIENT_SIDE_ID__ = '';\n` +
          `window.__DEMO_CONTEXTS__ = ${toInlineScript(DEMO_CONTEXTS)};\n` +
          `window.__LD_BOOTSTRAP__ = ${toInlineScript(bootstrap)};\n`,
      );
      return;
    }
    res.type('application/javascript').send(
      `window.__LD_CLIENT_SIDE_ID__ = ${toInlineScript(clientSideId)};\n` +
        `window.__DEMO_CONTEXTS__ = ${toInlineScript(DEMO_CONTEXTS)};\n` +
        `window.__LD_BOOTSTRAP__ = ${toInlineScript(bootstrap)};\n`,
    );
  });

  // GET /api/flags?user=<preset-key | visitor key>
  // Evaluates both demo flags server-side for the given context, using the
  // Node server SDK. This is here purely to demonstrate the server SDK in
  // the same app that showcases the browser SDK; the page's live UI relies
  // on the browser SDK's own evaluations. resolveLdContext() accepts both
  // a fixed demo- preset key and a generated visitor- key (see
  // server/contexts.mjs), falling back to the first demo preset for an
  // unrecognized or missing key.
  app.get('/api/flags', async (req, res) => {
    const context = resolveLdContext(req.query.user) ?? toLdContext(DEMO_CONTEXTS[0]);

    const [releaseBanner, heroRedesign] = await Promise.all([
      ldClient.variation(FLAG_RELEASE_BANNER, context, false),
      ldClient.variation(FLAG_HERO_REDESIGN, context, 'control'),
    ]);

    res.json({
      context,
      flags: {
        [FLAG_RELEASE_BANNER]: releaseBanner,
        [FLAG_HERO_REDESIGN]: heroRedesign,
      },
    });
  });

  // POST /api/chat {user, message}
  // Extra credit: AI Configs. `user` must be one of the preset demo keys
  // or a generated visitor key (same contexts the rest of the demo uses,
  // see server/contexts.mjs), `message` is the visitor's chat line, capped
  // at 500 characters the way a real support widget would cap it. The
  // reply, model, and variation come from server/aiChat.mjs, which
  // resolves the "support-chat" AI Config server-side, the browser never
  // talks to LaunchDarkly or the model provider directly.
  //
  // chatRequestLimiter runs first: 10 requests per minute per IP, and at
  // most 2 model calls in flight at once, both as a 429 with no model
  // call made (see createChatRequestLimiter() above).
  app.post('/api/chat', chatRequestLimiter, async (req, res) => {
    const { user, message } = req.body ?? {};

    const context = resolveLdContext(user);
    if (!context) {
      res.status(400).json({ error: 'user must be a preset demo context key or a valid visitor key' });
      return;
    }
    if (typeof message !== 'string' || message.length < 1 || message.length > 500) {
      res.status(400).json({ error: 'message must be a string between 1 and 500 characters' });
      return;
    }

    const result = await supportChat.reply(context, message);
    res.json(result);
  });

  // POST /api/chat/feedback {token, positive, user}
  // Records a thumbs up/down against a previous /api/chat reply. `token`
  // is the `resumptionToken` that reply returned, which lets
  // server/aiChat.mjs rebuild the same tracker and attach the feedback to
  // the original run instead of starting a new, disconnected one. `user`
  // is the same preset demo key /api/chat was called with, so the feedback
  // event is attributed to the actual visitor's context (validated against
  // the known presets, same as /api/chat) instead of an anonymous one.
  app.post('/api/chat/feedback', (req, res) => {
    const { token, positive, user } = req.body ?? {};
    if (typeof token !== 'string' || !token) {
      res.status(400).json({ error: 'token is required' });
      return;
    }
    if (typeof positive !== 'boolean') {
      res.status(400).json({ error: 'positive must be a boolean' });
      return;
    }

    const context = resolveLdContext(user);
    if (!context) {
      res.status(400).json({ error: 'user must be a preset demo context key or a valid visitor key' });
      return;
    }

    supportChat.feedback(token, positive, context);
    res.json({ ok: true });
  });

  // POST /api/checkout {user}
  // Extra credit: guarded rollout. This is the signal the guarded rollout
  // watches. Only the NEW banner (flag on) shows the "Check out now"
  // button that calls this; the old banner has none, matching the brief.
  // The server evaluates release-new-checkout-banner for this context
  // (see server/checkout.mjs), simulates a checkout, and tracks
  // checkout-completed or checkout-error accordingly. The browser never
  // decides success or failure itself, so the demo stays honest about
  // what LaunchDarkly is actually measuring.
  app.post('/api/checkout', checkoutRequestLimiter, async (req, res) => {
    const { user } = req.body ?? {};
    const context = resolveLdContext(user);
    if (!context) {
      res.status(400).json({ error: 'user must be a preset demo context key or a valid visitor key' });
      return;
    }

    const result = await checkout(context);
    res.json(result);
  });

  // POST /api/demo/regression {on: true|false}
  // A presenter-only switch for the checkout regression used in the
  // guarded rollout demo, as an alternative to restarting the server with
  // CHECKOUT_REGRESSION=on. Protected behind DEMO_CONTROLS=on in the
  // environment so this route is inert (404) unless the operator has
  // deliberately opted in, and even then it only answers requests from the
  // machine the server runs on (curl on the presenter's laptop), never a
  // page visitor.
  app.post('/api/demo/regression', (req, res) => {
    const fromLocalhost = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    if (process.env.DEMO_CONTROLS !== 'on' || !fromLocalhost) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const { on } = req.body ?? {};
    if (typeof on !== 'boolean') {
      res.status(400).json({ error: 'on must be a boolean' });
      return;
    }
    checkoutRegressionOn = on;
    res.json({ ok: true, regressionOn: checkoutRegressionOn });
  });

  app.get('/healthz', (req, res) => {
    res.json({ status: 'ok', ldInitialized: ldClient.initialized() });
  });

  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`ABC Company demo app listening on http://localhost:${PORT}`);
  });

  // Close the LD client cleanly on shutdown: flush any buffered analytics
  // events (flag evaluations, AI Config tracker events) so the last few
  // seconds of activity aren't lost, then close the streaming connection.
  const shutdown = async () => {
    await ldClient.flush();
    await ldClient.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Only boot the server when this file is run directly (`node server/index.mjs`,
// which is what `npm start`/`npm run dev` do). test/chatLimiter.test.mjs
// imports createChatRequestLimiter from this module without wanting a
// server, an LD client, or a listening port as a side effect of that import.
const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}
