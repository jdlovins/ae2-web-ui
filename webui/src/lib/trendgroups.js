// Named sets of items to chart together, in two deliberately separate halves:
//
//   personal — this browser only, localStorage, never sent anywhere.
//   shared   — the gateway's `trend_group` table, visible to every session.
//
// They are NOT two views of one list and are never synced. Everyone here signs
// in as the same admin account, so the server cannot tell two people apart —
// anything it stores is by definition everybody's. That makes "mine" a thing
// only the browser can hold, and it is the reason a personal group has no id
// the server would recognise and a shared one has no owner.
//
// The consequence to keep in mind when editing this file: a personal group
// survives nothing but this browser profile (clearing site data drops it), and
// a shared group is editable by anyone. Both are the intended trade, so neither
// side should grow a "sync to the other" button — it would silently publish a
// scratch selection, or silently fork a group two people are both maintaining.

import { writable, get } from 'svelte/store';

import { call } from './api.js';
import { persisted } from './stores.js';

const enc = encodeURIComponent;

/** The two halves, in the order they appear in the picker. */
export const SCOPES = [
  { id: 'personal', label: 'Mine', icon: 'user', hint: 'Saved in this browser only' },
  { id: 'shared', label: 'Shared', icon: 'network', hint: 'Saved for everyone on this account' },
];

/**
 * The view a group opens in, normalised. Unknown values fall back to the chart,
 * so a group written by a newer build never leaves the UI in a mode it cannot
 * render.
 */
export const groupMode = (raw) => (raw === 'change' ? 'change' : 'chart');

/**
 * Force a member list into the stored shape: `{itemid, itemname}` objects, no
 * duplicates.
 *
 * No member cap, deliberately. The chart's eight-colour palette limits what can
 * be DRAWN legibly, not what a group may contain — a thirty-item group of input
 * materials read as a change table is a normal thing to want, and capping
 * storage to the palette would have made the count beside the name a lie.
 * Past eight series the chart repeats colours with a different dash; see
 * LineChart's palette note.
 */
export function normaliseMembers(items) {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of items) {
    const itemid = String(raw?.itemid ?? '').trim();
    if (!itemid || seen.has(itemid)) continue;
    seen.add(itemid);
    out.push({ itemid, itemname: String(raw?.itemname ?? itemid) });
  }
  return out;
}

// --- Shared (gateway) ------------------------------------------------------

/**
 * Shared groups, on the same authenticated `call` as everything else, so they
 * inherit the silent re-auth on 401.
 *
 * Saving is an upsert keyed on (grid, name): saving twice under one name edits
 * that group rather than creating a second one that would be impossible to tell
 * apart in the strip.
 */
export const sharedGroups = {
  list: (grid) => call(`/history/trendgroups?grid=${enc(grid)}`),
  save: (grid, name, items, mode = 'chart') =>
    call('/history/trendgroups', 'POST', {
      body: { grid, name, items: normaliseMembers(items), mode: groupMode(mode) },
    }),
  update: (id, patch) => call(`/history/trendgroups/${id}`, 'PATCH', { body: patch }),
  remove: (id) => call(`/history/trendgroups/${id}`, 'DELETE'),
};

// --- Personal (localStorage) ----------------------------------------------

// Shape: { [gridKey]: [{ id, name, items, mode, updated_at }] }. Keyed by grid to
// match the shared table, so switching grids shows the sets that belong to it
// rather than a pile of names charting items this grid has never held.
const store = persisted('ae2_trend_groups', {});

/** Subscribe-able, for a UI that has to repaint when a group is saved. */
export const personalStore = store;

let seq = 0;
// Ids only have to be unique within this browser, and they must not collide
// with a shared group's numeric id in any UI keyed on both — hence the prefix.
const nextId = () => `p${Date.now().toString(36)}${(++seq).toString(36)}`;

const listFor = (state, grid) => (Array.isArray(state?.[String(grid)]) ? state[String(grid)] : []);
const byName = (name) => (g) => g.name.toLowerCase() === name.toLowerCase();

export const personalGroups = {
  /**
   * Groups for one grid, by name, matching the shared list's ordering.
   *
   * `mode` is normalised on the way out rather than migrated in storage: groups
   * saved before it existed simply have none, and defaulting on read costs
   * nothing and cannot half-apply.
   */
  list(grid) {
    return [...listFor(get(store), grid)]
      .map((g) => ({ ...g, mode: groupMode(g.mode) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },

  /**
   * Create, or replace the members of the group already holding this name on
   * this grid — the same upsert-on-name rule the shared half enforces with a
   * unique constraint, so the two behave identically from the UI's side.
   */
  save(grid, name, items, mode = 'chart') {
    const key = String(grid);
    const clean = { name: String(name).trim(), items: normaliseMembers(items), mode: groupMode(mode) };
    let saved;
    store.update((state) => {
      const list = listFor(state, grid);
      const at = list.findIndex(byName(clean.name));
      saved =
        at >= 0
          ? { ...list[at], ...clean, updated_at: new Date().toISOString() }
          : { id: nextId(), ...clean, updated_at: new Date().toISOString() };
      const next = at >= 0 ? list.map((g, i) => (i === at ? saved : g)) : [...list, saved];
      return { ...state, [key]: next };
    });
    return saved;
  },

  /** Rename in place. Returns false when the new name is already taken. */
  rename(grid, id, name) {
    const clean = String(name).trim();
    if (!clean) return false;
    const list = listFor(get(store), grid);
    if (list.some((g) => g.id !== id && byName(clean)(g))) return false;
    store.update((state) => ({
      ...state,
      [String(grid)]: listFor(state, grid).map((g) =>
        g.id === id ? { ...g, name: clean, updated_at: new Date().toISOString() } : g,
      ),
    }));
    return true;
  },

  remove(grid, id) {
    store.update((state) => ({ ...state, [String(grid)]: listFor(state, grid).filter((g) => g.id !== id) }));
  },
};
