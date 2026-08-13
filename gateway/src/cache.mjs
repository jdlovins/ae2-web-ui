// Single-flight TTL cache.
//
// The point is not really the TTL — it's the coalescing. Every read route on the
// mod is an ISyncedRequest, so it executes inline on the Minecraft server tick;
// load therefore scales with the number of open browser tabs, which is a
// terrible thing for it to scale with. Funnelling all readers through here makes
// the mod's load O(1) in users instead of O(users).

const entries = new Map(); // key -> { value, expires }
const inflight = new Map(); // key -> Promise

export const stats = { hits: 0, misses: 0, coalesced: 0, fetches: 0 };

/**
 * Resolve `key`, fetching at most once per TTL window and at most once
 * concurrently.
 *
 * `fresh` skips a warm entry (the UI's explicit Refresh), but still joins an
 * in-flight fetch — that data is already as new as a new request would get, and
 * joining keeps a refresh storm down to one hit on the game server.
 */
export function cached(key, ttlMs, fetcher, { fresh = false } = {}) {
  if (!fresh) {
    const hit = entries.get(key);
    if (hit && hit.expires > Date.now()) {
      stats.hits++;
      return Promise.resolve(hit.value);
    }
  }

  const flying = inflight.get(key);
  if (flying) {
    stats.coalesced++;
    return flying;
  }

  stats.misses++;
  stats.fetches++;
  const p = fetcher()
    .then((value) => {
      entries.set(key, { value, expires: Date.now() + ttlMs });
      return value;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Seed the cache from data fetched elsewhere (the collector's own poll). */
export function put(key, value, ttlMs) {
  entries.set(key, { value, expires: Date.now() + ttlMs });
}

/** Drop expired entries. The key space is routes×grids, so this stays tiny. */
export function prune() {
  const now = Date.now();
  for (const [k, v] of entries) if (v.expires <= now) entries.delete(k);
}

export function size() {
  return entries.size;
}
