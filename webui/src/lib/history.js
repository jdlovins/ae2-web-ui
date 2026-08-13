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
  /** Items known for a grid, biggest current stock first. */
  items: (grid, q = '', limit = 200) => call(`/history/items?grid=${enc(grid)}&q=${enc(q)}&limit=${limit}`),
  /**
   * Series for up to 20 itemids. `from`/`to` accept ISO or a relative offset
   * ("-24h", "-7d"); the service buckets down to ~`points` samples.
   */
  series: (grid, itemids, from, points = 400) =>
    call(`/history/series?grid=${enc(grid)}&items=${itemids.map(enc).join(',')}&from=${enc(from)}&points=${points}`),
};

// Time ranges offered above the chart. Presets before any custom range, and the
// one users reach for most sits first.
export const RANGES = [
  { id: '-24h', label: '24h' },
  { id: '-7d', label: '7d' },
  { id: '-30d', label: '30d' },
  { id: '-90d', label: '90d' },
  { id: '-1h', label: '1h' },
];
