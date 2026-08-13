// Caching read-through proxy for the mod's expensive read routes.
//
// nginx sends these paths here instead of to the mod; writes (/order, /job,
// /cancelcpu) and /auth still go straight to the mod and are never cached.
//
// The SPA is unchanged: same paths, same {status:"OK",data} envelope. It just
// stops being the thing that hammers the server tick.
//
// Fills are done with the COLLECTOR's mod session rather than the caller's, so
// one warm entry serves every tab. That's sound because this API is
// admin-only — AE2Controller issues tokens for a single admin identity and the
// read routes don't vary by player. If the mod ever grows per-player scoping,
// the cache key must include the caller.

import { call } from './ae2.mjs';
import { cached } from './cache.mjs';
import { withModMap, currentItemsGrid } from './modmap.mjs';

// Tight enough to feel live, long enough that N tabs cost what one tab costs.
const ROUTES = {
  '/items': { ttl: 10_000, params: ['grid'] },
  '/list': { ttl: 3_000, params: ['grid'] },
  '/get': { ttl: 2_500, params: ['grid', 'cpu'] },
  '/grids': { ttl: 15_000, params: [] },
};

export const PROXIED_PATHS = Object.keys(ROUTES);

export function isProxied(pathname) {
  return Object.prototype.hasOwnProperty.call(ROUTES, pathname);
}

/** Cache key for the item-list route, shared with the collector's poller. */
export const itemsKey = (grid) => `/items?grid=${grid}`;
export const ITEMS_TTL = ROUTES['/items'].ttl;

/**
 * Serve a proxied read. Returns the mod's `data` payload.
 * `fresh` comes from a `Cache-Control: no-cache` request header, which the SPA
 * sends only for an explicit Refresh.
 */
export function proxyRead(pathname, searchParams, { fresh = false } = {}) {
  const route = ROUTES[pathname];
  if (!route) throw new Error(`not a proxied route: ${pathname}`);

  // Build the key and the upstream query from a fixed param allow-list, so a
  // caller can't fragment the cache (or smuggle params) with extra junk.
  const qs = new URLSearchParams();
  for (const name of route.params) {
    const v = searchParams.get(name);
    if (v !== null) qs.set(name, v);
  }
  const suffix = qs.toString();
  const upstream = suffix ? `${pathname}?${suffix}` : pathname;

  // /items mutates the mod's shared stack map, so it serialises with orders.
  const fetcher = pathname === '/items' ? () => withModMap(() => call(upstream)) : () => call(upstream);
  return cached(upstream, route.ttl, fetcher, { fresh });
}

/**
 * Make the mod's stack map hold this grid, refilling it if it doesn't.
 *
 * Only meaningful while holding the modmap lock — the caller must already be
 * inside withModMap, or the map can be swapped out again before it's used.
 */
export async function ensureStackMap(gridKey) {
  if (currentItemsGrid() !== String(gridKey)) {
    // Deliberately uncached: it must reach the mod, since refilling that map
    // server-side is the entire point.
    await call(`/items?grid=${encodeURIComponent(gridKey)}`);
  }
}

/**
 * Forward an order, repairing the mod's stack map first if it currently holds a
 * different grid. Held under the same lock as /items so nothing can clobber the
 * map between the repair and the order itself.
 */
export function proxyOrder(searchParams) {
  const grid = searchParams.get('grid');
  const item = searchParams.get('item');
  const quantity = searchParams.get('quantity');
  if (!grid || !item || !quantity) throw new Error('order needs grid, item and quantity');
  const qs = new URLSearchParams({ grid, item, quantity }).toString();
  return withModMap(async () => {
    await ensureStackMap(grid);
    return call(`/order?${qs}`);
  });
}
