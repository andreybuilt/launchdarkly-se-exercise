// server/index.mjs
//
// ABC Company demo server. Serves the static landing page and bundle, a
// small JSON API that evaluates flags server-side (demonstrating the
// LaunchDarkly Node server SDK), a /config.js endpoint that hands the
// browser its LaunchDarkly client-side ID at runtime (never hard-coded in
// the bundle), /api/chat + /api/chat/feedback for the AI Configs extra
// credit (see server/aiChat.mjs), and /healthz for basic liveness checks.
//
// Run with: npm start  (builds the client bundle first, then starts this)

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { createLdClient, FLAG_RELEASE_BANNER, FLAG_HERO_REDESIGN } from './ldClient.mjs';
import { DEMO_CONTEXTS, findDemoContext, toLdContext } from './contexts.mjs';
import { createSupportChat } from './aiChat.mjs';

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

async function main() {
  const app = express();

  // The server-side SDK key is read once, here, by createLdClient(). See
  // server/ldClient.mjs for the comment on where LD_SDK_KEY comes from.
  const ldClient = await createLdClient();
  const supportChat = createSupportChat({ ldClient });

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

  // GET /api/flags?user=<preset-key>
  // Evaluates both demo flags server-side for the given preset context,
  // using the Node server SDK. This is here purely to demonstrate the
  // server SDK in the same app that showcases the browser SDK; the page's
  // live UI relies on the browser SDK's own evaluations.
  app.get('/api/flags', async (req, res) => {
    const presetKey = req.query.user;
    const preset = findDemoContext(presetKey) ?? DEMO_CONTEXTS[0];
    const context = toLdContext(preset);

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
  // Extra credit: AI Configs. `user` must be one of the five preset demo
  // keys (same contexts the rest of the demo uses, see
  // server/contexts.mjs), `message` is the visitor's chat line, capped at
  // 500 characters the way a real support widget would cap it. The reply,
  // model, and variation come from server/aiChat.mjs, which resolves the
  // "support-chat" AI Config server-side, the browser never talks to
  // LaunchDarkly or the model provider directly.
  app.post('/api/chat', async (req, res) => {
    const { user, message } = req.body ?? {};

    const preset = findDemoContext(user);
    if (!preset) {
      res.status(400).json({ error: 'user must be one of the preset demo context keys' });
      return;
    }
    if (typeof message !== 'string' || message.length < 1 || message.length > 500) {
      res.status(400).json({ error: 'message must be a string between 1 and 500 characters' });
      return;
    }

    const context = toLdContext(preset);
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

    const preset = findDemoContext(user);
    if (!preset) {
      res.status(400).json({ error: 'user must be one of the preset demo context keys' });
      return;
    }

    supportChat.feedback(token, positive, toLdContext(preset));
    res.json({ ok: true });
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

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start server:', err);
  process.exit(1);
});
