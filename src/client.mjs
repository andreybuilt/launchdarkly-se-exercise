// src/client.mjs
//
// Browser entry point, bundled by esbuild into public/bundle.js (see
// scripts/build-client.mjs). This is the ONLY place the LaunchDarkly
// js-client-sdk is used. It:
//
//   1. Reads the LaunchDarkly client-side ID from window.__LD_CLIENT_SIDE_ID__,
//      which the server injected via /config.js (never hard-coded here).
//   2. Creates the LD browser client for the first demo context.
//   3. Subscribes to live flag changes for both demo flags with
//      client.on('change:<flagKey>', ...) so the UI updates instantly with
//      no page reload (Part 1's "listener" requirement).
//   4. Wires up the context switcher panel, calling client.identify(...)
//      whenever the presenter picks a different preset user (Part 2's
//      live re-targeting requirement).
//   5. Extra credit: AI Configs. Wires up the support chat panel, a plain
//      fetch to the server's /api/chat and /api/chat/feedback (no
//      LaunchDarkly keys reach the browser for this, see server/aiChat.mjs).
//   6. Passes window.__LD_BOOTSTRAP__ (also injected by /config.js) to
//      client.start(), so the very first render uses the server's own flag
//      evaluation instead of a hard-coded default while the browser SDK
//      connects.
//
// SDK surface used here (see the installed packages for the full API):
//   @launchdarkly/js-client-sdk: createClient(clientSideId, pristineContext, options?)
//   @launchdarkly/js-client-sdk-common: LDEmitter.on(name, listener),
//     LDClientImpl.identify(pristineContext, identifyOptions?)

import { createClient } from '@launchdarkly/js-client-sdk';

const FLAG_RELEASE_BANNER = 'release-new-checkout-banner';
const FLAG_HERO_REDESIGN = 'landing-hero-redesign';

const demoContexts = window.__DEMO_CONTEXTS__ ?? [];
const clientSideId = window.__LD_CLIENT_SIDE_ID__ ?? '';

function presetToLdContext(preset) {
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

// ---- DOM references -------------------------------------------------

const bannerSlot = document.getElementById('banner-slot');
const heroSlot = document.getElementById('hero-slot');
const contextSelect = document.getElementById('context-select');
const contextJsonEl = document.getElementById('context-json');
const flagsJsonEl = document.getElementById('flags-json');
const connectionStatusEl = document.getElementById('connection-status');
const chatLogEl = document.getElementById('chat-log');
const chatFormEl = document.getElementById('chat-form');
const chatInputEl = document.getElementById('chat-input');

// ---- Render helpers ---------------------------------------------------

function renderBanner(isOn) {
  if (isOn) {
    // The new "Fall Launch" checkout banner (Part 1: the new feature
    // behind release-new-checkout-banner).
    bannerSlot.innerHTML = `
      <div class="banner banner-new">
        <strong>Fall Launch:</strong> Checkout just got faster. Save your cart
        across devices and check out in one click. <em>(new banner, flag ON)</em>
      </div>`;
  } else {
    bannerSlot.innerHTML = `
      <div class="banner banner-old">
        Thanks for shopping with ABC Company. <em>(old banner, flag OFF)</em>
      </div>`;
  }
}

function renderHero(variation) {
  if (variation === 'redesign') {
    heroSlot.innerHTML = `
      <section class="hero hero-redesign">
        <h1>Built for teams that move fast.</h1>
        <p>The redesigned ABC Company hero, targeted to this context.</p>
        <button type="button" class="hero-cta" data-cta="hero">Start your free trial</button>
      </section>`;
  } else {
    heroSlot.innerHTML = `
      <section class="hero hero-control">
        <h1>Welcome to ABC Company.</h1>
        <p>The original hero section (control variation).</p>
        <button type="button" class="hero-cta" data-cta="hero">Get started</button>
      </section>`;
  }
}

function renderUnderTheHood(context, flags) {
  contextJsonEl.textContent = JSON.stringify(context, null, 2);
  flagsJsonEl.textContent = JSON.stringify(flags, null, 2);
}

// ---- Extra credit: AI Configs support chat -----------------------------
// Plain fetch to the server's /api/chat and /api/chat/feedback. No
// LaunchDarkly keys reach the browser for this panel, server/aiChat.mjs
// resolves the AI Config and calls the model provider entirely server-side.

function appendChatMessage({ role, text, meta }) {
  const el = document.createElement('div');
  el.className = `chat-message chat-message-${role}`;
  el.textContent = text;

  if (meta) {
    const metaEl = document.createElement('div');
    metaEl.className = 'chat-meta';
    metaEl.textContent = meta;
    el.appendChild(metaEl);
  }

  chatLogEl.appendChild(el);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
  return el;
}

// Thumbs up/down under an assistant reply. Clicking sends the reply's
// resumptionToken to /api/chat/feedback, which rebuilds the original
// tracker server-side (see server/aiChat.mjs) so the sentiment lands on
// the same run the reply came from, not a disconnected new one. `presetKey`
// is the same demo user the question was asked as, so the feedback event is
// attributed to that visitor's context rather than an anonymous one.
function appendFeedbackButtons(messageEl, resumptionToken, presetKey) {
  if (!resumptionToken) return;

  const wrap = document.createElement('div');
  wrap.className = 'chat-feedback';

  const up = document.createElement('button');
  up.type = 'button';
  up.textContent = '\u{1F44D}';
  const down = document.createElement('button');
  down.type = 'button';
  down.textContent = '\u{1F44E}';

  async function sendFeedback(positive, clicked, other) {
    clicked.classList.add('feedback-sent');
    clicked.disabled = true;
    other.disabled = true;
    try {
      await fetch('/api/chat/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: resumptionToken, positive, user: presetKey }),
      });
    } catch {
      // Best-effort: feedback is a nice-to-have for the demo, a failed
      // POST here shouldn't disrupt the chat itself.
    }
  }

  up.addEventListener('click', () => sendFeedback(true, up, down));
  down.addEventListener('click', () => sendFeedback(false, down, up));

  wrap.appendChild(up);
  wrap.appendChild(down);
  messageEl.appendChild(wrap);
}

async function sendChatMessage(presetKey, message) {
  appendChatMessage({ role: 'user', text: message });

  chatInputEl.disabled = true;
  chatFormEl.querySelector('button').disabled = true;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: presetKey, message }),
    });
    const data = await res.json();

    if (!res.ok) {
      appendChatMessage({ role: 'error', text: data.error ?? 'Something went wrong.' });
      return;
    }

    // The meta line is what lets a presenter see LaunchDarkly switching
    // the prompt/model live: which AI Config variation answered, which
    // model it called, and how long the call took.
    const meta = data.enabled
      ? `variation: ${data.variationKey ?? 'n/a'} · model: ${data.model ?? 'n/a'} · ${data.durationMs ?? 0} ms`
      : 'AI Config disabled';
    const messageEl = appendChatMessage({ role: 'assistant', text: data.reply, meta });
    appendFeedbackButtons(messageEl, data.resumptionToken, presetKey);
  } catch (err) {
    appendChatMessage({ role: 'error', text: `Could not reach the server: ${err.message}` });
  } finally {
    chatInputEl.disabled = false;
    chatFormEl.querySelector('button').disabled = false;
    chatInputEl.focus();
  }
}

// ---- Boot --------------------------------------------------------------

async function main() {
  if (!clientSideId) {
    connectionStatusEl.textContent =
      'LD_CLIENT_SIDE_ID is not configured on the server. See .env.example.';
    connectionStatusEl.classList.add('status-error');
    return;
  }

  // Populate the context switcher with the five preset demo users.
  contextSelect.innerHTML = demoContexts
    .map((c) => `<option value="${c.key}">${c.label}</option>`)
    .join('');

  const initialPreset = demoContexts[0];
  const initialContext = presetToLdContext(initialPreset);

  // createClient(clientSideId, context, options), see file header comment.
  const client = createClient(clientSideId, initialContext, {
    // Streaming keeps a live connection open to LaunchDarkly, which is what
    // makes the change listeners below fire within a second of a toggle.
    streaming: true,
  });

  let currentContext = initialContext;
  // Tracks which preset the chat panel should send with each message, kept
  // in step with the context switcher below.
  let currentPresetKey = initialPreset.key;
  const currentFlags = {
    [FLAG_RELEASE_BANNER]: false,
    [FLAG_HERO_REDESIGN]: 'control',
  };

  function refreshUnderTheHoodPanel(context) {
    currentFlags[FLAG_RELEASE_BANNER] = client.variation(FLAG_RELEASE_BANNER, false);
    currentFlags[FLAG_HERO_REDESIGN] = client.variation(FLAG_HERO_REDESIGN, 'control');
    renderUnderTheHood(context, currentFlags);
  }

  // In js-client-sdk 4.x the client does not connect until start() is called,
  // so listeners can be attached first. start() resolves to a status object
  // ('complete' | 'failed' | 'timeout'); it does not throw on failure.
  //
  // No flicker on load: window.__LD_BOOTSTRAP__ (injected by /config.js) is
  // the flag state the server already evaluated for this same initial
  // context, passed here as the `bootstrap` start option. The SDK applies it
  // synchronously, so the variation() calls right below already reflect it,
  // before the connection to LaunchDarkly (and the promise below) has
  // resolved. Without it, the first paint would show the hard-coded
  // defaults and then flip once streaming connects.
  const startPromise = client.start({ timeout: 5, bootstrap: window.__LD_BOOTSTRAP__ });

  renderBanner(client.variation(FLAG_RELEASE_BANNER, false));
  renderHero(client.variation(FLAG_HERO_REDESIGN, 'control'));
  refreshUnderTheHoodPanel(initialContext);

  const init = await startPromise;
  if (init.status === 'complete') {
    connectionStatusEl.textContent = 'Connected to LaunchDarkly (streaming).';
    connectionStatusEl.classList.remove('status-error');
  } else {
    connectionStatusEl.textContent =
      `Could not reach LaunchDarkly (${init.status}). Check LD_CLIENT_SIDE_ID and network; ` +
      'the page is showing default flag values.';
    connectionStatusEl.classList.add('status-error');
  }

  // Re-render once start() settles: if the bootstrap above was empty (no
  // LD client on the server yet) or stale, this picks up whatever the SDK
  // resolved once connected.
  renderBanner(client.variation(FLAG_RELEASE_BANNER, false));
  renderHero(client.variation(FLAG_HERO_REDESIGN, 'control'));
  refreshUnderTheHoodPanel(initialContext);

  // ---- Part 1: live listener, no reload --------------------------------
  // client.on('change:<flagKey>', listener) fires whenever the
  // flag's value changes for the currently identified context, whether
  // that's because someone toggled it in LaunchDarkly, a trigger fired,
  // or a targeting rule now matches differently after identify(). This is
  // what lets a release/rollback or a remediation trigger update the page
  // instantly.
  //
  // In js-client-sdk 4.x the 'change:<flagKey>' event passes only the context,
  // not the new value, so each listener reads the fresh value back with
  // client.variation().
  client.on(`change:${FLAG_RELEASE_BANNER}`, () => {
    renderBanner(client.variation(FLAG_RELEASE_BANNER, false));
    refreshUnderTheHoodPanel(currentContext);
  });

  client.on(`change:${FLAG_HERO_REDESIGN}`, () => {
    renderHero(client.variation(FLAG_HERO_REDESIGN, 'control'));
    refreshUnderTheHoodPanel(currentContext);
  });

  // ---- Extra credit: Experimentation ------------------------------------
  // The hero's call-to-action is the experiment's conversion metric. track()
  // sends a custom event under the current context; LaunchDarkly joins it to
  // the variation that context was served, which is what the experiment
  // measures. The event key must match the metric created by
  // scripts/setup-experiment.mjs ("hero-cta-click").
  heroSlot.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-cta="hero"]')) {
      client.track('hero-cta-click');
      ev.target.textContent = 'Thanks! (conversion tracked)';
    }
  });

  // ---- Part 2: context switcher calls identify() ------------------------
  // Switching the preset user calls identify() with the new context. The
  // SDK re-evaluates both flags for that context and the 'change:*'
  // listeners above fire if either value differs, so targeting changes
  // (individual target or rule match) are reflected live, no reload.
  contextSelect.addEventListener('change', async (ev) => {
    const preset = demoContexts.find((c) => c.key === ev.target.value);
    if (!preset) return;
    const nextContext = presetToLdContext(preset);
    currentContext = nextContext;
    currentPresetKey = preset.key;
    await client.identify(nextContext);
    refreshUnderTheHoodPanel(nextContext);
    // Also re-render directly in case the values didn't change (no
    // 'change' event would fire), so the UI always reflects the active
    // context even when both presets happen to get the same variation.
    renderBanner(client.variation(FLAG_RELEASE_BANNER, false));
    renderHero(client.variation(FLAG_HERO_REDESIGN, 'control'));
  });

  // ---- Extra credit: AI Configs support chat ----------------------------
  // Sends the currently selected preset user with every message, so the
  // AI Config resolves for that context (plan == enterprise gets a
  // different variation than a free-plan user, same targeting idea as
  // Part 2's hero, just applied to a prompt/model instead of a string flag).
  chatFormEl.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const message = chatInputEl.value.trim();
    if (!message) return;
    chatInputEl.value = '';
    sendChatMessage(currentPresetKey, message);
  });
}

main();
