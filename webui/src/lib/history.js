// Client for the gateway service (../../gateway), mounted at /history.
// Same {status:"OK",data} envelope as the mod, so errors surface identically.

// The gateway gates /history/* on the same bearer token the mod issues
// (it replays the token against the mod to verify it), so these calls go through
// api.js's authenticated `call` and inherit its silent re-auth on 401.
import { call } from './api.js';

const enc = encodeURIComponent;

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
  items: (grid, q = '', limit = 200, { from = null, sort = null, dir = null } = {}) =>
    call(
      `/history/items?grid=${enc(grid)}&q=${enc(q)}&limit=${limit}` +
        (from ? `&from=${enc(from)}` : '') +
        (sort ? `&sort=${enc(sort)}` : '') +
        (dir ? `&dir=${enc(dir)}` : ''),
    ),
  /**
   * Series for up to 20 itemids. `from`/`to` accept ISO or a relative offset
   * ("-24h", "-7d"); the service buckets down to ~`points` samples.
   *
   * Resolves to `{ from, to, series, names }`. `names` maps itemid -> itemname
   * for every id asked for, including ones with no points in range.
   */
  series: (grid, itemids, from, points = 400) =>
    call(`/history/series?grid=${enc(grid)}&items=${itemids.map(enc).join(',')}&from=${enc(from)}&points=${points}`),
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
