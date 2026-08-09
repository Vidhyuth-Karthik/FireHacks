/* ============================================================
   Text-to-speech client.

   Talks to our own backend (POST /api/tts), which forwards to the
   self-hosted Kokoro FastAPI server. The browser never learns the
   Kokoro address and never calls it directly.

   Owns the awkward parts so callers don't have to:
     - one in-flight request at a time (a new one aborts the old)
     - fetch timeout, distinguishable from a user-initiated abort
     - Blob URL lifecycle (the previous URL is revoked when replaced)

   Usage:
     const tts = new TtsSession(audioEl);
     await tts.speak({ text: 'Hello', voice: 'af_heart', speed: 1 });
     tts.stop();
     tts.dispose();   // on unload
   ============================================================ */

import { API_BASE_URL } from './config.js';

const TTS_URL = `${API_BASE_URL}/api/tts`;

/** Fallback if /api/tts/voices can't be reached — keeps the UI usable. */
export const FALLBACK_VOICES = [
  { id: 'af_heart', label: 'Heart', group: 'American female' },
  { id: 'af_bella', label: 'Bella', group: 'American female' },
  { id: 'af_nicole', label: 'Nicole', group: 'American female' },
  { id: 'af_sarah', label: 'Sarah', group: 'American female' },
  { id: 'am_adam', label: 'Adam', group: 'American male' },
  { id: 'am_michael', label: 'Michael', group: 'American male' },
  { id: 'bf_emma', label: 'Emma', group: 'British female' },
  { id: 'bf_isabella', label: 'Isabella', group: 'British female' },
  { id: 'bm_george', label: 'George', group: 'British male' },
  { id: 'bm_lewis', label: 'Lewis', group: 'British male' },
];

export const SPEED_MIN = 0.5;
export const SPEED_MAX = 2.0;
export const DEFAULT_VOICE = 'af_heart';
export const DEFAULT_MAX_CHARS = 2000;

/** Typed failure so the UI can show the right message per `kind`. */
export class TtsError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'TtsError';
    this.kind = kind; // empty | too_long | rate_limited | server | network | timeout | aborted
  }
}

/** Voice list + limits, straight from the backend (single source of truth). */
export async function fetchVoiceConfig({ timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${TTS_URL}/voices`, { signal: controller.signal });
    if (!response.ok) throw new Error(String(response.status));
    const data = await response.json();
    return {
      voices: data.voices?.length ? data.voices : FALLBACK_VOICES,
      defaultVoice: data.default || DEFAULT_VOICE,
      maxChars: data.max_chars || DEFAULT_MAX_CHARS,
      speed: data.speed || { min: SPEED_MIN, max: SPEED_MAX, default: 1.0 },
      online: true,
    };
  } catch {
    return {
      voices: FALLBACK_VOICES,
      defaultVoice: DEFAULT_VOICE,
      maxChars: DEFAULT_MAX_CHARS,
      speed: { min: SPEED_MIN, max: SPEED_MAX, default: 1.0 },
      online: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

export class TtsSession {
  /**
   * @param {HTMLAudioElement|null} audioEl element to play through
   * @param {{timeoutMs?: number}} options
   */
  constructor(audioEl = null, { timeoutMs = 60000 } = {}) {
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

  /** Drop the current Blob URL. Called before replacing it and on dispose. */
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
   * Synthesize and (optionally) play. Resolves with { url, blob, contentType }.
   * Throws TtsError on every failure path.
   */
  async speak({ text, voice = DEFAULT_VOICE, speed = 1.0, autoplay = true, maxChars = DEFAULT_MAX_CHARS }) {
    const trimmed = (text || '').trim();
    if (!trimmed) throw new TtsError('empty', 'Enter some text first.');
    if (trimmed.length > maxChars) {
      throw new TtsError('too_long', `Text is too long (${trimmed.length}/${maxChars} characters).`);
    }

    // A new request supersedes whatever was running.
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
          this.timedOut ? 'The speech server took too long.' : 'Cancelled.',
        );
      }
      throw new TtsError('network', 'Could not reach the server. Is the API running?');
    } finally {
      clearTimeout(timer);
      if (this.controller === controller) this.controller = null;
    }

    if (!response.ok) {
      // The backend sends JSON {detail} for its own errors.
      let detail = `Request failed (${response.status}).`;
      try {
        const body = await response.json();
        if (body?.detail) detail = body.detail;
      } catch {
        /* non-JSON error body — keep the generic message */
      }
      if (response.status === 429) throw new TtsError('rate_limited', detail);
      if (response.status === 413) throw new TtsError('too_long', detail);
      throw new TtsError('server', detail);
    }

    const contentType = response.headers.get('content-type') || 'audio/mpeg';
    const blob = await response.blob();
    if (!blob.size) throw new TtsError('server', 'The server returned empty audio.');

    // Replace the old URL only once the new audio is safely in hand.
    this.releaseUrl();
    this.objectUrl = URL.createObjectURL(blob);
    this.lastBlob = blob;

    if (this.audioEl) {
      this.audioEl.src = this.objectUrl;
      if (autoplay) {
        try {
          await this.audioEl.play();
        } catch {
          // Autoplay policy: needs a user gesture first. Not fatal —
          // the audio element is loaded and the user can hit play.
        }
      }
    }

    return { url: this.objectUrl, blob, contentType };
  }

  /** Filename for the download button, matched to the returned audio. */
  downloadName(contentType = 'audio/mpeg') {
    const ext = contentType.includes('wav') ? 'wav' : contentType.includes('ogg') ? 'ogg' : 'mp3';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `whisper-${stamp}.${ext}`;
  }

  dispose() {
    this.stop();
    this.releaseUrl();
    this.lastBlob = null;
  }
}
