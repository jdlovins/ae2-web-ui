<script>
  // One item, in depth: what the network holds now, what it has held over a
  // range, and a chart. Bridges the Items grid and the Trends data, which were
  // previously two disconnected surfaces over the same items.
  import { api } from '../lib/api.js';
  import { history, RANGES } from '../lib/history.js';
  import { selectedGrid, settings, orderTarget, detailTarget } from '../lib/stores.js';
  import { formatNumber, formatDateTime, stripMc, isFluidId } from '../lib/format.js';
  import LineChart, { SERIES_COLORS } from './LineChart.svelte';
  import Modal from './Modal.svelte';
  import McText from './McText.svelte';
  import ItemIcon from './ItemIcon.svelte';
  import Icon from './Icon.svelte';

  let { itemid, item = null } = $props();

  let range = $state('-24h');
  // On here, unlike Trends: one series, where the gap between the bucket floor
  // and its peak is the reason to open this panel at all.
  let showBand = $state(true);

  let detail = $state(null);   // { item, range, points } from /history/item
  let resolved = $state(null); // live entry looked up when none was handed in
  let loading = $state(false);
  let histError = $state(null);

  // Derived rather than seeded state: $state(item) would capture only the first
  // value, so reopening on a different item would keep showing the old one.
  const live = $derived(item ?? resolved);

  const fluid = $derived(isFluidId(itemid));
  const name = $derived(live?.itemname || detail?.item?.itemname || itemid);
  const fmt = (n) => formatNumber(n, $settings.numberFormat);
  // Postgres hands these back as ISO strings, but formatDateTime takes epoch
  // millis — passing the string straight in renders "Invalid Date".
  const when = (iso) => (iso ? formatDateTime(Date.parse(iso)) : '—');

  function close() { detailTarget.set(null); }

  async function load() {
    if ($selectedGrid == null) return;
    loading = true;
    histError = null;
    try {
      detail = await history.item($selectedGrid, itemid, range, 200);
    } catch (e) {
      // Shown inline, never toasted: the panel is already on screen and can say
      // so in place, and the live fields below stay perfectly usable.
      histError = e.message;
      detail = null;
    } finally {
      loading = false;
    }
  }

  // Opened from a URL rather than a card, so there is no live entry yet. The
  // gateway caches /items for 10s and the grid has usually just paid for it, so
  // this is close to free. Several stacks can share an itemid with different
  // NBT; take the biggest, which is the one worth offering a Craft button for.
  async function resolveLive() {
    if (item || $selectedGrid == null) return;
    try {
      const items = await api.items($selectedGrid);
      const matches = items.filter((it) => it.itemid === itemid);
      resolved = matches.sort((a, b) => b.quantity - a.quantity)[0] || null;
    } catch { /* the panel degrades to history-only; no toast */ }
  }

  $effect(() => { itemid; range; $selectedGrid; load(); });
  $effect(() => { itemid; $selectedGrid; resolved = null; resolveLive(); });

  // A different grid invalidates both the itemid's meaning and its hashcode.
  let lastGrid = $selectedGrid;
  $effect(() => {
    if ($selectedGrid !== lastGrid) close();
  });

  const chartSeries = $derived(
    detail?.points?.length
      ? [{ itemid, label: stripMc(name), color: SERIES_COLORS[0], points: detail.points }]
      : [],
  );
</script>

<Modal title="Item detail" onClose={close} wide closeOnEscape={!$orderTarget}>
  <div class="head">
    <ItemIcon item={live || { itemid, itemname: name }} size={40} enabled={$settings.showIcons} />
    <div class="idwrap">
      <div class="nm"><McText name={name} /></div>
      <div class="sub">{itemid}</div>
    </div>
    <div class="badges">
      <span class="badge">{fluid ? 'Fluid' : 'Item'}</span>
      {#if live?.craftable}<span class="badge accent">Craftable</span>{/if}
    </div>
  </div>

  {#if !live && detail?.item}
    <div class="note"><Icon name="alert" size={15} /> Not currently in the network. Showing recorded history.</div>
  {/if}

  <div class="stats">
    <div class="stat">
      <div class="k">Current</div>
      <div class="v">{live ? fmt(live.quantity) : detail?.item ? fmt(detail.item.last_quantity) : '—'}</div>
    </div>
    <div class="stat">
      <div class="k">Min</div>
      <div class="v dim">{detail?.range?.samples ? fmt(detail.range.min) : '—'}</div>
    </div>
    <div class="stat">
      <div class="k">Avg</div>
      <div class="v dim">{detail?.range?.samples ? fmt(detail.range.avg) : '—'}</div>
    </div>
    <div class="stat">
      <div class="k">Max</div>
      <div class="v dim">{detail?.range?.samples ? fmt(detail.range.max) : '—'}</div>
    </div>
  </div>

  {#if detail?.item}
    <div class="seen">
      <span>First seen <span class="mono">{when(detail.item.first_seen)}</span></span>
      <span>Last sample <span class="mono">{when(detail.item.last_sample_at || detail.item.last_seen)}</span></span>
    </div>
  {/if}

  <div class="toolbar">
    <div class="ranges" role="group" aria-label="Time range">
      {#each RANGES as r}
        <button class={range === r.id ? 'accent' : ''} onclick={() => (range = r.id)} aria-pressed={range === r.id}>{r.label}</button>
      {/each}
    </div>
    <span class="spacer"></span>
    <button class={showBand ? 'accent' : ''} onclick={() => (showBand = !showBand)} aria-pressed={showBand} title="Shade the min–max range within each bucket">
      <Icon name="chart" size={15} /> Range band
    </button>
  </div>

  {#if histError}
    <div class="empty">
      <Icon name="alert" size={22} />
      <p>History unavailable — <span class="mono">{histError}</span></p>
      <p class="hint">The gateway records inventory levels; the item data above comes straight from the network.</p>
    </div>
  {:else if detail && !detail.item}
    <div class="empty">
      <Icon name="clock" size={22} />
      <p>No history recorded for this item yet.</p>
      <p class="hint">The collector snapshots the whole network on an interval, so a newly added item shows up on the next pass.</p>
    </div>
  {:else if detail && !chartSeries.length}
    <div class="empty">
      <Icon name="chart" size={22} />
      <p>No samples in this range.</p>
      <p class="hint">First seen {when(detail.item.first_seen)} — try a wider range.</p>
    </div>
  {:else}
    <LineChart series={chartSeries} {loading} numberFormat={$settings.numberFormat} height={260} band={showBand} />
  {/if}

  <div class="actions">
    <button onclick={close}>Close</button>
    {#if live?.craftable}
      <button class="accent" onclick={() => { orderTarget.set(live); close(); }}>
        <Icon name="hammer" size={15} /> Craft
      </button>
    {/if}
  </div>
</Modal>

<style>
  .head { display: flex; gap: 12px; align-items: flex-start; margin-bottom: 14px; }
  .idwrap { min-width: 0; flex: 1; }
  .nm { font-size: 15px; font-weight: 500; line-height: 1.3; }
  .sub { font-size: 11px; color: var(--text-faint); font-family: var(--mono); margin-top: 3px; overflow-wrap: anywhere; }
  .badges { display: flex; gap: 6px; flex: none; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: var(--card-hover); color: var(--text-dim); }
  .badge.accent { background: var(--accent-dim); color: var(--accent); }

  .note {
    display: flex; align-items: center; gap: 8px; margin-bottom: 12px;
    background: var(--warn-dim); color: var(--warn); border-radius: var(--radius);
    padding: 8px 11px; font-size: 12.5px;
  }

  .stats {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 1px;
    background: var(--border); border: 1px solid var(--border); border-radius: var(--radius);
    overflow: hidden; margin-bottom: 12px;
  }
  .stat { background: var(--card); padding: 9px 11px; }
  .stat .k { font-size: 11px; color: var(--text-mut); }
  .stat .v { font-size: 17px; font-family: var(--mono); margin-top: 2px; }
  .stat .v.dim { color: var(--text-dim); }

  .seen { display: flex; flex-wrap: wrap; gap: 18px; font-size: 12px; color: var(--text-mut); margin-bottom: 14px; }
  .mono { font-family: var(--mono); color: var(--text-dim); }

  .toolbar { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; margin-bottom: 12px; }
  .ranges { display: flex; gap: 6px; }
  .toolbar button { font-size: 12.5px; padding: 6px 11px; }
  .spacer { flex: 1; }

  .empty {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 8px; color: var(--text-mut); text-align: center; padding: 34px 20px; min-height: 200px;
  }
  .empty p { margin: 0; }
  .empty .hint { font-size: 12px; color: var(--text-faint); max-width: 46ch; }

  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
</style>
