import { writable } from 'svelte/store';

// A writable store mirrored to localStorage.
function persisted(key, initial) {
  let start = initial;
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) start = JSON.parse(raw);
  } catch { /* ignore */ }
  const store = writable(start);
  store.subscribe((v) => {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ }
  });
  return store;
}

// User preferences (persisted).
export const settings = persisted('ae2_settings', {
  sortBy: 0,          // 0 A-Z, 1 quantity, 2 mod
  sortOrder: 0,       // 0 asc, 1 desc
  storedCraftable: 2, // 0 stored, 1 craftable, 2 both
  itemsType: 2,       // 0 items, 1 fluids, 2 both
  numberFormat: 1,    // see format.js
  showItemId: false,
  showIcons: true,
  autoRefresh: false,
  defaultGrid: null,  // grid key or null
  skipPlanReview: false, // submit a craft as soon as its plan is ready
  // Shade min–max on Trends charts. Must default falsy: persisted() below does
  // not merge new defaults into an already-stored object, so for existing users
  // this key reads back as undefined no matter what is written here.
  showBand: false,
});

// Runtime app state (not persisted).
export const grids = writable([]);
export const selectedGrid = writable(null); // grid key (as string) or null
export const cpuList = writable({});        // { name: cluster }
export const orderTarget = writable(null);  // item being ordered, or null
export const activeView = writable('items'); // items | crafting | history
export const focusCpu = writable(null);      // CPU name to select in CraftingView
export const toasts = writable([]);          // [{ id, text, type }]

let toastSeq = 0;
export function toast(text, type = 'error') {
  const id = ++toastSeq;
  toasts.update((t) => [{ id, text, type }, ...t]);
  setTimeout(() => toasts.update((t) => t.filter((x) => x.id !== id)), 6000);
}
export function dismissToast(id) {
  toasts.update((t) => t.filter((x) => x.id !== id));
}
