// Read API for the charts. Mounted under /history/ so nginx can route it
// alongside the mod's own routes without collision.
//
// Responses use the same {status:"OK", data} envelope as the mod, so the SPA's
// existing api.js error handling applies unchanged.

import { createServer } from 'node:http';

import { listTrackedGrids, searchItems, series, stats } from './db.mjs';
import { state, collectNow } from './collector.mjs';
import { config } from './config.mjs';
import { extractToken, isValidToken } from './auth.mjs';
import { ApiError } from './ae2.mjs';
import { isProxied, proxyRead, proxyOrder } from './proxy.mjs';
import { stats as cacheStats, size as cacheSize, prune } from './cache.mjs';

const ok = (res, data) => {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ status: 'OK', data }));
};
const fail = (res, code, status, data = '') => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status, data }));
};

/** Client input errors, so route() can answer 400 instead of 500. */
class BadRequest extends Error {}

/** Accept an ISO instant or a relative "-24h" / "-7d" / "-90m" offset from now. */
function parseTime(raw, dflt) {
  if (!raw) return dflt;
  const rel = /^-(\d+)([smhd])$/.exec(raw);
  if (rel) {
    const mult = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[rel[2]];
    return new Date(Date.now() - Number(rel[1]) * mult);
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new BadRequest(`bad timestamp: ${raw}`);
  return d;
}

async function route(url, res, method = 'GET', fresh = false) {
  // Two path spaces share this server: the mod's read routes (proxied, cached)
  // and our own /history/* time-series API. Handle the proxy first so a bare
  // /items can never be mistaken for /history/items.
  if (url.pathname === '/order') {
    if (method !== 'GET') return fail(res, 405, 'METHOD_NOT_ALLOWED', 'GET only');
    return ok(res, await proxyOrder(url.searchParams));
  }

  if (isProxied(url.pathname)) {
    if (method !== 'GET') return fail(res, 405, 'METHOD_NOT_ALLOWED', 'reads only');
    return ok(res, await proxyRead(url.pathname, url.searchParams, { fresh }));
  }

  const p = url.pathname.replace(/^\/history/, '') || '/';
  const q = url.searchParams;

  if (p === '/health' || p === '/') {
    return ok(res, {
      collector: {
        runs: state.runs,
        failures: state.failures,
        rowsWritten: state.rowsWritten,
        lastRunAt: state.lastRunAt,
        lastOkAt: state.lastOkAt,
        lastError: state.lastError,
        grids: state.grids,
        intervalSec: config.intervalSec,
      },
      db: await stats().catch((e) => ({ error: e.message })),
      cache: { ...cacheStats, entries: cacheSize() },
    });
  }

  // Force a snapshot instead of waiting for the interval. POST so it isn't
  // triggered by a prefetch or a refresh of a bookmarked URL.
  if (p === '/collect') {
    if (method !== 'POST') return fail(res, 405, 'METHOD_NOT_ALLOWED', 'use POST');
    return ok(res, await collectNow());
  }

  if (p === '/grids') return ok(res, await listTrackedGrids());

  if (p === '/items') {
    const grid = q.get('grid');
    if (!grid) return fail(res, 400, 'MISSING_PARAM', 'grid');
    const limit = Math.min(1000, Number(q.get('limit')) || 200);
    return ok(res, await searchItems(grid, q.get('q') || '', limit));
  }

  if (p === '/series') {
    const grid = q.get('grid');
    if (!grid) return fail(res, 400, 'MISSING_PARAM', 'grid');
    const itemids = (q.get('items') || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!itemids.length) return fail(res, 400, 'MISSING_PARAM', 'items');
    if (itemids.length > 20) return fail(res, 400, 'TOO_MANY', 'at most 20 items per request');
    const to = parseTime(q.get('to'), new Date());
    const from = parseTime(q.get('from'), new Date(to.getTime() - 24 * 3600e3));
    if (from >= to) return fail(res, 400, 'BAD_RANGE', 'from must be before to');
    const points = Math.min(2000, Number(q.get('points')) || 400);
    return ok(res, { from, to, series: await series(grid, itemids, from, to, points) });
  }

  return fail(res, 404, 'NOT_FOUND', p);
}

export function startApi() {
  const server = createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return fail(res, 400, 'BAD_REQUEST');
    }

    // CORS preflight carries no credentials; answer before the auth gate.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      });
      return res.end();
    }

    // Liveness/readiness probes can't hold a session, and a 401 would make an
    // orchestrator restart a perfectly healthy pod forever. This exposes only
    // "the process is up" — no inventory data, no counters — so it's safe to
    // leave open. Everything else stays gated.
    if (url.pathname === '/history/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ status: 'OK', data: { ok: true } }));
    }

    // Every other route is gated on a token the MOD considers valid, so this
    // service grants exactly the access the mod's own API does — no second user
    // store, no shared secret. A 401 is what makes the SPA silently re-auth.
    if (!(await isValidToken(extractToken(req)))) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' });
      return res.end(JSON.stringify({ status: 'UNAUTHORIZED', data: 'invalid or expired token' }));
    }

    try {
      // An explicit Refresh in the UI sends Cache-Control: no-cache.
      const fresh = /no-cache/i.test(req.headers['cache-control'] || '');
      await route(url, res, req.method, fresh);
    } catch (e) {
      if (e instanceof BadRequest) return fail(res, 400, 'BAD_REQUEST', e.message);
      // A deny from the mod (ALL_CPU_BUSY, ITEM_NOT_FOUND, GRID_NOT_FOUND…) is a
      // real answer, not a gateway failure. Mirror the mod: HTTP 200 with the
      // status in the envelope, so the SPA reports the actual reason.
      if (e instanceof ApiError && typeof e.status === 'string' && !e.status.startsWith('HTTP_')) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({ status: e.status, data: e.data ?? '' }));
      }
      console.error(`[api] ${url.pathname}: ${e.message}`);
      fail(res, 500, 'INTERNAL_ERROR', e.message);
    }
  });
  server.listen(config.port, () => console.log(`[api] listening on :${config.port}`));
  setInterval(prune, 60_000).unref();
  return server;
}
