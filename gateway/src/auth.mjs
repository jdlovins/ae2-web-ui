// Bearer-token auth that reuses the mod's own sessions.
//
// The mod keeps its valid tokens in a private in-memory map (AE2Controller
// `validTokens`), so we can't verify one locally and we deliberately don't want
// a second user store or a shared secret. Instead we ASK the mod: replay the
// caller's token against an authenticated route and see whether it 401s.
//
// AE2Controller.checkAuth() runs BEFORE any request work and answers 401 on its
// own, so the probe never reaches the request handler's logic. We use
// /gridsettings for it because:
//   * it's an ASyncRequestHandler, so it never touches the Minecraft server
//     tick (every /items-style route does, and would lag the game), and
//   * called with no query params it fails fast on a missing-param check, so a
//     VALID token does no real work either.
// Either way the status code tells us what we need: 401 = reject, anything
// else = the token is live.

import { config } from './config.mjs';

const PROBE_PATH = '/gridsettings';
// Short TTLs: a revoked token (logout) stops working quickly, while a busy
// dashboard still costs the mod at most one probe per token per minute.
const OK_TTL_MS = 60_000;
const BAD_TTL_MS = 10_000;
const MAX_ENTRIES = 500;

const cache = new Map(); // token -> { ok, expires }

export function extractToken(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

function remember(token, ok) {
  // Bound the cache so a flood of junk tokens can't grow it without limit.
  if (cache.size >= MAX_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
    if (cache.size >= MAX_ENTRIES) cache.clear();
  }
  cache.set(token, { ok, expires: Date.now() + (ok ? OK_TTL_MS : BAD_TTL_MS) });
  return ok;
}

/**
 * True if the mod still recognises this token.
 * Fails CLOSED: if the mod is unreachable we cannot verify, so we reject rather
 * than serve inventory history to an unverified caller.
 */
export async function isValidToken(token) {
  if (!token) return false;
  const hit = cache.get(token);
  if (hit && hit.expires > Date.now()) return hit.ok;

  try {
    const res = await fetch(config.modUrl + PROBE_PATH, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    return remember(token, res.status !== 401);
  } catch (e) {
    // Don't cache transport failures as a verdict — the next request retries.
    console.warn(`[auth] could not verify token against the mod: ${e.message}`);
    return false;
  }
}

/** Drop a token from the cache (used when the mod reports it stale mid-flight). */
export function forget(token) {
  if (token) cache.delete(token);
}
