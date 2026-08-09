# Placeholder for AI-related endpoints.
#
# This router is kept separate from auth.py on purpose: as you add
# real AI features (chat, summarization, image generation, etc.),
# add new endpoints here - or create more files like this one, one
# per feature area - instead of piling everything into main.py.
# Register any new router in main.py the same way this one is
# registered (see app.include_router(ai.router)).

from typing import Optional

from fastapi import APIRouter, Cookie, HTTPException

from routers.auth import SESSION_COOKIE_NAME, get_current_user

router = APIRouter(prefix="/api/ai", tags=["ai"])


@router.get("/ping")
def ping(session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE_NAME)):
    """Example of a protected endpoint - only logged-in users can call it.

    Replace this with real AI endpoints later, e.g.:

        @router.post("/chat")
        def chat(message: ChatMessage, session_token: Optional[str] = Cookie(...)):
            user_id = get_current_user(session_token)
            if user_id is None:
                raise HTTPException(status_code=401, detail="Not logged in")
            ...call your AI model here...
    """
    user_id = get_current_user(session_token)
    if user_id is None:
        raise HTTPException(status_code=401, detail="Not logged in")

    return {"message": "AI router is wired up and ready.", "requested_by": user_id}
