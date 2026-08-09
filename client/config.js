/* ============================================================
   Runtime configuration.

   Resolution order (first hit wins):
     1. ?api=http://192.168.1.50:8000   — set at demo time, no redeploy
     2. localStorage 'whisper.api'      — sticky across reloads
     3. localhost:8000 when served locally, else the Vercel deploy

   The query param is the important one: on demo day the backend runs on
   somebody's laptop on the venue LAN, and that IP is not knowable now.

   NOTE: Vercel's Python functions do not support WebSockets, so /ws only
   works against a locally-run backend. See UI-SPEC.md §5.
   ============================================================ */

const FALLBACK_REMOTE = 'https://fire-hacks.vercel.app';
const STORAGE_KEY = 'whisper.api';

const stripTrailingSlash = (url) => url.replace(/\/+$/, '');

function resolveApiBase() {
  const fromQuery = new URLSearchParams(window.location.search).get('api');
  if (fromQuery) {
    const clean = stripTrailingSlash(fromQuery);
    try {
      localStorage.setItem(STORAGE_KEY, clean);
    } catch {}
    return clean;
  }

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return stripTrailingSlash(stored);
  } catch {}

  const host = window.location.hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '';
  return isLocal ? `http://${host || 'localhost'}:8000` : FALLBACK_REMOTE;
}

export const API_BASE_URL = resolveApiBase();

export const WS_URL = `${API_BASE_URL.replace(/^http/, 'ws')}/ws`;

/** Demo escape hatch: ?mock=1 forces the local agent even if a server is up. */
export const FORCE_MOCK =
  new URLSearchParams(window.location.search).get('mock') === '1';

export function setApiBase(url) {
  try {
    localStorage.setItem(STORAGE_KEY, stripTrailingSlash(url));
  } catch {}
}
