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
//      live re-targeting requirement). Six presets: the five fixed demo
//      users plus "New visitor", a freshly generated context that is not a
//      demo- key and so falls into the experiment.
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
//   @launchdarkly/js-client-sdk-common: LDEmitter.on(name, listener) - the
//     EventName union includes 'change', `change:${flagKey}`,
//     'dataSourceStatus', 'error', 'initialized', 'ready' (see
//     node_modules/@launchdarkly/js-client-sdk-common/dist/esm/LDEmitter.d.ts).
//     'dataSourceStatus' emits a DataSourceStatus object with
//     state: 'INITIALIZING' | 'VALID' | 'INTERRUPTED' | 'SET_OFFLINE' | 'CLOSED'
//     (DataSourceStatus.d.ts in the same package) - this is the mechanism
//     used below to know when the stream is actually live, independent of
//     whether start() has resolved.

import { createClient } from '@launchdarkly/js-client-sdk';

const FLAG_RELEASE_BANNER = 'release-new-checkout-banner';
const FLAG_HERO_REDESIGN = 'landing-hero-redesign';

const demoContexts = window.__DEMO_CONTEXTS__ ?? [];
const clientSideId = window.__LD_CLIENT_SIDE_ID__ ?? '';

// The sixth preset. Generated once per page load (a fresh key on every
// reload), never a demo- key, so it always falls through the "key starts
// with demo-" rule into the default rule where the experiment runs. Server
// counterpart: server/contexts.mjs's generateVisitorKey()/VISITOR_KEY_PATTERN;
// duplicated here in the Web Crypto form because this file cannot import a
// server-only module, but it produces the identical "visitor-XXXXXXXX" shape.
function generateVisitorKey() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `visitor-${hex}`;
}

const visitorPreset = {
  key: generateVisitorKey(),
  label: 'New visitor (enters the experiment)',
  name: 'New visitor',
  betaTester: false,
  orgKey: 'org-visitor',
  company: 'New Visitor Co',
  plan: 'free',
};

// Builds the same multi-context shape server/contexts.mjs's toLdContext()/
// toVisitorLdContext() build: a "user" kind for the person, an
// "organization" kind for the account. region is only present on the fixed
// demo presets (server/contexts.mjs never sets one for the visitor), so it
// is added to the user kind only when the preset actually has one.
function presetToLdContext(preset) {
  const user = {
    key: preset.key,
    name: preset.name,
    betaTester: preset.betaTester,
    _meta: { privateAttributes: ['name'] },
  };
  if (preset.region) {
    user.region = preset.region;
  }
  return {
    kind: 'multi',
    user,
    organization: {
      key: preset.orgKey,
      name: preset.company,
      plan: preset.plan,
      _meta: { privateAttributes: ['name'] },
    },
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

// Extra credit: guarded rollout. Only the NEW banner carries a checkout
// button; the old banner has none, matching the brief exactly, and its
// checkouts are only ever simulated by scripts/simulate-checkout.mjs, not
// by anything in this browser code. Clicking calls POST /api/checkout,
// which evaluates release-new-checkout-banner server-side (the same flag
// this banner itself is driven by) and reports success or failure; the
// browser never decides the outcome, it only shows what the server said.
function renderBanner(isOn) {
  if (isOn) {
    // The new "Fall Launch" checkout banner (Part 1: the new feature
    // behind release-new-checkout-banner).
    bannerSlot.innerHTML = `
      <div class="banner banner-new">
        <strong>Fall Launch:</strong> Checkout just got faster. Save your cart
        across devices and check out in one click. <em>(new banner, flag ON)</em>
        <button type="button" id="checkout-button" class="checkout-button">Check out now</button>
        <span id="checkout-result" class="checkout-result"></span>
      </div>`;
  } else {
    bannerSlot.innerHTML = `
      <div class="banner banner-old">
        Thanks for shopping with ABC Company. <em>(old banner, flag OFF)</em>
      </div>`;
  }
}

// Wired up fresh every time renderBanner() puts the button back in the
// DOM (a change:release-new-checkout-banner event, or a context switch,
// both call renderBanner() again), since innerHTML replacement drops any
// previous listener along with the old button element.
function wireCheckoutButton(presetKeyGetter) {
  const button = document.getElementById('checkout-button');
  const resultEl = document.getElementById('checkout-result');
  if (!button) return;

  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Checking out...';
    resultEl.textContent = '';
    resultEl.className = 'checkout-result';

    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: presetKeyGetter() }),
      });
      const data = await res.json();

      if (!res.ok) {
        resultEl.textContent = data.error ?? 'Checkout failed.';
        resultEl.classList.add('checkout-error');
      } else if (data.ok) {
        resultEl.textContent = 'Checkout complete.';
        resultEl.classList.add('checkout-ok');
      } else {
        resultEl.textContent = 'Checkout failed. Please try again.';
        resultEl.classList.add('checkout-error');
      }
    } catch (err) {
      resultEl.textContent = `Could not reach the server: ${err.message}`;
      resultEl.classList.add('checkout-error');
    } finally {
      button.disabled = false;
      button.textContent = 'Check out now';
    }
  });
}

function renderHero(variation) {
  if (variation === 'redesign') {
    heroSlot.innerHTML = `
      <section class="hero hero-redesign">
        <h1>Built for teams that move fast.</h1>
        <p>The redesigned ABC Company hero (redesign variation).</p>
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

  // Populate the context switcher with the five preset demo users plus the
  // sixth "New visitor" preset (generated client-side, never sent by the
  // server since its key only exists for this page load).
  const allPresets = [...demoContexts, visitorPreset];
  contextSelect.innerHTML = allPresets.map((c) => `<option value="${c.key}">${c.label}</option>`).join('');

  const initialPreset = demoContexts[0];
  const initialContext = presetToLdContext(initialPreset);

  // createClient(clientSideId, context, options), see file header comment.
  const client = createClient(clientSideId, initialContext, {
    // Streaming keeps a live connection open to LaunchDarkly, which is what
    // makes the change listeners below fire within a second of a toggle.
    streaming: true,
  });

  let currentContext = initialContext;
  // Tracks which preset the chat panel and the CTA messaging should use,
  // kept in step with the context switcher below.
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

  // renderBanner() replaces bannerSlot's innerHTML, which drops the
  // checkout button's listener along with the old element, so every call
  // site that re-renders the banner re-wires the button through this
  // wrapper instead of calling renderBanner() directly. presetKeyGetter is
  // a function, not the key itself, because by the time someone clicks
  // the button currentPresetKey may have moved on to a different preset.
  function renderBannerWithCheckout(isOn) {
    renderBanner(isOn);
    if (isOn) {
      wireCheckoutButton(() => currentPresetKey);
    }
  }

  // ---- Attach every client.on(...) listener BEFORE calling client.start() ----
  // In js-client-sdk 4.x the client does not connect until start() is
  // called. Registering listeners first, rather than after kicking off
  // start(), means nothing the connection does on its way up can be missed
  // by a listener that was attached a tick too late.

  // Part 1: live listener, no reload. client.on('change:<flagKey>', listener)
  // fires whenever the flag's value changes for the currently identified
  // context, whether that's because someone toggled it in LaunchDarkly, a
  // trigger fired, or a targeting rule now matches differently after
  // identify(). This is what lets a release/rollback or a remediation
  // trigger update the page instantly.
  //
  // In js-client-sdk 4.x the 'change:<flagKey>' event passes only the
  // context, not the new value, so each listener reads the fresh value
  // back with client.variation().
  client.on(`change:${FLAG_RELEASE_BANNER}`, () => {
    renderBannerWithCheckout(client.variation(FLAG_RELEASE_BANNER, false));
    refreshUnderTheHoodPanel(currentContext);
  });

  client.on(`change:${FLAG_HERO_REDESIGN}`, () => {
    renderHero(client.variation(FLAG_HERO_REDESIGN, 'control'));
    refreshUnderTheHoodPanel(currentContext);
  });

  // 'dataSourceStatus' tells us when the stream is actually live,
  // independent of start()'s own promise. With a bootstrap, start() can
  // resolve 'complete' before the streaming connection has finished
  // negotiating (the bootstrap satisfies start() immediately; the
  // connection itself takes a moment longer), so the "Live: streaming"
  // status line below is driven by this event, not by start() resolving.
  client.on('dataSourceStatus', (status) => {
    if (status.state === 'VALID') {
      connectionStatusEl.textContent = 'Live: streaming from LaunchDarkly.';
      connectionStatusEl.classList.remove('status-error');
    } else if (status.state === 'INTERRUPTED' || status.state === 'CLOSED') {
      connectionStatusEl.textContent =
        `LaunchDarkly connection ${status.state.toLowerCase()}. Showing the last known flag values.`;
      connectionStatusEl.classList.add('status-error');
    }
  });

  // No flicker on load: window.__LD_BOOTSTRAP__ (injected by /config.js) is
  // the flag state the server already evaluated for this same initial
  // context, passed here as the `bootstrap` start option. The SDK applies
  // it synchronously, so the variation() calls right below already reflect
  // it, before the connection to LaunchDarkly (and the promise below) has
  // resolved.
  const startPromise = client.start({ timeout: 5, bootstrap: window.__LD_BOOTSTRAP__ });

  renderBannerWithCheckout(client.variation(FLAG_RELEASE_BANNER, false));
  renderHero(client.variation(FLAG_HERO_REDESIGN, 'control'));
  refreshUnderTheHoodPanel(initialContext);
  // This is the bootstrap value, not yet the live stream: say so, and let
  // the 'dataSourceStatus' listener above upgrade the message once the
  // connection actually goes VALID.
  connectionStatusEl.textContent = 'Loaded from server bootstrap.';

  const init = await startPromise;
  if (init.status !== 'complete') {
    // start() resolves {status: 'complete' | 'failed' | 'timeout'} and
    // never throws; a non-'complete' status is the one case
    // 'dataSourceStatus' won't resolve on its own, so it is reported here.
    connectionStatusEl.textContent =
      `Could not reach LaunchDarkly (${init.status}). Check LD_CLIENT_SIDE_ID and network; ` +
      'the page is showing default flag values.';
    connectionStatusEl.classList.add('status-error');
  }

  // Re-render once start() settles: if the bootstrap above was empty (no
  // LD client on the server yet) or stale, this picks up whatever the SDK
  // resolved once connected.
  renderBannerWithCheckout(client.variation(FLAG_RELEASE_BANNER, false));
  renderHero(client.variation(FLAG_HERO_REDESIGN, 'control'));
  refreshUnderTheHoodPanel(initialContext);

  // Flush buffered events (flag evaluations, hero-cta-click, AI Config
  // tracker events) before the tab is torn down. 'pagehide' fires on
  // navigation, tab close and backgrounding on mobile, where 'unload' is
  // unreliable; client.flush() here is fire-and-forget, there is no later
  // point in the page lifecycle to await it from.
  window.addEventListener('pagehide', () => {
    client.flush();
  });

  // ---- Extra credit: Experimentation ------------------------------------
  // The hero's call-to-action is the experiment's conversion metric.
  // track() sends a custom event under the current context; LaunchDarkly
  // joins it to the variation that context was served, which is what the
  // experiment measures. The event key must match the metric created by
  // scripts/setup-experiment.mjs ("hero-cta-click"). The experiment only
  // runs on the flag's default rule (see scripts/setup-experiment.mjs), so
  // a demo- user's click is still tracked for the demo, but is never part
  // of the experiment's measured traffic, the message below says so.
  heroSlot.addEventListener('click', async (ev) => {
    const button = ev.target.closest('[data-cta="hero"]');
    if (!button) return;

    client.track('hero-cta-click');
    button.disabled = true;
    button.textContent = 'Sending...';
    // Only report the click as sent once flush() has actually resolved,
    // not the instant track() is called (track() only buffers the event).
    await client.flush();
    button.textContent = currentPresetKey.startsWith('demo-')
      ? 'Tracked (demo users are not in the experiment)'
      : 'Conversion sent';
  });

  // ---- Part 2: context switcher calls identify() ------------------------
  // Switching the preset user calls identify() with the new context. The
  // SDK re-evaluates both flags for that context and the 'change:*'
  // listeners above fire if either value differs, so targeting changes
  // (individual target or rule match) are reflected live, no reload.
  contextSelect.addEventListener('change', async (ev) => {
    const preset = allPresets.find((c) => c.key === ev.target.value);
    if (!preset) return;
    const nextContext = presetToLdContext(preset);
    currentContext = nextContext;
    currentPresetKey = preset.key;
    await client.identify(nextContext);
    refreshUnderTheHoodPanel(nextContext);
    // Also re-render directly in case the values didn't change (no
    // 'change' event would fire), so the UI always reflects the active
    // context even when both presets happen to get the same variation.
    renderBannerWithCheckout(client.variation(FLAG_RELEASE_BANNER, false));
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
