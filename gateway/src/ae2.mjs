// Client for the mod's HTTP API. Mirrors webui/src/lib/api.js: bearer token
// from POST /auth, one silent re-auth on 401, {status:"OK",data} envelope.

import { config } from './config.mjs';
import { cached } from './cache.mjs';
import { noteItemsFor, invalidate, withModMap } from './modmap.mjs';
import { ITEMS_TTL } from './proxy.mjs';

// A hung Minecraft server must not wedge a request forever. The mod's synced
// requests give up server-side after ~10s, so anything beyond this is the
// connection itself hanging — which is exactly what happened when the server
// locked up: fetches that never settle, ticks piling up behind them.
const REQUEST_TIMEOUT_MS = Number(process.env.AE2_TIMEOUT_MS) || 30_000;

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
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status === 401) {
    await authenticate();
    res = await fetch(config.modUrl + path, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
      // Carried for the maintainer, which can only order by hashcode. Once a
      // craftable stack is found it wins the slot: stacks sharing an itemid
      // differ by NBT, and ordering a non-craftable one is refused outright.
      if (!prev.craftable && it.craftable) prev.hashcode = it.hashcode;
      prev.craftable = prev.craftable || !!it.craftable;
    } else {
      byId.set(it.itemid, {
        itemid: it.itemid,
        itemname: it.itemname || it.itemid,
        quantity: Number(it.quantity) || 0,
        craftable: !!it.craftable,
        // Valid only until the mod's stack map is refilled for another grid,
        // and never across a server restart. Must not be persisted.
        hashcode: it.hashcode,
        // Fluids come back as a bare FluidRegistry name with no colons;
        // items are always "modid:name:meta".
        isFluid: !it.itemid.includes(':'),
      });
    }
  }
  return [...byId.values()];
}

// --- Crafting, for the level maintainer ---------------------------------
//
// Deliberately uncached, unlike the SPA's reads through proxy.mjs: the
// maintainer decides whether to spend a CPU based on these answers, and acting
// on a three-second-old "that CPU is free" is how you get a double order.

/** `{ [cpuName]: { isBusy, availableStorage, craftingAllowMode, finalOutput, … } }` */
export function cpuList(gridKey) {
  return call(`/list?grid=${encodeURIComponent(gridKey)}`);
}

/** Start planning a craft. Resolves to `{ jobID }`; the plan computes async. */
export function beginOrder(gridKey, hashcode, quantity) {
  return call(`/order?grid=${encodeURIComponent(gridKey)}&item=${hashcode}&quantity=${quantity}`);
}

/** Poll a plan. `isDone` false means still computing; `isSimulating` means it can't be made. */
export function jobStatus(gridKey, jobID) {
  return call(`/job?grid=${encodeURIComponent(gridKey)}&id=${jobID}`);
}

export function submitJob(gridKey, jobID, cpuName) {
  return call(
    `/job?grid=${encodeURIComponent(gridKey)}&id=${jobID}&submit&cpu=${encodeURIComponent(cpuName)}`,
  );
}

export function cancelJob(gridKey, jobID) {
  return call(`/job?grid=${encodeURIComponent(gridKey)}&id=${jobID}&cancel`);
}
