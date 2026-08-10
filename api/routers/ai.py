# AI endpoints, backed by Azure OpenAI (Responses API).
#
# Two functions, matching the Step-0 contract the team froze:
#   predict_options(context) -> [str]   the 8 things this person might
#                                       want to say right now
#   expand(selection, context) -> str   that intent as a full sentence
#
# Configure with AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT (the full
# .../openai/v1/responses URL for your resource) and AZURE_OPENAI_DEPLOYMENT
# - see .env.example.
#
# IMPORTANT - reasoning models are slow, and this runs as a Vercel
# serverless function with (by default) a 10s execution limit.
# Plain instruct deployments (gpt-4o-mini and similar) measure ~2-4s per
# prediction, which is why that's the expected deployment target here.
# Reasoning models "think out loud" before answering and can take 20-40s+,
# which will time out as a Vercel function unless you migrate vercel.json
# off the legacy builds/routes format to set a longer maxDuration.
# /expand defaults to a template regardless, since it sits on the
# press-to-speak path where even a fast model's latency is too
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

AZURE_OPENAI_ENDPOINT = os.environ.get("AZURE_OPENAI_ENDPOINT", "")
AZURE_OPENAI_API_KEY = os.environ.get("AZURE_OPENAI_API_KEY", "")
AZURE_OPENAI_DEPLOYMENT = os.environ.get("AZURE_OPENAI_DEPLOYMENT", "")
AZURE_OPENAI_TIMEOUT = float(os.environ.get("AZURE_OPENAI_TIMEOUT", "90"))

OPTION_COUNT = 8

# Replies live on the same 8-slot ring, so a user keeps their positional
# memory when the wheel flips from needs to replies.
VALID_INTENTS = {"need", "yes", "no", "feeling", "social", "question"}


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
    # Recent room speech transcribed via the mic (client/mic.js), most
    # recent last - a tie-breaker signal, same spirit as `recent`.
    heard: List[str] = []
    # Optional device sensors. Tie-breakers only - see build_context_line.
    temperature_f: Optional[float] = None
    light_lux: Optional[float] = None


class PredictRequest(BaseModel):
    context: Context = Context()


class RespondRequest(BaseModel):
    """What the other person just said, to be answered."""

    heard: str
    context: Context = Context()


class ExpandRequest(BaseModel):
    selection: str
    context: Context = Context()
    use_model: bool = False  # opt in to the slow, good path


# ---- Azure OpenAI client --------------------------------------------


def extract_output_text(data: dict) -> str:
    """Pull the text out of a Responses API payload.

    The API offers a convenience `output_text` string; when that's absent
    (or empty) fall back to walking the `output` array of message items,
    each holding one or more content parts.
    """
    text = data.get("output_text")
    if isinstance(text, str) and text.strip():
        return text

    parts = []
    for item in data.get("output") or []:
        if item.get("type") != "message":
            continue
        for content in item.get("content") or []:
            if content.get("type") in ("output_text", "text") and content.get("text"):
                parts.append(content["text"])
    return "".join(parts)


async def chat(system: str, user: str, max_tokens: int = 900) -> str:
    """One Responses API call against Azure OpenAI. Returns the model's text."""
    if not (AZURE_OPENAI_API_KEY and AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_DEPLOYMENT):
        raise HTTPException(
            status_code=503,
            detail="Azure OpenAI is not configured (AZURE_OPENAI_API_KEY / "
            "AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_DEPLOYMENT).",
        )

    payload = {
        "model": AZURE_OPENAI_DEPLOYMENT,
        "instructions": system,
        "input": user,
        "max_output_tokens": max_tokens,
        # No sampling `temperature` here - some deployments reject it on
        # the Responses surface, and it's unrelated to the room-temperature
        # sensor value that also flows through this router.
    }

    try:
        async with httpx.AsyncClient(timeout=AZURE_OPENAI_TIMEOUT) as client:
            response = await client.post(
                AZURE_OPENAI_ENDPOINT,
                headers={
                    "Authorization": f"Bearer {AZURE_OPENAI_API_KEY}",
                    "Content-Type": "application/json",
                },
                json=payload,
            )
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="The model took too long to respond.")
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="Could not reach Azure OpenAI.")

    if response.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail=f"Azure OpenAI error ({response.status_code}): {response.text[:200]}",
        )

    return extract_output_text(response.json())


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
No numbering, no explanation, no markdown outside the JSON array.

The context line may include what was recently overheard in the room and
the temperature/light. Treat both as gentle tie-breakers only, never the
main basis for a slot - e.g. a cold room can nudge slot 3 toward
"too cold", overheard talk of food can nudge slot 2. The fixed 8-slot
order above always wins over anything overheard."""

EXPAND_SYSTEM = """You help a non-verbal person speak.
Turn their chosen short intent into ONE natural, polite, dignified sentence
in their own voice. First person. Under 20 words. No preamble.
Reply with ONLY the sentence in double quotes."""

# Someone has spoken TO the user; these are answers, not needs. Same eight
# slots as the needs wheel so positional memory survives the switch.
RESPOND_SYSTEM = f"""You are the prediction engine inside a communication aid used
by a person who cannot speak easily. Someone has just spoken TO them. Offer the
{OPTION_COUNT} things the USER is most likely to want to say BACK, right now.

Write in FIRST PERSON, as the user. Each reply is 1-5 words, plain and dignified.
Answer what was actually said - if they were greeted, greet back; if asked a
question, answer it.

Return ONLY a JSON array of exactly {OPTION_COUNT} objects, in this fixed order:
1 agree or say yes, 2 decline or say no, 3 a greeting or social reply,
4 how they are feeling, 5 a question back, 6 a request or need,
7 ask them to repeat or say you don't understand, 8 a closing or thank you.

Each object is {{"text": "...", "intent": "..."}} where intent is one of:
need, yes, no, feeling, social, question.

Slot 2 must ALWAYS be a genuine way to refuse - the ability to say no matters
for this person's safety and dignity.

No markdown, no prose outside the JSON array."""


FALLBACK_REPLIES = [
    {"text": "Yes, please", "intent": "yes"},
    {"text": "No, thank you", "intent": "no"},
    {"text": "Hello", "intent": "social"},
    {"text": "I'm alright", "intent": "feeling"},
    {"text": "How are you?", "intent": "question"},
    {"text": "I need help", "intent": "need"},
    {"text": "Say that again?", "intent": "question"},
    {"text": "Thank you", "intent": "social"},
]


def temp_word(fahrenheit: Optional[float]) -> str:
    if fahrenheit is None:
        return "unknown"
    if fahrenheit <= 58:
        return "cold"
    if fahrenheit <= 66:
        return "cool"
    if fahrenheit <= 76:
        return "comfortable"
    if fahrenheit <= 84:
        return "warm"
    return "hot"


def light_word(lux: Optional[float]) -> str:
    if lux is None:
        return "unknown"
    if lux < 40:
        return "dark"
    if lux < 200:
        return "dim"
    if lux < 600:
        return "indoor light"
    return "bright"


def build_context_line(context: Context) -> str:
    parts = [f"name={context.name}", f"time of day={context.part_of_day}"]
    if context.common_needs:
        parts.append(f"usual needs={context.common_needs}")
    if context.recent:
        parts.append(f"recently said={', '.join(context.recent[-4:])}")
    if context.rejected:
        # This is the personalisation signal - what they just said "no" to.
        parts.append(f"just rejected (avoid these)={', '.join(context.rejected[-4:])}")
    if context.heard:
        # What the mic overheard in the room - a tie-breaker signal, same
        # spirit as `recent`, not the primary basis for a prediction.
        parts.append(f"recently overheard in the room={', '.join(context.heard[-4:])}")
    if context.temperature_f is not None or context.light_lux is not None:
        parts.append(
            f"environment=temperature {temp_word(context.temperature_f)}, "
            f"light {light_word(context.light_lux)}"
        )
    return "; ".join(parts)


# ---- Endpoints -----------------------------------------------------


@router.get("/ping")
def ping():
    """Health check - reports config without leaking the key."""
    return {
        "message": "AI router is wired up and ready.",
        "provider": "azure-openai",
        "model": AZURE_OPENAI_DEPLOYMENT,
        "key_configured": bool(AZURE_OPENAI_API_KEY and AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_DEPLOYMENT),
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
            "model": AZURE_OPENAI_DEPLOYMENT,
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

    return {"options": options, "source": "model", "model": AZURE_OPENAI_DEPLOYMENT}


def normalise_reply(item) -> Optional[dict]:
    """Accept {"text","intent"} or a bare string; return a clean reply dict."""
    if isinstance(item, str):
        text, intent = item.strip(), "social"
    elif isinstance(item, dict):
        text = str(item.get("text") or item.get("short") or "").strip()
        intent = str(item.get("intent") or "social").strip().lower()
    else:
        return None

    if not text:
        return None
    if intent not in VALID_INTENTS:
        intent = "social"
    return {"text": text, "intent": intent}


@router.post("/respond")
async def respond(request: RespondRequest):
    """The 8 things this person might want to say BACK to what they just heard.

    Separate from /predict because the two answer different questions: /predict
    asks "what might they need?", this asks "what might they reply?". A greeting
    has nowhere to go on the needs wheel.
    """
    heard = request.heard.strip()
    if not heard:
        raise HTTPException(status_code=400, detail="heard is required")

    user_message = (
        f"{build_context_line(request.context)}\n"
        f"The other person just said: \"{heard}\"\n"
        f"Give the {OPTION_COUNT} replies now."
    )

    try:
        raw = await chat(RESPOND_SYSTEM, user_message, max_tokens=900)
        parsed = extract_json_array(raw)
    except HTTPException:
        parsed = None

    replies = []
    for item in parsed or []:
        reply = normalise_reply(item)
        if reply:
            replies.append(reply)
    replies = replies[:OPTION_COUNT]

    if not replies:
        return {
            "replies": FALLBACK_REPLIES,
            "heard": heard,
            "source": "fallback",
            "model": AZURE_OPENAI_DEPLOYMENT,
        }

    # Keep all eight slots filled so the ring never has holes.
    for filler in FALLBACK_REPLIES:
        if len(replies) >= OPTION_COUNT:
            break
        if all(r["text"].lower() != filler["text"].lower() for r in replies):
            replies.append(filler)

    return {
        "replies": replies,
        "heard": heard,
        "source": "model",
        "model": AZURE_OPENAI_DEPLOYMENT,
    }


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

    return {"text": sentence, "source": "model", "model": AZURE_OPENAI_DEPLOYMENT}


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
