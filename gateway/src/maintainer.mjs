// Level maintainer: keep configured items above a stock floor by ordering a
// fixed batch whenever they fall below it.
//
// Runs at the end of each collector tick, off the snapshot that tick just took.
// That is why it costs the game nothing extra in the common case: quantities are
// already in hand, and the mod is only contacted when a rule actually needs to
// order something.
//
// CPU CHOICE IS OURS, NOT AE2's. AE2 only honours a CPU's "Accept request"
// setting when it picks the CPU itself (CraftingGridCache.submitJob, the
// `target == null` branch); an explicitly named CPU skips the check entirely.
// Meanwhile every request this mod makes carries a PlayerSource — PlayerSource
// .isPlayer() is unconditionally true, fake player or not — so if we let AE2
// choose, the maintainer would be treated as a player: it would compete for the
// CPUs you use interactively and be refused by the ones you reserved for
// automation. Exactly backwards. So we filter and name the CPU ourselves.
//
// The tradeoff, stated plainly: this leans on AE2 not enforcing allow-mode for
// named targets. If that is ever tightened upstream, submission starts failing
// and the durable fix is a non-player order path in the mod itself.

import { config } from './config.mjs';
import { cpuList, beginOrder, jobStatus, submitJob, cancelJob, ApiError } from './ae2.mjs';
import { withModMap } from './modmap.mjs';
import { ensureStackMap } from './proxy.mjs';
import { listRules, recordFailure, noteOrdered, logEvent, recentOrders } from './db.mjs';

// Counters are lifetime totals across every grid; anything describing a CURRENT
// situation is per grid, under `grids`. Those two were conflated at first, and a
// single `inFlight` is actively misleading with more than one grid: each grid
// overwrites it, so the number shown belongs to whichever grid happened to run
// last rather than to the network you were looking at.
export const state = {
  runs: 0,
  lastRunAt: null,
  lastError: null,
  ordered: 0,
  failures: 0,
  grids: {},
};

/** Per-grid slot in `state.grids`, created on first use. */
function gridState(gridKey) {
  const key = String(gridKey);
  state.grids[key] ??= {
    inFlight: 0,
    othersCrafting: 0,
    ordered: 0,
    failures: 0,
    skipped: null,
    lastRunAt: null,
    lastError: null,
    // Jobs THIS service submitted and believes are still running:
    // [{ cpu, itemid, at }]. Seeded from the database on the first tick after a
    // restart — see seedOwned().
    owned: [],
    ownedSeeded: false,
  };
  return state.grids[key];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Rank a CPU for maintainer use. Lower is better; null means never use it.
 *
 * An absent craftingAllowMode means the mod predates the field, so the setting
 * cannot be read at all. Treated as unrestricted rather than skipped: refusing
 * to work on an older mod build would be worse than occasionally taking a CPU
 * the user meant for themselves, and they can still pin one via the setting
 * once they update.
 */
function cpuRank(mode) {
  if (mode === 'ONLY_PLAYER') return null;
  if (mode === 'ONLY_NONPLAYER') return 0;
  return 1;
}

/**
 * Pick the CPU to run `bytes` on, or null if none is suitable.
 *
 * Automation-only CPUs first, then unrestricted, never player-only. Within a
 * tier the SMALLEST sufficient CPU wins — the opposite of AE2's own "most
 * co-processors first", and deliberately so: this is background restocking, and
 * burning the fastest CPU on it is precisely what you don't want when you sit
 * down to craft something yourself.
 */
export function pickCpu(cpus, bytes) {
  const eligible = [];
  for (const [name, c] of Object.entries(cpus || {})) {
    if (!c || c.isBusy || c.finalOutput) continue;
    const rank = cpuRank(c.craftingAllowMode);
    if (rank === null) continue;
    // Same test AE2 makes for an idle CPU: availableStorage is the cluster's
    // total capacity, not its free space.
    if (Number(c.availableStorage) < bytes) continue;
    eligible.push({ name, rank, size: Number(c.availableStorage) });
  }
  eligible.sort((a, b) => a.rank - b.rank || a.size - b.size || a.name.localeCompare(b.name));
  return eligible[0]?.name ?? null;
}

/** Items currently being crafted anywhere on the grid, as a Set of itemid. */
function craftingNow(cpus) {
  const busy = new Set();
  for (const c of Object.values(cpus || {})) {
    if (c?.finalOutput?.itemid) busy.add(c.finalOutput.itemid);
  }
  return busy;
}

/**
 * Of the jobs we placed, the ones still running.
 *
 * A job survives only while the CPU we submitted it to is still showing that
 * item as its final output. Anything else — finished, cancelled, or the CPU
 * moved on to something else — drops out. That makes the list self-healing
 * without job ids or any cleanup pass of its own: nothing can leak, because
 * membership is re-derived from the live CPU list every tick.
 *
 * Pure, and exported, so it can be exercised against fixtures without a mod.
 */
export function stillRunning(cpus, owned) {
  return (owned || []).filter((j) => cpus?.[j.cpu]?.finalOutput?.itemid === j.itemid);
}

/**
 * Rebuild `owned` after a restart from the events we already write.
 *
 * Every submission logs an 'ordered' event carrying the CPU name, so the record
 * of what we placed outlives the process. Whatever comes back is passed through
 * stillRunning() by the caller, so rows whose CPU has since moved on cost
 * nothing. The window only has to exceed the longest plausible job.
 */
async function seedOwned(gridKey) {
  try {
    const rows = await recentOrders(gridKey, 24 * 3600_000);
    return rows.map((r) => ({ cpu: r.cpu, itemid: r.itemid, at: new Date(r.ts).getTime() }));
  } catch {
    // A failure here means the cap under-counts until these jobs finish, which
    // is the same position a restart used to leave it in permanently. Not worth
    // failing the tick over.
    return [];
  }
}

/** Wait for a plan to finish computing. Returns the finished job data, or null on timeout. */
async function awaitPlan(gridKey, jobID) {
  const deadline = Date.now() + config.maintainPlanTimeoutSec * 1000;
  for (;;) {
    const data = await jobStatus(gridKey, jobID);
    if (data?.isDone) return data;
    if (Date.now() >= deadline) return null;
    await sleep(500);
  }
}

/**
 * Everything a failed plan couldn't source, biggest shortfall first.
 *
 * Kept in full on the event so the UI can show the actual list. The rule row
 * only has space for a line of text, and truncating there used to be the only
 * copy — "Agar ×512" with no way to find out what else was short.
 */
function missingItems(plan) {
  return (plan || [])
    .filter((p) => p.missing > 0)
    .map((p) => ({ itemid: p.itemid, itemname: p.itemname, missing: Number(p.missing) }))
    .sort((a, b) => b.missing - a.missing);
}

/** One line for the rule row. Says when it is hiding some. */
function missingSummary(missing) {
  if (!missing.length) return 'no craftable path';
  const head = missing.slice(0, 3).map((p) => `${p.itemname} ×${p.missing}`).join(', ');
  return missing.length > 3 ? `${head} (+${missing.length - 3} more)` : head;
}

// Flat, not exponential. A rule almost always fails because an ingredient is
// missing, and that gets fixed on a human timescale — escalating to hours meant a
// rule you repaired in two minutes could still be sitting out a multi-hour wait,
// looking broken. fail_count is still counted; it just no longer sets the delay.
//
// The cost this gives up: a permanently unmakeable rule now re-plans every
// interval forever rather than tapering off, and a failed plan is the expensive
// kind — AE2 walks the whole tree, and awaitPlan polls /job on the server tick.
const backoffMs = () => config.maintainBackoffSec * 1000;

/**
 * Order one batch for one rule. Returns the NAME OF THE CPU the job was
 * submitted to, or false if nothing was submitted — the caller records that name
 * so the job can be recognised as ours on later ticks and counted against the
 * job cap.
 *
 * The whole sequence is held under the modmap lock: the hashcode we order by is
 * only valid while the mod's global stack map holds THIS grid, and the collector
 * polling another grid in between would silently invalidate it.
 */
async function fulfil(rule, item, cpus) {
  const gridKey = String(rule.grid_key);

  const { jobID } = await withModMap(async () => {
    await ensureStackMap(gridKey);
    return beginOrder(gridKey, item.hashcode, rule.batch);
  });

  const plan = await awaitPlan(gridKey, jobID);
  if (!plan) {
    // Abandon rather than leave it pinned in the mod's job table forever. Not
    // counted as a failure: nothing says the plan was impossible, only slow.
    await cancelJob(gridKey, jobID).catch(() => {});
    await logEvent(rule.id, 'timeout', { quantity: rule.batch, detail: 'plan did not finish in time' });
    return false;
  }

  if (plan.isSimulating) {
    // The expensive outcome, and the one backoff exists for: AE2 computed the
    // whole tree and found it unmakeable. Retrying that every tick is what would
    // actually hurt the server.
    await cancelJob(gridKey, jobID).catch(() => {});
    const missing = missingItems(plan.plan);
    const detail = missingSummary(missing);
    await recordFailure(rule.id, detail, backoffMs());
    await logEvent(rule.id, 'failed', {
      quantity: rule.batch,
      detail,
      data: { missing, bytesTotal: Number(plan.bytesTotal) || 0 },
    });
    state.failures++;
    gridState(gridKey).failures++;
    return false;
  }

  const cpu = pickCpu(cpus, Number(plan.bytesTotal) || 0);
  if (!cpu) {
    // Not a failure: no plan was wasted in any meaningful sense and the CPUs
    // will free up on their own. Retry next tick, no backoff.
    await cancelJob(gridKey, jobID).catch(() => {});
    return false;
  }

  await submitJob(gridKey, jobID, cpu);
  await noteOrdered(rule.id);
  await logEvent(rule.id, 'ordered', { quantity: rule.batch, cpu });
  state.ordered++;
  gridState(gridKey).ordered++;
  // Claim it locally so a second rule in this same tick sees the CPU as taken —
  // `cpus` is a snapshot from before the submission.
  if (cpus[cpu]) cpus[cpu].isBusy = true;
  // The CPU name, not just success: the caller records it as ours so the job
  // can be recognised on later ticks and counted against the cap.
  return cpu;
}

/**
 * Run every rule for one grid against the snapshot just taken.
 *
 * `items` is the collapsed snapshot from ae2.snapshotGrid, so it carries both
 * the quantity to compare and the hashcode to order by.
 */
export async function runForGrid(gridKey, items) {
  if (!config.maintainEnabled) return;

  const gs = gridState(gridKey);
  gs.lastRunAt = new Date();
  gs.skipped = null;

  const rules = (await listRules(gridKey)).filter((r) => r.enabled);
  if (!rules.length) { gs.inFlight = 0; gs.othersCrafting = 0; gs.owned = []; return; }

  const byId = new Map(items.map((i) => [i.itemid, i]));
  const now = Date.now();
  const active = rules.filter((r) => !r.retry_after || new Date(r.retry_after).getTime() <= now);

  // Which rules actually want something right now. Computed before touching the
  // mod so a grid where everything is stocked — the normal case — costs nothing.
  const wanting = [];
  for (const r of active) {
    const item = byId.get(r.itemid);
    if (!item) {
      // The item isn't in this grid at all, so there is no hashcode to order by.
      // Recorded as a failure purely so the backoff timer suppresses it: without
      // that, a typo'd or decommissioned rule writes an event every single tick.
      await recordFailure(r.id, 'item not present in this grid', backoffMs());
      await logEvent(r.id, 'unknown', { detail: 'item not present in this grid' });
      continue;
    }
    if (item.quantity < Number(r.target)) wanting.push(r);
  }

  // Nothing to do, and deliberately without asking the mod for its CPU list —
  // this is the normal case and it should cost nothing. The consequence is that
  // `inFlight`/`othersCrafting` in health are as of the last tick that had work
  // to do, not of this instant; `lastRunAt` is when the rules were last checked,
  // which is not the same thing.
  if (!wanting.length) return;

  const cpus = await cpuList(gridKey);
  const busyWith = craftingNow(cpus);

  // The cap governs how much work the MAINTAINER runs at once, so only the jobs
  // it placed count against it. Crafts a player started by hand are none of its
  // business — an earlier version counted those too, and on a server where
  // people craft maintained items themselves it meant three hand-started jobs
  // silently ate the budget and every short rule reported "job cap reached"
  // while the maintainer held nothing.
  //
  // This cannot cause a duplicate job: the busyWith check below still skips any
  // item being crafted by anyone, and pickCpu() never takes a busy CPU, so the
  // network's own capacity remains the real limit on total load.
  if (!gs.ownedSeeded) {
    gs.owned = await seedOwned(gridKey);
    gs.ownedSeeded = true;
  }
  gs.owned = stillRunning(cpus, gs.owned);
  let running = gs.owned.length;
  gs.inFlight = running;

  // Reported alongside so health answers "whose jobs are these" without anyone
  // having to reason about it — the question that made this bug slow to find.
  const ruleIds = new Set(rules.map((r) => r.itemid));
  const ours = new Set(gs.owned.map((j) => j.itemid));
  gs.othersCrafting = [...busyWith].filter((id) => ruleIds.has(id) && !ours.has(id)).length;

  for (const rule of wanting) {
    // Something is already making it — ours or yours; either way a second job
    // would just double-stock.
    if (busyWith.has(rule.itemid)) continue;

    // Counted from THIS grid's CPUs, so the cap is naturally per grid: one
    // network saturating its crafting capacity can't starve another.
    if (running >= config.maintainMaxJobs) {
      gs.skipped = `job cap (${config.maintainMaxJobs}) reached`;
      break;
    }

    const item = byId.get(rule.itemid);
    if (item?.hashcode == null) continue;

    try {
      const cpu = await fulfil(rule, item, cpus);
      if (cpu) {
        gs.owned = [...gs.owned, { cpu, itemid: rule.itemid, at: Date.now() }];
        running++;
        gs.inFlight = running;
      }
    } catch (e) {
      // ALL_CPU_BUSY and a stale hashcode (ITEM_NOT_FOUND, e.g. the game server
      // restarted since the snapshot) are both cheap and transient — no plan was
      // computed, so retrying next tick costs nothing and backing off for half an
      // hour would just make the maintainer look broken.
      const transient = e instanceof ApiError && (e.status === 'ALL_CPU_BUSY' || e.status === 'ITEM_NOT_FOUND');
      if (transient) continue;
      state.failures++;
      state.lastError = e.message;
      gs.failures++;
      gs.lastError = e.message;
      await recordFailure(rule.id, e.message, backoffMs());
      await logEvent(rule.id, 'error', { detail: e.message });
    }
  }
}

/** Called by the collector once per tick, after every grid has been snapshotted. */
export async function runMaintainer(snapshots) {
  if (!config.maintainEnabled) return;
  state.runs++;
  state.lastRunAt = new Date();
  for (const [gridKey, items] of snapshots) {
    try {
      await runForGrid(gridKey, items);
    } catch (e) {
      // Never throw into the collector loop: a maintainer problem must not stop
      // history from being recorded. Per grid, so one unreachable network does
      // not stop the others being maintained.
      state.lastError = e.message;
      gridState(gridKey).lastError = e.message;
      console.error(`[maintain] grid ${gridKey}: ${e.message}`);
    }
  }
}
