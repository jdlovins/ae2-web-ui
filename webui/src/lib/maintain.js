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
};

/**
 * What a rule is doing right now, derived from the rule plus live CPU state.
 *
 * Kept here rather than in the component so the ordering of the checks — which
 * is the actual logic — sits in one readable place. Backoff outranks "low"
 * deliberately: if a rule is failing, that is the thing you need to see.
 */
export function ruleStatus(rule, item, cpus) {
  if (!rule.enabled) return { id: 'paused', label: 'Paused', tone: 'mute' };

  const crafting = Object.entries(cpus || {}).find(
    ([, c]) => c?.finalOutput?.itemid === rule.itemid,
  );
  if (crafting) return { id: 'crafting', label: 'Crafting', tone: 'accent', cpu: crafting[0] };

  if (rule.retry_after && new Date(rule.retry_after) > new Date()) {
    return { id: 'backoff', label: 'Backing off', tone: 'danger' };
  }

  if (!item) return { id: 'unknown', label: 'Not in grid', tone: 'warn' };
  if (item.quantity < rule.target) return { id: 'low', label: 'Waiting for CPU', tone: 'warn' };
  return { id: 'stocked', label: 'Stocked', tone: 'good' };
}
