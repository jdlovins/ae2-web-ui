// Polling loop: snapshot every tracked grid on an interval and store it.

import { listGrids, snapshotGrid } from './ae2.mjs';
import { writeSnapshot } from './db.mjs';
import { config, MIN_SANE_INTERVAL } from './config.mjs';

export const state = {
  lastRunAt: null,
  lastOkAt: null,
  lastError: null,
  runs: 0,
  failures: 0,
  rowsWritten: 0,
  grids: [],
};

async function resolveGrids() {
  if (config.grids.length) return config.grids;
  const grids = await listGrids();
  return grids.map((g) => String(g.key));
}

async function tick() {
  state.lastRunAt = new Date();
  state.runs++;
  try {
    const grids = await resolveGrids();
    state.grids = grids;
    // One timestamp for the whole tick so every grid lines up on a chart.
    const ts = new Date();
    let rows = 0;
    for (const gridKey of grids) {
      const items = await snapshotGrid(gridKey);
      rows += await writeSnapshot(gridKey, items, ts);
    }
    state.rowsWritten += rows;
    state.lastOkAt = new Date();
    state.lastError = null;
    console.log(`[collect] ${grids.length} grid(s), ${rows} rows @ ${ts.toISOString()}`);
  } catch (e) {
    state.failures++;
    state.lastError = e.message;
    // Never throw out of the loop: the game server restarting is routine, and
    // the next tick should just pick back up.
    console.error(`[collect] failed: ${e.message}`);
  }
}

// Manual trigger for the UI's "Snapshot now" button. Collapses concurrent
// callers onto the in-flight run so a double-click can't double-poll the game
// server, and returns the resulting counters.
let inFlight = null;
export function collectNow() {
  if (!inFlight) {
    inFlight = tick().finally(() => { inFlight = null; });
  }
  return inFlight.then(() => ({
    ok: !state.lastError,
    at: state.lastRunAt,
    error: state.lastError,
    rowsWritten: state.rowsWritten,
  }));
}

export function startCollector() {
  if (config.intervalSec < MIN_SANE_INTERVAL) {
    console.warn(
      `[collect] SAMPLE_INTERVAL_SEC=${config.intervalSec}s is below the ${MIN_SANE_INTERVAL}s ` +
        `advisory floor. /items runs on the Minecraft server tick and will lag the game.`,
    );
  }
  console.log(`[collect] every ${config.intervalSec}s against ${config.modUrl}`);
  tick();
  // setInterval, not a self-scheduling chain: a slow tick should not drift the
  // cadence. Overlap is harmless — the (item_id, ts) unique index dedupes.
  return setInterval(tick, config.intervalSec * 1000);
}
