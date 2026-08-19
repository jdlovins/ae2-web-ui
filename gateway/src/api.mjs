// Read API for the charts. Mounted under /history/ so nginx can route it
// alongside the mod's own routes without collision.
//
// Responses use the same {status:"OK", data} envelope as the mod, so the SPA's
// existing api.js error handling applies unchanged.

import { createServer } from 'node:http';

import {
  listTrackedGrids,
  searchItems,
  series,
  itemDetail,
  stats,
  listRules,
  getRule,
  createRule,
  updateRule,
  deleteRule,
  listEvents,
  listGroups,
  getGroup,
  upsertGroup,
  updateGroup,
  deleteGroup,
} from './db.mjs';
import { state, collectNow } from './collector.mjs';
import { state as maintainState } from './maintainer.mjs';
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

/**
 * A group name: required, trimmed, and short enough to read as a chip.
 *
 * Trimming here rather than at the database means the name that comes back is
 * the name that will be matched on the next save, so " Ores" and "Ores" are one
 * group instead of two that look identical in the strip.
 */
function groupName(raw) {
  const name = String(raw ?? '').trim();
  if (!name) throw new BadRequest('name is required');
  if (name.length > 60) throw new BadRequest('name must be 60 characters or fewer');
  return name;
}

/**
 * The view a group opens in. Anything unrecognised falls back to the chart
 * rather than 400ing: a newer SPA sending a mode this build has never heard of
 * should still be able to save its group.
 */
const groupMode = (raw) => (raw === 'change' ? 'change' : 'chart');

/** A required positive integer field, e.g. a stock target. */
function posInt(body, name) {
  const n = Number(body?.[name]);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new BadRequest(`${name} must be a positive whole number`);
  }
  return n;
}

async function route(url, res, method = 'GET', fresh = false, body = null) {
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
      maintainer: { ...maintainState, enabled: config.maintainEnabled, maxJobs: config.maintainMaxJobs },
    });
  }

  // --- Level maintainer ---------------------------------------------------
  if (p === '/maintain') {
    if (method === 'GET') {
      // No grid = every rule, which is what the health view wants; the SPA
      // always scopes to the grid it is showing.
      return ok(res, await listRules(q.get('grid') || null));
    }
    if (method === 'POST') {
      const grid = body?.grid ?? q.get('grid');
      if (!grid) throw new BadRequest('grid is required');
      if (!body?.itemid) throw new BadRequest('itemid is required');
      const target = posInt(body, 'target');
      const batch = posInt(body, 'batch');
      return ok(
        res,
        await createRule({
          gridKey: grid,
          itemid: String(body.itemid),
          itemname: String(body.itemname || body.itemid),
          target,
          batch,
        }),
      );
    }
    return fail(res, 405, 'METHOD_NOT_ALLOWED', 'GET or POST');
  }

  const rule = /^\/maintain\/(\d+)(\/events)?$/.exec(p);
  if (rule) {
    const id = Number(rule[1]);
    if (rule[2]) {
      if (method !== 'GET') return fail(res, 405, 'METHOD_NOT_ALLOWED', 'GET only');
      return ok(res, await listEvents(id, Math.min(100, Number(q.get('limit')) || 20)));
    }
    if (method === 'GET') {
      const found = await getRule(id);
      if (!found) return fail(res, 404, 'NOT_FOUND', `rule ${id}`);
      return ok(res, found);
    }
    if (method === 'PATCH' || method === 'POST') {
      const patch = {};
      if (body?.target !== undefined) patch.target = posInt(body, 'target');
      if (body?.batch !== undefined) patch.batch = posInt(body, 'batch');
      if (body?.enabled !== undefined) patch.enabled = !!body.enabled;
      const updated = await updateRule(id, patch);
      if (!updated) return fail(res, 404, 'NOT_FOUND', `rule ${id}`);
      return ok(res, updated);
    }
    if (method === 'DELETE') {
      if (!(await deleteRule(id))) return fail(res, 404, 'NOT_FOUND', `rule ${id}`);
      return ok(res, { deleted: id });
    }
    return fail(res, 405, 'METHOD_NOT_ALLOWED', 'GET, PATCH or DELETE');
  }

  // --- Trend groups (shared) ----------------------------------------------
  // Named item sets for the Trends chart. Everything here is the shared half of
  // the feature; the private half lives entirely in the browser and never
  // reaches this service.
  if (p === '/trendgroups') {
    if (method === 'GET') {
      return ok(res, await listGroups(q.get('grid') || null));
    }
    if (method === 'POST') {
      const grid = body?.grid ?? q.get('grid');
      if (!grid) throw new BadRequest('grid is required');
      return ok(
        res,
        await upsertGroup({
          gridKey: grid,
          name: groupName(body?.name),
          items: body?.items,
          mode: groupMode(body?.mode),
        }),
      );
    }
    return fail(res, 405, 'METHOD_NOT_ALLOWED', 'GET or POST');
  }

  const group = /^\/trendgroups\/(\d+)$/.exec(p);
  if (group) {
    const id = Number(group[1]);
    if (method === 'GET') {
      const found = await getGroup(id);
      if (!found) return fail(res, 404, 'NOT_FOUND', `group ${id}`);
      return ok(res, found);
    }
    if (method === 'PATCH' || method === 'POST') {
      const patch = {};
      if (body?.name !== undefined) patch.name = groupName(body.name);
      if (body?.items !== undefined) patch.items = body.items;
      if (body?.mode !== undefined) patch.mode = groupMode(body.mode);
      const updated = await updateGroup(id, patch);
      if (!updated) return fail(res, 404, 'NOT_FOUND', `group ${id}`);
      return ok(res, updated);
    }
    if (method === 'DELETE') {
      if (!(await deleteGroup(id))) return fail(res, 404, 'NOT_FOUND', `group ${id}`);
      return ok(res, { deleted: id });
    }
    return fail(res, 405, 'METHOD_NOT_ALLOWED', 'GET, PATCH or DELETE');
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
    // `from` turns on the change column; `sort=change` orders by it. Both are
    // optional so the plain "what's in here" call stays a single index scan.
    const from = q.get('from') ? parseTime(q.get('from'), null) : null;
    const sort = q.get('sort') === 'change' ? 'change' : 'quantity';
    const dir = q.get('dir') === 'asc' ? 'asc' : 'desc';
    // Hide anything holding less than this. 0/absent/garbage = no filter.
    const min = Math.max(0, Number(q.get('min')) || 0);
    return ok(res, await searchItems(grid, q.get('q') || '', limit, { from, sort, dir, min }));
  }

  // One item, for the detail panel: identity + exact range stats + its series.
  if (p === '/item') {
    const grid = q.get('grid');
    if (!grid) return fail(res, 400, 'MISSING_PARAM', 'grid');
    const itemid = q.get('itemid');
    if (!itemid) return fail(res, 400, 'MISSING_PARAM', 'itemid');
    const to = parseTime(q.get('to'), new Date());
    const from = parseTime(q.get('from'), new Date(to.getTime() - 24 * 3600e3));
    if (from >= to) return fail(res, 400, 'BAD_RANGE', 'from must be before to');
    const points = Math.min(2000, Number(q.get('points')) || 200);

    const detail = await itemDetail(grid, itemid, from, to);
    // Deliberately OK-with-null rather than 404: the SPA's call() throws on any
    // non-OK envelope, so a 404 would surface as an error toast. "No history for
    // this item yet" is an expected state and belongs in the panel as prose.
    if (!detail) return ok(res, { item: null, range: null, from, to, points: [] });

    const { series: rows } = await series(grid, [itemid], from, to, points);
    return ok(res, { ...detail, from, to, points: rows[0]?.points ?? [] });
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
    // `names` is returned alongside rather than folded into `series` so a caller
    // restoring a selection from itemids alone can label items that have no
    // points in the requested range.
    const { series: rows, names } = await series(grid, itemids, from, to, points);
    return ok(res, { from, to, series: rows, names });
  }

  return fail(res, 404, 'NOT_FOUND', p);
}

/**
 * Read and parse a JSON request body.
 *
 * Capped well below anything a rule could legitimately be: this endpoint is
 * authenticated, but an unbounded read is an unbounded read.
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 64_000) {
        reject(new BadRequest('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new BadRequest('body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
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
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
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
      const body = req.method === 'GET' || req.method === 'HEAD' ? null : await readJsonBody(req);
      await route(url, res, req.method, fresh, body);
    } catch (e) {
      if (e instanceof BadRequest) return fail(res, 400, 'BAD_REQUEST', e.message);
      // A rename onto a name another group already holds. Reported as its own
      // status so the dialog can say which name clashed instead of showing a
      // raw constraint error.
      if (e?.code === '23505') return fail(res, 409, 'NAME_TAKEN', 'a group with that name already exists');
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
