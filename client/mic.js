/* ============================================================
   Microphone transcription client.

   Wraps the browser's SpeechRecognition (Web Speech API) so callers
   get a small start/stop session instead of the raw, callback-heavy
   API. Runs entirely client-side, no backend involved — same
   "works with no backend" posture as the mock agent in speak.js.

   Permission is requested EXPLICITLY via getUserMedia before
   recognition starts. SpeechRecognition will often prompt on its own,
   but not always, and when it doesn't the failure is completely
   silent — no prompt, no error, no state change. Asking directly
   guarantees the browser's mic prompt appears and gives us a real
   error to show when it's refused.

   Requires a secure context (https:// or localhost). On plain http://
   from any other host the mic APIs are absent and nothing can work —
   that case is detected and reported rather than failing silently.

   Chrome/Edge only; Firefox and Safari don't implement recognition.

     const mic = new MicSession({
       onInterim: (text) => ...,   // partial, still-listening text
       onFinal: (text) => ...,     // a completed utterance
       onStateChange: (listening) => ...,
       onStatus: (message) => ..., // human-readable progress
       onError: (kind, message) => ...,
     });
     await mic.start();
     mic.stop();
   ============================================================ */

const SpeechRecognitionImpl =
  typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);

export class MicSession {
  constructor({ onInterim, onFinal, onStateChange, onStatus, onError, lang = 'en-US' } = {}) {
    this.onInterim = onInterim || (() => {});
    this.onFinal = onFinal || (() => {});
    this.onStateChange = onStateChange || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onError = onError || (() => {});
    this.lang = lang;

    this.recognition = null;
    this.listening = false; // intent — stays true across the auto-restarts Chrome forces
    this.starting = false;
    this.restartTimer = null;
    this.sawResult = false; // proves the speech service actually answered
    this.watchdog = null;
  }

  get isSupported() {
    return Boolean(SpeechRecognitionImpl);
  }

  /** True on https:// and on localhost; false on plain http:// elsewhere. */
  get isSecure() {
    if (typeof window === 'undefined') return false;
    if (window.isSecureContext) return true;
    const host = window.location.hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '';
  }

  /**
   * Ask the browser for the microphone. This is what makes the permission
   * prompt appear. Resolves true if granted.
   */
  async requestPermission() {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.onError('insecure', 'Microphone unavailable — the page must be served over https:// or localhost.');
      return false;
    }

    try {
      this.onStatus('requesting microphone permission…');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // We only needed the grant; recognition opens its own capture.
      stream.getTracks().forEach((track) => track.stop());
      this.onStatus('microphone permission granted');
      return true;
    } catch (error) {
      const name = error?.name || '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        this.onError('denied', 'Microphone access was denied. Allow it in the address-bar icon, then try again.');
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        this.onError('nomic', 'No microphone was found on this device.');
      } else {
        this.onError('error', `Microphone error: ${name || error}`);
      }
      return false;
    }
  }

  async start() {
    if (this.listening || this.starting) return false;

    if (!this.isSecure) {
      this.onError('insecure', 'Microphone needs https:// or localhost — this page is not a secure context.');
      return false;
    }
    if (!this.isSupported) {
      this.onError('unsupported', 'This browser cannot transcribe speech (Chrome or Edge required).');
      return false;
    }

    this.starting = true;
    try {
      const granted = await this.requestPermission();
      if (!granted) return false;

      this.listening = true;
      this.sawResult = false;
      this._open();

      // If the speech service never answers, say so instead of sitting
      // on a "listening" pill that does nothing. Chromium builds without
      // Google's speech keys fail exactly this way.
      clearTimeout(this.watchdog);
      this.watchdog = setTimeout(() => {
        if (this.listening && !this.sawResult) {
          this.onStatus('listening — no speech detected yet');
        }
      }, 6000);

      return true;
    } finally {
      this.starting = false;
    }
  }

  stop() {
    this.listening = false;
    clearTimeout(this.restartTimer);
    clearTimeout(this.watchdog);
    if (this.recognition) {
      this.recognition.onend = null; // don't let the manual stop trigger a restart
      try {
        this.recognition.stop();
      } catch {}
      this.recognition = null;
    }
    this.onStateChange(false);
  }

  _open() {
    const recognition = new SpeechRecognitionImpl();
    recognition.lang = this.lang;
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onstart = () => this.onStateChange(true);

    recognition.onresult = (event) => {
      this.sawResult = true;
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0].transcript.trim();
        if (!text) continue;
        if (result.isFinal) this.onFinal(text);
        else interim += `${text} `;
      }
      if (interim) this.onInterim(interim.trim());
    };

    recognition.onerror = (event) => {
      // "no-speech" fires constantly during natural pauses — not a real error.
      if (event.error === 'no-speech' || event.error === 'aborted') return;

      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        this.listening = false;
        this.onError('denied', 'Microphone access was denied.');
        this.onStateChange(false);
        return;
      }
      if (event.error === 'network') {
        // Recognition is a cloud service — offline, or a Chromium build
        // without Google's speech API keys.
        this.listening = false;
        this.onError('network', 'Speech service unreachable. Needs internet and Chrome/Edge.');
        this.onStateChange(false);
        return;
      }
      this.onError('error', `Speech recognition error: ${event.error}`);
    };

    // Chrome ends the session after a stretch of silence even with
    // continuous:true. Restart transparently while we still intend to listen.
    recognition.onend = () => {
      if (!this.listening) {
        this.onStateChange(false);
        return;
      }
      this.restartTimer = setTimeout(() => {
        if (this.listening) this._open();
      }, 250);
    };

    this.recognition = recognition;
    try {
      recognition.start();
    } catch {
      // start() throws if called while a session is already starting —
      // benign, the existing session is still on its way up.
    }
  }
}
