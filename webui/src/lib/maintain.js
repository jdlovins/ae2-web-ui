// Client for the level maintainer, served by the gateway under /history/maintain
// (the same prefix nginx already proxies, so no routing change was needed).
//
// Goes through api.js's authenticated `call`, so it inherits the silent re-auth
// on 401 exactly like every other request.
import { call } from './api.js';

const enc = encodeURIComponent;

export const maintain = {
  /** Rules for one grid, enabled first then by name. */
  list: (grid) => call(`/history/maintain?grid=${enc(grid)}`),

  /**
   * Create a rule, or overwrite the existing one for this (grid, item) — the
   * table is unique on that pair, so "add" and "edit the item I already track"
   * are the same operation and the UI needn't distinguish them.
   */
  create: (grid, { itemid, itemname, target, batch }) =>
    call('/history/maintain', 'POST', { body: { grid, itemid, itemname, target, batch } }),

  /** Patch a rule. Any omitted field is left alone; this also clears any backoff. */
  update: (id, patch) => call(`/history/maintain/${id}`, 'PATCH', { body: patch }),

  remove: (id) => call(`/history/maintain/${id}`, 'DELETE'),

  /** Recent activity for one rule: ordered, failed, timeout, unknown, error. */
  events: (id, limit = 20) => call(`/history/maintain/${id}/events?limit=${limit}`),

  /**
   * The maintainer's own view of itself: `enabled`, lifetime counters, and a
   * per-grid `{ lastRunAt, skipped, ... }`. Needed because a rule below target
   * looks identical whether the maintainer hasn't run yet or ran and couldn't
   * place the job — only the gateway knows which.
   */
  status: async () => (await call('/history/health'))?.maintainer ?? null,
};

// When we first saw each rule short of target. Nothing records the moment a
// shortfall actually began, so this is the best available lower bound, and it is
// deliberately session-only: a guess isn't worth persisting, and re-deriving it
// costs one poll. Keyed by rule id, dropped as soon as the rule is back at
// target so a long-running page can't accumulate stale entries.
const firstSeenShort = new Map();

/**
 * Record which rules are currently short. Call after each rules/items refresh,
 * before the statuses are read.
 */
export function noteShortfall(rules, byId) {
  const live = new Set();
  for (const r of rules || []) {
    live.add(r.id);
    const item = byId.get(r.itemid);
    if (item && Number(item.quantity) < Number(r.target)) {
      if (!firstSeenShort.has(r.id)) firstSeenShort.set(r.id, Date.now());
    } else {
      firstSeenShort.delete(r.id);
    }
  }
  for (const id of [...firstSeenShort.keys()]) if (!live.has(id)) firstSeenShort.delete(id);
}

/**
 * What a rule is doing right now, derived from the rule plus live CPU state.
 *
 * Kept here rather than in the component so the ordering of the checks — which
 * is the actual logic — sits in one readable place. Backoff outranks "low"
 * deliberately: if a rule is failing, that is the thing you need to see.
 */
export function ruleStatus(rule, item, cpus, maint = null) {
  if (!rule.enabled) return { id: 'paused', label: 'Paused', tone: 'mute' };

  const crafting = Object.entries(cpus || {}).find(
    ([, c]) => c?.finalOutput?.itemid === rule.itemid,
  );
  if (crafting) return { id: 'crafting', label: 'Crafting', tone: 'accent', cpu: crafting[0] };

  if (rule.retry_after && new Date(rule.retry_after) > new Date()) {
    return { id: 'backoff', label: 'Backing off', tone: 'danger' };
  }

  if (!item) return { id: 'unknown', label: 'Not in grid', tone: 'warn' };
  if (Number(item.quantity) >= Number(rule.target)) {
    return { id: 'stocked', label: 'Stocked', tone: 'good' };
  }

  // Below target. WHY it hasn't been ordered is the part that used to be lost:
  // the maintainer only runs at the end of a collector tick, so a rule can be
  // short simply because that tick hasn't come round yet. Blaming CPUs for what
  // is really a scheduling delay sent us debugging a non-problem once already.
  //
  // Without the health payload we can't tell those apart, so keep the old label
  // rather than guess — a caller that hasn't loaded it yet must not flash a
  // wrong chip.
  if (maint) {
    if (maint.enabled === false) return { id: 'disabled', label: 'Maintainer off', tone: 'mute' };

    const grid = maint.grids?.[String(rule.grid_key)];
    const lastRun = grid?.lastRunAt ? new Date(grid.lastRunAt).getTime() : 0;

    // The shortfall can't predate the rule itself, and may be newer if stock
    // only just dropped. Either bound beats assuming the maintainer has looked.
    const dueSince = Math.max(
      new Date(rule.updated_at).getTime() || 0,
      firstSeenShort.get(rule.id) ?? 0,
    );

    if (!lastRun || lastRun < dueSince) {
      return { id: 'queued', label: 'Queueing job', tone: 'accent' };
    }
    // It ran and stopped early, so this rule was never reached.
    if (grid?.skipped) return { id: 'cap', label: 'Job cap reached', tone: 'warn' };
  }

  // It ran, reached this rule, and still didn't place a job — no eligible CPU.
  return { id: 'low', label: 'Waiting for CPU', tone: 'warn' };
}
