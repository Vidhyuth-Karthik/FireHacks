# Hackathon Starter Kit — Code Walkthrough

This document explains what every file does and how a request travels
through the system, from clicking "Log In" in the browser to reading
a row back out of the database. It's written for someone who is
comfortable with basic Python but new to FastAPI and web apps in
general.

## 1. The big picture

```
Browser (client/, a Static Space)  --HTTPS-->  FastAPI (api/, a Docker Space)  --SQL-->  Turso (hosted SQLite-compatible DB)
```

The frontend and the API are two **separate deployments** on two
**separate origins** — the client is a Hugging Face Static Space, the
API is a Hugging Face Docker Space, and each has its own `*.hf.space`
URL. Because of that, every request from the browser to the API is
**cross-origin**, which has two consequences baked into the code:

1. The API must explicitly opt in to being called from the client's
   origin, via **CORS** (`CORSMiddleware` in `main.py`).
2. The login session cookie must be marked `SameSite=None; Secure` so
   the browser is willing to send it cross-site at all (see
   `routers/auth.py`).

The database is hosted on **Turso** rather than a local SQLite file
for a similar reason: the API's Docker Space container is ephemeral —
its disk is wiped on every restart/redeploy — so anything written to
a local file wouldn't survive.

## 2. Folder layout

```
hackathon-starter-kit/
├── api/                        deploys as its own Docker Space
│   ├── main.py                 entry point — creates the app, wires up CORS + routers
│   ├── database.py             opens Turso connections, creates tables
│   ├── security.py             password hashing (no external crypto library needed)
│   ├── requirements.txt        pip packages this project needs
│   ├── Dockerfile               how Hugging Face builds/runs the API container
│   ├── README.md                Space config (sdk: docker) + required secrets
│   └── routers/
│       ├── auth.py             signup / login / logout / "who am I" endpoints
│       └── ai.py                placeholder for future AI endpoints
└── client/                     deploys as its own Static Space
    ├── index.html               login + signup page
    ├── home.html                 page shown after a successful login
    ├── style.css                 shared styling for both pages
    ├── script.js                 shared browser logic for both pages
    └── README.md                 Space config (sdk: static)
```

There is no `data/app.db` anymore — the database lives on Turso, not
on disk.

## 3. File-by-file

### `api/main.py` — the entry point

This is the file `uvicorn` loads when you run `uvicorn main:app`. It:

1. Creates the `FastAPI()` app object.
2. Adds `CORSMiddleware`, configured from the `CORS_ORIGINS`
   environment variable (a comma-separated list of allowed frontend
   origins) with `allow_credentials=True` — required for the browser
   to send/receive the session cookie across origins.
3. Registers a **startup event** that calls `init_db()`, so the
   `users` and `sessions` tables exist in Turso before any request can
   hit them.
4. **Includes the routers** — `auth.router` and `ai.router` — which
   is what actually adds endpoints like `/api/auth/login` to the app.
   Adding a new feature area later is as simple as writing a new
   router file and adding one more `app.include_router(...)` line
   here.

Unlike a typical single-server tutorial setup, this file does **not**
mount or serve the `client/` folder — the API is standalone. The
client is a completely separate static deployment (see
`client/README.md`).

### `api/database.py` — talking to Turso

Uses the `libsql` package to connect to a Turso database (a hosted,
SQLite-compatible service) over the network instead of opening a
local file.

- `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` are read from environment
  variables. `load_dotenv()` (from `python-dotenv`) runs first, so a
  local `.env` file (copied from `.env.example`, gitignored) fills
  them in for local dev; in production there's no `.env` file, so
  they come from the Space secrets set in the dashboard instead.
- `get_connection()` opens a **new** connection every time it's
  called — slightly less "efficient" than reusing one, but it
  sidesteps threading/connection-sharing quirks entirely, a
  reasonable trade for a learning project.
- `row_to_dict(cursor, row)` — libsql's cursor returns query results
  as plain tuples, unlike Python's built-in `sqlite3` module (which
  this project used to use), so there's no built-in `row["user_id"]`
  style access. This helper rebuilds that convenience by zipping
  `cursor.description` (the column names) together with the row
  tuple into a dict. `routers/auth.py` calls this on every row it
  reads.
- `init_db()` runs two `CREATE TABLE IF NOT EXISTS` statements:
  - **`users`**: `user_id` (primary key), `password_hash`,
    `password_salt`, `created_at`.
  - **`sessions`**: `token` (primary key), `user_id`, `created_at`.
    This is how the server remembers "this browser is logged in as
    this user" between requests.

### `api/security.py` — password hashing

Passwords are **never** stored in plain text. This file has two
functions built entirely from `hashlib` (built into Python):

- `hash_password(password, salt=None)` — if no salt is given (i.e.
  during signup), it generates a random 16-byte salt with
  `os.urandom`, then runs the password through
  `hashlib.pbkdf2_hmac("sha256", ...)` 100,000 times. Returns
  `(hash, salt)`.
- `verify_password(password, salt, expected_hash)` — re-hashes the
  attempted password with the *stored* salt and checks whether it
  matches the *stored* hash. Used during login.

The "salt" is just random bytes mixed into the hash so that two users
with the same password don't end up with the same hash in the
database, and so precomputed "rainbow table" attacks don't work.

### `api/routers/auth.py` — the authentication endpoints

This file defines an `APIRouter` with the prefix `/api/auth`, so
every route declared here is automatically namespaced (e.g.
`@router.post("/login")` becomes `/api/auth/login`).

| Endpoint | Method | What it does |
|---|---|---|
| `/api/auth/signup` | POST | Checks the user ID isn't taken, hashes the password, inserts a new row into `users`. |
| `/api/auth/login` | POST | Looks up the user, verifies the password, creates a random session token, stores it in `sessions`, and sends it back as a cross-origin session cookie. |
| `/api/auth/logout` | POST | Deletes the session row matching the cookie's token, then tells the browser to delete the cookie. |
| `/api/auth/me` | GET | Reads the cookie, looks up the session, and returns the logged-in `user_id` — or `401` if there isn't one. |

The `Credentials` class (a Pydantic `BaseModel`) describes the shape
of the JSON body signup/login expect: `{"user_id": ..., "password":
...}`. FastAPI uses this to automatically validate incoming requests
and reject malformed ones with a clear error, before your function
body even runs.

**Why a cookie instead of returning a token in the JSON response?**
Because the cookie is marked `httponly=True`, JavaScript in the
browser can never read it — only the browser itself can, and it
sends it back automatically on every request. That removes an entire
class of token-theft bugs a beginner could otherwise introduce by
accidentally logging a token or storing it somewhere insecure.

**Why `samesite="none", secure=True`?** Because the client and API
are on different origins, this is a *cross-site* cookie. Browsers
refuse to send cookies cross-site unless they're marked
`SameSite=None`, and they require `SameSite=None` cookies to also be
`Secure` (HTTPS-only). Hugging Face Spaces are always served over
HTTPS, so this works in production; browsers also treat
`http://localhost` as a secure-enough origin for local dev.

The last function, `get_current_user(session_token)`, isn't an
endpoint — it's a shared helper. It takes whatever token was in the
cookie and returns the matching `user_id`, or `None`. This is the
function `routers/ai.py` (and any future protected router) imports to
check "is this request logged in?"

### `api/routers/ai.py` — where AI features will live

Currently contains one example endpoint, `GET /api/ai/ping`, that
does nothing but prove the pattern: it reads the session cookie,
calls `get_current_user()` from `auth.py`, and returns `401` if
nobody's logged in.

This file exists specifically so that adding real AI functionality
later doesn't mean touching `auth.py` or `main.py`. The recipe is:

1. Add a new function to this file (or a new file in `routers/`)
   decorated with `@router.post("/your-endpoint")`.
2. Read the session cookie the same way `ping()` does and call
   `get_current_user()` to enforce login.
3. If you add a new file instead of editing this one, register it in
   `main.py` with one more `app.include_router(...)` line.

### `api/Dockerfile` — how the API Space is built

Hugging Face Docker Spaces run the container as user ID 1000, so the
Dockerfile creates a `user` account and switches to it *before*
copying any files in — otherwise those files would be owned by root
and Python/pip would hit permission errors. It installs
`requirements.txt`, copies the rest of the API code in, and finally
runs `uvicorn main:app --host 0.0.0.0 --port 7860` — 7860 is the port
Spaces expect a Docker container to listen on (declared as
`app_port: 7860` in `README.md`).

### `api/README.md` — the API Space's configuration

The YAML frontmatter at the top (`sdk: docker`, `app_port: 7860`,
etc.) is read directly by Hugging Face to configure the Space — this
isn't just documentation, it's config. The rest of the file is a
reminder of which secrets need to be set in the Space's settings
(`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `CORS_ORIGINS`).

### `client/index.html` — login and signup page

A single page with two forms (`#login-form`, `#signup-form`) toggled
by tab buttons. Both forms just collect a user ID and password —
none of the actual request logic lives in this file, it's all in
`script.js`.

### `client/home.html` — the "logged in" page

Shown after a successful login. It has a placeholder
(`#user-id-display`) for the logged-in user's ID and a logout button.
Like `index.html`, it has no logic of its own — `script.js` fills in
the blanks.

### `client/style.css` — shared styling

Plain CSS, no framework. Styles the centered card, the tab buttons,
form inputs, and the success/error message text. Shared by both
HTML pages via `<link rel="stylesheet" href="style.css">`.

### `client/script.js` — all the browser-side logic

Both `index.html` and `home.html` load this same file. Each section
checks whether the elements it needs actually exist on the current
page before doing anything, so one file safely serves both pages:

- **`API_BASE_URL`** — the full origin of the deployed API
  (`https://your-username-your-api-space.hf.space` in production,
  `http://localhost:8000` for local dev against a locally-run API).
  Every request below is made against this base URL instead of a
  relative path, since the client no longer shares an origin with the
  API.
- **`postJSON(path, data)`** — a small wrapper around `fetch()` that
  prefixes `path` with `API_BASE_URL`, sends JSON, includes cookies
  cross-origin (`credentials: "include"`), and throws a JavaScript
  error with the server's message if the request failed.
- **Login/signup section** (only runs if `#login-form` exists): wires
  up the tab-switching buttons, and submits each form's data to
  `/api/auth/login` or `/api/auth/signup`. On successful login, it
  redirects to `/home.html`.
- **Home page section** (only runs if `#user-id-display` exists): on
  page load, calls `/api/auth/me` to check whether the visitor is
  actually logged in. If not, it redirects back to `/index.html`. The
  logout button calls `/api/auth/logout` and redirects back to the
  login page.

### `client/README.md` — the client Space's configuration

The YAML frontmatter (`sdk: static`) tells Hugging Face to serve this
folder's files directly with no build step — `index.html` is the
default page served at the Space's root URL.

## 4. Full request sequence: signing up, logging in, and visiting the home page

Here's what happens, step by step, for a brand-new user, once both
Spaces are deployed:

```
1. Browser requests  GET https://<client-space>.hf.space/
   → the Static Space serves client/index.html directly

2. User fills in the "Sign Up" form and submits
   → script.js POSTs JSON to https://<api-space>.hf.space/api/auth/signup
     (the browser sends an OPTIONS preflight first; CORSMiddleware
     answers it because <client-space> is in CORS_ORIGINS)
   → routers/auth.py: signup()
       - checks the user_id isn't already in the `users` table (Turso)
       - security.py: hash_password() salts + hashes the password
       - INSERTs a new row into `users`
   → responds 200 {"message": "Account created..."}
   → script.js shows the success message and switches to the Login tab

3. User fills in the "Log In" form and submits
   → script.js POSTs JSON to https://<api-space>.hf.space/api/auth/login
   → routers/auth.py: login()
       - SELECTs the stored hash + salt for that user_id, via
         row_to_dict() so it can be read as row["password_hash"]
       - security.py: verify_password() re-hashes the attempt and compares
       - if it matches: generates a random token (secrets.token_hex),
         INSERTs it into `sessions`, and calls response.set_cookie(...)
         with samesite="none", secure=True
   → the HTTP response includes
     Set-Cookie: session_token=<random>; HttpOnly; Secure; SameSite=None
   → the browser accepts it because it's cross-site but Secure +
     SameSite=None
   → script.js redirects the browser to /home.html (on the client's
     own origin)

4. Browser requests  GET https://<client-space>.hf.space/home.html
   → the Static Space serves client/home.html
     (no cookie needed yet - this is a same-origin page load, not an
     API call)

5. home.html loads script.js, which immediately calls
   GET https://<api-space>.hf.space/api/auth/me with credentials: "include"
   → the browser attaches the session_token cookie because this
     request targets the API's origin, which is where the cookie was set
   → routers/auth.py: me() → get_current_user(session_token)
       - SELECTs `sessions` for a row matching that token
       - returns the associated user_id
   → responds 200 {"user_id": "..."}
   → script.js fills in #user-id-display with the returned name

6. User clicks "Log Out"
   → script.js POSTs to https://<api-space>.hf.space/api/auth/logout
     (cookie attached automatically)
   → routers/auth.py: logout()
       - DELETEs the matching row from `sessions`
       - response.delete_cookie(...) tells the browser to drop the cookie
   → script.js redirects back to /index.html
```

If a logged-out visitor (no valid cookie) tries to open `/home.html`
directly, step 5 still runs — `/api/auth/me` will respond `401`
because there's no matching session — and `script.js` immediately
redirects them to `/index.html` instead of showing the page.

## 5. Where a protected AI endpoint fits in

Once you add a real endpoint to `routers/ai.py` (following the
`ping()` example), the sequence looks the same as steps 4–5 above:
the browser's cookie is sent automatically (as long as the fetch call
uses `credentials: "include"` and targets `API_BASE_URL`), the
endpoint calls `get_current_user()` from `auth.py`, and it either
proceeds (user is logged in) or returns `401` (user is not). The
frontend would call it with
`fetch(API_BASE_URL + "/api/ai/your-endpoint", { credentials: "include" })`
the same way `script.js` already calls `/api/auth/me`.

## 6. Deploying to Hugging Face

Each folder becomes the root of its own Space repository:

1. Create a free database at [turso.tech](https://turso.tech) and
   note its URL and auth token.
2. Create a Docker Space, push the contents of `api/` to it as the
   repo root, then set `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, and
   `CORS_ORIGINS` under **Settings → Variables and secrets**. You
   won't know the client Space's URL for `CORS_ORIGINS` until step 3 —
   come back and set it after.
3. Create a Static Space and push the contents of `client/` to it as
   the repo root.
4. Update `API_BASE_URL` in `client/script.js` to the API Space's
   `https://*.hf.space` URL, then push that change to the client Space.
5. Go back to the API Space's settings and set `CORS_ORIGINS` to the
   client Space's URL.

## 7. Troubleshooting tips for beginners

- **CORS error in the browser console** ("has been blocked by CORS
  policy") — `CORS_ORIGINS` on the API doesn't include the exact
  origin the browser is calling from. Check it matches scheme + host
  + port exactly (e.g. `http://127.0.0.1:5500` is a *different*
  origin from `http://localhost:5500`).
- **"Not logged in" right after logging in** — open DevTools →
  Application → Cookies and confirm `session_token` was actually set.
  If it's missing, double check the API is being served over HTTPS
  (or `localhost`) — browsers silently drop `Secure` cookies set over
  plain HTTP on any other host.
- **`KeyError: 'TURSO_DATABASE_URL'` on startup** — the API couldn't
  find its database credentials. Locally, copy `api/.env.example` to
  `api/.env` and fill in real values; in production, set
  `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` as Space secrets.
- **"Address already in use" when starting uvicorn locally** — a
  previous server is still running. Find it with `lsof -i :8000` and
  stop it, or start this one on a different port with `--port 8001`
  (and update `API_BASE_URL` in `script.js` to match).
- **Changes to `client/*.html`, `.css`, or `.js` don't show up** —
  hard-refresh the browser; static files may be cached.
- **Changes to `.py` files don't show up locally** — make sure you
  started uvicorn with `--reload`, or restart it manually.
