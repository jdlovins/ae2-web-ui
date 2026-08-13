// Serialises the interactions that depend on the mod's global stack map.
//
// The mod keeps ONE map of hashcode -> stack (AE2Controller.hashcodeToStack) and
// GetItems.handle() CLEARS it on every /items call, refilling it with only the
// grid that was asked for. /order then resolves its `item` hashcode out of that
// map — so an /items for a *different* grid in between makes a perfectly valid
// order fail with ITEM_NOT_FOUND.
//
// On a single-grid network you'd rarely notice. With two grids and a background
// poller sampling both, the map flips every minute and ordering breaks at random
// (verified: identical order returns OK, then ITEM_NOT_FOUND after polling the
// other grid).
//
// This gateway is the only thing that talks to the mod, so it can fix this
// without mod changes: track which grid last filled the map, refill it for the
// right grid before forwarding an order, and hold a lock across those two calls
// so nothing — including the collector — can clobber it in between.
//
// The proper fix is upstream: key that map per grid. Until then this holds.

let tail = Promise.resolve();

/** Run `fn` with exclusive access to the mod's stack map. FIFO, never rejects the chain. */
export function withModMap(fn) {
  const result = tail.then(fn, fn);
  tail = result.then(
    () => {},
    () => {},
  );
  return result;
}

let lastGrid = null;

/** Record that an upstream /items has just refilled the map for this grid. */
export function noteItemsFor(gridKey) {
  lastGrid = gridKey == null ? null : String(gridKey);
}

/** The grid whose stacks the mod's map currently holds, as far as we know. */
export function currentItemsGrid() {
  return lastGrid;
}

/** Forget our assumption (e.g. the mod restarted and cleared everything). */
export function invalidate() {
  lastGrid = null;
}
