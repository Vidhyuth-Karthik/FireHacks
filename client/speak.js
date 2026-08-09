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
import { TtsSession, TtsError, fetchVoiceConfig } from './tts.js';

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
  audio: document.querySelector('[data-audio]'),
};

/* ---- State ----------------------------------------------- */
const state = {
  items: [], // normalised {short, full}
  highlight: 0,
  lastSpoken: '',
  mock: FORCE_MOCK,
  socket: null,
  context: { name: 'Guest', partOfDay: partOfDay(), recent: [] },
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
  if (typeof item === 'string') return { short: item, full: item };
  return { short: item.short ?? item.text ?? '', full: item.full ?? item.text ?? item.short ?? '' };
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
    ['Source', state.mock ? 'local agent' : 'backend'],
    ['Recent', state.context.recent.slice(-2).join(' · ') || '—'],
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
/* Audio comes from the self-hosted Kokoro server via our own backend
   (see tts.js). The browser's speechSynthesis is deliberately unused. */

const tts = new TtsSession(els.audio, { timeoutMs: 45000 });
const speech = { ready: false, voice: null, config: null };
const VOICE_KEY = 'whisper.kokoro.voice';

async function loadVoices() {
  speech.config = await fetchVoiceConfig();

  let stored = null;
  try {
    stored = localStorage.getItem(VOICE_KEY);
  } catch {}
  const known = speech.config.voices.some((v) => v.id === stored);
  speech.voice = known ? stored : speech.config.defaultVoice;

  if (els.voiceSelect) {
    els.voiceSelect.innerHTML = '';
    const groups = new Map();
    for (const voice of speech.config.voices) {
      const key = voice.group || 'Voices';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(voice);
    }
    for (const [groupName, list] of groups) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = groupName;
      for (const voice of list) {
        const option = document.createElement('option');
        option.value = voice.id;
        option.textContent = voice.label || voice.id;
        optgroup.append(option);
      }
      els.voiceSelect.append(optgroup);
    }
    els.voiceSelect.value = speech.voice;
  }

  if (!speech.config.online) {
    trace('voice list unavailable — using built-in list', 'reject');
  }
}

/* Autoplay policy blocks programmatic play() until the user has
   interacted. "Bless" the element once on the first gesture so later
   playback (driven by the joystick, not a click) is allowed. */
function unlockVoice() {
  if (speech.ready) return;
  speech.ready = true;

  if (els.audio) {
    els.audio.muted = true;
    els.audio
      .play()
      .then(() => {
        els.audio.pause();
        els.audio.currentTime = 0;
        els.audio.muted = false;
      })
      .catch(() => {
        els.audio.muted = false;
      });
  }

  setPill('voice', 'live');
  if (els.voiceLabel) els.voiceLabel.textContent = 'Voice';
  trace('voice unlocked');
}

async function speak(text) {
  if (!text) return;
  state.lastSpoken = text;

  if (!speech.ready) {
    setPill('voice', 'degraded');
    if (els.voiceLabel) els.voiceLabel.textContent = 'Click to enable';
    return;
  }

  try {
    await tts.speak({
      text,
      voice: speech.voice || speech.config?.defaultVoice,
      speed: 1.0,
      autoplay: true,
      maxChars: speech.config?.maxChars ?? 2000,
    });
    setPill('voice', 'live');
  } catch (error) {
    if (!(error instanceof TtsError)) throw error;
    if (error.kind === 'aborted') return; // superseded by a newer utterance

    setPill('voice', 'degraded');
    trace(`speech failed: ${error.message}`, 'reject');
  }
}

function showUtterance(text) {
  if (!els.utterance) return;
  els.utterance.textContent = text;
  els.utterance.dataset.idle = 'false';
  els.utterance.dataset.fresh = 'false';
  els.utterance.offsetHeight; // restart the entrance
  els.utterance.dataset.fresh = 'true';
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

/* ---- WebSocket ------------------------------------------- */
let reconnectAttempts = 0;

function connect() {
  if (state.mock) return;

  let socket;
  try {
    socket = new WebSocket(WS_URL);
  } catch {
    return enterMock('socket construction failed');
  }

  state.socket = socket;
  setPill('server', 'degraded');

  const failTimer = setTimeout(() => {
    if (socket.readyState !== WebSocket.OPEN) socket.close();
  }, 2500);

  socket.addEventListener('open', () => {
    clearTimeout(failTimer);
    reconnectAttempts = 0;
    setPill('server', 'live');
    setPill('device', 'live'); // the backend is the device's only route in
    trace(`connected to ${WS_URL}`);
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
    setPill('server', 'down');
    setPill('device', 'down');
    reconnectAttempts += 1;
    if (reconnectAttempts >= 2) enterMock('backend unreachable');
    else setTimeout(connect, 1200);
  });

  socket.addEventListener('error', () => socket.close());
}

function enterMock(reason) {
  if (state.mock) return;
  state.mock = true;
  state.socket = null;
  if (els.simBadge) els.simBadge.hidden = false;
  setPill('server', 'down');
  setPill('device', 'down');
  trace(`${reason} — running local agent`, 'reject');
  renderContext();
  mockPredict();
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

function mockExpand(item) {
  applyMessage({ state: 'expanding' });
  setTimeout(() => applyMessage({ state: 'speak', text: item.full, short: item.short }), 480);
}

/* ---- Input ----------------------------------------------- */
function select() {
  const choice = state.items[state.highlight];
  if (!choice) return;
  setHub(null, 'Selected', { pulse: true });
  trace(`selected "${choice.short}"`);
  if (state.mock) mockExpand(choice);
  // Live mode: the backend owns the transition; the ESP32 press told it already.
}

function regenerate() {
  const rejected = state.items[state.highlight];
  trace(`rejected "${rejected?.short ?? 'set'}" — re-predicting`, 'reject');
  if (state.mock) {
    mockVariant += 1;
    setHub(null, 'Thinking', { thinking: true });
    setTimeout(mockPredict, 460);
  } else {
    postInput('left');
  }
}

/* Only used when a backend is live and we drive it from the browser —
   the ESP32 posts to this same endpoint. Best-effort. */
function postInput(dir) {
  if (state.mock) return;
  fetch(`${API_BASE_URL}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir }),
  }).catch(() => trace(`could not POST /input (${dir})`, 'reject'));
}

/* Direction semantics under the frozen 4-way contract, plus direct
   8-way jumps if firmware starts sending diagonals. */
function handleDirection(dir) {
  setHub(SLOTS[DIR_INDEX.get(dir)]?.glyph || '·', null, { pulse: dir === 'press' });

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
    case 'press':
      select();
      break;
    default: {
      const index = DIR_INDEX.get(dir);
      if (index !== undefined) setHighlight(index);
    }
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
    if (!state.mock) postInput(keyMap[event.key]);
    handleDirection(keyMap[event.key]);
    return;
  }

  if (event.key === 'r' || event.key === 'R') {
    event.preventDefault();
    regenerate();
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

loadVoices();

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
  speech.voice = e.target.value;
  try {
    localStorage.setItem(VOICE_KEY, speech.voice);
  } catch {}
  unlockVoice();
  speak('This is the voice I will use.');
});

/* Blob URLs outlive the page unless we let them go. */
window.addEventListener('pagehide', () => tts.dispose());

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

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
document.querySelectorAll('[data-bg-video]').forEach((v) => {
  if (reduced) v.pause();
  else v.play().catch(() => {});
});

if (state.mock) {
  if (els.simBadge) els.simBadge.hidden = false;
  trace('mock forced via ?mock=1');
  mockPredict();
} else {
  trace(`connecting to ${WS_URL}`);
  connect();
}
