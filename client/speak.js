/* ============================================================
   Whisper — speaker page.

   Consumes backend state over /ws and renders it onto the ring.
   Falls back to a local scripted agent if the socket never opens,
   so the demo is completable with no backend and no hardware.

   Contract (UI-SPEC.md §4.3):
     {"state":"options","items":[...],"highlight":0}
     {"state":"speak","text":"..."}
     {"state":"expanding"} | {"state":"confirm","text":...} | {"state":"idle"}
   ============================================================ */

import { WS_URL, API_BASE_URL, FORCE_MOCK } from './config.js';

/* ---- Geometry -------------------------------------------- */
/* Clockwise from top. A slot's position NEVER changes: positional
   memory is the accessibility win, so short lists leave gaps. */
const SLOTS = [
  { dir: 'up', angle: -90, glyph: '↑' },
  { dir: 'up_right', angle: -45, glyph: '↗' },
  { dir: 'right', angle: 0, glyph: '→' },
  { dir: 'down_right', angle: 45, glyph: '↘' },
  { dir: 'down', angle: 90, glyph: '↓' },
  { dir: 'down_left', angle: 135, glyph: '↙' },
  { dir: 'left', angle: 180, glyph: '←' },
  { dir: 'up_left', angle: -135, glyph: '↖' },
];

const DIR_INDEX = new Map(SLOTS.map((s, i) => [s.dir, i]));

/* ---- Elements -------------------------------------------- */
const els = {
  ring: document.querySelector('[data-ring]'),
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
};

/* ---- State ----------------------------------------------- */
const state = {
  items: [],
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

  // Keep the log bounded during a long demo.
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
    ['Recent', state.context.recent.slice(-3).join(' · ') || '—'],
  ];

  els.context.innerHTML = '';
  for (const [key, val] of rows) {
    const row = document.createElement('div');
    row.className = 'context-row';
    row.innerHTML =
      `<span class="context-row__key"></span><span class="context-row__val"></span>`;
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
    el.className = 'slot';
    el.id = `slot-${index}`;
    el.setAttribute('role', 'option');
    el.setAttribute('aria-selected', 'false');
    el.dataset.index = String(index);
    el.dataset.empty = 'true';
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

/* Ellipse maths. Radii come from CSS so the ring can shrink without JS. */
function positionSlots() {
  if (!els.ring) return;
  const styles = getComputedStyle(els.ring);
  const rx = parseFloat(styles.getPropertyValue('--rx')) || 360;
  const ry = parseFloat(styles.getPropertyValue('--ry')) || 235;

  els.ring.querySelectorAll('.slot').forEach((el) => {
    const { angle } = SLOTS[Number(el.dataset.index)];
    const rad = (angle * Math.PI) / 180;
    el.style.setProperty('--x', `${Math.cos(rad) * rx}px`);
    el.style.setProperty('--y', `${Math.sin(rad) * ry}px`);
  });
}

function renderOptions() {
  if (!els.ring) return;
  els.ring.querySelectorAll('.slot').forEach((el) => {
    const index = Number(el.dataset.index);
    const text = state.items[index] ?? '';
    el.querySelector('[data-text]').textContent = text;
    el.dataset.empty = text ? 'false' : 'true';
    const selected = text && index === state.highlight;
    el.setAttribute('aria-selected', selected ? 'true' : 'false');
  });

  const active = els.ring.querySelector('[aria-selected="true"]');
  els.ring.setAttribute('aria-activedescendant', active ? active.id : '');
}

function setHighlight(index) {
  if (!state.items.length) return;
  const count = SLOTS.length;
  let next = ((index % count) + count) % count;

  // Skip empty slots so navigation never lands on a gap.
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
    }, 420);
  }
}

/* ---- Speech ---------------------------------------------- */
const speech = {
  ready: false,
  voices: [],
  voiceURI: null,
};

const VOICE_KEY = 'whisper.voice';

function loadVoices() {
  if (!('speechSynthesis' in window)) {
    setPill('voice', 'down');
    if (els.voiceLabel) els.voiceLabel.textContent = 'No voice';
    return;
  }

  speech.voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en'));
  if (!speech.voices.length) return;

  try {
    speech.voiceURI = speech.voiceURI || localStorage.getItem(VOICE_KEY);
  } catch {}

  if (els.voiceSelect) {
    els.voiceSelect.innerHTML = '';
    speech.voices.forEach((v) => {
      const opt = document.createElement('option');
      opt.value = v.voiceURI;
      opt.textContent = v.name;
      els.voiceSelect.append(opt);
    });
    if (speech.voiceURI) els.voiceSelect.value = speech.voiceURI;
    else speech.voiceURI = els.voiceSelect.value;
  }
}

/* Browsers refuse speechSynthesis before a user gesture — prime it once. */
function unlockVoice() {
  if (speech.ready || !('speechSynthesis' in window)) return;
  const warmup = new SpeechSynthesisUtterance('');
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
  if (voice) utter.voice = voice;
  utter.rate = 0.96;
  utter.pitch = 1;
  speechSynthesis.speak(utter);
}

function showUtterance(text) {
  if (!els.utterance) return;
  els.utterance.textContent = text;
  els.utterance.dataset.idle = 'false';
}

/* ---- Backend messages ------------------------------------ */
function applyMessage(msg) {
  switch (msg.state) {
    case 'options':
      state.items = (msg.items || []).slice(0, SLOTS.length);
      state.highlight = Number.isInteger(msg.highlight) ? msg.highlight : 0;
      renderOptions();
      setHub(null, 'Choosing');
      trace(`predicted ${state.items.length} options`);
      break;

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
      state.context.recent.push(msg.text);
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

  // Optional: backend may echo the raw direction so the hub can animate.
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
    setPill('device', 'live'); // backend is the device's only route in
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
    if (reconnectAttempts >= 2) {
      enterMock('backend unreachable');
    } else {
      setTimeout(connect, 1200);
    }
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
   blocked on the AI or backend tracks. Phrases mirror the synthetic
   AAC set: needs, feelings, people, actions. */
const MOCK_SETS = {
  morning: [
    ['I need the bathroom', 'I\'d like breakfast', 'I\'m too cold', 'Can you sit me up',
     'I want to see someone', 'My mouth is dry', 'Open the curtains', 'I\'m alright'],
    ['I want to get dressed', 'Turn the radio on', 'My back hurts', 'I\'d like a drink',
     'Call my daughter', 'I\'m tired still', 'Too bright in here', 'Nothing right now'],
  ],
  afternoon: [
    ['I\'d like a drink', 'I need to move', 'I\'m in pain', 'Put the TV on',
     'I want company', 'Take me outside', 'I\'m hungry', 'I\'m fine thanks'],
    ['Can you help me up', 'It\'s too loud', 'I want to rest', 'Call the nurse',
     'I\'d like the window open', 'Where is everyone', 'My hand is stuck', 'Nothing right now'],
  ],
  evening: [
    ['I\'m ready for bed', 'I\'d like dinner', 'I\'m cold', 'Can someone stay',
     'Turn the light down', 'I\'m in pain', 'Call my son', 'I\'m alright'],
    ['I want to sit up', 'Put music on', 'I need the bathroom', 'I\'m thirsty',
     'Too quiet in here', 'I want to talk', 'My legs ache', 'Nothing right now'],
  ],
  night: [
    ['I can\'t sleep', 'I need the bathroom', 'I\'m cold', 'Please stay a minute',
     'I\'m in pain', 'Turn the light off', 'I\'m thirsty', 'I\'m alright'],
    ['Something\'s wrong', 'Call someone', 'Fix my pillow', 'I\'m too warm',
     'I want quiet', 'I\'m frightened', 'I need to move', 'Nothing right now'],
  ],
};

const MOCK_EXPANSIONS = {
  'I need the bathroom': 'I need to use the bathroom, could you help me?',
  'I\'d like breakfast': 'I think I\'d like some breakfast now, please.',
  'I\'m too cold': 'I\'m getting cold — could I have another blanket?',
  'I\'m cold': 'I\'m getting cold — could I have another blanket?',
  'Can you sit me up': 'Could you help me sit up a little, please?',
  'I want to see someone': 'I\'d really like to see someone today.',
  'I\'m in pain': 'I\'m in quite a lot of pain and I\'d like someone to know.',
  'I can\'t sleep': 'I can\'t get to sleep — would you sit with me a while?',
  'Please stay a minute': 'Would you stay with me for a minute? I\'d like the company.',
  'I\'m thirsty': 'I\'m thirsty — could I have something to drink?',
  'I\'m alright': 'I\'m alright, thank you for asking.',
  'Nothing right now': 'Nothing right now, thank you.',
};

let mockVariant = 0;

function mockPredict() {
  const sets = MOCK_SETS[state.context.partOfDay] || MOCK_SETS.afternoon;
  const items = sets[mockVariant % sets.length];
  applyMessage({ state: 'options', items, highlight: 0 });
}

function mockExpand(choice) {
  applyMessage({ state: 'expanding' });
  const text =
    MOCK_EXPANSIONS[choice] ||
    `${choice.charAt(0).toUpperCase()}${choice.slice(1)}, please.`;
  setTimeout(() => applyMessage({ state: 'speak', text }), 460);
}

/* ---- Input ----------------------------------------------- */
function select() {
  const choice = state.items[state.highlight];
  if (!choice) return;
  setHub(null, 'Selected', { pulse: true });
  trace(`selected "${choice}"`);
  if (state.mock) mockExpand(choice);
  // Live mode: the backend owns the transition; the ESP32 press already told it.
}

function regenerate() {
  const rejected = state.items[state.highlight];
  trace(`rejected "${rejected ?? 'set'}" — re-predicting`, 'reject');
  if (state.mock) {
    mockVariant += 1;
    setHub(null, 'Thinking', { thinking: true });
    setTimeout(mockPredict, 420);
  } else {
    postInput('left');
  }
}

/* Only used when a backend is live and we want to drive it from the
   browser — the ESP32 posts to the same endpoint. Best-effort. */
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

  // 1–8 jump straight to a slot. The safest path on stage.
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
if ('speechSynthesis' in window) {
  speechSynthesis.addEventListener('voiceschanged', loadVoices);
}

window.addEventListener('resize', positionSlots);
document.addEventListener('keydown', onKey);
document.addEventListener('pointerdown', unlockVoice, { once: true });

els.voiceSelect?.addEventListener('change', (e) => {
  speech.voiceURI = e.target.value;
  try {
    localStorage.setItem(VOICE_KEY, speech.voiceURI);
  } catch {}
  unlockVoice();
  speak('This is the voice I\'ll use.');
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

if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  document.querySelectorAll('[data-bg-video]').forEach((v) => v.pause());
}

if (state.mock) {
  if (els.simBadge) els.simBadge.hidden = false;
  trace('mock forced via ?mock=1');
  mockPredict();
} else {
  trace(`connecting to ${WS_URL}`);
  connect();
}
