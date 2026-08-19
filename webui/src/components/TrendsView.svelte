<script>
  import { history, RANGES } from '../lib/history.js';
  import { selectedGrid, settings, toast } from '../lib/stores.js';
  import { formatNumber, stripMc, formatDateTime, formatChange, formatDuration, parseQuantity } from '../lib/format.js';
  import { updateParams, param, paramAll, routeEpoch } from '../lib/router.js';
  import { personalGroups, personalStore, sharedGroups, SCOPES, normaliseMembers, groupMode } from '../lib/trendgroups.js';
  import LineChart, { SERIES_COLORS, MAX_SERIES } from './LineChart.svelte';
  import GroupDialog from './GroupDialog.svelte';
  import SparkGrid from './SparkGrid.svelte';
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
  // 'chart' draws the lines; 'change' drops them for a single table of how far
  // each item moved over the range. The second exists for input materials,
  // where the question is "are we keeping up?" — a number per item, not eight
  // overlapping curves.
  let mode = $state('chart');
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

  // --- Groups --------------------------------------------------------------
  // Two independent halves; see lib/trendgroups.js for why they are not synced.
  let groupScope = $state('personal');
  let sharedList = $state([]);
  let sharedError = $state(null);
  let dialog = $state(null);       // { name } while the save dialog is open
  let renaming = $state(null);     // { id, text } while a chip is being renamed
  // Deleting a shared group takes it away from everyone, so the trash button
  // arms rather than fires. Cleared on a timer so a stray click doesn't leave a
  // chip sitting armed indefinitely.
  let armed = $state(null);
  let armedTimer;
  function arm(id) {
    clearTimeout(armedTimer);
    armed = id;
    armedTimer = setTimeout(() => (armed = null), 4000);
  }

  const personalList = $derived($personalStore && $selectedGrid != null ? personalGroups.list($selectedGrid) : []);
  const groups = $derived(groupScope === 'shared' ? sharedList : personalList);

  // Which chip is lit: the one whose members ARE the current selection. Derived
  // by comparison rather than tracked as state, so editing the selection after
  // applying a group correctly stops claiming that group is what you are
  // looking at — and so a group applied from a pasted URL still lights up.
  const memberKey = (items) => (items || []).map((i) => i.itemid).sort().join('\u0000');
  const pickedKey = $derived(memberKey(picked));
  const activeGroup = $derived(picked.length ? (groups.find((g) => memberKey(g.items) === pickedKey) ?? null) : null);

  async function loadShared() {
    if ($selectedGrid == null) { sharedList = []; return; }
    try { sharedList = await sharedGroups.list($selectedGrid); sharedError = null; }
    catch (e) { sharedList = []; sharedError = e.message; }
  }

  function applyGroup(g) {
    picked = normaliseMembers(g.items);
    // A group's member order was arranged deliberately and saved, so opening it
    // shows it that way. Worst-first stays the default for an ad-hoc selection,
    // where no one has said anything about order — but here they have, and a
    // sort the user never asked for was overriding the arrangement they did.
    tableSort = { key: 'order', dir: 'asc' };
    // Each group carries the view it is meant to be read in — a group of input
    // materials opens straight into the change table, not into a chart you then
    // have to switch away from.
    mode = groupMode(g.mode);
    loadSeries();
    syncUrl();
  }

  async function saveGroup(scope) {
    dialog = null;
    if (scope === 'shared') await loadShared();
    groupScope = scope; // land on the half it went to, so the new chip is visible
    toast('Group saved.', 'success');
  }

  async function removeGroup(g) {
    if (armed !== g.id) return arm(g.id);
    armed = null;
    try {
      if (groupScope === 'shared') { await sharedGroups.remove(g.id); await loadShared(); }
      else personalGroups.remove($selectedGrid, g.id);
    } catch (e) { toast(e.message); }
  }

  async function commitRename() {
    const r = renaming;
    renaming = null;
    if (!r) return;
    const name = r.text.trim();
    const g = groups.find((x) => x.id === r.id);
    if (!g || !name || name === g.name) return;
    try {
      if (groupScope === 'shared') { await sharedGroups.update(g.id, { name }); await loadShared(); }
      else if (!personalGroups.rename($selectedGrid, g.id, name)) toast('A group here already has that name.');
    } catch (e) { toast(e.message); }
  }

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

  // Driven by `picked`, not by `data`: the response comes back in whatever order
  // the request batches resolved, and the selection's order is a thing the user
  // now sets by hand. Iterating the selection is what makes a reorder move the
  // legend, the colours and the small-multiple panels together, with no refetch.
  const chartSeries = $derived.by(() => {
    const byId = new Map(data.map((s) => [s.itemid, s]));
    return picked
      .map((p) => {
        const s = byId.get(p.itemid);
        return s ? { itemid: p.itemid, label: stripMc(p.itemname), color: colorOf(p.itemid), points: s.points } : null;
      })
      .filter(Boolean);
  });

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
    else picked = [...picked, { itemid: it.itemid, itemname: it.itemname }];
    loadSeries();
    syncUrl();
  }

  // --- Reordering the selection ------------------------------------------
  // The order is the colour order, the legend order and the panel order, and it
  // is stored with a group — so arranging a group once is worth doing. Only the
  // pinned rows (the selection, above the divider) take part; the rest of the
  // list is a search result and has no order of its own.
  //
  // Note this DOES repaint: colour is the slot's, so moving an item swaps its
  // colour with the one it displaces. That is the point of arranging by hand —
  // distinct from a filter changing the series count, which still must not
  // repaint the survivors.
  // POINTER events, not HTML5 drag-and-drop. These rows are <button>s, and
  // Chromium gives form controls `-webkit-user-drag: none`, so `draggable` on a
  // button often never starts a real drag — while a synthetic dragstart from a
  // test harness works fine, which is exactly how the first version of this
  // passed its tests and failed in a browser.
  let dragFrom = $state(null);
  let listEl;
  // Set once a press turns into a drag, so the click that follows toggles
  // nothing — otherwise dropping an item would also deselect it.
  let dragged = false;
  let pressY = 0;

  function moveTo(from, to) {
    if (to < 0 || to >= picked.length || from === to) return;
    const next = [...picked];
    next.splice(to, 0, ...next.splice(from, 1));
    picked = next;
    // An arrangement made by hand is a statement about how these items should
    // be read, so the change table follows it rather than staying on whatever
    // column was last sorted. Clicking any header still overrides this.
    tableSort = { key: 'order', dir: 'asc' };
  }

  function pressStart(e, index, selected) {
    if (!selected || e.button !== 0) return;
    dragFrom = index;
    dragged = false;
    pressY = e.clientY;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }

  // Which pinned row is under the pointer. Measured from the live rows rather
  // than from a cached height: they are not all the same height once a name
  // wraps.
  function rowAt(clientY) {
    const rows = listEl ? [...listEl.querySelectorAll('.prow')].slice(0, picked.length) : [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) return i;
    }
    return null;
  }

  function pressMove(e) {
    if (dragFrom === null) return;
    // A few pixels of slop, so a click with a shaky hand is still a click.
    if (!dragged && Math.abs(e.clientY - pressY) < 4) return;
    dragged = true;
    const to = rowAt(e.clientY);
    if (to !== null && to !== dragFrom) {
      moveTo(dragFrom, to);
      dragFrom = to;
    }
  }

  function pressEnd() {
    if (dragFrom === null) return;
    dragFrom = null;
    if (dragged) syncUrl();
  }

  // Alt+Arrow moves the focused row, so arranging does not require a pointer.
  function rowKey(e, index) {
    if (!e.altKey || index >= picked.length) return;
    const to = e.key === 'ArrowUp' ? index - 1 : e.key === 'ArrowDown' ? index + 1 : null;
    if (to === null) return;
    e.preventDefault();
    moveTo(index, to);
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
      mode: mode === 'chart' ? null : mode, // the default needn't be spelled out
      // Same reasoning as `mode`: how the table is ordered is part of the view
      // being looked at, not a way of finding something, so it survives a
      // refresh and travels with a copied link. The default stays unspelled.
      sort: tableSort.key === 'frac' && tableSort.dir === 'asc' ? null : `${tableSort.key}:${tableSort.dir}`,
    });
  }

  let lastGrid;
  $effect(() => {
    if ($selectedGrid !== lastGrid) {
      lastGrid = $selectedGrid;
      picked = []; data = [];
      loadHealth(); loadOptions(); loadShared();
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
    mode = param('mode') === 'change' ? 'change' : 'chart';
    // "key:dir". An unknown key falls back to the default rather than leaving
    // the table sorted by a column that no longer exists.
    const [sk, sd] = String(param('sort') || '').split(':');
    tableSort = SORT_LABEL[sk] ? { key: sk, dir: sd === 'desc' ? 'desc' : 'asc' } : { key: 'frac', dir: 'asc' };
    const ids = paramAll('item');
    if (!ids.length) return;
    picked = ids.map((id) => ({ itemid: id, itemname: id }));
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
  function setMode(m) { mode = m; syncUrl(); }
  // A net rate is a derived, noisy figure — one decimal below 10/h, whole
  // numbers above, so the column stays a glanceable width.
  const formatRate1 = (n) =>
    n === null ? '—' : (Math.abs(n) >= 10 ? formatNumber(Math.round(n), $settings.numberFormat) : (n > 0 ? '+' : '') + n.toFixed(1));
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

  // How the change table is ordered. Worst-first by default — the table's first
  // job is "what are we falling behind on", and that answer should not need a
  // click. But the selection now has an order the user arranged by hand, and a
  // table that ignored it was the one place the arrangement didn't reach; the
  // Item column sorts back to it.
  let tableSort = $state({ key: 'frac', dir: 'asc' });

  const SORT_LABEL = {
    order: 'the order you arranged',
    first: 'starting stock',
    last: 'current stock',
    min: 'lowest point',
    max: 'highest point',
    delta: 'absolute change',
    frac: 'percentage change',
    rate: 'net per hour',
  };

  function sortBy(key) {
    // Flip the active column, the way a sortable header behaves. A new column
    // starts descending — biggest first — except the arranged order, which only
    // reads correctly forwards.
    if (tableSort.key === key) tableSort = { key, dir: tableSort.dir === 'asc' ? 'desc' : 'asc' };
    else tableSort = { key, dir: key === 'order' ? 'asc' : 'desc' };
    syncUrl();
  }

  /**
   * One row per charted item for the chart-less view: where it started, where it
   * is now, and the move between — measured over exactly the window the range
   * buttons select, from the same points the chart would have drawn.
   */
  const changeRows = $derived.by(() => {
    const rows = chartSeries.map((s) => {
      const pts = s.points;
      const first = pts.length ? pts[0].quantity : null;
      const last = pts.length ? pts[pts.length - 1].quantity : null;
      let min = null;
      let max = null;
      for (const pt of pts) {
        if (min === null || pt.quantity < min) min = pt.quantity;
        if (max === null || pt.quantity > max) max = pt.quantity;
      }
      const delta = first === null ? null : last - first;
      // A percentage needs something to be a percentage of. From a standing
      // start there is none, so those rows carry a null fraction and are
      // labelled rather than shown as an infinite gain.
      const frac = first ? delta / first : null;
      // Net movement per hour, over the span actually covered by the points
      // rather than the nominal range — a series that only started recording
      // halfway through would otherwise read as half the rate it is running at.
      const spanH = pts.length > 1 ? (new Date(pts[pts.length - 1].ts) - new Date(pts[0].ts)) / 3600e3 : 0;
      const rate = spanH > 0 ? delta / spanH : null;
      return { ...s, first, last, min, max, delta, frac, rate };
    });
    // `order` is the index the selection already has — chartSeries is derived
    // from `picked` — so sorting by it is just restoring this array's own order.
    const { key, dir } = tableSort;
    const sign = dir === 'asc' ? 1 : -1;
    return rows
      .map((r, order) => ({ ...r, order }))
      .sort((a, b) => {
        const x = a[key];
        const y = b[key];
        // Rows with nothing to compare sink to the bottom either way, rather
        // than riding to the top of an ascending sort as a false worst case.
        if (x === y) return a.order - b.order;
        if (x === null || x === undefined) return 1;
        if (y === null || y === undefined) return -1;
        return (x - y) * sign;
      });
  });

  /**
   * The row that runs out soonest, or null if nothing is draining.
   *
   * A straight-line projection off the net rate, which is exactly as crude as it
   * sounds — hence one figure in prose rather than a column of them implying
   * this is a forecast. It answers "is anything about to bite?", nothing more.
   */
  const draining = $derived.by(() => {
    const falling = changeRows.filter((r) => r.rate !== null && r.rate < 0 && r.last > 0);
    if (!falling.length) return null;
    return falling.reduce((a, b) => (a.last / -a.rate <= b.last / -b.rate ? a : b));
  });

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

  // Past MAX_SERIES the overlaid chart runs out of distinguishable colours — the
  // palette is eight validated hues and a ninth is not a generated one — so the
  // chart becomes one small panel per item instead. Overlaid stays the default
  // below that because a shared y-axis genuinely beats per-panel scales when the
  // series fit on it.
  const manySeries = $derived(chartSeries.length > MAX_SERIES);

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
    <div class="modes" role="group" aria-label="Display">
      <button class={mode === 'chart' ? 'accent' : ''} onclick={() => setMode('chart')} aria-pressed={mode === 'chart'} title="Plot the selected items over time">
        <Icon name="chart" size={15} /> Chart
      </button>
      <button
        class={mode === 'change' ? 'accent' : ''}
        onclick={() => setMode('change')}
        aria-pressed={mode === 'change'}
        title="No chart — one row per item showing how far it moved over the range"
      >
        <Icon name="grid" size={15} /> Change
      </button>
    </div>
    <button class={showTable ? 'accent' : ''} onclick={() => { showTable = !showTable; syncUrl(); }} aria-pressed={showTable} title="Every recorded value, timestamp by timestamp">
      <Icon name="stack" size={15} /> Values
    </button>
    <!-- Off by default here: with up to 8 series the fills overlap into mud. The
         single-series item panel turns it on instead. Hidden in change mode,
         where there is no band to shade. -->
    {#if mode === 'chart' && !manySeries}
    <button
      class={$settings.showBand ? 'accent' : ''}
      onclick={() => settings.update((s) => ({ ...s, showBand: !s.showBand }))}
      aria-pressed={!!$settings.showBand}
      title="Shade the min–max range within each bucket"
    >
      <Icon name="chart" size={15} /> Range band
    </button>
    {/if}
    <button onclick={snapshotNow} disabled={snapping} title="Sample the network right now">
      <Icon name={snapping ? 'loader' : 'bolt'} size={15} spin={snapping} /> Snapshot now
    </button>
    <button onclick={() => { loadSeries(); loadHealth(); }} title="Refresh"><Icon name="refresh" size={15} spin={loading} /></button>
    <CopyLink label="Copy chart link" />
  </div>

  <!-- Groups: a saved selection is one click away, and which half you are
       looking at is always on screen — the two lists are independent, so a name
       missing from one is not a bug. -->
  <div class="groups">
    <div class="gscope" role="group" aria-label="Which groups">
      {#each SCOPES as sc}
        <button class={groupScope === sc.id ? 'on' : ''} onclick={() => (groupScope = sc.id)} aria-pressed={groupScope === sc.id} title={sc.hint}>
          <Icon name={sc.icon} size={13} /> <span class="glab">{sc.label}</span>
        </button>
      {/each}
    </div>

    <div class="chips">
      {#each groups as g (g.id)}
        {#if renaming?.id === g.id}
          <!-- svelte-ignore a11y_autofocus -->
          <input
            class="ren"
            autofocus
            bind:value={renaming.text}
            onblur={commitRename}
            onkeydown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') renaming = null; }}
            aria-label="Group name"
          />
        {:else}
          <div class="chip {activeGroup?.id === g.id ? 'on' : ''}">
            <button
              class="capply"
              onclick={() => applyGroup(g)}
              title="Opens as {groupMode(g.mode) === 'change' ? 'a change table' : 'a chart'} — {(g.items || []).map((i) => stripMc(i.itemname)).join(', ')}"
            >
              <Icon name={groupMode(g.mode) === 'change' ? 'grid' : 'chart'} size={12} />
              <span class="cname">{g.name}</span>
              <span class="ccount mono">{g.items?.length ?? 0}</span>
            </button>
            <button class="ghost cbtn" onclick={() => (renaming = { id: g.id, text: g.name })} title="Rename" aria-label="Rename {g.name}">
              <Icon name="settings" size={13} />
            </button>
            <button
              class="ghost cbtn {armed === g.id ? 'armed' : ''}"
              onclick={() => removeGroup(g)}
              title={armed === g.id ? 'Click again to delete' : groupScope === 'shared' ? 'Delete for everyone' : 'Delete'}
              aria-label="Delete {g.name}"
            >
              <Icon name={armed === g.id ? 'alert' : 'trash'} size={13} />
            </button>
          </div>
        {/if}
      {/each}

      {#if !groups.length}
        <span class="gnone">
          {#if groupScope === 'shared' && sharedError}
            Shared groups unavailable: <span class="mono">{sharedError}</span>
          {:else if groupScope === 'shared'}
            No shared groups yet — save one and everyone on this account sees it.
          {:else}
            No groups yet — pick some items and save them as a group.
          {/if}
        </span>
      {/if}
    </div>

    <button
      class="gsave"
      disabled={!picked.length}
      onclick={() => (dialog = { name: activeGroup?.name || '', mode })}
      title={picked.length ? 'Save the current selection as a group' : 'Pick some items first'}
    >
      <Icon name="plus" size={14} /> Save group
    </button>
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
          <span class="cnt">{picked.length} picked</span>
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
        <div class="plist" bind:this={listEl}>
          {#each displayed as it, i (it.itemid)}
            {@const on = picked.some((p) => p.itemid === it.itemid)}
            {@const chg = formatChange(it.change)}
            {#if i === picked.length && picked.length && displayed.length > picked.length}
              <div class="pdiv"></div>
            {/if}
            <button
              class="prow {on ? 'on' : ''} {dragFrom === i && dragged ? 'dragging' : ''}"
              onclick={() => { if (dragged) { dragged = false; return; } toggle(it); }}
              aria-pressed={on}
              onpointerdown={(e) => pressStart(e, i, on)}
              onpointermove={pressMove}
              onpointerup={pressEnd}
              onpointercancel={pressEnd}
              onkeydown={(e) => rowKey(e, i)}
              title={on ? 'Drag to reorder, or Alt+↑/↓' : ''}
            >
              {#if on}<span class="swatch" style:background={colorOf(it.itemid)}></span>{:else}<span class="swatch off"></span>{/if}
              {#if on}<span class="grip" aria-hidden="true"><Icon name="sort" size={13} /></span>{/if}
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
            <p class="sub">Past {MAX_SERIES} the chart becomes one panel per item.</p>
          </div>
        {:else}
          {#if mode === 'chart'}
            <div class="card">
              <h3>
                Inventory level
                {#if manySeries}<span class="in">one panel per item &middot; each scaled to itself</span>{/if}
              </h3>
              {#if manySeries}
                <SparkGrid series={chartSeries} {loading} numberFormat={$settings.numberFormat} showIcons={$settings.showIcons} />
              {:else}
                <LineChart series={chartSeries} {loading} numberFormat={$settings.numberFormat} height={340} band={!!$settings.showBand} />
              {/if}
            </div>
          {:else}
            <div class="card">
              <h3>
                Change over {RANGES.find((r) => r.id === range)?.label ?? range}
                {#if activeGroup}<span class="in">in {activeGroup.name}</span>{/if}
              </h3>
              <!-- No inner scroll: at forty rows this IS the page's content, and
                   a 420px window inside an otherwise empty pane reads as broken.
                   The Values table below keeps its cap — it is a detail panel
                   under a chart, not the main event. -->
              <div class="tablewrap open">
                <table class="chg {loading ? 'busy' : ''}">
                  <thead>
                    <tr>
                      {#each [['order', 'Item'], ['first', 'Start'], ['last', 'Now'], ['min', 'Low'], ['max', 'High'], ['delta', 'Change'], ['frac', '%'], ['rate', 'Per hour']] as [key, label] (key)}
                        {@const on = tableSort.key === key}
                        <th
                          class:lead={key === 'order'}
                          aria-sort={on ? (tableSort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                        >
                          <button
                            class="sortbtn {on ? 'on' : ''}"
                            onclick={() => sortBy(key)}
                            title={on ? `Sorted by ${SORT_LABEL[key]} — click to reverse` : `Sort by ${SORT_LABEL[key]}`}
                          >
                            {label}
                            {#if on}
                              <span class="dirmark {tableSort.dir === 'asc' ? 'up' : ''}" aria-hidden="true"><Icon name="chevron" size={12} /></span>
                            {/if}
                          </button>
                        </th>
                      {/each}
                    </tr>
                  </thead>
                  <tbody>
                    {#each changeRows as r (r.itemid)}
                      {@const tone = r.delta > 0 ? 'up' : r.delta < 0 ? 'down' : ''}
                      <tr>
                        <td class="lead">
                          <span class="swatch" style:background={r.color}></span>
                          <span class="rname">{r.label}</span>
                        </td>
                        <td class="mono num">{r.first === null ? '—' : formatNumber(r.first, $settings.numberFormat)}</td>
                        <td class="mono num">{r.last === null ? '—' : formatNumber(r.last, $settings.numberFormat)}</td>
                        <td class="mono num dim">{r.min === null ? '—' : formatNumber(r.min, $settings.numberFormat)}</td>
                        <td class="mono num dim">{r.max === null ? '—' : formatNumber(r.max, $settings.numberFormat)}</td>
                        <td class="mono num {tone}">
                          {r.delta === null ? '—' : (r.delta > 0 ? '+' : '') + formatNumber(r.delta, $settings.numberFormat)}
                        </td>
                        <td class="mono num {tone}">
                          {#if r.frac !== null}
                            {formatChange(r.frac)}
                          {:else if r.first === 0 && r.last > 0}
                            new
                          {:else}
                            —
                          {/if}
                        </td>
                        <td class="mono num {tone}">{formatRate1(r.rate)}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
              <p class="foot">
                {#if tableSort.key === 'frac' && tableSort.dir === 'asc'}
                  Biggest fallers first.
                {:else if tableSort.key === 'order'}
                  In the order you arranged.
                {/if}
                A negative rate is stock going out faster than it comes in.
                {#if draining}
                  At this rate <strong>{draining.label}</strong> runs out in about
                  {formatDuration((draining.last / -draining.rate) * 3600)}.
                {/if}
              </p>
            </div>
          {/if}

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

  {#if dialog}
    <GroupDialog
      members={picked}
      personal={personalList}
      shared={sharedList}
      scope={groupScope}
      name={dialog.name}
      mode={dialog.mode}
      onClose={() => (dialog = null)}
      onSaved={saveGroup}
    />
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

  .modes { display: flex; gap: 4px; }

  /* Group strip: its own band under the toolbar, so the chips it holds are not
     competing for space with the range buttons on a narrow window. */
  .groups {
    flex: none; display: flex; align-items: center; gap: 8px;
    padding: 7px 14px; background: var(--panel); border-bottom: 1px solid var(--border);
  }
  .gscope { flex: none; display: flex; gap: 4px; }
  .gscope button { font-size: 11.5px; padding: 5px 9px; gap: 5px; }
  .gscope button.on { background: var(--accent-dim); border-color: var(--accent-border); color: var(--accent); }

  /* The chips scroll rather than wrap: this band sits above a chart that owns
     the rest of the screen, and a second row of chips would come out of its
     height every time someone saved another group. */
  .chips { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; overflow-x: auto; padding: 2px 0; }
  .chip {
    flex: none; display: flex; align-items: center;
    background: var(--card); border: 1px solid var(--border-2); border-radius: var(--radius);
  }
  .chip.on { border-color: var(--accent-border); background: var(--accent-dim); }
  .capply {
    display: flex; align-items: center; gap: 7px; background: transparent; border: none;
    border-radius: 0; padding: 5px 4px 5px 9px; font-size: 12.5px; max-width: 260px;
  }
  .capply:hover { background: transparent; }
  .chip:hover { border-color: var(--border-3); }
  .chip.on .capply { color: var(--accent); }
  .cname { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .capply :global(svg) { color: var(--text-mut); flex: none; }
  .chip.on .capply :global(svg) { color: var(--accent); }
  .ccount { font-size: 10.5px; color: var(--text-mut); }
  .chip.on .ccount { color: var(--accent); opacity: 0.8; }
  /* Edit affordances stay out of the way until the chip is pointed at — the
     common action by far is applying the group, and three live buttons per chip
     made the strip read as a settings screen. */
  .cbtn { padding: 4px 5px; opacity: 0; width: 0; overflow: hidden; }
  .chip:hover .cbtn, .chip:focus-within .cbtn { opacity: 1; width: auto; }
  .cbtn.armed { opacity: 1; width: auto; color: var(--danger); }
  .ren { flex: none; width: 150px; font-size: 12.5px; padding: 4px 8px; }
  .gnone { font-size: 12px; color: var(--text-mut); white-space: nowrap; }
  .gnone .mono { font-family: var(--mono); }
  .gsave { flex: none; font-size: 12px; padding: 6px 10px; }

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
  /* The handle is a hint, not a target — the whole row drags. Held at zero
     width until the row is pointed at so the selection doesn't jitter wider. */
  .grip { display: flex; color: var(--text-faint); opacity: 0; width: 0; overflow: hidden; transition: opacity 0.12s; cursor: grab; }
  .prow.on:hover .grip, .prow.on:focus-visible .grip { opacity: 1; width: auto; }
  .prow.dragging { opacity: 0.45; }
  /* Pointer-driven reordering: the browser must not start its own text
     selection or drag while a row is being moved. touch-action stays pan-y so
     the list still scrolls under a finger — touch reorders via Alt+arrow on a
     keyboard, or by pressing and moving once the row is selected. */
  .prow.on { touch-action: pan-y; user-select: none; }
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
  .tablewrap.open { max-height: none; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { text-align: right; padding: 5px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  th { position: sticky; top: 0; background: var(--card); color: var(--text-mut); font-weight: 500; text-align: right; }
  th:first-child, td:first-child { text-align: left; }
  th .key { margin-right: 6px; vertical-align: middle; }
  .when { color: var(--text-mut); }
  .num { color: var(--text); }

  /* Change table */
  .card h3 .in { color: var(--text-mut); font-weight: 400; }
  table.chg { table-layout: auto; }
  table.chg.busy { opacity: 0.55; transition: opacity 0.15s; }
  table.chg .lead { text-align: left; }
  /* The header IS the control, so the button carries none of the global button
     chrome — it has to keep reading as a column heading. */
  .sortbtn {
    display: inline-flex; align-items: center; gap: 3px; width: 100%;
    justify-content: flex-end; padding: 0; border: none; border-radius: 0;
    background: transparent; color: inherit; font: inherit; cursor: pointer;
  }
  .sortbtn:hover { background: transparent; color: var(--text); }
  .sortbtn.on { color: var(--accent); }
  th.lead .sortbtn { justify-content: flex-start; }
  table.chg td.lead { display: flex; align-items: center; gap: 8px; }
  table.chg .rname { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  table.chg .dim { color: var(--text-mut); }
  table.chg .up { color: var(--good); }
  table.chg .down { color: var(--danger); }
  .foot { margin: 10px 0 0; font-size: 12px; color: var(--text-mut); line-height: 1.6; }

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

    /* Same treatment as the toolbar: one scrolling row beats three stacked. */
    .groups { padding: 6px 10px; gap: 6px; }
    .gscope button .glab { display: none; }
    .gsave { padding: 6px 8px; }

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
