# Text to speech, running in-process with Kokoro (ONNX).
#
# Why in-process and not a browser API: the machine this demos on only
# exposes three SAPI5 voices to speechSynthesis (David, Mark, Zira) - all
# robotic, and gender selection is unreliable. Kokoro gives 54 lifelike
# voices whose gender and accent are fixed by the voice id:
#
#     af_*  American female      am_*  American male
#     bf_*  British  female      bm_*  British  male
#
# Setup (see TTS-SETUP.md):
#     pip install -r requirements-tts.txt
#     download kokoro-v1.0.onnx + voices-v1.0.bin into api/models/
#
# Everything here degrades softly. If the package or the model files are
# missing, the import does not explode and the endpoints return 503 - so
# the API still deploys to Vercel (where the model deliberately is not
# shipped) and auth/ai keep working.

import asyncio
import io
import os
import threading
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/tts", tags=["tts"])


# ---- Optional dependency -------------------------------------------

try:
    from kokoro_onnx import Kokoro
    import soundfile as sf

    KOKORO_IMPORTED = True
    IMPORT_ERROR = ""
except Exception as error:  # ImportError, or a broken native wheel
    KOKORO_IMPORTED = False
    IMPORT_ERROR = f"{type(error).__name__}: {error}"


# ---- Configuration -------------------------------------------------

_HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

MODEL_PATH = os.environ.get("KOKORO_MODEL_PATH", os.path.join(_HERE, "models", "kokoro-v1.0.onnx"))
VOICES_PATH = os.environ.get("KOKORO_VOICES_PATH", os.path.join(_HERE, "models", "voices-v1.0.bin"))

DEFAULT_VOICE = os.environ.get("KOKORO_DEFAULT_VOICE", "af_heart")
TTS_MAX_CHARS = int(os.environ.get("TTS_MAX_CHARS", "1000"))
TTS_LANG = os.environ.get("KOKORO_LANG", "en-us")

SPEED_MIN, SPEED_MAX = 0.5, 2.0

# Gender/accent are a property of the voice id prefix, which is what makes
# "give me a female British voice" answerable without a lookup table of
# every name.
GROUPS = {
    "af": ("American", "female"),
    "am": ("American", "male"),
    "bf": ("British", "female"),
    "bm": ("British", "male"),
}

# Kokoro also ships Spanish/French/Hindi/Italian/Japanese/Portuguese/
# Chinese voices (ef_, ff_, hf_, if_, jf_, pf_, zf_ ...). We synthesize
# with lang="en-us", so those mangle English text - hide them unless
# somebody deliberately asks for the full list.
INCLUDE_NON_ENGLISH = os.environ.get("KOKORO_ALL_LANGUAGES", "").lower() in ("1", "true", "yes")


def is_english(voice_id: str) -> bool:
    return voice_id[:2] in GROUPS


def selectable_voices(model) -> list:
    voices = sorted(model.get_voices())
    if INCLUDE_NON_ENGLISH:
        return voices
    return [v for v in voices if is_english(v)]


# ---- Lazy model ----------------------------------------------------
# ~340MB and about a second to load. Doing it at import time would slow
# every app start, including the ones that never speak.

_model: Optional["Kokoro"] = None
_model_lock = threading.Lock()


def models_present() -> bool:
    return os.path.isfile(MODEL_PATH) and os.path.isfile(VOICES_PATH)


def unavailable_reason() -> Optional[str]:
    if not KOKORO_IMPORTED:
        return f"kokoro-onnx is not installed ({IMPORT_ERROR}). Run: pip install -r requirements-tts.txt"
    if not models_present():
        return f"Model files missing. Expected {MODEL_PATH} and {VOICES_PATH} - see TTS-SETUP.md"
    return None


def get_model() -> "Kokoro":
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:  # re-check inside the lock
                _model = Kokoro(MODEL_PATH, VOICES_PATH)
    return _model


def require_model() -> "Kokoro":
    reason = unavailable_reason()
    if reason:
        raise HTTPException(status_code=503, detail=reason)
    return get_model()


def describe_voice(voice_id: str) -> dict:
    accent, gender = GROUPS.get(voice_id[:2], ("Other", "unspecified"))
    return {
        "id": voice_id,
        "label": voice_id.split("_", 1)[-1].replace("_", " ").title(),
        "gender": gender,
        "accent": accent,
        "group": f"{accent} {gender}",
    }


# ---- Schemas -------------------------------------------------------


class SpeechRequest(BaseModel):
    text: str
    voice: str = DEFAULT_VOICE
    speed: float = Field(default=1.0, ge=SPEED_MIN, le=SPEED_MAX)


# ---- Endpoints -----------------------------------------------------


@router.get("/health")
def health():
    """Whether speech can actually be produced, and why not if it can't."""
    reason = unavailable_reason()
    return {
        "available": reason is None,
        "detail": reason,
        "model_loaded": _model is not None,
        "model_path": MODEL_PATH,
    }


@router.get("/voices")
def list_voices():
    """Voice list for the dropdown, grouped by accent and gender."""
    reason = unavailable_reason()
    if reason:
        raise HTTPException(status_code=503, detail=reason)

    voices = selectable_voices(get_model())
    return {
        "voices": [describe_voice(v) for v in voices],
        "default": DEFAULT_VOICE,
        "speed": {"min": SPEED_MIN, "max": SPEED_MAX, "default": 1.0},
        "max_chars": TTS_MAX_CHARS,
    }


@router.post("")
@router.post("/")
async def synthesize(payload: SpeechRequest):
    """Generate speech and return it as a WAV.

    Nothing is written to disk - the audio only exists for this response.
    """
    model = require_model()

    text = (payload.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text is required.")
    if len(text) > TTS_MAX_CHARS:
        raise HTTPException(
            status_code=413,
            detail=f"Text is too long ({len(text)} characters). Limit is {TTS_MAX_CHARS}.",
        )

    available = selectable_voices(model)
    if payload.voice not in available:
        raise HTTPException(status_code=400, detail=f"Unknown voice '{payload.voice}'.")

    def render():
        samples, sample_rate = model.create(
            text, voice=payload.voice, speed=payload.speed, lang=TTS_LANG
        )
        buffer = io.BytesIO()
        sf.write(buffer, samples, sample_rate, format="WAV", subtype="PCM_16")
        return buffer.getvalue()

    try:
        # Synthesis is CPU-bound and blocking; keep it off the event loop
        # so concurrent requests (and the WebSocket) don't stall.
        audio = await asyncio.to_thread(render)
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"Synthesis failed: {type(error).__name__}: {error}")

    if not audio:
        raise HTTPException(status_code=500, detail="Synthesis produced no audio.")

    return Response(
        content=audio,
        media_type="audio/wav",
        headers={"Cache-Control": "no-store"},
    )
