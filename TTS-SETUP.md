# Text to speech — self-hosted Kokoro FastAPI

Whisper generates speech with [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI),
a Dockerised wrapper around the Kokoro-82M model that exposes an
OpenAI-compatible `/v1/audio/speech` endpoint. No paid speech API is used
anywhere, and the browser's built-in `speechSynthesis` is not used either.

**On cost:** the software is free and there are no per-character API fees.
The server still has to run somewhere. On CPU that means roughly 2 GB of RAM
and a couple of cores; the first start downloads ~2 GB of model weights. In
production you are paying for a machine, just not per word.

---

## How the pieces fit

```
browser  ──POST /api/tts──▶  FastAPI (api/routers/tts.py)  ──▶  Kokoro :8880
         ◀──── audio bytes ──┘                              ◀── audio bytes
```

The browser never talks to Kokoro directly. That keeps the TTS server off the
public internet, means Kokoro needs no CORS configuration, and lets the backend
enforce length limits and rate limiting.

> **Note on origins.** In this project the client and API deploy as two
> separate Vercel projects, so the call is cross-origin rather than
> same-origin. That is already handled — the client sends requests to
> `API_BASE_URL`, and the API's existing `CORS_ORIGINS` allowlist covers it.
> The important property still holds: clients depend on *our* API, never on
> the TTS server.

---

## 1. Start Kokoro

With the Compose file in this repo:

```bash
docker compose up kokoro
```

Or standalone, without Compose:

```bash
docker run --rm -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest
```

Have an NVIDIA GPU? Use `ghcr.io/remsky/kokoro-fastapi-gpu:latest` with
`--gpus all` — it is dramatically faster.

Give it a minute on first run while the weights download. Check it:

```bash
curl http://localhost:8880/v1/audio/voices
```

Kokoro also ships a test page at <http://localhost:8880/web>.

## 2. Point the API at it

```bash
cd api
cp .env.example .env      # then fill in your Turso values
```

`.env.example` already contains the default:

```
TTS_BASE_URL=http://localhost:8880/v1
```

Running the API inside Compose instead? Use the service name —
`TTS_BASE_URL=http://kokoro:8880/v1`. The Compose file sets this for you.

## 3. Start the API

```bash
cd api
pip install -r requirements.txt
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

Confirm the API can see Kokoro:

```bash
curl http://localhost:8000/api/tts/health
# {"reachable": true, "status": 200}
```

## 4. Start the website

```bash
cd client
python -m http.server 5500
```

Open <http://localhost:5500/voice.html>. `client/config.js` defaults to
`http://localhost:8000` when served from localhost, so no configuration is
needed for local development.

---

## Configuration

All backend settings are environment variables, read in
[`api/routers/tts.py`](api/routers/tts.py).

| Variable | Default | Purpose |
| --- | --- | --- |
| `TTS_BASE_URL` | `http://localhost:8880/v1` | Kokoro base URL, including `/v1` |
| `TTS_MODEL` | `kokoro` | Model name sent in the OpenAI-shaped body |
| `TTS_DEFAULT_VOICE` | `af_heart` | Voice used when none is supplied |
| `TTS_RESPONSE_FORMAT` | `mp3` | `mp3`, `wav`, `opus`, `flac` |
| `TTS_MAX_CHARS` | `2000` | Rejects longer requests with `413` |
| `TTS_TIMEOUT_SECONDS` | `60` | Upstream timeout; exceeded returns `504` |
| `TTS_RATE_LIMIT_REQUESTS` | `20` | Requests allowed per window, per IP |
| `TTS_RATE_LIMIT_WINDOW_SECONDS` | `60` | Length of the window |

In production set `TTS_BASE_URL` in your host's environment settings — on
Vercel that is **Project → Settings → Environment Variables**. Point it at
wherever Kokoro actually runs; it does not have to be public, it only has to be
reachable from the API.

---

## API

### `POST /api/tts`

```json
{ "text": "Hello, this is a voice test.", "voice": "af_heart", "speed": 1.0 }
```

Returns raw audio with Kokoro's own content type (`audio/mpeg` by default).
Nothing is written to disk.

| Status | Meaning |
| --- | --- |
| `400` | Empty text, or an unknown voice |
| `413` | Longer than `TTS_MAX_CHARS` |
| `429` | Rate limited (`Retry-After` header included) |
| `502` | Kokoro unreachable or returned an error |
| `504` | Kokoro took longer than `TTS_TIMEOUT_SECONDS` |

### `GET /api/tts/voices`

The voice list, speed bounds and character limit. The frontend dropdown is
built from this, so voices are defined once, server-side.

### `GET /api/tts/health`

Whether Kokoro is reachable — useful for checking `TTS_BASE_URL` without
synthesizing anything.

---

## Testing it

1. **Voice studio** — <http://localhost:5500/voice.html>. Type text, pick a
   voice, set speed, press **Generate & play**. Audio should play
   automatically and a **Download audio** button should appear.
2. **Empty input** — press Generate with an empty box: an inline error, no
   request sent.
3. **Duplicate requests** — press Generate twice quickly: the button disables
   and shows a spinner; only one request goes out.
4. **Stop** — press Stop mid-generation: the request aborts and the status
   reads "Stopped."
5. **Server error** — stop the Kokoro container and press Generate: you should
   see "Could not reach the speech server. Is Kokoro running?"
6. **Network error** — stop the API and press Generate: "Could not reach the
   API. Is the backend running?"
7. **Rate limit** — hold Enter to fire >20 requests in a minute: `429` with a
   "Slow down" message.
8. **Speaker page** — <http://localhost:5500/speak.html>, click once to enable
   voice, then use arrow keys and Enter. Sentences are spoken through Kokoro.
9. **Keyboard/screen reader** — tab through the studio: every control has a
   visible focus ring, and status changes are announced via `aria-live`.

Backend only:

```bash
curl -X POST http://localhost:8000/api/tts \
  -H 'Content-Type: application/json' \
  -d '{"text":"Hello from Kokoro.","voice":"af_heart","speed":1.0}' \
  --output test.mp3
```

---

## Deployment notes

- **Vercel's Python runtime is a poor host for this.** Functions are short-lived
  and payload-limited, and the in-memory rate limiter resets per invocation.
  Run the API on a persistent host (Fly.io, Railway, a VPS, or the existing
  Hugging Face Docker Space) if TTS is on the critical path.
- **The rate limiter is per-process.** It stops one browser hammering the
  endpoint; it is not a distributed limiter. Move it to Redis if you run more
  than one worker.
- **`/api/tts` is unauthenticated.** That suits the demo, where nobody logs in.
  To lock it down, copy the `get_current_user` pattern from
  [`api/routers/ai.py`](api/routers/ai.py).
