<script>
  import { api } from '../lib/api.js';
  import { selectedGrid, settings, orderTarget, toast } from '../lib/stores.js';
  import { stripMc, modOf, isFluidId } from '../lib/format.js';
  import { pollVisible } from '../lib/poll.js';
  import ItemCard from './ItemCard.svelte';
  import Icon from './Icon.svelte';

  let items = $state([]);
  let loading = $state(false);
  let search = $state('');

  const SORT_LABELS = ['A–Z', 'Quantity', 'Mod'];
  const FILTER_LABELS = ['Stored', 'Craftable', 'Stored + craftable'];
  const TYPE_LABELS = ['Items', 'Fluids', 'Items + fluids'];

  // Was matching AE2FC "fluid drop" items, which GTNH 2.9 removed — it hit zero
  // of the ~400 fluids actually in a network, so the filter did nothing.
  const isFluid = (it) => isFluidId(it.itemid);

  async function load(fresh = false) {
    const grid = $selectedGrid;
    if (grid === null || grid === undefined) { items = []; return; }
    loading = true;
    try { items = await api.items(grid, { fresh }); }
    catch (e) { toast(e.message); }
    finally { loading = false; }
  }

  let lastGrid;
  $effect(() => {
    if ($selectedGrid !== lastGrid) { lastGrid = $selectedGrid; if (scroller) scroller.scrollTop = 0; load(); }
  });

  // The toolbar's Auto toggle. Deliberately a plain (non-fresh) read on a period
  // longer than the gateway's 10s /items TTL, so it mostly lands on a warm cache
  // entry the collector already paid for — an auto-refreshing tab costs the game
  // server close to nothing. Derived rather than read inline so that cycling an
  // unrelated setting doesn't restart the timer.
  const autoRefresh = $derived($settings.autoRefresh);
  $effect(() => {
    if (!autoRefresh) return;
    $selectedGrid; // restart on grid change
    return pollVisible(() => load(), 15000);
  });

  const filtered = $derived.by(() => {
    const s = $settings;
    const q = search.trim().toLowerCase();
    let list = items.filter((it) => {
      if (s.storedCraftable !== 2 && it.craftable !== (s.storedCraftable === 1)) return false;
      if (s.itemsType !== 2 && isFluid(it) !== (s.itemsType === 1)) return false;
      if (q && stripMc(it.itemname).toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
    const dir = s.sortOrder === 1 ? -1 : 1;
    list = [...list].sort((a, b) => {
      if (s.sortBy === 1) return (a.quantity - b.quantity) * dir;
      if (s.sortBy === 2) return (modOf(a.itemid).localeCompare(modOf(b.itemid)) || stripMc(a.itemname).localeCompare(stripMc(b.itemname))) * dir;
      return stripMc(a.itemname).localeCompare(stripMc(b.itemname)) * dir;
    });
    return list;
  });

  // --- Virtual grid (handles thousands of items) ---
  const PAD = 14, GAP = 10, CARD_H = 128, ROW_H = CARD_H + GAP, MIN_COL = 176, OVERSCAN = 4;
  let scroller = $state(null);
  let vpH = $state(600);
  let vpW = $state(900);
  let scrollTop = $state(0);
  let raf = 0;
  function onScroll() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; scrollTop = scroller ? scroller.scrollTop : 0; });
  }

  const cols = $derived(Math.max(1, Math.floor((vpW - 2 * PAD + GAP) / (MIN_COL + GAP))));
  const totalRows = $derived(Math.ceil(filtered.length / cols));
  const totalH = $derived(totalRows * ROW_H);
  const startRow = $derived(Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN));
  const endRow = $derived(Math.min(totalRows, Math.ceil((scrollTop + vpH) / ROW_H) + OVERSCAN));
  const windowItems = $derived(filtered.slice(startRow * cols, endRow * cols));
  const offsetY = $derived(startRow * ROW_H);

  const cycle = (key, max) => settings.update((s) => ({ ...s, [key]: (s[key] + 1) % max }));
</script>

<div class="view">
  <div class="toolbar">
    <div class="searchbox">
      <Icon name="search" size={16} />
      <input placeholder="Search items…" bind:value={search} />
      {#if search}<button class="ghost clr" onclick={() => (search = '')} aria-label="Clear"><Icon name="x" size={15} /></button>{/if}
    </div>
    <button onclick={() => cycle('sortBy', 3)} title="Sort by"><Icon name="sort" size={15} /> {SORT_LABELS[$settings.sortBy]}</button>
    <button onclick={() => settings.update((s) => ({ ...s, sortOrder: s.sortOrder ? 0 : 1 }))} title="Sort direction">
      {$settings.sortOrder ? 'Desc' : 'Asc'}
    </button>
    <button onclick={() => cycle('storedCraftable', 3)} title="Filter"><Icon name="stack" size={15} /> {FILTER_LABELS[$settings.storedCraftable]}</button>
    <button onclick={() => cycle('itemsType', 3)} title="Item type"><Icon name="filter" size={15} /> {TYPE_LABELS[$settings.itemsType]}</button>
    <button
      class={$settings.autoRefresh ? 'accent' : ''}
      onclick={() => settings.update((s) => ({ ...s, autoRefresh: !s.autoRefresh }))}
      title="Auto-refresh the current view"
    ><Icon name="refresh" size={15} /> Auto</button>
    <button onclick={() => load(true)} title="Refresh"><Icon name="refresh" size={15} spin={loading} /> Refresh</button>
    <span class="count">{filtered.length.toLocaleString()} item{filtered.length === 1 ? '' : 's'}</span>
  </div>

  {#if $selectedGrid === null || $selectedGrid === undefined}
    <div class="empty"><Icon name="network" size={26} /><p>Select a grid to view its contents.</p></div>
  {:else if filtered.length === 0 && !loading}
    <div class="empty"><Icon name="box" size={26} /><p>{items.length ? 'No items match your filters.' : 'This network is empty.'}</p></div>
  {:else}
    <div class="scroller" bind:this={scroller} bind:clientHeight={vpH} bind:clientWidth={vpW} onscroll={onScroll}>
      <div class="sizer" style:height="{totalH}px">
        <div class="grid" style:transform="translateY({offsetY}px)" style:grid-template-columns="repeat({cols}, minmax(0, 1fr))">
          {#each windowItems as it (it.hashcode)}
            <ItemCard
              item={it}
              showId={$settings.showItemId}
              showIcon={$settings.showIcons}
              numberFormat={$settings.numberFormat}
              onOrder={(item) => orderTarget.set(item)}
            />
          {/each}
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .view { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .toolbar {
    flex: none; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    padding: 10px 14px; background: var(--panel-2); border-bottom: 1px solid var(--border);
  }
  .searchbox {
    flex: 1 1 200px; min-width: 160px; display: flex; align-items: center; gap: 8px;
    background: var(--card-hover); border: 1px solid var(--border-2); border-radius: var(--radius);
    padding: 0 10px; color: var(--text-faint);
  }
  .searchbox input { flex: 1; background: transparent; border: none; padding: 8px 0; }
  .searchbox input:focus { border: none; }
  .clr { padding: 4px; }
  .toolbar button { font-size: 12.5px; padding: 7px 10px; }
  .count { margin-left: auto; color: var(--text-mut); font-size: 12.5px; }
  .scroller { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 14px; position: relative; min-height: 0; }
  .sizer { position: relative; width: 100%; }
  .grid { position: absolute; top: 0; left: 0; right: 0; display: grid; gap: 10px; align-content: start; }
  .empty {
    flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 10px; color: var(--text-mut); text-align: center; padding: 40px;
  }
</style>
