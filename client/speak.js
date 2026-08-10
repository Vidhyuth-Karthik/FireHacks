/* ============================================================
   Whisper — speaker page.

   Consumes backend state over /ws and renders it onto the ring.
   Falls back to a local scripted agent if the socket never opens,
   so the demo is completable with no backend and no hardware.

   Contract (UI-SPEC.md §4.3):
     {"state":"options","items":[...],"highlight":0}
     {"state":"speak","text":"..."}
     {"state":"expanding"} | {"state":"confirm","text":...} | {"state":"idle"}

   `items` may be plain strings or {short, full} pairs. The ring shows
   the short label; the voice says the full sentence. That split IS the
   product: minimal input, complete speech.
   ============================================================ */

import { WS_URL, API_BASE_URL, FORCE_MOCK } from './config.js';
import { mountTargetCursor } from './target-cursor.js';
import { mountBackgroundVideo } from './background.js';
import { MicSession } from './mic.js';

/* ---- Geometry -------------------------------------------- */
/* Clockwise from top. A slot's position NEVER changes; each also owns
   a fixed semantic role so a user learns "up is always the urgent one". */
const SLOTS = [
  { dir: 'up', angle: -90, glyph: '↑', role: 'need' },
  { dir: 'up_right', angle: -45, glyph: '↗', role: 'food' },
  { dir: 'right', angle: 0, glyph: '→', role: 'comfort' },
  { dir: 'down_right', angle: 45, glyph: '↘', role: 'position' },
  { dir: 'down', angle: 90, glyph: '↓', role: 'pain' },
  { dir: 'down_left', angle: 135, glyph: '↙', role: 'people' },
  { dir: 'left', angle: 180, glyph: '←', role: 'environment' },
  { dir: 'up_left', angle: -135, glyph: '↖', role: 'closing' },
];

const DIR_INDEX = new Map(SLOTS.map((s, i) => [s.dir, i]));

/* ---- Elements -------------------------------------------- */
const els = {
  ring: document.querySelector('[data-ring]'),
  lens: document.querySelector('[data-lens]'),
  hub: document.querySelector('[data-hub]'),
  hubDir: document.querySelector('[data-hub-dir]'),
  hubState: document.querySelector('[data-hub-state]'),
  utterance: document.querySelector('[data-utterance]'),
  trace: document.querySelector('[data-trace]'),
  context: document.querySelector('[data-context]'),
  simBadge: document.querySelector('[data-sim-badge]'),
  voiceSelect: document.querySelector('[data-voice-select]'),
  voiceEnable: document.querySelector('[data-voice-enable]'),
  voiceLabel: document.querySelector('[data-voice-label]'),
  speakAgain: document.querySelector('[data-speak-again]'),
  regenerate: document.querySelector('[data-regenerate]'),
  micToggle: document.querySelector('[data-mic-toggle]'),
  micLabel: document.querySelector('[data-mic-label]'),
  stageHint: document.querySelector('[data-stage-hint]'),
};

/* ---- State ----------------------------------------------- */
const state = {
  items: [], // normalised {short, full}
  highlight: 0,
  lastSpoken: '',
  socket: null,
  source: 'starting', // what actually produced the options on screen
  mode: 'needs', // 'needs' while idle, 'reply' while the mic is listening
  replyTo: '', // the utterance the current reply wheel answers

  // `heard` is overheard room speech, transcribed live from the mic —
  // context for the reasoning model, distinct from `recent` (what the
  // ring itself has spoken) and `rejected` (what was just turned down).
  context: { name: 'Guest', partOfDay: partOfDay(), recent: [], heard: [], rejected: [] },
};

function partOfDay(d = new Date()) {
  const h = d.getHours();
  if (h < 11) return 'morning';
  if (h < 17) return 'afternoon';
  if (h < 21) return 'evening';
  return 'night';
}

/* Backend may send strings; normalise everything to {short, full}. */
function normaliseItem(item) {
  if (!item) return null;
  if (typeof item === 'string') return { short: item, full: item, intent: '' };
  return {
    short: item.short ?? item.text ?? '',
    full: item.full ?? item.text ?? item.short ?? '',
    intent: item.intent ?? '', // reply wheel only: yes/no/social/…
  };
}

/* The line above the ring. Says what the wheel is currently for. */
const STAGE_HINT_DEFAULT = 'Nudge to choose · press to speak';

function setStageHint(text) {
  if (!els.stageHint) return;
  els.stageHint.textContent = text || STAGE_HINT_DEFAULT;
  els.stageHint.dataset.reply = text ? 'true' : 'false';
}

/* ---- Status pills ---------------------------------------- */
function setPill(name, value) {
  const pill = document.querySelector(`[data-pill="${name}"]`);
  if (pill) pill.dataset.state = value;
}

/* ---- Trace ----------------------------------------------- */
function trace(message, kind = 'info') {
  if (!els.trace) return;
  const line = document.createElement('p');
  line.className = 'trace__line';
  line.dataset.kind = kind;

  const stamp = document.createElement('time');
  stamp.textContent = new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  line.append(stamp, document.createTextNode(message));
  els.trace.append(line);

  while (els.trace.childElementCount > 120) els.trace.firstElementChild.remove();
  els.trace.scrollTop = els.trace.scrollHeight;
}

/* ---- Context rail ---------------------------------------- */
function renderContext() {
  if (!els.context) return;
  const rows = [
    ['Speaking as', state.context.name],
    ['Time', state.context.partOfDay],
    ['Wheel', state.mode === 'reply' ? 'replies' : 'needs'],
    ['Source', state.source],
    ['Recent', state.context.recent.slice(-2).join(' · ') || '—'],
    ['Heard', state.context.heard.slice(-2).join(' · ') || '—'],
  ];

  els.context.innerHTML = '';
  for (const [key, val] of rows) {
    const row = document.createElement('div');
    row.className = 'context-row';
    row.innerHTML = `<span class="context-row__key"></span><span class="context-row__val"></span>`;
    row.children[0].textContent = key;
    row.children[1].textContent = val;
    els.context.append(row);
  }
}

/* ---- Ring ------------------------------------------------ */
function buildRing() {
  if (!els.ring) return;
  SLOTS.forEach((slot, index) => {
    const el = document.createElement('div');
    el.className = 'slot cursor-target';
    el.id = `slot-${index}`;
    el.setAttribute('role', 'option');
    el.setAttribute('aria-selected', 'false');
    el.dataset.index = String(index);
    el.dataset.empty = 'true';
    el.style.setProperty('--i', String(index));
    el.innerHTML = `<span class="slot__key"></span><span data-text></span>`;
    el.querySelector('.slot__key').textContent = `${index + 1} ${slot.glyph}`;
    el.addEventListener('click', () => {
      setHighlight(index);
      select();
    });
    els.ring.append(el);
  });
  positionSlots();
}

/* Ellipse maths. Radii come from CSS so the ring shrinks without JS. */
function ringRadii() {
  const styles = getComputedStyle(els.ring);
  return {
    rx: parseFloat(styles.getPropertyValue('--rx')) || 340,
    ry: parseFloat(styles.getPropertyValue('--ry')) || 215,
  };
}

function slotOffset(index) {
  const { rx, ry } = ringRadii();
  const rad = (SLOTS[index].angle * Math.PI) / 180;
  return { x: Math.cos(rad) * rx, y: Math.sin(rad) * ry };
}

function positionSlots() {
  if (!els.ring) return;
  els.ring.querySelectorAll('.slot').forEach((el) => {
    const { x, y } = slotOffset(Number(el.dataset.index));
    el.style.setProperty('--x', `${x}px`);
    el.style.setProperty('--y', `${y}px`);
  });
  moveLens({ animate: false });
}

/* The lens flows to the active slot. Uniform slot size means this is a
   pure translate — no reflow, so it stays smooth under any load. */
let lensTimer = null;
function moveLens({ animate = true } = {}) {
  if (!els.lens) return;

  const active = state.items[state.highlight];
  if (!active) {
    els.lens.dataset.visible = 'false';
    return;
  }

  const { x, y } = slotOffset(state.highlight);
  const wasHidden = els.lens.dataset.visible !== 'true';

  if (!animate || wasHidden) {
    // Jump without a tween when appearing or on resize.
    els.lens.style.transition = 'none';
    els.lens.style.setProperty('--lx', `${x}px`);
    els.lens.style.setProperty('--ly', `${y}px`);
    els.lens.offsetHeight; // flush
    els.lens.style.transition = '';
    els.lens.dataset.visible = 'true';
    return;
  }

  els.lens.style.setProperty('--lx', `${x}px`);
  els.lens.style.setProperty('--ly', `${y}px`);
  els.lens.dataset.moving = 'true';
  clearTimeout(lensTimer);
  lensTimer = setTimeout(() => {
    els.lens.dataset.moving = 'false';
  }, 260);
}

function renderOptions({ entering = false } = {}) {
  if (!els.ring) return;
  els.ring.querySelectorAll('.slot').forEach((el) => {
    const index = Number(el.dataset.index);
    const item = state.items[index];
    el.querySelector('[data-text]').textContent = item ? item.short : '';
    el.dataset.empty = item ? 'false' : 'true';
    // Lets refusals read differently from agreement at a glance.
    el.dataset.intent = item?.intent || '';
    el.setAttribute('aria-selected', item && index === state.highlight ? 'true' : 'false');

    if (entering && item) {
      el.dataset.enter = 'false';
      el.offsetHeight; // restart the animation
      el.dataset.enter = 'true';
    }
  });

  const active = els.ring.querySelector('[aria-selected="true"]');
  els.ring.setAttribute('aria-activedescendant', active ? active.id : '');
  moveLens({ animate: !entering });
}

function setHighlight(index) {
  if (!state.items.length) return;
  const count = SLOTS.length;
  let next = ((index % count) + count) % count;

  let guard = 0;
  while (!state.items[next] && guard++ < count) next = (next + 1) % count;

  state.highlight = next;
  renderOptions();
}

function step(delta) {
  if (!state.items.length) return;
  const count = SLOTS.length;
  let next = state.highlight;
  let guard = 0;
  do {
    next = (next + delta + count) % count;
  } while (!state.items[next] && guard++ < count);
  state.highlight = next;
  renderOptions();
  setHub(SLOTS[next].glyph, 'Choosing');
}

/* ---- Hub ------------------------------------------------- */
let pulseTimer = null;
function setHub(glyph, label, { pulse = false, thinking = false } = {}) {
  if (!els.hub) return;
  if (glyph) els.hubDir.textContent = glyph;
  if (label) els.hubState.textContent = label;
  els.hub.dataset.thinking = String(thinking);

  if (pulse) {
    els.hub.dataset.pulse = 'true';
    clearTimeout(pulseTimer);
    pulseTimer = setTimeout(() => {
      els.hub.dataset.pulse = 'false';
    }, 460);
  }
}

/* ---- Speech ---------------------------------------------- */
/* Classic browser TTS via the Web Speech API — the Google male/female
   voices Chrome ships. No backend required. */

const speech = { ready: false, voices: [], voiceURI: null };
const VOICE_KEY = 'whisper.voice';

function voiceLabel(v) {
  const isMale = /\bmale\b/i.test(v.name);
  const isFemale = /\bfemale\b/i.test(v.name) || (!isMale && /google us english/i.test(v.name));
  const gender = isMale ? 'Male' : isFemale ? 'Female' : '';
  return gender ? `${v.name.replace(/^Google\s*/i, 'Google ')} (${gender})` : v.name;
}

function loadVoices() {
  if (!('speechSynthesis' in window)) {
    setPill('voice', 'down');
    if (els.voiceLabel) els.voiceLabel.textContent = 'No voice';
    return;
  }

  const all = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en'));
  speech.voices = all.filter((v) => /google/i.test(v.name));
  if (!speech.voices.length) speech.voices = all; // no Google voices on this machine — fall back

  if (!speech.voices.length) return;

  if (!speech.voiceURI) {
    try {
      speech.voiceURI = localStorage.getItem(VOICE_KEY);
    } catch {}
  }
  if (!speech.voiceURI || !speech.voices.some((v) => v.voiceURI === speech.voiceURI)) {
    speech.voiceURI = speech.voices[0].voiceURI;
  }

  if (els.voiceSelect) {
    els.voiceSelect.innerHTML = '';
    speech.voices.forEach((v) => {
      const opt = document.createElement('option');
      opt.value = v.voiceURI;
      opt.textContent = voiceLabel(v);
      els.voiceSelect.append(opt);
    });
    els.voiceSelect.value = speech.voiceURI;
  }
}

/* Browsers refuse speechSynthesis before a user gesture — prime it once. */
function unlockVoice() {
  if (speech.ready || !('speechSynthesis' in window)) return;
  const warmup = new SpeechSynthesisUtterance(' ');
  warmup.volume = 0;
  speechSynthesis.speak(warmup);
  speech.ready = true;
  setPill('voice', 'live');
  if (els.voiceLabel) els.voiceLabel.textContent = 'Voice';
  trace('voice unlocked');
}

function speak(text) {
  if (!text) return;
  state.lastSpoken = text;

  if (!('speechSynthesis' in window)) {
    trace('speechSynthesis unavailable', 'reject');
    return;
  }
  if (!speech.ready) {
    setPill('voice', 'degraded');
    if (els.voiceLabel) els.voiceLabel.textContent = 'Click to enable';
    return;
  }

  speechSynthesis.cancel(); // never stack utterances
  const utter = new SpeechSynthesisUtterance(text);
  const voice = speech.voices.find((v) => v.voiceURI === speech.voiceURI);
  // Assigning .voice throws if the object isn't a live SpeechSynthesisVoice
  // (stale list after a device change). Speaking in the default voice beats
  // not speaking at all — this is the whole point of the device.
  try {
    if (voice) {
      utter.voice = voice;
      utter.lang = voice.lang;
    }
  } catch {
    trace('voice unavailable — using the default', 'reject');
  }
  utter.rate = 0.94;
  utter.pitch = 1.02;
  speechSynthesis.speak(utter);
  setPill('voice', 'live');
}

function showUtterance(text) {
  if (!els.utterance) return;
  els.utterance.textContent = text;
  els.utterance.dataset.idle = 'false';
  els.utterance.dataset.fresh = 'false';
  els.utterance.offsetHeight; // restart the entrance
  els.utterance.dataset.fresh = 'true';
}

/* ---- The reasoning model --------------------------------- */
/* POST /api/ai/predict is the path that actually carries what the mic
   overheard to the model (see api/routers/ai.py). It's plain REST, so
   unlike /ws it works on the Vercel deploy too — that's what makes the
   transcript reach the agent at all. Falls back to the scripted set
   whenever the API can't be reached, so the demo never dead-ends. */

function apiContext() {
  return {
    name: state.context.name,
    part_of_day: state.context.partOfDay,
    recent: state.context.recent.slice(-4),
    heard: state.context.heard.slice(-4),
    rejected: state.context.rejected.slice(-4),
  };
}

/* The trace used to say only "predicted 8 options", which makes a real
   model response and the server's hardcoded fallback look identical.
   List them. */
function traceOptions(label, texts) {
  trace(`${label}: ${texts.map((t, i) => `${i + 1}·${t}`).join('  ')}`, 'speak');
}

let predictSeq = 0;

async function predictFromApi({ reason = 'context' } = {}) {
  const seq = ++predictSeq;
  setHub(null, 'Thinking', { thinking: true });
  trace(`asking the model (${reason})…`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(`${API_BASE_URL}/api/ai/predict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: apiContext() }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    if (seq !== predictSeq) return true; // a newer prediction supersedes this one

    const options = (data.options || []).filter(Boolean);
    if (!options.length) throw new Error('empty option set');

    state.source = data.source === 'model' ? `${data.model || 'model'}` : 'server fallback';
    state.mode = 'needs';
    applyMessage({ state: 'options', items: options, highlight: 0 });
    // Print what actually came back, not just how many — otherwise there's
    // no way to tell a real prediction from the server's fallback list.
    traceOptions(`needs (${data.source})`, options.map((o) => (o.short ?? o)));
    setPill('server', data.source === 'model' ? 'live' : 'degraded');
    // Only genuinely scripted output earns the SIMULATED badge.
    if (els.simBadge) els.simBadge.hidden = data.source === 'model';
    renderContext();
    return true;
  } catch (error) {
    if (seq !== predictSeq) return true;
    trace(`model unreachable (${error.message}) — scripted set`, 'reject');
    setPill('server', 'down');
    if (els.simBadge) els.simBadge.hidden = false;
    state.source = 'scripted';
    mockPredict();
    renderContext();
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/* ---- The reply wheel --------------------------------------
   When someone speaks TO the user, the needs wheel is the wrong
   question — "hello" has no slot among bathroom/food/pain. So while
   the mic is listening the ring flips to replies generated from what
   was actually heard, and flips back to needs when the mic goes off.

   Same eight positions either way, so positional memory survives the
   switch. Slot 2 is always a refusal (see RESPOND_SYSTEM). */

let respondSeq = 0;

async function respondFromApi(heardText) {
  const seq = ++respondSeq;
  setHub(null, 'Thinking', { thinking: true });
  trace(`asking for replies to "${heardText}"…`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(`${API_BASE_URL}/api/ai/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ heard: heardText, context: apiContext() }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    if (seq !== respondSeq) return false; // superseded by newer speech

    const replies = (data.replies || []).filter((r) => r && r.text);
    if (!replies.length) throw new Error('empty reply set');

    state.mode = 'reply';
    state.replyTo = heardText;
    state.source = data.source === 'model' ? `${data.model || 'model'} · reply` : 'server fallback · reply';

    // Replies are already short enough to speak as-is, so short === full
    // and pressing one skips the /expand round trip entirely.
    applyMessage({
      state: 'options',
      items: replies.map((r) => ({ short: r.text, full: r.text, intent: r.intent })),
      highlight: 0,
    });

    traceOptions(`replies (${data.source})`, replies.map((r) => r.text));
    setPill('server', data.source === 'model' ? 'live' : 'degraded');
    if (els.simBadge) els.simBadge.hidden = data.source === 'model';
    setStageHint(`Replying to “${heardText}”`);
    renderContext();
    return true;
  } catch (error) {
    if (seq !== respondSeq) return false;
    trace(`replies unavailable (${error.message})`, 'reject');
    setPill('server', 'down');
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/* Back to the needs wheel — what the device shows when nobody is
   talking to them. */
function returnToNeeds() {
  if (state.mode === 'needs') return;
  state.mode = 'needs';
  state.replyTo = '';
  setStageHint(null);
  trace('back to the needs wheel');
  predictFromApi({ reason: 'mic off' });
}

/* ---- Microphone -------------------------------------------
   Overhears the room (caregiver talking, ambient conversation) and
   transcribes it live via the browser's own speech recognition.
   Each finished utterance lands in state.context.heard and then
   triggers a re-prediction, so what the room says visibly changes
   what the ring offers. That round trip IS the feature. */

const HEARD_LIMIT = 6;
const REPREDICT_DELAY = 1400; // let a sentence finish before re-asking

function setMicPill(value, label) {
  setPill('mic', value);
  if (els.micLabel) els.micLabel.textContent = label;
}

let repredictTimer = null;

const mic = new MicSession({
  onInterim: (text) => {
    setHub(null, 'Hearing…', { thinking: true });
    if (els.micLabel) els.micLabel.textContent = 'Hearing…';
  },

  onFinal: (text) => {
    state.context.heard.push(text);
    if (state.context.heard.length > HEARD_LIMIT) state.context.heard.shift();
    renderContext();
    trace(`heard "${text}"`, 'heard');
    setHub(null, 'Listening');
    if (els.micLabel) els.micLabel.textContent = 'Mic on';

    // Someone is talking to them — offer replies, not needs. Debounced so
    // a long sentence becomes one request rather than one per clause.
    clearTimeout(repredictTimer);
    repredictTimer = setTimeout(() => respondFromApi(text), REPREDICT_DELAY);
  },

  onStateChange: (listening) => {
    setMicPill(listening ? 'live' : 'down', listening ? 'Mic on' : 'Mic off');
    if (els.micToggle) els.micToggle.setAttribute('aria-pressed', String(listening));
    if (listening) {
      setHub(null, 'Listening');
    } else {
      // Mic off — nobody is talking to them, so go back to needs.
      clearTimeout(repredictTimer);
      returnToNeeds();
    }
  },

  onStatus: (message) => trace(`mic: ${message}`),

  onError: (kind, message) => {
    const label =
      kind === 'unsupported' ? 'No mic support'
      : kind === 'insecure' ? 'Mic needs https'
      : kind === 'denied' ? 'Mic blocked'
      : kind === 'nomic' ? 'No microphone'
      : kind === 'network' ? 'Mic offline'
      : 'Mic error';
    setMicPill('degraded', label);
    trace(`mic: ${message}`, 'reject');
  },
});

async function toggleMic() {
  if (mic.listening) {
    mic.stop();
    trace('mic: stopped');
    return;
  }
  setMicPill('degraded', 'Starting…');
  await mic.start();
}

/* The board posts once a second. If three of those go missing the pill
   drops back to dim, so an unplugged ESP32 is visible on stage. */
let deviceTimer = null;
function markDeviceAlive() {
  setPill('device', 'live');
  clearTimeout(deviceTimer);
  deviceTimer = setTimeout(() => setPill('device', 'down'), 3500);
}

/* ---- Backend messages ------------------------------------ */
function applyMessage(msg) {
  switch (msg.state) {
    case 'options': {
      state.items = (msg.items || []).slice(0, SLOTS.length).map(normaliseItem);
      state.highlight = Number.isInteger(msg.highlight) ? msg.highlight : 0;
      renderOptions({ entering: true });
      setHub(null, 'Choosing');
      trace(`predicted ${state.items.filter(Boolean).length} options`);
      break;
    }

    case 'expanding':
      setHub(null, 'Thinking', { thinking: true });
      trace('expanding selection');
      break;

    case 'confirm':
      showUtterance(msg.text || '');
      setHub(null, 'Confirm');
      break;

    case 'speak':
      showUtterance(msg.text || '');
      speak(msg.text);
      setHub(null, 'Speaking');
      trace(`spoke "${msg.text}"`, 'speak');
      state.context.recent.push(msg.short || msg.text);
      renderContext();
      break;

    case 'idle':
      setHub('·', 'Idle');
      break;

    // A joystick gesture, already debounced by the backend. The browser
    // decides what it means — see handleDirection.
    case 'input':
      markDeviceAlive();
      handleDirection(msg.dir, { direct: true }); // real 8-way hardware
      break;

    // Heartbeat: the board posted, whether or not it moved. This is what
    // keeps the DEVICE pill honest while the stick sits at centre.
    case 'device':
      markDeviceAlive();
      break;

    case 'context':
      Object.assign(state.context, msg.context || msg);
      renderContext();
      break;

    default:
      // Never throw on an unknown state — the backend will change under us.
      trace(`unhandled state: ${msg.state}`);
  }

  if (msg.dir) {
    const slot = SLOTS[DIR_INDEX.get(msg.dir) ?? -1];
    setHub(slot ? slot.glyph : '·', null, { pulse: msg.dir === 'press' });
  }
}

/* ---- WebSocket -------------------------------------------
   The socket carries ONE thing now: joystick gestures from the ESP32
   (see api/routers/joystick.py). Options, speech and the wheel logic all
   live in this file, so losing the socket costs the hardware input and
   nothing else — the keyboard path still completes the whole demo.

   Keeps retrying quietly: the board and the laptop come up in whatever
   order they come up in. */

let reconnectAttempts = 0;
const RECONNECT_CEILING = 15000;

function connect() {
  if (FORCE_MOCK) return;

  let socket;
  try {
    socket = new WebSocket(WS_URL);
  } catch {
    return scheduleReconnect('socket construction failed');
  }

  state.socket = socket;

  const failTimer = setTimeout(() => {
    if (socket.readyState !== WebSocket.OPEN) socket.close();
  }, 2500);

  socket.addEventListener('open', () => {
    clearTimeout(failTimer);
    reconnectAttempts = 0;
    trace(`joystick feed connected (${WS_URL})`);
  });

  socket.addEventListener('message', (event) => {
    try {
      applyMessage(JSON.parse(event.data));
    } catch {
      trace('unparseable message', 'reject');
    }
  });

  socket.addEventListener('close', () => {
    clearTimeout(failTimer);
    state.socket = null;
    setPill('device', 'down');
    scheduleReconnect();
  });

  socket.addEventListener('error', () => socket.close());
}

/* Backs off to 15s so a demo with no hardware isn't spamming the console
   all afternoon, but still reconnects on its own when the board appears. */
function scheduleReconnect(reason) {
  if (reason) trace(`${reason}`, 'reject');
  if (reconnectAttempts === 1) trace('no joystick feed — keyboard still works');
  reconnectAttempts += 1;
  const delay = Math.min(1200 * reconnectAttempts, RECONNECT_CEILING);
  setTimeout(connect, delay);
}

/* ---- Local scripted agent -------------------------------- */
/* Stands in for predict_options()/expand() so the frontend is never
   blocked on the AI or backend tracks.

   Each set is eight intents in fixed compass order, one per slot role:
   need / food / comfort / position / pain / people / environment / closing.
   `short` is what the ring shows; `full` is what the voice says. */

const s = (short, full) => ({ short, full });

const MOCK_SETS = {
  morning: [
    [
      s('Bathroom', 'I need to use the bathroom — could you help me there?'),
      s('Breakfast', "I'd like some breakfast when there's a moment."),
      s('Too cold', "I'm cold. Could I have another blanket, please?"),
      s('Sit me up', 'Could you help me sit up a little higher?'),
      s('My back hurts', 'My back is hurting this morning — more than usual.'),
      s('Call my daughter', "I'd like to speak to my daughter today, if she's free."),
      s('Open the curtains', 'Could you open the curtains? I want to see outside.'),
      s("I'm alright", "I'm alright for now, thank you."),
    ],
    [
      s('Something to drink', "I'm thirsty — could I have some water?"),
      s('Not hungry yet', "I don't want anything to eat just yet, thank you."),
      s('Too warm', "I'm too warm. Could you take one of these off?"),
      s('Get dressed', "I'd like to get dressed now, please."),
      s('Still tired', "I didn't sleep well and I'm still very tired."),
      s('Who is here?', "Could you tell me who's here this morning?"),
      s('Too bright', "It's too bright in here — could you dim the light?"),
      s('Nothing right now', 'Nothing right now, thank you.'),
    ],
  ],
  afternoon: [
    [
      s('Bathroom', 'I need to use the bathroom — could you help me there?'),
      s('Something to drink', "I'm thirsty — could I have something to drink?"),
      s('Too cold', "I'm getting cold. Could I have a blanket?"),
      s('Help me move', "I've been in this position too long. Could you help me move?"),
      s("I'm in pain", "I'm in a lot of pain and I'd like someone to know."),
      s('I want company', "I'd like some company for a while, if you can stay."),
      s('Put the TV on', 'Could you put the television on for me?'),
      s("I'm alright", "I'm alright, thank you for asking."),
    ],
    [
      s('Something to eat', "I'm hungry — could I have something to eat?"),
      s('Not thirsty', "No, I don't want anything to drink, thank you."),
      s('Take me outside', "I'd love to go outside for a bit if the weather's good."),
      s('Help me up', 'Could you help me sit up, please?'),
      s('My hand is stuck', 'My hand is caught — could you move it for me?'),
      s('Call the nurse', 'Could you call the nurse? I need some help.'),
      s('Too loud', "It's too loud in here. Could you turn that down?"),
      s('Nothing right now', 'Nothing right now, thank you.'),
    ],
  ],
  evening: [
    [
      s('Bathroom', 'I need the bathroom before I settle down.'),
      s('Dinner', "I'd like my dinner now, please."),
      s("I'm cold", "I'm cold — could I have another blanket?"),
      s('Ready for bed', "I'm ready to go to bed now."),
      s("I'm in pain", "I'm in pain and I'd like something for it."),
      s('Call my son', "I'd like to ring my son before it gets late."),
      s('Dim the light', 'Could you turn the light down a little?'),
      s("I'm alright", "I'm alright, thank you."),
    ],
    [
      s('Something to drink', 'Could I have a drink before bed?'),
      s('Not hungry', "I don't want anything to eat tonight, thank you."),
      s('Sit up a bit', "Could you sit me up a bit? I'm not comfortable."),
      s('Stay a while', 'Would you stay with me a while? I like the company.'),
      s('My legs ache', 'My legs are aching badly this evening.'),
      s('I want to talk', "I'd like to talk to someone for a bit."),
      s('Put music on', 'Could you put some music on, quietly?'),
      s('Nothing right now', 'Nothing right now, thank you.'),
    ],
  ],
  night: [
    [
      s('Bathroom', 'I need the bathroom — I know it’s late, I’m sorry.'),
      s("I'm thirsty", 'Could I have a sip of water?'),
      s("I'm cold", "I'm cold. Could you put another blanket over me?"),
      s("Can't sleep", "I can't get to sleep. I've been lying here a long time."),
      s("I'm in pain", "I'm in pain and I can't settle because of it."),
      s('Please stay', 'Would you stay with me a few minutes? I don’t want to be alone.'),
      s('Turn the light off', 'Could you turn the light off, please?'),
      s("I'm alright", "I'm alright — go back to sleep."),
    ],
    [
      s('Something is wrong', "Something isn't right. I think you should check on me."),
      s('Too warm', "I'm too warm — could you take a blanket off?"),
      s('Fix my pillow', 'My pillow has slipped. Could you fix it for me?'),
      s('I need to move', "I need to be moved — I've been on this side too long."),
      s("I'm frightened", "I'm frightened and I'd rather not be on my own."),
      s('Call someone', 'Please call someone for me.'),
      s('Too noisy', "There's a noise keeping me awake."),
      s('Nothing right now', 'Nothing right now — thank you.'),
    ],
  ],
};

let mockVariant = 0;

function mockPredict() {
  const sets = MOCK_SETS[state.context.partOfDay] || MOCK_SETS.afternoon;
  applyMessage({ state: 'options', items: sets[mockVariant % sets.length], highlight: 0 });
}

/* Turn the chosen short label into the full sentence, then say it.

   Scripted items already carry their own `full`, so they skip the network
   entirely. Model-supplied options are bare labels ("Bathroom"), and those
   go to /api/ai/expand — which answers from a template by default, because
   this sits on the press-to-speak path where model latency would be heard
   as silence. */
async function expandAndSpeak(item) {
  // Replies are already complete utterances. Running "Hello" through
  // /expand would produce "I'd like hello, please." — say it as written.
  if (state.mode === 'reply') {
    applyMessage({ state: 'speak', text: item.short, short: item.short });
    return;
  }

  if (item.full && item.full !== item.short) {
    applyMessage({ state: 'expanding' });
    setTimeout(() => applyMessage({ state: 'speak', text: item.full, short: item.short }), 480);
    return;
  }

  applyMessage({ state: 'expanding' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(`${API_BASE_URL}/api/ai/expand`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selection: item.short, context: apiContext() }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    applyMessage({ state: 'speak', text: data.text || item.short, short: item.short });
  } catch {
    // Say the label itself rather than nothing.
    trace('expand unreachable — speaking the label', 'reject');
    applyMessage({ state: 'speak', text: item.short, short: item.short });
  } finally {
    clearTimeout(timer);
  }
}

/* ---- Input ----------------------------------------------- */
function select() {
  const choice = state.items[state.highlight];
  if (!choice) return;
  setHub(null, 'Selected', { pulse: true });
  trace(`selected "${choice.short}"`);
  // The browser owns the wheel in every mode now: the backend relays
  // joystick gestures but has no idea what's on the ring.
  expandAndSpeak(choice);
}

function regenerate() {
  const rejected = state.items[state.highlight];
  trace(`rejected "${rejected?.short ?? 'set'}" — re-predicting`, 'reject');

  // What they just said "no" to is the strongest personalisation signal
  // the model gets — record it before asking again.
  if (rejected?.short) {
    state.context.rejected.push(rejected.short);
    if (state.context.rejected.length > 6) state.context.rejected.shift();
  }

  // Re-ask in whichever wheel is on screen, or the regenerate would
  // silently drop the user back to needs mid-conversation.
  if (state.mode === 'reply' && state.replyTo) {
    respondFromApi(state.replyTo);
  } else {
    mockVariant += 1;
    predictFromApi({ reason: 'rejected' });
  }
}

/* Direction semantics, and they differ by input device on purpose.

   The joystick has eight physical positions, so all eight jump straight
   to the matching slot — that IS the ring's promise (UI-SPEC §4.2: the
   screen layout is the input topology). With every direction spoken for,
   "not what I meant" becomes a double-press, which the backend detects.

   A keyboard only has four arrows, so it keeps the original stepping
   contract and regenerates with R. */
function handleDirection(dir, { direct = false } = {}) {
  setHub(SLOTS[DIR_INDEX.get(dir)]?.glyph || '·', null, { pulse: dir === 'press' });

  if (dir === 'press') return select();
  if (dir === 'regenerate') return regenerate();

  const index = DIR_INDEX.get(dir);

  if (direct) {
    if (index !== undefined) {
      setHighlight(index);
      setHub(SLOTS[index].glyph, 'Choosing');
    }
    return;
  }

  switch (dir) {
    case 'up':
      step(-1);
      break;
    case 'down':
    case 'right':
      step(1);
      break;
    case 'left':
      regenerate();
      break;
    default:
      if (index !== undefined) setHighlight(index);
  }
}

function onKey(event) {
  unlockVoice();

  const keyMap = {
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right',
    Enter: 'press',
    ' ': 'press',
  };

  if (keyMap[event.key]) {
    event.preventDefault();
    handleDirection(keyMap[event.key]);
    return;
  }

  if (event.key === 'r' || event.key === 'R') {
    event.preventDefault();
    regenerate();
    return;
  }

  if (event.key === 'm' || event.key === 'M') {
    event.preventDefault();
    toggleMic();
    return;
  }

  if (/^[1-8]$/.test(event.key)) {
    event.preventDefault();
    setHighlight(Number(event.key) - 1);
    setHub(SLOTS[Number(event.key) - 1].glyph, 'Choosing');
  }
}

/* ---- Boot ------------------------------------------------ */
buildRing();
renderContext();
renderOptions();
setPill('server', 'down');
setPill('device', 'down');
setPill('voice', 'degraded');
if (els.voiceLabel) els.voiceLabel.textContent = 'Click to enable';
setMicPill('down', mic.isSupported ? 'Mic off' : 'No mic support');

loadVoices();
if ('speechSynthesis' in window) {
  speechSynthesis.addEventListener('voiceschanged', loadVoices);
}

mountTargetCursor({
  spinDuration: 2,
  hoverDuration: 0.2,
  parallaxOn: true,
  cursorColor: '#fbf3e6',
  cursorColorOnTarget: '#9fc4e8',
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(positionSlots, 90);
});

document.addEventListener('keydown', onKey);
document.addEventListener('pointerdown', unlockVoice, { once: true });

els.voiceSelect?.addEventListener('change', (e) => {
  speech.voiceURI = e.target.value;
  try {
    localStorage.setItem(VOICE_KEY, speech.voiceURI);
  } catch {}
  unlockVoice();
  speak('This is the voice I will use.');
});

els.voiceEnable?.addEventListener('click', () => {
  unlockVoice();
  speak('Voice ready.');
});

els.speakAgain?.addEventListener('click', () => {
  unlockVoice();
  if (state.lastSpoken) speak(state.lastSpoken);
});

els.regenerate?.addEventListener('click', () => {
  unlockVoice();
  regenerate();
});

els.micToggle?.addEventListener('click', toggleMic);

mountBackgroundVideo();

/* The wheel fills from REST immediately — it never waits on the socket,
   because the joystick is an input device, not the source of options. */
predictFromApi({ reason: 'startup' });

if (FORCE_MOCK) {
  trace('joystick feed skipped via ?mock=1');
} else {
  connect();
}
