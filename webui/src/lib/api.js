// Thin typed wrapper over the mod's HTTP API.
//
// Deployment model: this SPA is served by its own container (nginx), which
// reverse-proxies the API routes to the mod. So requests are same-origin to
// our container and auth is a Bearer token (the mod also accepts a cookie, but
// the token keeps things explicit and portable). Admin-only, "type once": the
// password is cached in localStorage so we can silently re-auth when the
// 7-day token expires.

const PW_KEY = 'ae2_pw';
const TOKEN_KEY = 'ae2_token';

export class ApiError extends Error {
  constructor(status, data) {
    super(`${status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
    this.status = status;
    this.data = data;
  }
}

let token = localStorage.getItem(TOKEN_KEY) || null;

function setToken(t) { token = t; if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); }
export function savePassword(pw) { localStorage.setItem(PW_KEY, pw); }
export function hasCredentials() { return !!localStorage.getItem(PW_KEY); }

export function logout() {
  localStorage.removeItem(PW_KEY);
  setToken(null);
  location.reload();
}

/**
 * Outcome of an auth attempt. The distinction matters: a cached password should
 * survive the Minecraft server going away (it restarts often), and should only
 * be discarded when the server actively rejects it.
 *
 *   'ok'          - authenticated, token stored
 *   'rejected'    - the server says these credentials are wrong
 *   'unreachable' - we could not ask (mod down/restarting, proxy 502, offline)
 *   'no-password' - nothing cached to try
 */
export const AUTH = { OK: 'ok', REJECTED: 'rejected', UNREACHABLE: 'unreachable', NONE: 'no-password' };

// Collapse concurrent re-auths onto one request. On a server restart several
// polls 401 at once; without this each fires its own /auth.
let reauthInFlight = null;

async function doReauth(pw) {
  let res;
  try {
    res = await fetch('/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'Admin', password: pw, remember: 'on' }).toString(),
    });
  } catch {
    return AUTH.UNREACHABLE; // network/DNS/connection refused
  }
  // Only an explicit auth rejection invalidates the password. 5xx (and nginx's
  // 502/504 while the mod is down) mean "ask again later", not "wrong password".
  if (res.status === 400 || res.status === 401 || res.status === 403) return AUTH.REJECTED;
  if (!res.ok) return AUTH.UNREACHABLE;
  try {
    const data = await res.json();
    if (!data?.token) return AUTH.UNREACHABLE;
    setToken(data.token);
    return AUTH.OK;
  } catch {
    return AUTH.UNREACHABLE;
  }
}

/** POST /auth with the cached password. Returns one of AUTH.*. */
export async function reauth() {
  const pw = localStorage.getItem(PW_KEY);
  if (!pw) return AUTH.NONE;
  if (!reauthInFlight) {
    reauthInFlight = doReauth(pw).finally(() => { reauthInFlight = null; });
  }
  return reauthInFlight;
}

/**
 * Verify a password entered by the user. Caches it on success, and keeps it on
 * an unreachable server so a restart mid-login doesn't lose it.
 */
export async function login(pw) {
  savePassword(pw);
  const result = await reauth();
  if (result === AUTH.REJECTED) localStorage.removeItem(PW_KEY);
  return result;
}

function authHeaders() {
  return token ? { Authorization: 'Bearer ' + token, Accept: 'application/json' } : { Accept: 'application/json' };
}

/**
 * Authenticated GET returning the {status:"OK",data} envelope's payload, with a
 * single silent re-auth on 401.
 *
 * Exported because the gateway (/history/*) validates the very same mod
 * tokens, so it needs identical handling — see lib/history.js.
 */
export async function call(path, method = 'GET', { fresh = false } = {}) {
  // `fresh` reaches the caching proxy as Cache-Control: no-cache, so an explicit
  // Refresh is always honest while background polling stays cheap.
  const headers = fresh ? { ...authHeaders(), 'Cache-Control': 'no-cache' } : authHeaders();
  let res = await fetch(path, { method, headers });
  if (res.status === 401) {
    const result = await reauth();
    if (result === AUTH.OK) {
      const retryHeaders = fresh ? { ...authHeaders(), 'Cache-Control': 'no-cache' } : authHeaders();
      res = await fetch(path, { method, headers: retryHeaders });
    } else if (result === AUTH.UNREACHABLE) {
      // Credentials are fine, the server just isn't answering. Distinct from
      // UNAUTHORIZED so the app shows "reconnecting" instead of a login prompt.
      throw new ApiError('OFFLINE', 'server unreachable');
    } else {
      throw new ApiError('UNAUTHORIZED', 'session expired');
    }
  }
  if (!res.ok) {
    // Prefer the envelope's status when the body carries one.
    const body = await res.text().catch(() => '');
    try {
      const j = JSON.parse(body);
      if (j?.status) throw new ApiError(j.status, j.data);
    } catch (e) {
      if (e instanceof ApiError) throw e;
    }
    throw new ApiError('HTTP_' + res.status, body);
  }
  const json = await res.json();
  if (json.status !== 'OK') throw new ApiError(json.status, json.data);
  return json.data;
}

const enc = encodeURIComponent;

export const api = {
  grids: () => call('/grids'),
  // opts.fresh bypasses the caching proxy — pass it for user-initiated refreshes
  // only, never for background polls.
  items: (grid, opts) => call(`/items?grid=${grid}`, 'GET', opts),
  cpuList: (grid, opts) => call(`/list?grid=${grid}`, 'GET', opts),
  cpu: (grid, cpu, opts) => call(`/get?grid=${grid}&cpu=${enc(cpu)}`, 'GET', opts),
  order: (grid, itemHash, quantity) => call(`/order?grid=${grid}&item=${itemHash}&quantity=${quantity}`),
  job: (grid, id) => call(`/job?grid=${grid}&id=${id}`),
  submitJob: (grid, id, cpu) => call(`/job?grid=${grid}&id=${id}&submit&cpu=${enc(cpu)}`),
  cancelJob: (grid, id) => call(`/job?grid=${grid}&id=${id}&cancel`),
  cancelCpu: (grid, cpu) => call(`/cancelcpu?grid=${grid}&cpu=${enc(cpu)}`),
  trackingHistory: (grid) => call(`/trackinghistory?grid=${grid}`),
  tracking: (grid, id) => call(`/gettracking?grid=${grid}&id=${id}`),
  gridSettings: (grid, track) => call(`/gridsettings?grid=${grid}&track=${track ? 1 : 0}`),
};
