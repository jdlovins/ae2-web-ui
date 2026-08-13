// Client for the mod's HTTP API. Mirrors webui/src/lib/api.js: bearer token
// from POST /auth, one silent re-auth on 401, {status:"OK",data} envelope.

import { config } from './config.mjs';
import { cached } from './cache.mjs';
import { noteItemsFor, invalidate, withModMap } from './modmap.mjs';
import { ITEMS_TTL } from './proxy.mjs';

export class ApiError extends Error {
  constructor(status, data) {
    super(`${status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
    this.status = status;
    this.data = data;
  }
}

let token = null;

async function authenticate() {
  const res = await fetch(`${config.modUrl}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      username: config.username,
      password: config.password,
      remember: 'on',
    }).toString(),
  });
  if (!res.ok) throw new ApiError('AUTH_FAILED', `HTTP ${res.status}`);
  const data = await res.json();
  if (!data?.token) throw new ApiError('AUTH_FAILED', 'no token in response');
  token = data.token;
  // A fresh session usually means the mod restarted, so its map is empty now.
  invalidate();
}

export async function call(path) {
  if (!token) await authenticate();
  let res = await fetch(config.modUrl + path, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (res.status === 401) {
    await authenticate();
    res = await fetch(config.modUrl + path, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
  }
  if (!res.ok) throw new ApiError(`HTTP_${res.status}`, await res.text().catch(() => ''));
  const json = await res.json();
  if (json.status !== 'OK') throw new ApiError(json.status, json.data);
  // Every /items reaching the mod clears and refills its global stack map with
  // just this grid — remember which, so an order can repair it if needed.
  const items = /^\/items\?grid=([^&]+)/.exec(path);
  if (items) noteItemsFor(decodeURIComponent(items[1]));
  return json.data;
}

/** Attached grids only; key === -1 means "no security terminal", not selectable. */
export async function listGrids() {
  const grids = await call('/grids');
  return grids.filter((g) => g.key !== -1);
}

/**
 * Snapshot one grid, collapsed to one row per itemid.
 *
 * Several stacks can share an itemid (same item, different NBT), so quantities
 * are summed and `craftable` is OR-ed — the series then means "how much of this
 * item does the network hold", which is what an inventory level should be.
 */
export async function snapshotGrid(gridKey) {
  // Through the shared cache: the collector warms exactly the entry the SPA's
  // item grid reads, so a user browsing right after a tick costs the mod nothing.
  const path = `/items?grid=${encodeURIComponent(gridKey)}`;
  const raw = await cached(path, ITEMS_TTL, () => withModMap(() => call(path)));
  const byId = new Map();
  for (const it of raw) {
    if (!it?.itemid) continue;
    const prev = byId.get(it.itemid);
    if (prev) {
      prev.quantity += Number(it.quantity) || 0;
      prev.craftable = prev.craftable || !!it.craftable;
    } else {
      byId.set(it.itemid, {
        itemid: it.itemid,
        itemname: it.itemname || it.itemid,
        quantity: Number(it.quantity) || 0,
        craftable: !!it.craftable,
        // Fluids come back as a bare FluidRegistry name with no colons;
        // items are always "modid:name:meta".
        isFluid: !it.itemid.includes(':'),
      });
    }
  }
  return [...byId.values()];
}
