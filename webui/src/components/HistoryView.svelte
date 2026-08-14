<script>
  import { api } from '../lib/api.js';
  import { selectedGrid, settings, toast } from '../lib/stores.js';
  import { formatNumber, formatRate, formatTime, formatPercent, formatDateTime, stripMc } from '../lib/format.js';
  import { updateParams, param, routeEpoch } from '../lib/router.js';
  import McText from './McText.svelte';
  import ItemIcon from './ItemIcon.svelte';
  import Timeline from './Timeline.svelte';
  import Icon from './Icon.svelte';
  import CopyLink from './CopyLink.svelte';

  let list = $state([]);
  let loading = $state(false);
  let detail = $state(null);
  let detailLoading = $state(false);
  let openId = $state(null);
  let showItemChart = $state(false);
  let showIfaceChart = $state(false);

  export async function load() {
    if ($selectedGrid == null) { list = []; return; }
    loading = true;
    try { list = await api.trackingHistory($selectedGrid); }
    catch (e) { toast(e.message); }
    finally { loading = false; }
  }

  let lastGrid;
  $effect(() => { if ($selectedGrid !== lastGrid) { lastGrid = $selectedGrid; detail = null; openId = null; load(); } });

  async function open(entry, { keepCharts = false } = {}) {
    openId = entry.id;
    detailLoading = true;
    if (!keepCharts) showItemChart = showIfaceChart = false;
    syncUrl();
    try { detail = await api.tracking($selectedGrid, entry.id); }
    catch (e) { toast(e.message); }
    finally { detailLoading = false; }
  }

  // --- Linking -------------------------------------------------------------
  //
  // The link carries the job's timeStarted as a witness, and that is not
  // belt-and-braces. Crafting history lives only in memory: the mod's
  // onServerStopped clears it AND resets the id counter to 1, so after a restart
  // job 3 is a DIFFERENT craft rather than a missing one. Without the witness a
  // shared link would quietly open the wrong job — worse than a dead link.
  const chartList = () => [showItemChart && 'item', showIfaceChart && 'iface'].filter(Boolean).join(',');

  function syncUrl() {
    const entry = list.find((e) => String(e.id) === String(openId));
    updateParams({ job: openId, t: entry?.timeStarted ?? null, charts: chartList() || null });
  }

  function toggleChart(which) {
    if (which === 'item') showItemChart = !showItemChart;
    else showIfaceChart = !showIfaceChart;
    syncUrl();
  }

  // Seed from the URL once per navigation, and only once the list has arrived —
  // the entry has to be resolved before it can be opened or vouched for.
  let seededFor = null;
  $effect(() => {
    const key = `${$routeEpoch}|${$selectedGrid}`;
    if (seededFor === key || !list.length) return;
    seededFor = key;

    const charts = (param('charts') || '').split(',').filter(Boolean);
    showItemChart = charts.includes('item');
    showIfaceChart = charts.includes('iface');

    const jobId = param('job');
    if (!jobId) return;
    const entry = list.find((e) => String(e.id) === String(jobId));
    const witness = param('t');
    if (!entry || (witness && String(entry.timeStarted) !== String(witness))) {
      toast('That craft is no longer in the server’s history — it was cleared when the server restarted.');
      updateParams({ job: null, t: null });
      return;
    }
    open(entry, { keepCharts: true });
  });

  const toSpans = (timings, extra) => (timings || []).map((t) => ({ start: Number(t.started), end: Number(t.ended), extra }));
  const itemRows = $derived((detail?.items || []).map((it) => ({
    label: stripMc(it.itemname),
    meta: formatTime(it.timeSpentOn),
    spans: toSpans(it.timings, [`${formatNumber(it.craftedTotal, $settings.numberFormat)} crafted · ${formatRate(it.craftsPerSec)}/s`, `${formatPercent(it.shareInCraftingTimeCombined)} of active time`]),
  })));
  const ifaceRows = $derived((detail?.interfaceShare || []).map((f) => ({
    label: f.name,
    meta: formatTime(f.timingsCombined ?? (f.timings || []).reduce((a, t) => a + (t.ended - t.started), 0)),
    spans: toSpans(f.timings, (f.location || []).map((l) => `@ dim ${l.dimid} · ${l.x}, ${l.y}, ${l.z}`)),
  })));
</script>

<div class="wrap">
  <aside class="list">
    <div class="ahead">
      <span>Crafting history</span>
      <button class="ghost" onclick={load} title="Refresh"><Icon name="refresh" size={15} spin={loading} /></button>
    </div>
    <div class="entries">
      {#each list as e (e.id)}
        <button class="entry {openId === e.id ? 'sel' : ''}" onclick={() => open(e)}>
          <div class="etitle"><McText name={e.finalOutput.itemname} /> ×{formatNumber(e.finalOutput.quantity, $settings.numberFormat)}{#if e.wasCancelled}<span class="cx">cancelled</span>{/if}</div>
          <div class="emeta">{formatDateTime(e.timeStarted)} · {formatTime(Number(e.timeDone) - Number(e.timeStarted))}</div>
        </button>
      {/each}
      {#if list.length === 0 && !loading}
        <div class="none">No tracked jobs yet. Enable “Track” on a grid to record crafting history.</div>
      {/if}
    </div>
  </aside>

  <section class="detail">
    {#if detailLoading}
      <div class="empty"><Icon name="loader" size={24} spin /><p>Loading job…</p></div>
    {:else if detail}
      <div class="dhead">
        <span class="dtitle">
          <McText name={detail.finalOutput.itemname} /> ×{formatNumber(detail.finalOutput.quantity, $settings.numberFormat)}
          {#if detail.wasCancelled}<span class="cx">cancelled</span>{/if}
        </span>
        <span class="dtime">{formatTime(Number(detail.timeDone) - Number(detail.timeStarted))}</span>
        <CopyLink label="Copy link" />
      </div>
      <div class="dbody">
        <div class="summary">
          <div><Icon name="clock" size={14} /> Started {formatDateTime(detail.timeStarted)}</div>
          <div><Icon name="check" size={14} /> Done {formatDateTime(detail.timeDone)}</div>
        </div>

        <div class="charts">
          <button onclick={() => toggleChart('item')}><Icon name="chart" size={15} /> {showItemChart ? 'Hide' : 'Show'} item crafting timeline</button>
          {#if showItemChart}<div class="chart"><Timeline rows={itemRows} color="#5fe3c9" /></div>{/if}
          <button onclick={() => toggleChart('iface')}><Icon name="chart" size={15} /> {showIfaceChart ? 'Hide' : 'Show'} interface usage timeline</button>
          {#if showIfaceChart}<div class="chart"><Timeline rows={ifaceRows} color="#8fa2c8" /></div>{/if}
        </div>

        <div class="items">
          {#each detail.items as it (it.itemid + it.itemname)}
            <div class="cell">
              <div class="ctop"><ItemIcon item={{ ...it, hashcode: it.itemid }} size={28} enabled={$settings.showIcons} /><span class="cn"><McText name={it.itemname} /> ×{formatNumber(it.craftedTotal, $settings.numberFormat)}</span></div>
              <div class="cmeta">{formatTime(it.timeSpentOn)} ({formatPercent(it.shareInCraftingTimeCombined)}) · {formatRate(it.craftsPerSec)}/s</div>
            </div>
          {/each}
        </div>
      </div>
    {:else}
      <div class="empty"><Icon name="history" size={26} /><p>Select a job to see its breakdown and timelines.</p></div>
    {/if}
  </section>
</div>

<style>
  .wrap { display: flex; height: 100%; min-height: 0; }
  .list { flex: none; width: 300px; border-right: 1px solid var(--border); background: var(--panel-2); display: flex; flex-direction: column; min-height: 0; }
  .ahead { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid var(--border); font-weight: 500; color: var(--text-dim); }
  .entries { overflow: auto; padding: 8px; display: flex; flex-direction: column; gap: 5px; }
  .entry { flex-direction: column; align-items: flex-start; gap: 3px; text-align: left; background: var(--card); }
  .entry.sel { border-color: var(--border-3); background: #17352d; }
  .etitle { font-size: 13px; font-weight: 500; }
  .emeta { font-size: 11.5px; color: var(--text-mut); font-family: var(--mono); }
  .cx { margin-left: 7px; font-size: 10.5px; color: var(--danger); border: 1px solid var(--danger-border); border-radius: 999px; padding: 1px 7px; }
  .none { padding: 14px; color: var(--text-mut); font-size: 13px; }
  .detail { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .dhead { flex: none; display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--border); }
  .dtitle { font-size: 15px; font-weight: 500; flex: 1; }
  .dtime { font-family: var(--mono); color: var(--text-mut); font-size: 13px; }
  .dbody { flex: 1; overflow: auto; padding: 14px; }
  .summary { display: flex; flex-wrap: wrap; gap: 8px 20px; color: var(--text-dim); font-size: 13px; margin-bottom: 14px; }
  .summary div { display: flex; align-items: center; gap: 6px; }
  .charts { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
  .chart { background: var(--card); border: 1px solid var(--border-2); border-radius: var(--radius); padding: 12px; }
  .items { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; }
  .cell { border: 1px solid var(--border-2); border-radius: var(--radius); padding: 10px; background: var(--card); }
  .ctop { display: flex; align-items: center; gap: 7px; margin-bottom: 5px; }
  .cn { font-size: 12.5px; font-weight: 500; }
  .cmeta { font-size: 11px; color: var(--text-mut); font-family: var(--mono); }
  .empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: var(--text-mut); }
  @media (max-width: 720px) {
    .wrap { flex-direction: column; }
    .list { width: 100%; max-height: 38%; border-right: none; border-bottom: 1px solid var(--border); }
  }
</style>
