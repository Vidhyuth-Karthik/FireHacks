/* ============================================================
   Text-to-speech client.

   Speech comes from our own backend (POST /api/tts), which runs Kokoro
   in-process. The browser's speechSynthesis is deliberately not used:
   this machine only exposes three robotic SAPI5 voices to it, and voice
   gender is not reliably selectable.

   Owns the awkward parts so callers don't have to:
     - one in-flight request at a time (a new one aborts the old)
     - fetch timeout, distinguishable from a user-initiated abort
     - Blob URL lifecycle (the previous URL is revoked when replaced)

     const tts = new TtsSession(audioEl);
     await tts.speak({ text: 'Hello', voice: 'af_heart' });
     tts.stop();
     tts.dispose();
   ============================================================ */

import { API_BASE_URL } from './config.js';

const TTS_URL = `${API_BASE_URL}/api/tts`;

export const DEFAULT_VOICE = 'af_heart';
export const DEFAULT_MAX_CHARS = 1000;

/* Shown if the backend can't be reached. Gender/accent live in the id
   prefix: af=American female, am=American male, bf/bm=British. */
export const FALLBACK_VOICES = [
  { id: 'af_heart', label: 'Heart', gender: 'female', accent: 'American', group: 'American female' },
  { id: 'af_bella', label: 'Bella', gender: 'female', accent: 'American', group: 'American female' },
  { id: 'am_michael', label: 'Michael', gender: 'male', accent: 'American', group: 'American male' },
  { id: 'am_adam', label: 'Adam', gender: 'male', accent: 'American', group: 'American male' },
  { id: 'bf_emma', label: 'Emma', gender: 'female', accent: 'British', group: 'British female' },
  { id: 'bm_george', label: 'George', gender: 'male', accent: 'British', group: 'British male' },
];

/** Typed failure so the UI can react per `kind`. */
export class TtsError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'TtsError';
    this.kind = kind; // empty | too_long | unavailable | server | network | timeout | aborted
  }
}

/** Voice list + limits from the backend (single source of truth). */
export async function fetchVoiceConfig({ timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${TTS_URL}/voices`, { signal: controller.signal });
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        detail = (await response.json())?.detail || detail;
      } catch {}
      return { voices: FALLBACK_VOICES, defaultVoice: DEFAULT_VOICE, maxChars: DEFAULT_MAX_CHARS, online: false, detail };
    }
    const data = await response.json();
    return {
      voices: data.voices?.length ? data.voices : FALLBACK_VOICES,
      defaultVoice: data.default || DEFAULT_VOICE,
      maxChars: data.max_chars || DEFAULT_MAX_CHARS,
      online: true,
      detail: '',
    };
  } catch {
    return {
      voices: FALLBACK_VOICES,
      defaultVoice: DEFAULT_VOICE,
      maxChars: DEFAULT_MAX_CHARS,
      online: false,
      detail: 'Could not reach the API.',
    };
  } finally {
    clearTimeout(timer);
  }
}

export class TtsSession {
  constructor(audioEl = null, { timeoutMs = 45000 } = {}) {
    this.audioEl = audioEl;
    this.timeoutMs = timeoutMs;
    this.objectUrl = null;
    this.lastBlob = null;
    this.controller = null;
    this.timedOut = false;
  }

  get isBusy() {
    return this.controller !== null;
  }

  releaseUrl() {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  /** Cancel any in-flight request and stop playback. */
  stop() {
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
    if (this.audioEl) {
      this.audioEl.pause();
      this.audioEl.currentTime = 0;
    }
  }

  /**
   * Synthesize and (optionally) play. Resolves { url, blob, contentType }.
   * Throws TtsError on every failure path.
   */
  async speak({ text, voice = DEFAULT_VOICE, speed = 1.0, autoplay = true, maxChars = DEFAULT_MAX_CHARS }) {
    const trimmed = (text || '').trim();
    if (!trimmed) throw new TtsError('empty', 'Nothing to say.');
    if (trimmed.length > maxChars) {
      throw new TtsError('too_long', `Text is too long (${trimmed.length}/${maxChars}).`);
    }

    // A new utterance supersedes whatever was running.
    if (this.controller) this.controller.abort();

    const controller = new AbortController();
    this.controller = controller;
    this.timedOut = false;

    const timer = setTimeout(() => {
      this.timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    let response;
    try {
      response = await fetch(TTS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: trimmed, voice, speed }),
        signal: controller.signal,
      });
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new TtsError(
          this.timedOut ? 'timeout' : 'aborted',
          this.timedOut ? 'Speech generation took too long.' : 'Cancelled.',
        );
      }
      throw new TtsError('network', 'Could not reach the API. Is the backend running?');
    } finally {
      clearTimeout(timer);
      if (this.controller === controller) this.controller = null;
    }

    if (!response.ok) {
      let detail = `Request failed (${response.status}).`;
      try {
        detail = (await response.json())?.detail || detail;
      } catch {}
      if (response.status === 503) throw new TtsError('unavailable', detail);
      if (response.status === 413) throw new TtsError('too_long', detail);
      throw new TtsError('server', detail);
    }

    const contentType = response.headers.get('content-type') || 'audio/wav';
    const blob = await response.blob();
    if (!blob.size) throw new TtsError('server', 'The server returned empty audio.');

    // Swap the URL only once the new audio is safely in hand.
    this.releaseUrl();
    this.objectUrl = URL.createObjectURL(blob);
    this.lastBlob = blob;

    if (this.audioEl) {
      this.audioEl.src = this.objectUrl;
      if (autoplay) {
        try {
          await this.audioEl.play();
        } catch {
          // Autoplay policy - needs a user gesture first. Not fatal.
        }
      }
    }

    return { url: this.objectUrl, blob, contentType };
  }

  dispose() {
    this.stop();
    this.releaseUrl();
    this.lastBlob = null;
  }
}
