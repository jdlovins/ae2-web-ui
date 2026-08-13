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

// The single entry point for running a tick. Concurrent callers — the schedule,
// the UI's "Snapshot now", two clicks in a row — all collapse onto the run
// that's already going rather than starting another poll of the game server.
let inFlight = null;
function runTick() {
  if (!inFlight) {
    inFlight = tick().finally(() => { inFlight = null; });
  }
  return inFlight;
}

/** Manual trigger for the UI's "Snapshot now" button. */
export function collectNow() {
  return runTick().then(() => ({
    ok: !state.lastError,
    at: state.lastRunAt,
    error: state.lastError,
    rowsWritten: state.rowsWritten,
  }));
}

/**
 * Start the poller.
 *
 * Deliberately a self-scheduling setTimeout chain, NOT setInterval. setInterval
 * fires on a fixed cadence regardless of whether the previous run finished, so a
 * slow or hung mod makes ticks overlap and pile up: each one holds the stack-map
 * lock or waits on a socket, memory grows, and when the mod recovers they all
 * fire at once — a thundering herd on the very server tick this service exists
 * to protect. (An earlier version of this file claimed overlap was harmless
 * because the unique index dedupes the rows. The rows, yes; the load, no.)
 *
 * Scheduling the next run only after the current one settles makes overlap
 * structurally impossible instead of merely deduped. The delay is measured from
 * completion, so the cadence stays ~intervalSec when ticks are quick and
 * degrades to back-to-back rather than unbounded when they are slow.
 */
export function startCollector() {
  if (config.intervalSec < MIN_SANE_INTERVAL) {
    console.warn(
      `[collect] SAMPLE_INTERVAL_SEC=${config.intervalSec}s is below the ${MIN_SANE_INTERVAL}s ` +
        `advisory floor. /items runs on the Minecraft server tick and will lag the game.`,
    );
  }
  console.log(`[collect] every ${config.intervalSec}s against ${config.modUrl}`);

  const periodMs = config.intervalSec * 1000;
  let timer = null;
  let stopped = false;

  const loop = async () => {
    const startedAt = Date.now();
    await runTick(); // never rejects: tick() handles its own failures
    if (stopped) return;
    // At least a second of breathing room even if a tick overran the period.
    const delay = Math.max(1000, periodMs - (Date.now() - startedAt));
    timer = setTimeout(loop, delay);
  };
  loop();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
