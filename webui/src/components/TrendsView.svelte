<script>
  import { history, RANGES } from '../lib/history.js';
  import { selectedGrid, settings, toast } from '../lib/stores.js';
  import { formatNumber, stripMc, formatDateTime, formatChange, parseQuantity } from '../lib/format.js';
  import { updateParams, param, paramAll, routeEpoch } from '../lib/router.js';
  import LineChart, { SERIES_COLORS, MAX_SERIES } from './LineChart.svelte';
  import McText from './McText.svelte';
  import ItemIcon from './ItemIcon.svelte';
  import Icon from './Icon.svelte';
  import CopyLink from './CopyLink.svelte';

  let range = $state('-24h');
  let picker = $state('');
  let options = $state([]);
  let picked = $state([]); // [{ itemid, itemname }] — order fixes colour slots
  let data = $state([]);
  let loading = $state(false);
  let health = $state(null);
  let showTable = $state(false);
  let optionsLoading = $state(false);
  let trackedGrids = $state(null); // null = not yet known
  let pickerSort = $state('quantity'); // quantity | change
  let pickerDir = $state('desc');      // change only: desc = gains, asc = drains
  // Narrow screens only — the CSS ignores this above 720px, where the picker is
  // a permanent column. Starts closed on a phone: expanded it took 197px of an
  // 812px screen, which together with the toolbar left the chart card taller
  // than its own scroll container.
  let pickerOpen = $state(!window.matchMedia('(max-width: 720px)').matches);
  // Held as text so shorthand ("10k") can be typed; unparseable input falls back
  // to no filter rather than freezing the list mid-keystroke.
  let floorText = $state(String($settings.minStock || '') || '');
  const floor = $derived(parseQuantity(floorText) ?? 0);
  const floorBad = $derived(!!floorText.trim() && parseQuantity(floorText) === null);

  // Selected items pin to the top of the list. Otherwise a series you are
  // charting can be pushed off the end by the sort or filtered out by a search,
  // leaving no way to see or deselect it. Falls back to the minimal {itemid,
  // itemname} from `picked` when the item isn't in the current result set.
  const displayed = $derived.by(() => {
    const chosen = new Set(picked.map((p) => p.itemid));
    const byId = new Map(options.map((o) => [o.itemid, o]));
    const top = picked.map((p) => byId.get(p.itemid) ?? { itemid: p.itemid, itemname: p.itemname });
    return [...top, ...options.filter((o) => !chosen.has(o.itemid))];
  });

  // Colour follows the entity, not its rank: the slot is the item's index in
  // `picked`, so removing one series never repaints the others.
  const colorOf = (itemid) => SERIES_COLORS[picked.findIndex((p) => p.itemid === itemid) % SERIES_COLORS.length];

  const chartSeries = $derived(
    data
      .map((s) => {
        const meta = picked.find((p) => p.itemid === s.itemid);
        return meta ? { itemid: s.itemid, label: stripMc(meta.itemname), color: colorOf(s.itemid), points: s.points } : null;
      })
      .filter(Boolean),
  );

  async function loadHealth() {
    try {
      health = await history.health();
      trackedGrids = await history.grids();
    } catch (e) { health = { error: e.message }; trackedGrids = null; }
  }

  async function loadOptions() {
    if ($selectedGrid == null) { options = []; return; }
    optionsLoading = true;
    // `from` is always sent so every row can show its change, whichever sort is
    // active; only the ordering follows pickerSort.
    try { options = await history.items($selectedGrid, picker.trim(), 60, { from: range, sort: pickerSort, dir: pickerDir, min: floor }); }
    catch (e) { options = []; if (!health?.error) toast(e.message); }
    finally { optionsLoading = false; }
  }

  async function loadSeries() {
    if (!picked.length || $selectedGrid == null) { data = []; return; }
    loading = true;
    try {
      const r = await history.series($selectedGrid, picked.map((p) => p.itemid), range, 400);
      data = r.series;
      // A deep-linked series arrives with its id standing in for a name — the
      // URL can't carry display names. The response maps every id asked for,
      // including ones with no points in range, so this is the one place the
      // real name is available.
      if (r.names) picked = picked.map((p) => (r.names[p.itemid] ? { ...p, itemname: r.names[p.itemid] } : p));
    } catch (e) { toast(e.message); }
    finally { loading = false; }
  }

  function toggle(it) {
    const i = picked.findIndex((p) => p.itemid === it.itemid);
    if (i >= 0) picked = picked.filter((_, k) => k !== i);
    else if (picked.length >= MAX_SERIES) {
      toast(`At most ${MAX_SERIES} items can be charted at once.`, 'info');
      return;
    } else picked = [...picked, { itemid: it.itemid, itemname: it.itemname }];
    loadSeries();
    syncUrl();
  }

  // --- Linking -------------------------------------------------------------
  // Series go out as repeated `item=` params: ids carry ':' and '.', and
  // getAll() means no separator has to be safe against them.
  //
  // The picker's own controls (sort, direction, stock floor) stay out — they are
  // how you FIND a series, not part of the chart being shared.
  function syncUrl() {
    updateParams({
      range: range === '-24h' ? null : range, // the default needn't be spelled out
      item: picked.map((p) => p.itemid),
      table: showTable || null,
    });
  }

  let lastGrid;
  $effect(() => {
    if ($selectedGrid !== lastGrid) {
      lastGrid = $selectedGrid;
      picked = []; data = [];
      loadHealth(); loadOptions();
    }
  });

  // Seed once per navigation. MUST be declared after the grid effect above:
  // effects run in declaration order, and that one clears `picked` on a grid
  // change — seeding first would have its selection wiped a moment later.
  //
  // Names aren't known until the series arrive, so each id is its own
  // placeholder label; loadSeries() corrects them from the response's `names`.
  let seededFor = null;
  $effect(() => {
    const key = `${$routeEpoch}|${$selectedGrid}`;
    if (seededFor === key || $selectedGrid == null) return;
    seededFor = key;

    const r = param('range');
    if (r && RANGES.some((x) => x.id === r)) range = r;
    showTable = param('table') === 'true' || param('table') === '1';
    const ids = paramAll('item');
    if (!ids.length) return;
    picked = ids.slice(0, MAX_SERIES).map((id) => ({ itemid: id, itemname: id }));
    loadSeries();
  });

  // Debounce the picker so typing doesn't hammer the API. The floor shares the
  // timer, so a keystroke in either box costs one request rather than two.
  let searchTimer;
  $effect(() => {
    picker;
    floorText;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadOptions, 250);
    return () => clearTimeout(searchTimer);
  });

  // Remember the floor across reloads, storing the resolved number rather than
  // the typed text so "10k" and "10000" restore identically.
  $effect(() => {
    const v = floor;
    if (($settings.minStock || 0) !== v) settings.update((s) => ({ ...s, minStock: v }));
  });

  // The picker's change column is measured over the same window as the chart,
  // so a range change has to refresh both.
  function setRange(id) { range = id; loadSeries(); loadOptions(); syncUrl(); }
  // Clicking the active Change button flips direction, the way a sortable column
  // header behaves. Switching sort mode always starts from descending.
  function setPickerSort(mode) {
    if (mode === 'change' && pickerSort === 'change') pickerDir = pickerDir === 'desc' ? 'asc' : 'desc';
    else { pickerSort = mode; pickerDir = 'desc'; }
    loadOptions();
  }

  let snapping = $state(false);
  async function snapshotNow() {
    snapping = true;
    try {
      const r = await history.collect();
      if (r.ok) {
        toast('Snapshot recorded.', 'success');
        await Promise.all([loadSeries(), loadOptions(), loadHealth()]);
      } else {
        toast(`Snapshot failed: ${r.error}`);
      }
    } catch (e) { toast(e.message); }
    finally { snapping = false; }
  }

  // Table view: every value the tooltip shows, reachable without hovering.
  const tableRows = $derived.by(() => {
    const stamps = new Set();
    for (const s of chartSeries) for (const p of s.points) stamps.add(new Date(p.ts).getTime());
    const sorted = [...stamps].sort((a, b) => b - a).slice(0, 200);
    const maps = chartSeries.map((s) => {
      const m = new Map();
      for (const p of s.points) m.set(new Date(p.ts).getTime(), p.quantity);
      return m;
    });
    return sorted.map((t) => ({ t, cells: maps.map((m) => m.get(t)) }));
  });

  const collectorDown = $derived(!!health?.error);
  const noData = $derived(!collectorDown && health?.db?.samples === 0);
  // The collector runs on its own schedule, so a failing poll is invisible from
  // the chart alone — surface it instead of showing a mysteriously empty list.
  const collectorError = $derived(health?.collector?.lastError || null);
  // Samples exist, but none for the grid being viewed: almost always the
  // collector is pointed at a different server than the SPA is.
  const gridUntracked = $derived(
    !collectorDown && $selectedGrid != null && Array.isArray(trackedGrids) &&
      !trackedGrids.some((g) => String(g.grid_key) === String($selectedGrid)),
  );
</script>

<div class="view">
  <!-- Filters: one row, above everything they scope. Range first. -->
  <div class="toolbar">
    <div class="ranges" role="group" aria-label="Time range">
      {#each RANGES as r}
        <button class={range === r.id ? 'accent' : ''} onclick={() => setRange(r.id)} aria-pressed={range === r.id}>{r.label}</button>
      {/each}
    </div>
    <div class="searchbox">
      <Icon name="search" size={16} />
      <input placeholder="Find an item to chart…" bind:value={picker} />
      {#if picker}<button class="ghost clr" onclick={() => (picker = '')} aria-label="Clear"><Icon name="x" size={15} /></button>{/if}
    </div>
    <button class={showTable ? 'accent' : ''} onclick={() => { showTable = !showTable; syncUrl(); }} aria-pressed={showTable}>
      <Icon name="grid" size={15} /> Table
    </button>
    <!-- Off by default here: with up to 8 series the fills overlap into mud. The
         single-series item panel turns it on instead. -->
    <button
      class={$settings.showBand ? 'accent' : ''}
      onclick={() => settings.update((s) => ({ ...s, showBand: !s.showBand }))}
      aria-pressed={!!$settings.showBand}
      title="Shade the min–max range within each bucket"
    >
      <Icon name="chart" size={15} /> Range band
    </button>
    <button onclick={snapshotNow} disabled={snapping} title="Sample the network right now">
      <Icon name={snapping ? 'loader' : 'bolt'} size={15} spin={snapping} /> Snapshot now
    </button>
    <button onclick={() => { loadSeries(); loadHealth(); }} title="Refresh"><Icon name="refresh" size={15} spin={loading} /></button>
    <CopyLink label="Copy chart link" />
  </div>

  {#if collectorError}
    <div class="banner">
      <Icon name="alert" size={15} />
      <span>Gateway's last poll failed: <span class="mono">{collectorError}</span></span>
    </div>
  {/if}

  {#if gridUntracked}
    <div class="banner">
      <Icon name="alert" size={15} />
      <span>
        No samples for grid <span class="mono">{$selectedGrid}</span>.
        {#if trackedGrids?.length}
          The gateway is recording <span class="mono">{trackedGrids.map((g) => g.grid_key).join(', ')}</span> —
          check <span class="mono">AE2_URL</span> points at the same server as this page.
        {:else}
          It hasn't recorded any grid yet.
        {/if}
      </span>
    </div>
  {/if}

  {#if collectorDown}
    <div class="empty">
      <Icon name="alert" size={26} />
      <p>The gateway service isn't reachable.</p>
      <p class="sub mono">{health.error}</p>
      <p class="sub">Start it with <code>docker compose up -d</code> in the repo root.</p>
    </div>
  {:else if noData}
    <div class="empty">
      <Icon name="chart" size={26} />
      <p>No samples recorded yet.</p>
      <p class="sub">The collector writes a snapshot every {health?.collector?.intervalSec ?? 60}s — check back shortly.</p>
    </div>
  {:else}
    <div class="body">
      <aside class="picker {pickerOpen ? '' : 'closed'}">
        <!-- The header doubles as the collapse toggle on narrow screens; on
             desktop the button is hidden and `closed` has no effect. -->
        <button class="phead" onclick={() => (pickerOpen = !pickerOpen)} aria-expanded={pickerOpen}>
          <span>Items</span>
          <span class="cnt">{picked.length}/{MAX_SERIES}</span>
          <span class="pchev" aria-hidden="true"><Icon name="chevron" size={15} /></span>
        </button>
        <div class="psort" role="group" aria-label="Sort items by">
          <button class={pickerSort === 'quantity' ? 'on' : ''} onclick={() => setPickerSort('quantity')} aria-pressed={pickerSort === 'quantity'}>Stock</button>
          <button
            class={pickerSort === 'change' ? 'on' : ''}
            onclick={() => setPickerSort('change')}
            aria-pressed={pickerSort === 'change'}
            title={pickerSort !== 'change'
              ? 'Sort by change over the selected range'
              : pickerDir === 'desc'
                ? 'Biggest gains first — click for biggest drops'
                : 'Biggest drops first — click for biggest gains'}
          >
            Change
            {#if pickerSort === 'change'}
              <span class="dirmark {pickerDir === 'asc' ? 'up' : ''}" aria-hidden="true"><Icon name="chevron" size={13} /></span>
            {/if}
          </button>
        </div>
        <div class="pfloor">
          <input
            class:bad={floorBad}
            placeholder="Min stock — e.g. 10k"
            aria-label="Hide items holding less than"
            aria-invalid={floorBad}
            autocomplete="off" spellcheck="false"
            bind:value={floorText}
          />
          {#if floorText}
            <button class="ghost clr" onclick={() => (floorText = '')} aria-label="Clear minimum"><Icon name="x" size={14} /></button>
          {/if}
        </div>
        <div class="plist">
          {#each displayed as it, i (it.itemid)}
            {@const on = picked.some((p) => p.itemid === it.itemid)}
            {@const chg = formatChange(it.change)}
            {#if i === picked.length && picked.length && displayed.length > picked.length}
              <div class="pdiv"></div>
            {/if}
            <button class="prow {on ? 'on' : ''}" onclick={() => toggle(it)} aria-pressed={on}>
              {#if on}<span class="swatch" style:background={colorOf(it.itemid)}></span>{:else}<span class="swatch off"></span>{/if}
              <ItemIcon item={it} size={22} enabled={$settings.showIcons} />
              <span class="pname"><McText name={it.itemname} /></span>
              <span class="pnums">
                <span class="pqty mono">{formatNumber(it.last_quantity ?? 0, 2)}</span>
                {#if chg}
                  <span class="pchg mono {it.change > 0 ? 'up' : it.change < 0 ? 'down' : ''}">{chg}</span>
                {:else if it.first_quantity === 0 && it.last_quantity > 0}
                  <span class="pchg mono up">new</span>
                {/if}
              </span>
            </button>
          {/each}
          {#if !displayed.length && !optionsLoading}
            <div class="none">{picker ? 'No tracked item matches.' : 'No items tracked yet.'}</div>
          {/if}
        </div>
      </aside>

      <section class="main">
        {#if !picked.length}
          <div class="empty">
            <Icon name="chart" size={26} />
            <p>Pick an item to chart its inventory level.</p>
            <p class="sub">Up to {MAX_SERIES} at once.</p>
          </div>
        {:else}
          <div class="card">
            <h3>Inventory level</h3>
            <LineChart series={chartSeries} {loading} numberFormat={$settings.numberFormat} height={340} band={!!$settings.showBand} />
          </div>

          {#if showTable}
            <div class="card">
              <h3>Values</h3>
              <div class="tablewrap">
                <table>
                  <thead>
                    <tr>
                      <th>Time</th>
                      {#each chartSeries as s (s.itemid)}
                        <th>
                          <svg class="key" width="12" height="4" viewBox="0 0 12 4" aria-hidden="true" focusable="false">
                            <line x1="0.5" y1="2" x2="11.5" y2="2" stroke={s.color} stroke-width="2" stroke-linecap="round" />
                          </svg>{s.label}
                        </th>
                      {/each}
                    </tr>
                  </thead>
                  <tbody>
                    {#each tableRows as r (r.t)}
                      <tr>
                        <td class="mono when">{formatDateTime(r.t)}</td>
                        {#each r.cells as c}
                          <td class="mono num">{c === undefined ? '—' : formatNumber(c, $settings.numberFormat)}</td>
                        {/each}
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            </div>
          {/if}
        {/if}
      </section>
    </div>
  {/if}
</div>

<style>
  .view { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .toolbar {
    flex: none; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    padding: 10px 14px; background: var(--panel-2); border-bottom: 1px solid var(--border);
  }
  .toolbar button { font-size: 12.5px; padding: 7px 10px; }
  .ranges { display: flex; gap: 4px; }
  .searchbox {
    flex: 1 1 200px; min-width: 160px; display: flex; align-items: center; gap: 8px;
    background: var(--card-hover); border: 1px solid var(--border-2); border-radius: var(--radius);
    padding: 0 10px; color: var(--text-faint);
  }
  .searchbox input { flex: 1; background: transparent; border: none; padding: 8px 0; }
  .searchbox input:focus { border: none; }
  .clr { padding: 4px; }

  .body { flex: 1; display: flex; min-height: 0; }
  .picker { flex: none; width: 290px; border-right: 1px solid var(--border); background: var(--panel-2); display: flex; flex-direction: column; min-height: 0; }
  /* A <button> for the mobile toggle, so it must shed the global button chrome
     and keep reading as the panel header it is on desktop. */
  .phead {
    display: flex; justify-content: space-between; align-items: center; gap: 8px;
    width: 100%; padding: 10px 14px; border: none; border-bottom: 1px solid var(--border);
    border-radius: 0; background: transparent; color: var(--text-dim); font-weight: 500;
    text-align: left; cursor: default;
  }
  .phead:hover { background: transparent; border-color: var(--border); }
  /* Only a control where it does something. */
  .pchev { display: none; margin-left: auto; transition: transform 0.15s; }
  .cnt { font-size: 11.5px; color: var(--text-mut); font-family: var(--mono); }
  .plist { overflow: auto; padding: 8px; display: flex; flex-direction: column; gap: 4px; }
  .prow { background: var(--card); gap: 8px; text-align: left; padding: 6px 8px; }
  .prow.on { border-color: var(--border-3); background: #17352d; }
  .swatch { width: 4px; height: 20px; border-radius: 2px; flex: none; }
  .swatch.off { background: #2b3855; }
  .pname { flex: 1; min-width: 0; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pnums { flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 1px; }
  .pqty { font-size: 11px; color: var(--text-mut); flex: none; }
  .pchg { font-size: 10.5px; color: var(--text-faint); }
  .pchg.up { color: var(--good); }
  .pchg.down { color: var(--danger); }

  .psort { display: flex; gap: 4px; padding: 8px 8px 0; }
  .psort button { flex: 1; justify-content: center; font-size: 11.5px; padding: 5px 8px; }
  .psort button.on { background: var(--accent-dim); border-color: var(--accent-border); color: var(--accent); }
  .pfloor { display: flex; align-items: center; gap: 4px; padding: 6px 8px 0; }
  .pfloor input { flex: 1; min-width: 0; font-size: 11.5px; padding: 5px 8px; font-family: var(--mono); }
  .pfloor input.bad { border-color: var(--danger-border); }
  .pfloor .clr { padding: 4px; }
  .dirmark { display: inline-flex; transition: transform 0.15s; }
  .dirmark.up { transform: rotate(180deg); }
  /* Separates the pinned selection from the rest of the results. */
  .pdiv { height: 1px; background: var(--border); margin: 4px 2px; }
  .none { padding: 14px; color: var(--text-mut); font-size: 13px; }

  .main { flex: 1; min-width: 0; min-height: 0; overflow: auto; padding: 14px; display: flex; flex-direction: column; gap: 14px; }
  .card { background: var(--card); border: 1px solid var(--border-2); border-radius: var(--radius-lg); padding: 14px; }
  .card h3 { margin: 0 0 12px; font-size: 13.5px; font-weight: 500; color: var(--text-dim); }

  .tablewrap { overflow: auto; max-height: 420px; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { text-align: right; padding: 5px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  th { position: sticky; top: 0; background: var(--card); color: var(--text-mut); font-weight: 500; text-align: right; }
  th:first-child, td:first-child { text-align: left; }
  th .key { margin-right: 6px; vertical-align: middle; }
  .when { color: var(--text-mut); }
  .num { color: var(--text); }

  .empty {
    flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 8px; color: var(--text-mut); text-align: center; padding: 40px;
  }
  .empty p { margin: 0; }
  .banner {
    flex: none; display: flex; align-items: center; gap: 9px;
    padding: 9px 14px; background: var(--warn-dim); border-bottom: 1px solid #4a3f16;
    color: var(--warn); font-size: 12.5px;
  }
  .banner .mono { font-family: var(--mono); }
  .empty .sub { font-size: 12.5px; color: var(--text-faint); }
  code { background: var(--card-hover); border-radius: 4px; padding: 1px 5px; font-family: var(--mono); font-size: 11.5px; }

  @media (max-width: 720px) {
    .body { flex-direction: column; }
    .picker { width: 100%; max-height: 60%; border-right: none; border-bottom: 1px solid var(--border); }

    /* Wrapping cost 139px of an 812px screen — three rows of controls. One
       scrolling row is 65px and keeps every control reachable. */
    .toolbar { flex-wrap: nowrap; overflow-x: auto; padding: 7px 10px; }
    .toolbar > * { flex: none; }
    .searchbox { flex: 1 0 150px; }

    .phead { cursor: pointer; }
    .pchev { display: inline-flex; transform: rotate(180deg); }
    .picker.closed { max-height: none; flex: none; }
    .picker.closed .pchev { transform: rotate(0deg); }
    /* Collapsed, only the header survives — the chart gets everything else. */
    .picker.closed .psort,
    .picker.closed .pfloor,
    .picker.closed .plist { display: none; }
  }
</style>
