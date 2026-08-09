# Authentication endpoints: signup, login, logout, and "who am I".
#
# Sessions are tracked with a random token stored in the database and
# sent to the browser as an httpOnly cookie. The browser sends the
# cookie back automatically on every request after login, so the
# frontend doesn't need to manage tokens by hand.

import secrets
from typing import Optional

from fastapi import APIRouter, Cookie, HTTPException, Response
from pydantic import BaseModel

from database import get_connection, row_to_dict
from security import hash_password, verify_password

router = APIRouter(prefix="/api/auth", tags=["auth"])

SESSION_COOKIE_NAME = "session_token"


class Credentials(BaseModel):
    user_id: str
    password: str


@router.post("/signup")
def signup(credentials: Credentials):
    user_id = credentials.user_id.strip()
    password = credentials.password

    if not user_id or not password:
        raise HTTPException(status_code=400, detail="user_id and password are required")

    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute("SELECT user_id FROM users WHERE user_id = ?", (user_id,))
    if cursor.fetchone() is not None:
        conn.close()
        raise HTTPException(status_code=400, detail="That user ID is already taken")

    password_hash, salt = hash_password(password)
    cursor.execute(
        "INSERT INTO users (user_id, password_hash, password_salt) VALUES (?, ?, ?)",
        (user_id, password_hash, salt),
    )
    conn.commit()
    conn.close()

    return {"message": "Account created. You can now log in."}


@router.post("/login")
def login(credentials: Credentials, response: Response):
    user_id = credentials.user_id.strip()
    password = credentials.password

    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT password_hash, password_salt FROM users WHERE user_id = ?", (user_id,)
    )
    row = row_to_dict(cursor, cursor.fetchone())

    if row is None or not verify_password(password, row["password_salt"], row["password_hash"]):
        conn.close()
        raise HTTPException(status_code=401, detail="Incorrect user ID or password")

    # Create a new session token and remember which user it belongs to.
    token = secrets.token_hex(32)
    cursor.execute("INSERT INTO sessions (token, user_id) VALUES (?, ?)", (token, user_id))
    conn.commit()
    conn.close()

    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=token,
        httponly=True,  # JavaScript can't read this cookie - reduces XSS risk
        # The frontend is a different origin now, so this cookie must be sent
        # cross-site. Browsers require SameSite=None to be paired with
        # Secure - that's fine for a deployed (HTTPS) frontend/backend, and
        # browsers special-case http://localhost as a "secure" origin too,
        # so local dev keeps working without HTTPS.
        samesite="none",
        secure=True,
        max_age=60 * 60 * 24,  # 1 day, in seconds
    )
    return {"message": "Logged in", "user_id": user_id}


@router.post("/logout")
def logout(
    response: Response,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE_NAME),
):
    if session_token:
        conn = get_connection()
        conn.execute("DELETE FROM sessions WHERE token = ?", (session_token,))
        conn.commit()
        conn.close()

    response.delete_cookie(SESSION_COOKIE_NAME)
    return {"message": "Logged out"}


@router.get("/me")
def me(session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE_NAME)):
    user_id = get_current_user(session_token)
    if user_id is None:
        raise HTTPException(status_code=401, detail="Not logged in")
    return {"user_id": user_id}


def get_current_user(session_token: Optional[str]) -> Optional[str]:
    """Look up which user (if any) owns this session token.

    Other routers - like routers/ai.py - can import this function to
    check whether a request is coming from a logged-in user before
    doing any work.
    """
    if not session_token:
        return None

    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT user_id FROM sessions WHERE token = ?", (session_token,))
    row = row_to_dict(cursor, cursor.fetchone())
    conn.close()

    return row["user_id"] if row else None
