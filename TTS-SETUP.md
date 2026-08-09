# Voices — self-hosted Kokoro TTS

Whisper speaks with [Kokoro](https://github.com/thewh1teagle/kokoro-onnx), an
82M-parameter TTS model running **in-process inside the FastAPI backend**. No
Docker, no paid API, no per-character fees.

## Why not the browser's built-in voices

`speechSynthesis` can only reach what the OS installs. On the demo laptop that
is three SAPI5 voices from ~2012:

| Voice | Gender |
| --- | --- |
| Microsoft David | male |
| Microsoft Mark | male |
| Microsoft Zira | female |

All robotic, and only one female. Chrome and Edge both expose the same three.
That is a hard ceiling — no amount of code makes those lifelike.

Kokoro gives **28 English voices** whose accent and gender are fixed by the
voice id, so "a British female voice" is a guarantee rather than a guess:

| Prefix | Meaning | Count |
| --- | --- | --- |
| `af_` | American female | 11 |
| `am_` | American male | 9 |
| `bf_` | British female | 4 |
| `bm_` | British male | 4 |

Generation is faster than realtime — about **0.8s for a 2.4s clip** on CPU.

---

## Setup

```bash
cd api
pip install -r requirements-tts.txt   # kokoro-onnx + soundfile
python download_voices.py             # ~340MB into api/models/, one time
```

Then start the API as usual:

```bash
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

Confirm it works:

```bash
curl http://localhost:8000/api/tts/health
# {"available": true, ...}
```

Serve the client and open the speaker page:

```bash
cd client && python -m http.server 5500
```

<http://localhost:5500/speak.html> — click **Voice** once to satisfy the
browser's autoplay policy, then drive it with the arrow keys.

---

## Why the deps are in a separate file

`requirements-tts.txt` is deliberately **not** `requirements.txt`.
`onnxruntime` plus the 340MB model exceeds Vercel's 250MB serverless function
limit and would break the entire deployment.

So:

- **Vercel** keeps working for auth and the AI agent. `/api/tts` returns `503`
  with an explanatory message rather than crashing the app.
- **Speech runs on the backend you run locally**, which is where the ESP32
  posts anyway (`http://<laptop-ip>:8000`).

Point the client at that backend with `?api=http://<laptop-ip>:8000`.

---

## API

### `POST /api/tts`

```json
{ "text": "I need to use the bathroom.", "voice": "af_heart", "speed": 1.0 }
```

Returns `audio/wav`. Nothing is written to disk.

| Status | Meaning |
| --- | --- |
| `400` | Empty text, or an unknown voice |
| `413` | Longer than `TTS_MAX_CHARS` (default 1000) |
| `500` | Synthesis failed |
| `503` | `kokoro-onnx` not installed, or model files missing |

### `GET /api/tts/voices`

The voice list grouped by accent and gender — the dropdown is built from this,
so voices are defined once, server-side.

### `GET /api/tts/health`

Whether speech can be produced, and *why not* if it can't. Check this first
when something is wrong.

---

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `KOKORO_MODEL_PATH` | `api/models/kokoro-v1.0.onnx` | Model file |
| `KOKORO_VOICES_PATH` | `api/models/voices-v1.0.bin` | Voice embeddings |
| `KOKORO_DEFAULT_VOICE` | `af_heart` | Voice when none is chosen |
| `KOKORO_LANG` | `en-us` | Phonemiser language |
| `KOKORO_ALL_LANGUAGES` | unset | Set to `1` to also list the Spanish/French/Hindi/Italian/Japanese/Portuguese/Chinese voices. They are hidden by default because we synthesize as `en-us` and they mangle English. |
| `TTS_MAX_CHARS` | `1000` | Rejects longer requests |

---

## Testing

1. **Voice picker** — the dropdown on the speaker page shows 4 groups
   (American/British × female/male), 28 voices total.
2. **Gender actually changes** — pick `bm_george`, then `af_heart`; the sample
   that plays on change should be clearly different.
3. **Speech on selection** — arrow keys to move, Enter to speak. Audio plays
   within about a second.
4. **Graceful failure** — stop the API and press Enter: the `VOICE` pill goes
   amber and the trace logs "speech failed", instead of silently doing nothing.
5. **Model missing** — rename `api/models/`, restart, hit
   `/api/tts/health`: `available: false` with a message telling you what to do.

Backend only:

```bash
curl -X POST http://localhost:8000/api/tts \
  -H 'Content-Type: application/json' \
  -d '{"text":"Hello, this is a test.","voice":"bf_emma"}' \
  --output test.wav
```

---

## Notes

- The model files are gitignored (`api/models/`). Every machine runs
  `python download_voices.py` once.
- First synthesis after a restart is ~1s slower — the model loads lazily on
  first use rather than at startup, so the API boots fast.
- Kokoro is free and runs offline once downloaded, but it still needs a
  machine to run on. There are no per-character costs.
