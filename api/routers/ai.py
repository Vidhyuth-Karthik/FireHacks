# AI endpoints, backed by Featherless AI (serverless open-model inference).
#
# Two functions, matching the Step-0 contract the team froze:
#   predict_options(context) -> [str]   the 8 things this person might
#                                       want to say right now
#   expand(selection, context) -> str   that intent as a full sentence
#
# Featherless is OpenAI-compatible, so this is a plain chat-completions
# call with a different base URL. Configure with FEATHERLESS_API_KEY and
# FEATHERLESS_MODEL - see .env.example.
#
# IMPORTANT - reasoning models are slow, and this runs as a Vercel
# serverless function with (by default) a 10s execution limit.
# The default model is a plain instruct model (~2-4s/prediction) for
# that reason. Reasoning models - DeepSeek-R1 distills, QwQ, etc. -
# "think out loud" before answering: the R1-14B distill measured ~19-34s,
# QwQ-32B ~40s. Both will time out as a Vercel function unless you migrate
# vercel.json off the legacy builds/routes format to set a longer
# maxDuration. /expand defaults to a template regardless, since it sits
# on the press-to-speak path where even a fast model's latency is too
# slow - pass use_model=true there only if you've solved the timeout.

import json
import os
import re
from typing import List, Optional

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/api/ai", tags=["ai"])


# ---- Configuration -------------------------------------------------

FEATHERLESS_BASE_URL = os.environ.get(
    "FEATHERLESS_BASE_URL", "https://api.featherless.ai/v1"
).rstrip("/")
FEATHERLESS_API_KEY = os.environ.get("FEATHERLESS_API_KEY", "")
FEATHERLESS_MODEL = os.environ.get("FEATHERLESS_MODEL", "Qwen/Qwen2.5-14B-Instruct")
FEATHERLESS_TIMEOUT = float(os.environ.get("FEATHERLESS_TIMEOUT", "90"))

OPTION_COUNT = 8


# ---- Fallback ------------------------------------------------------
# If the key is missing or the model is slow/down, the demo must still
# work. These are the same eight compass roles the ring expects.
FALLBACK_OPTIONS = {
    "morning": [
        "Bathroom", "Breakfast", "Too cold", "Sit me up",
        "My back hurts", "Call my daughter", "Open the curtains", "I'm alright",
    ],
    "afternoon": [
        "Bathroom", "Something to drink", "Too cold", "Help me move",
        "I'm in pain", "I want company", "Put the TV on", "I'm alright",
    ],
    "evening": [
        "Bathroom", "Dinner", "I'm cold", "Ready for bed",
        "I'm in pain", "Call my son", "Dim the light", "I'm alright",
    ],
    "night": [
        "Bathroom", "I'm thirsty", "I'm cold", "Can't sleep",
        "I'm in pain", "Please stay", "Turn the light off", "I'm alright",
    ],
}


# ---- Schemas -------------------------------------------------------


class Context(BaseModel):
    name: str = "Guest"
    part_of_day: str = "afternoon"
    common_needs: str = ""
    recent: List[str] = []
    rejected: List[str] = []


class PredictRequest(BaseModel):
    context: Context = Context()


class ExpandRequest(BaseModel):
    selection: str
    context: Context = Context()
    use_model: bool = False  # opt in to the slow, good path


# ---- Featherless client --------------------------------------------


async def chat(system: str, user: str, max_tokens: int = 900) -> str:
    """One chat completion against Featherless. Returns raw content."""
    if not FEATHERLESS_API_KEY:
        raise HTTPException(status_code=503, detail="FEATHERLESS_API_KEY is not set.")

    payload = {
        "model": FEATHERLESS_MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "max_tokens": max_tokens,
        "temperature": 0.7,
    }

    try:
        async with httpx.AsyncClient(timeout=FEATHERLESS_TIMEOUT) as client:
            response = await client.post(
                f"{FEATHERLESS_BASE_URL}/chat/completions",
                headers={
                    "Authorization": f"Bearer {FEATHERLESS_API_KEY}",
                    "Content-Type": "application/json",
                    # Featherless sits behind Cloudflare, which blocks some
                    # default client user-agents with "error code: 1010".
                    "User-Agent": "whisper-aac/1.0",
                },
                json=payload,
            )
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="The model took too long to respond.")
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="Could not reach Featherless.")

    if response.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail=f"Featherless error ({response.status_code}): {response.text[:200]}",
        )

    data = response.json()
    message = data["choices"][0]["message"]
    # Some models put the chain of thought in a separate field, most of
    # the R1 distills just inline it in content.
    return message.get("content") or message.get("reasoning_content") or ""


def strip_reasoning(text: str) -> str:
    """Drop the model's thinking so only the answer is left.

    R1-style models emit their reasoning first. Sometimes it is wrapped in
    <think> tags, often - on the distills - it is just loose prose ahead of
    the real answer. Removing the tagged form is easy; the loose form is
    handled by the extractors below, which look at the END of the text.
    """
    return re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()


def extract_json_array(text: str) -> Optional[list]:
    """Pull the last JSON array out of a reasoning model's ramble."""
    cleaned = strip_reasoning(text)

    # Prefer a fenced ```json block if there is one.
    fenced = re.findall(r"```(?:json)?\s*(\[.*?\])\s*```", cleaned, flags=re.DOTALL)
    candidates = list(fenced)

    # Otherwise every bracketed run, last one first - the answer comes
    # after the thinking.
    candidates += re.findall(r"\[[^\[\]]*\]", cleaned, flags=re.DOTALL)

    for candidate in reversed(candidates):
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, list) and parsed:
            return parsed
    return None


def last_sentence(text: str) -> str:
    """Take the final quoted or trailing line as the spoken sentence."""
    cleaned = strip_reasoning(text)

    quoted = re.findall(r'"([^"]{4,200})"', cleaned)
    if quoted:
        return quoted[-1].strip()

    lines = [line.strip(" -*`") for line in cleaned.splitlines() if line.strip()]
    return lines[-1] if lines else ""


# ---- Prompts -------------------------------------------------------

PREDICT_SYSTEM = f"""You help a non-verbal person with a communication aid.
They choose from {OPTION_COUNT} options using one joystick movement, so the
options must cover what they are most likely to need RIGHT NOW.

Return ONLY a JSON array of exactly {OPTION_COUNT} strings, in this fixed order:
1 urgent bodily need, 2 food or drink, 3 temperature or comfort,
4 position or movement, 5 pain, 6 people or contact, 7 environment
(light/sound/TV), 8 a reassuring "nothing needed" closer.

Each string is 1-4 words, plain, dignified, first person where natural.
No numbering, no explanation, no markdown outside the JSON array."""

EXPAND_SYSTEM = """You help a non-verbal person speak.
Turn their chosen short intent into ONE natural, polite, dignified sentence
in their own voice. First person. Under 20 words. No preamble.
Reply with ONLY the sentence in double quotes."""


def build_context_line(context: Context) -> str:
    parts = [f"name={context.name}", f"time of day={context.part_of_day}"]
    if context.common_needs:
        parts.append(f"usual needs={context.common_needs}")
    if context.recent:
        parts.append(f"recently said={', '.join(context.recent[-4:])}")
    if context.rejected:
        # This is the personalisation signal - what they just said "no" to.
        parts.append(f"just rejected (avoid these)={', '.join(context.rejected[-4:])}")
    return "; ".join(parts)


# ---- Endpoints -----------------------------------------------------


@router.get("/ping")
def ping():
    """Health check - reports config without leaking the key."""
    return {
        "message": "AI router is wired up and ready.",
        "provider": "featherless",
        "model": FEATHERLESS_MODEL,
        "key_configured": bool(FEATHERLESS_API_KEY),
    }


@router.post("/predict")
async def predict(request: PredictRequest):
    """The 8 things this person is most likely to want to say."""
    context = request.context

    try:
        raw = await chat(PREDICT_SYSTEM, build_context_line(context), max_tokens=900)
        options = extract_json_array(raw)
    except HTTPException:
        options = None

    if not options:
        # Model unavailable, too slow, or unparseable - keep the demo alive.
        return {
            "options": FALLBACK_OPTIONS.get(context.part_of_day, FALLBACK_OPTIONS["afternoon"]),
            "source": "fallback",
            "model": FEATHERLESS_MODEL,
        }

    options = [str(option).strip() for option in options if str(option).strip()]
    options = options[:OPTION_COUNT]

    # Pad from the fallback set so the ring always has 8 slots filled.
    filler = FALLBACK_OPTIONS.get(context.part_of_day, FALLBACK_OPTIONS["afternoon"])
    for candidate in filler:
        if len(options) >= OPTION_COUNT:
            break
        if candidate not in options:
            options.append(candidate)

    return {"options": options, "source": "model", "model": FEATHERLESS_MODEL}


@router.post("/expand")
async def expand(request: ExpandRequest):
    """Turn a chosen intent into a full sentence.

    Defaults to a template because this sits on the press-to-speak path and
    a reasoning model would add ~20s of silence. Pass use_model=true to get
    the model's version when latency does not matter.
    """
    selection = request.selection.strip()
    if not selection:
        raise HTTPException(status_code=400, detail="selection is required")

    if not request.use_model:
        return {"text": template_expand(selection), "source": "template"}

    try:
        raw = await chat(EXPAND_SYSTEM, f"{build_context_line(request.context)}\nIntent: {selection}", max_tokens=700)
        sentence = last_sentence(raw)
    except HTTPException:
        sentence = ""

    if not sentence:
        return {"text": template_expand(selection), "source": "fallback"}

    return {"text": sentence, "source": "model", "model": FEATHERLESS_MODEL}


# Bare nouns don't survive a generic template ("I would like bathroom"),
# so the intents we ship get a hand-written sentence.
PHRASE_TEMPLATES = {
    "bathroom": "I need to use the bathroom — could you help me?",
    "breakfast": "I'd like some breakfast, please.",
    "dinner": "I'd like my dinner now, please.",
    "something to drink": "I'm thirsty — could I have something to drink?",
    "something to eat": "I'm hungry — could I have something to eat?",
    "too cold": "I'm cold. Could I have another blanket?",
    "too warm": "I'm too warm — could you take a blanket off?",
    "sit me up": "Could you help me sit up a little, please?",
    "ready for bed": "I'm ready to go to bed now.",
    "help me move": "I've been like this too long — could you help me move?",
    "can't sleep": "I can't get to sleep. I've been lying here a long time.",
    "please stay": "Would you stay with me a while? I don't want to be alone.",
    "i want company": "I'd like some company for a while, if you can stay.",
}


def template_expand(selection: str) -> str:
    """Fast, predictable sentence for the critical path."""
    text = selection.strip()
    lowered = text.lower().rstrip(".!?")

    if lowered in PHRASE_TEMPLATES:
        return PHRASE_TEMPLATES[lowered]

    # Already a first-person statement - leave it alone.
    if lowered.startswith(("i ", "i'm", "im ", "my ", "can ", "could ", "would ", "please")):
        sentence = text
    # Imperative - turn into a polite request.
    elif lowered.startswith(
        ("call ", "open ", "turn ", "put ", "take ", "dim ", "help ", "sit ", "fix ", "bring ", "close ")
    ):
        sentence = f"Could you {lowered}, please?"
    else:
        sentence = f"I'd like {lowered}, please."

    if not sentence.endswith((".", "?", "!")):
        sentence += "."
    return sentence[0].upper() + sentence[1:]
