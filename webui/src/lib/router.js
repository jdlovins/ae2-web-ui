// Hash routing, so a view can be linked and sent to someone.
//
// A HASH, not a path, and not negotiable: nginx.conf.template proxies
// ^/(grids|items|list|get|order)$, ^/(job|cancelcpu|trackinghistory|…) and
// /history/ to upstreams BEFORE the SPA fallback. Half the view names collide
// with those — /items and /history most obviously — so a path route would be
// answered by the gateway instead of the app. A fragment never reaches the
// server at all, so it cannot collide and needs no nginx change.
//
// The scheme:
//   #/items?grid=100234
//   #/items?grid=100234&item=minecraft:redstone&range=-24h&band=1
//   #/crafting?grid=100234&cpu=CPU%20%231
//   #/history?grid=100234&job=3&t=1786644945242&charts=item,iface
//   #/trends?grid=100234&range=-7d&item=a&item=b&table=1
//
// Item ids carry ':' and '.', so series are repeated `item=` params rather than
// a joined list — URLSearchParams.getAll sidesteps any separator question.
//
// DIRECTION OF FLOW, which is the whole design: state is written to the URL
// from user actions only (a click, a toggle), and read back from it only when
// the URL changes underneath us. Nothing writes the URL reactively, so a value
// can never round-trip and re-trigger its own write.

import { writable } from 'svelte/store';

export const VIEWS = ['items', 'crafting', 'maintain', 'history', 'trends'];

/** Bumped when the URL changes from OUTSIDE the app: back/forward, or a pasted link. */
export const routeEpoch = writable(0);

function parse(hash) {
  const raw = String(hash || '').replace(/^#\/?/, '');
  const cut = raw.indexOf('?');
  const name = cut === -1 ? raw : raw.slice(0, cut);
  return {
    view: VIEWS.includes(name) ? name : null,
    params: new URLSearchParams(cut === -1 ? '' : raw.slice(cut + 1)),
  };
}

/** The URL as it stands right now. Always read fresh — `location` is the state. */
export function current() {
  return parse(location.hash);
}

/** Current value of one param, or null. */
export const param = (k) => current().params.get(k);
/** All values of a repeated param. */
export const paramAll = (k) => current().params.getAll(k);

const serialize = (view, params) => {
  const qs = params.toString();
  return `#/${view || ''}${qs ? `?${qs}` : ''}`;
};

// What we last wrote ourselves. `hashchange` fires for our own writes too, and
// without this the app would treat every write as an external navigation and
// re-seed every view from the URL it had just produced.
let lastWritten = null;

function write(hash) {
  if (hash === location.hash) return;
  lastWritten = hash;
  // replaceState, not push: this URL tracks a live, polling UI, and pushing
  // would bury the page the user arrived from under dozens of entries.
  history.replaceState(null, '', hash);
}

/**
 * Merge into the current query. `null`/`undefined`/`false`/`''` remove a key;
 * an array becomes repeated params.
 */
export function updateParams(patch) {
  const { view, params } = current();
  for (const [k, v] of Object.entries(patch)) {
    params.delete(k);
    if (v === null || v === undefined || v === false || v === '') continue;
    if (Array.isArray(v)) {
      for (const x of v) if (x !== null && x !== undefined && x !== '') params.append(k, String(x));
    } else {
      params.append(k, String(v));
    }
  }
  write(serialize(view, params));
}

/**
 * Switch view, dropping the previous view's params but keeping `grid`.
 *
 * The early return matters more than it looks: applying a URL sets `activeView`
 * to the view the URL already names, which lands back here. Without it we would
 * wipe the very params — the job id, the picked series — that we were about to
 * read.
 */
export function setView(view) {
  const cur = current();
  if (cur.view === view) return;
  const params = new URLSearchParams();
  const grid = cur.params.get('grid');
  if (grid) params.set('grid', grid);
  write(serialize(view, params));
}

export function setGrid(grid) {
  updateParams({ grid });
}

/** Absolute URL for the current view, for the copy button. */
export function shareUrl() {
  return location.href;
}

/** Start listening for external navigation. Returns a teardown. */
export function startRouter() {
  const onHash = () => {
    if (location.hash === lastWritten) return; // our own write echoing back
    lastWritten = location.hash;
    routeEpoch.update((n) => n + 1);
  };
  window.addEventListener('hashchange', onHash);
  return () => window.removeEventListener('hashchange', onHash);
}

/**
 * Copy text, falling back for non-secure origins.
 *
 * navigator.clipboard is undefined on plain HTTP, which is exactly how this
 * terminal is reached on a LAN (http://host:port) — the modern API would be
 * missing precisely where the button gets used.
 */
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
