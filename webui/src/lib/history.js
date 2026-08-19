// Client for the gateway service (../../gateway), mounted at /history.
// Same {status:"OK",data} envelope as the mod, so errors surface identically.

// The gateway gates /history/* on the same bearer token the mod issues
// (it replays the token against the mod to verify it), so these calls go through
// api.js's authenticated `call` and inherit its silent re-auth on 401.
import { call } from './api.js';

const enc = encodeURIComponent;

// Matches the ceiling /history/series enforces. Kept as a constant rather than
// inlined so the two are obviously the same number if either ever moves.
const SERIES_BATCH = 20;

export const history = {
  /** Collector + database health, for the empty/degraded states. */
  health: () => call('/history/health'),
  /** Force a snapshot now instead of waiting for the collector's interval. */
  collect: () => call('/history/collect', 'POST'),
  /** Grids that have samples recorded. */
  grids: () => call('/history/grids'),
  /**
   * Items known for a grid. Biggest current stock first by default; pass
   * `{ from, sort: 'change' }` to rank by how much each moved over that window,
   * which also adds `first_quantity` and a fractional `change` to every row.
   */
  items: (grid, q = '', limit = 200, { from = null, sort = null, dir = null, min = 0 } = {}) =>
    call(
      `/history/items?grid=${enc(grid)}&q=${enc(q)}&limit=${limit}` +
        (from ? `&from=${enc(from)}` : '') +
        (sort ? `&sort=${enc(sort)}` : '') +
        (dir ? `&dir=${enc(dir)}` : '') +
        (min ? `&min=${min}` : ''),
    ),
  /**
   * Series for up to 20 itemids. `from`/`to` accept ISO or a relative offset
   * ("-24h", "-7d"); the service buckets down to ~`points` samples.
   *
   * Resolves to `{ from, to, series, names }`. `names` maps itemid -> itemname
   * for every id asked for, including ones with no points in range.
   */
  series: async (grid, itemids, from, points = 400) => {
    // The endpoint refuses more than SERIES_BATCH ids in one call — a guard on
    // the database, not on the chart — so a group bigger than that is split
    // across requests and stitched back together here. Requests go out in
    // parallel; they are independent reads of the same window.
    const batches = [];
    for (let i = 0; i < itemids.length; i += SERIES_BATCH) batches.push(itemids.slice(i, i + SERIES_BATCH));
    const parts = await Promise.all(
      batches.map((ids) =>
        call(`/history/series?grid=${enc(grid)}&items=${ids.map(enc).join(',')}&from=${enc(from)}&points=${points}`),
      ),
    );
    if (parts.length === 1) return parts[0];
    // `from`/`to` are resolved per request from "now", so they can differ by
    // milliseconds between batches. Take the first: every batch asked for the
    // same window, and the callers use these only for labelling.
    return {
      from: parts[0]?.from,
      to: parts[0]?.to,
      series: parts.flatMap((p) => p.series ?? []),
      names: Object.assign({}, ...parts.map((p) => p.names ?? {})),
    };
  },
  /**
   * One item: identity, exact min/avg/max over the range, and its series.
   * `data.item` is null when the collector has never recorded this item — an
   * expected state, not an error.
   */
  item: (grid, itemid, from = '-24h', points = 200) =>
    call(`/history/item?grid=${enc(grid)}&itemid=${enc(itemid)}&from=${enc(from)}&points=${points}`),
};

// Time ranges offered above the chart, shortest to longest. Nothing indexes into
// this array — both consumers iterate it and hold '-24h' as their own default —
// so the order is purely how it reads.
export const RANGES = [
  { id: '-1h', label: '1h' },
  { id: '-24h', label: '24h' },
  { id: '-7d', label: '7d' },
  { id: '-30d', label: '30d' },
  { id: '-90d', label: '90d' },
];
