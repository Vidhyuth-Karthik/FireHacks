/* ============================================================
   Voice studio page controller.

   All the TTS mechanics live in tts.js; this file is just the UI
   wiring — form state, status messages, and button enable/disable.
   ============================================================ */

import { TtsSession, TtsError, fetchVoiceConfig } from './tts.js';
import { mountTargetCursor } from './target-cursor.js';

const els = {
  form: document.querySelector('[data-tts-form]'),
  text: document.querySelector('#tts-text'),
  counter: document.querySelector('[data-counter]'),
  voice: document.querySelector('[data-voice]'),
  speed: document.querySelector('[data-speed]'),
  speedOut: document.querySelector('[data-speed-out]'),
  generate: document.querySelector('[data-generate]'),
  generateLabel: document.querySelector('[data-generate-label]'),
  stop: document.querySelector('[data-stop]'),
  download: document.querySelector('[data-download]'),
  status: document.querySelector('[data-status]'),
  audio: document.querySelector('[data-audio]'),
};

const VOICE_KEY = 'whisper.kokoro.voice';
const SPEED_KEY = 'whisper.kokoro.speed';

const session = new TtsSession(els.audio, { timeoutMs: 60000 });
let config = null;
let busy = false;

/* ---- Status ---------------------------------------------- */
function setStatus(message, kind = 'idle') {
  els.status.textContent = message;
  els.status.dataset.kind = kind;
}

/* ---- Voice dropdown -------------------------------------- */
function renderVoices({ voices, defaultVoice }) {
  const groups = new Map();
  for (const voice of voices) {
    const key = voice.group || 'Voices';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(voice);
  }

  els.voice.innerHTML = '';
  for (const [groupName, list] of groups) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = groupName;
    for (const voice of list) {
      const option = document.createElement('option');
      option.value = voice.id;
      option.textContent = voice.label || voice.id;
      optgroup.append(option);
    }
    els.voice.append(optgroup);
  }

  let stored = null;
  try {
    stored = localStorage.getItem(VOICE_KEY);
  } catch {}
  const wanted = stored && voices.some((v) => v.id === stored) ? stored : defaultVoice;
  els.voice.value = wanted;
}

/* ---- Character counter ----------------------------------- */
function updateCounter() {
  const max = config?.maxChars ?? 2000;
  const length = els.text.value.trim().length;
  els.counter.textContent = `${length} / ${max}`;
  els.counter.dataset.over = String(length > max);
}

/* ---- Busy state ------------------------------------------ */
/* Requirement 9: a second submit must not fire while one is running. */
function setBusy(next) {
  busy = next;
  els.generate.disabled = next;
  els.generate.dataset.busy = String(next);
  els.generateLabel.textContent = next ? 'Generating…' : 'Generate & play';
  els.stop.disabled = !next;
}

/* ---- Generate -------------------------------------------- */
async function generate(event) {
  event?.preventDefault();
  if (busy) return;

  const text = els.text.value.trim();
  if (!text) {
    setStatus('Enter some text to speak.', 'error');
    els.text.focus();
    return;
  }

  const voice = els.voice.value;
  const speed = Number(els.speed.value);

  try {
    localStorage.setItem(VOICE_KEY, voice);
    localStorage.setItem(SPEED_KEY, String(speed));
  } catch {}

  setBusy(true);
  setStatus(`Generating with ${voice} at ${speed.toFixed(2)}×…`, 'loading');
  els.download.hidden = true;

  try {
    const { url, contentType } = await session.speak({
      text,
      voice,
      speed,
      autoplay: true,
      maxChars: config?.maxChars ?? 2000,
    });

    els.download.href = url;
    els.download.download = session.downloadName(contentType);
    els.download.hidden = false;

    setStatus(`Ready — ${Math.round(session.lastBlob.size / 1024)} KB of ${contentType}. Playing.`, 'success');
  } catch (error) {
    if (!(error instanceof TtsError)) throw error;

    // The Stop handler already wrote its own message — don't clobber it.
    if (error.kind === 'aborted') return;

    // Requirement 8: distinct messaging per failure mode.
    const messages = {
      empty: 'Enter some text to speak.',
      too_long: error.message,
      rate_limited: `Slow down — ${error.message}`,
      timeout: 'The speech server took too long. Is Kokoro still starting up?',
      network: 'Could not reach the API. Is the backend running?',
      server: error.message,
      aborted: 'Cancelled.',
    };
    setStatus(messages[error.kind] ?? error.message, error.kind === 'aborted' ? 'idle' : 'error');
  } finally {
    setBusy(false);
  }
}

/* ---- Boot ------------------------------------------------ */
async function init() {
  setStatus('Loading voices…', 'loading');
  config = await fetchVoiceConfig();
  renderVoices(config);
  updateCounter();

  let storedSpeed = null;
  try {
    storedSpeed = localStorage.getItem(SPEED_KEY);
  } catch {}
  if (storedSpeed) els.speed.value = storedSpeed;
  els.speedOut.textContent = `${Number(els.speed.value).toFixed(2)}×`;

  setStatus(
    config.online
      ? 'Ready.'
      : 'Could not load voices from the API — using the built-in list. Is the backend running?',
    config.online ? 'idle' : 'error',
  );
}

els.form.addEventListener('submit', generate);

els.stop.addEventListener('click', () => {
  session.stop();
  setBusy(false);
  setStatus('Stopped.', 'idle');
});

els.text.addEventListener('input', updateCounter);

/* Ctrl/Cmd+Enter submits from inside the textarea. */
els.text.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    generate();
  }
});

els.speed.addEventListener('input', () => {
  els.speedOut.textContent = `${Number(els.speed.value).toFixed(2)}×`;
});

els.audio.addEventListener('ended', () => setStatus('Finished playing.', 'idle'));

/* Blob URLs are process-wide; release ours when leaving the page. */
window.addEventListener('pagehide', () => session.dispose());

mountTargetCursor({
  spinDuration: 2,
  hoverDuration: 0.2,
  parallaxOn: true,
  cursorColor: '#fbf3e6',
  cursorColorOnTarget: '#edb46a',
});

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
document.querySelectorAll('[data-bg-video]').forEach((v) => {
  if (reduced) v.pause();
  else v.play().catch(() => {});
});

init();
