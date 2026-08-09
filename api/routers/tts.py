# Text-to-speech endpoints, backed by a self-hosted Kokoro FastAPI server.
#
# The browser never talks to the Kokoro server directly. It POSTs here,
# and this router forwards the request on. Two reasons:
#   1. The Kokoro server's address stays server-side, so it doesn't have
#      to be reachable from (or known to) the public internet.
#   2. No CORS configuration is needed on Kokoro itself.
#
# Kokoro exposes an OpenAI-compatible speech endpoint, so the forwarded
# body is the same shape the OpenAI SDK would send:
#
#     POST {TTS_BASE_URL}/audio/speech
#     {"model": "kokoro", "input": "...", "voice": "af_heart",
#      "response_format": "mp3", "speed": 1.0}
#
# Everything is configured with environment variables - see .env.example.

import os
import time
from collections import defaultdict, deque
from typing import Deque, Dict

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/tts", tags=["tts"])


# ---- Configuration -------------------------------------------------

# Base URL of the Kokoro server, including the /v1 suffix.
TTS_BASE_URL = os.environ.get("TTS_BASE_URL", "http://localhost:8880/v1").rstrip("/")

# Kokoro ignores the model name but the OpenAI-compatible schema requires it.
TTS_MODEL = os.environ.get("TTS_MODEL", "kokoro")

# Guard rails. Long inputs mean long synthesis times and big responses,
# so cap the request rather than letting a single caller tie up the server.
TTS_MAX_CHARS = int(os.environ.get("TTS_MAX_CHARS", "2000"))
TTS_TIMEOUT_SECONDS = float(os.environ.get("TTS_TIMEOUT_SECONDS", "60"))

TTS_DEFAULT_VOICE = os.environ.get("TTS_DEFAULT_VOICE", "af_heart")
TTS_RESPONSE_FORMAT = os.environ.get("TTS_RESPONSE_FORMAT", "mp3")

SPEED_MIN = 0.5
SPEED_MAX = 2.0

# Simple fixed-window rate limit, per client IP.
RATE_LIMIT_REQUESTS = int(os.environ.get("TTS_RATE_LIMIT_REQUESTS", "20"))
RATE_LIMIT_WINDOW_SECONDS = float(os.environ.get("TTS_RATE_LIMIT_WINDOW_SECONDS", "60"))


# The voice list is defined here, server-side, and served to the frontend
# from /api/tts/voices - so the dropdown has a single source of truth and
# adding a voice doesn't mean editing JavaScript. Names come from the
# Kokoro-82M voice packs shipped with Kokoro FastAPI.
VOICES = [
    {"id": "af_heart", "label": "Heart", "group": "American female"},
    {"id": "af_alloy", "label": "Alloy", "group": "American female"},
    {"id": "af_aoede", "label": "Aoede", "group": "American female"},
    {"id": "af_bella", "label": "Bella", "group": "American female"},
    {"id": "af_jessica", "label": "Jessica", "group": "American female"},
    {"id": "af_kore", "label": "Kore", "group": "American female"},
    {"id": "af_nicole", "label": "Nicole", "group": "American female"},
    {"id": "af_nova", "label": "Nova", "group": "American female"},
    {"id": "af_river", "label": "River", "group": "American female"},
    {"id": "af_sarah", "label": "Sarah", "group": "American female"},
    {"id": "af_sky", "label": "Sky", "group": "American female"},
    {"id": "am_adam", "label": "Adam", "group": "American male"},
    {"id": "am_echo", "label": "Echo", "group": "American male"},
    {"id": "am_eric", "label": "Eric", "group": "American male"},
    {"id": "am_fenrir", "label": "Fenrir", "group": "American male"},
    {"id": "am_liam", "label": "Liam", "group": "American male"},
    {"id": "am_michael", "label": "Michael", "group": "American male"},
    {"id": "am_onyx", "label": "Onyx", "group": "American male"},
    {"id": "am_puck", "label": "Puck", "group": "American male"},
    {"id": "bf_alice", "label": "Alice", "group": "British female"},
    {"id": "bf_emma", "label": "Emma", "group": "British female"},
    {"id": "bf_isabella", "label": "Isabella", "group": "British female"},
    {"id": "bf_lily", "label": "Lily", "group": "British female"},
    {"id": "bm_daniel", "label": "Daniel", "group": "British male"},
    {"id": "bm_fable", "label": "Fable", "group": "British male"},
    {"id": "bm_george", "label": "George", "group": "British male"},
    {"id": "bm_lewis", "label": "Lewis", "group": "British male"},
]

VOICE_IDS = {voice["id"] for voice in VOICES}


# ---- Rate limiting -------------------------------------------------
# In-memory and therefore per-process: good enough to stop one browser
# hammering the endpoint, not a substitute for a real limiter if this
# ever runs multi-worker or serverless. Swap in Redis if that changes.
_request_log: Dict[str, Deque[float]] = defaultdict(deque)


def enforce_rate_limit(client_ip: str) -> None:
    now = time.monotonic()
    window_start = now - RATE_LIMIT_WINDOW_SECONDS
    hits = _request_log[client_ip]

    while hits and hits[0] < window_start:
        hits.popleft()

    if len(hits) >= RATE_LIMIT_REQUESTS:
        retry_after = int(hits[0] + RATE_LIMIT_WINDOW_SECONDS - now) + 1
        raise HTTPException(
            status_code=429,
            detail=f"Too many requests. Try again in {retry_after}s.",
            headers={"Retry-After": str(retry_after)},
        )

    hits.append(now)


# ---- Schemas -------------------------------------------------------


class SpeechRequest(BaseModel):
    text: str
    voice: str = TTS_DEFAULT_VOICE
    speed: float = Field(default=1.0, ge=SPEED_MIN, le=SPEED_MAX)


# ---- Endpoints -----------------------------------------------------


@router.get("/voices")
def list_voices():
    """The voice list the frontend dropdown is built from."""
    return {
        "voices": VOICES,
        "default": TTS_DEFAULT_VOICE,
        "speed": {"min": SPEED_MIN, "max": SPEED_MAX, "default": 1.0},
        "max_chars": TTS_MAX_CHARS,
    }


@router.get("/health")
async def health():
    """Report whether the Kokoro server is actually reachable.

    Useful during setup - it tells you whether TTS_BASE_URL is right
    without having to synthesize anything.
    """
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(f"{TTS_BASE_URL}/audio/voices")
        return {"reachable": response.status_code < 500, "status": response.status_code}
    except httpx.HTTPError as error:
        return {"reachable": False, "error": type(error).__name__, "detail": str(error)}


@router.post("")
@router.post("/")
async def synthesize(payload: SpeechRequest, request: Request):
    """Turn text into speech using the self-hosted Kokoro server.

    Returns raw audio bytes with whatever content type Kokoro produced,
    so the browser can drop the response straight into an <audio> element.
    Nothing is written to disk - the audio only exists for this response.
    """
    enforce_rate_limit(request.client.host if request.client else "unknown")

    text = (payload.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text is required.")

    if len(text) > TTS_MAX_CHARS:
        raise HTTPException(
            status_code=413,
            detail=f"Text is too long ({len(text)} characters). Limit is {TTS_MAX_CHARS}.",
        )

    if payload.voice not in VOICE_IDS:
        raise HTTPException(status_code=400, detail=f"Unknown voice '{payload.voice}'.")

    body = {
        "model": TTS_MODEL,
        "input": text,
        "voice": payload.voice,
        "response_format": TTS_RESPONSE_FORMAT,
        "speed": payload.speed,
    }

    try:
        async with httpx.AsyncClient(timeout=TTS_TIMEOUT_SECONDS) as client:
            response = await client.post(f"{TTS_BASE_URL}/audio/speech", json=body)
    except httpx.TimeoutException:
        raise HTTPException(
            status_code=504,
            detail="The speech server took too long to respond.",
        )
    except httpx.HTTPError:
        # Almost always "Kokoro isn't running" or TTS_BASE_URL is wrong.
        raise HTTPException(
            status_code=502,
            detail="Could not reach the speech server. Is Kokoro running?",
        )

    if response.status_code >= 400:
        # Pass along Kokoro's own complaint (truncated) - it's usually
        # something actionable like an unknown voice.
        raise HTTPException(
            status_code=502,
            detail=f"Speech server error ({response.status_code}): {response.text[:200]}",
        )

    audio = response.content
    if not audio:
        raise HTTPException(status_code=502, detail="Speech server returned empty audio.")

    return Response(
        content=audio,
        media_type=response.headers.get("content-type", "audio/mpeg"),
        headers={
            "Cache-Control": "no-store",
            "Content-Disposition": 'inline; filename="whisper-speech"',
        },
    )
