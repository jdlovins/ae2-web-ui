<script>
  import { api } from '../lib/api.js';
  import { selectedGrid, cpuList, focusCpu, toast } from '../lib/stores.js';
  import { formatNumber, formatRate, formatBytes, formatTime, formatPercent } from '../lib/format.js';
  import { pollVisible } from '../lib/poll.js';
  import { settings } from '../lib/stores.js';
  import McText from './McText.svelte';
  import ItemIcon from './ItemIcon.svelte';
  import Icon from './Icon.svelte';

  let selected = $state('');
  let detail = $state(null);
  let loading = $state(false);

  const names = $derived(Object.keys($cpuList));

  // Honor a CPU focused by the order flow.
  $effect(() => {
    if ($focusCpu && names.includes($focusCpu)) { selected = $focusCpu; focusCpu.set(null); }
  });

  // Keep a valid selection as the CPU list updates.
  $effect(() => {
    if (names.length === 0) { selected = ''; return; }
    if (!$cpuList[selected]) {
      const busy = names.find((n) => $cpuList[n].isBusy || $cpuList[n].finalOutput);
      selected = busy || names[0];
    }
  });

  let lastKey;
  $effect(() => {
    const key = $selectedGrid + '|' + selected;
    if (key !== lastKey && selected) { lastKey = key; loadDetail(); }
  });

  async function loadDetail(fresh = false) {
    if (!selected || $selectedGrid == null) return;
    loading = true;
    try { detail = await api.cpu($selectedGrid, selected, { fresh }); trackPeak(detail); }
    catch (e) { toast(e.message); detail = null; }
    finally { loading = false; }
  }

  // --- Job progress -------------------------------------------------------
  // /get only ever reports what's *left* (active + pending), never the job's
  // original size, so progress isn't directly derivable. With tracking on the
  // CPU also reports craftedTotal per item, which makes the total exactly
  // crafted + active + pending. Without it we fall back to the largest backlog
  // seen since opening this CPU, which only reads correctly if we were watching
  // from the start — hence the "estimated" marker.
  let peakRemaining = $state(0);
  let peakKey = $state('');

  const remainingOf = (d) =>
    (d.items || []).reduce((a, it) => a + (Number(it.active) || 0) + (Number(it.pending) || 0), 0);

  function trackPeak(d) {
    if (!d?.finalOutput) { peakRemaining = 0; peakKey = ''; return; }
    const key = `${$selectedGrid}|${selected}|${d.finalOutput.hashcode}`;
    const remaining = remainingOf(d);
    if (key !== peakKey) { peakKey = key; peakRemaining = remaining; }
    else if (remaining > peakRemaining) peakRemaining = remaining;
  }

  // The CPU list carries timeStarted, so elapsed survives even when /get omits it.
  const elapsed = $derived.by(() => {
    if (Number(detail?.timeElapsed) > 0) return Number(detail.timeElapsed);
    const started = Number($cpuList[selected]?.timeStarted) || 0;
    return started > 0 ? Date.now() - started : 0;
  });

  const progress = $derived.by(() => {
    const d = detail;
    if (!d?.finalOutput || !d.items?.length) return null;

    let crafted = 0;
    for (const it of d.items) crafted += Number(it.craftedTotal) || 0;
    const remaining = remainingOf(d);

    // hasTrackingInfo alone decides this: a tracked job that hasn't finished its
    // first craft yet has crafted === 0, and that's a real 0%, not an estimate.
    const tracked = d.hasTrackingInfo;
    const total = tracked ? crafted + remaining : peakRemaining;
    if (total <= 0) return null;

    const done = tracked ? crafted : Math.max(0, peakRemaining - remaining);
    const ratio = Math.min(1, Math.max(0, done / total));

    // No ETA on purpose. Extrapolating from the average rate so far assumes every
    // remaining craft costs what the average one did, and it doesn't: crafts
    // differ by recipe, machine tier and how much runs in parallel. The cheap
    // steps finish first and inflate the average, so the estimate collapses
    // toward zero exactly as the slow steps begin — one job sat on "2s left" for
    // eight minutes. A number that confident and that wrong is worse than none.
    return { ratio, done, total, remaining, estimated: !tracked };
  });

  // Poll the open CPU while this view is mounted and the tab is visible. At 3s
  // this is the heaviest poll in the app, and /get runs on the server tick.
  $effect(() => pollVisible(() => { if (selected) loadDetail(); }, 3000));

  async function cancel() {
    if (!selected) return;
    try { await api.cancelCpu($selectedGrid, selected); toast(`Cancelled job on ${selected}`); }
    catch (e) { toast(e.message); }
    const list = await api.cpuList($selectedGrid).catch(() => null);
    if (list) cpuList.set(list);
    loadDetail();
  }

  const cellClass = (it) => (it.active > 0 ? 'active' : it.pending > 0 ? 'pending' : 'storage');

  // AE2's per-CPU "Accept request" setting (CraftingAllow). Absent on AE2 builds
  // without it — GTNH Unofficial only — so undefined must render as nothing
  // rather than as "unrestricted", which would be a claim we can't make.
  const ALLOW_MODE = {
    ONLY_PLAYER: { label: 'Player only', title: 'Only accepts crafting requests made by a player' },
    ONLY_NONPLAYER: { label: 'Automation only', title: 'Only accepts crafting requests from machines — a request from here will be refused' },
  };
  const allowMode = (c) => ALLOW_MODE[c?.craftingAllowMode];
</script>

<div class="wrap">
  <aside class="cpus">
    <div class="ahead">Crafting CPUs</div>
    <div class="clist">
      {#each names as name}
        {@const c = $cpuList[name]}
        <button class="crow {selected === name ? 'sel' : ''}" onclick={() => (selected = name)}>
          <div class="crow-top">
            <span class="cdot {c.isBusy || c.finalOutput ? 'busy' : 'idle'}"></span>
            <span class="cname">{name}</span>
            {#if allowMode(c)}
              {@const m = allowMode(c)}
              <span class="cmode {c.craftingAllowMode === 'ONLY_NONPLAYER' ? 'warn' : ''}" title={m.title}>{m.label}</span>
            {/if}
          </div>
          {#if c.finalOutput}
            <span class="ctask"><McText name={c.finalOutput.itemname} /> ×{formatNumber(c.finalOutput.quantity, $settings.numberFormat)}</span>
          {:else}
            <span class="cidle">idle · {formatBytes(c.availableStorage)} · {c.coProcessors} co-proc</span>
          {/if}
        </button>
      {/each}
      {#if names.length === 0}<div class="none">No crafting CPUs on this network.</div>{/if}
    </div>
  </aside>

  <section class="detail">
    <div class="dhead">
      <div class="dtop">
        {#if detail?.finalOutput}
          <span class="dtitle">Crafting <McText name={detail.finalOutput.itemname} /> ×{formatNumber(detail.finalOutput.quantity, $settings.numberFormat)}</span>
        {:else}
          <span class="dtitle">{selected || 'CPU'} — idle</span>
        {/if}
        <div class="dactions">
          <button onclick={() => loadDetail(true)} title="Refresh"><Icon name="refresh" size={15} spin={loading} /></button>
          {#if detail?.finalOutput}
            <button class="danger" onclick={cancel}><Icon name="x" size={15} /> Cancel job</button>
          {/if}
        </div>
      </div>

      {#if progress}
        <div class="prog">
          <div class="bar" role="progressbar" aria-valuenow={Math.round(progress.ratio * 100)} aria-valuemin="0" aria-valuemax="100">
            <div class="fill" style:width="{progress.ratio * 100}%"></div>
          </div>
          <div class="pmeta">
            <span class="pct">{formatPercent(progress.ratio)}</span>
            <span>{formatNumber(progress.done, $settings.numberFormat)} / {formatNumber(progress.total, $settings.numberFormat)} crafts</span>
            {#if elapsed > 0}
              <span><Icon name="clock" size={13} /> {formatTime(elapsed)} elapsed</span>
            {/if}
            {#if progress.estimated}
              <span class="est" title="This job isn't being tracked — either Track is off for this grid, or it was switched on after the job started. Progress is measured against the largest backlog seen since you opened this CPU, so it reads low if you didn't watch from the start.">
                <Icon name="alert" size={13} /> estimated
              </span>
            {/if}
          </div>
        </div>
      {/if}
    </div>

    {#if detail && detail.items && detail.items.length}
      <div class="items">
        {#each detail.items as it, i (i)}
          <div class="cell {cellClass(it)}">
            <div class="ctop"><ItemIcon item={{ ...it, hashcode: it.itemid }} size={30} enabled={$settings.showIcons} /><span class="cn"><McText name={it.itemname} /></span></div>
            <div class="crow2">
              {#if it.active > 0}<span class="tag crafting">Crafting {formatNumber(it.active, $settings.numberFormat)}</span>{/if}
              {#if it.pending > 0}<span class="tag sched">Scheduled {formatNumber(it.pending, $settings.numberFormat)}</span>{/if}
              <span class="tag stored">Stored {formatNumber(it.stored, $settings.numberFormat)}</span>
            </div>
            {#if detail.hasTrackingInfo && it.timeSpentCrafting}
              <div class="track">
                {formatTime(it.timeSpentCrafting)} ({formatPercent(it.shareInCraftingTimeCombined)}) · {formatRate(it.craftsPerSec)}/s
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {:else if selected}
      <div class="empty"><Icon name="tools" size={26} /><p>This CPU is idle.</p></div>
    {:else}
      <div class="empty"><Icon name="tools" size={26} /><p>Select a CPU to see its job.</p></div>
    {/if}
  </section>
</div>

<style>
  .wrap { display: flex; height: 100%; min-height: 0; }
  .cpus { flex: none; width: 260px; border-right: 1px solid var(--border); background: var(--panel-2); display: flex; flex-direction: column; min-height: 0; }
  .ahead { padding: 12px 14px; font-weight: 500; border-bottom: 1px solid var(--border); color: var(--text-dim); }
  .clist { overflow: auto; padding: 8px; display: flex; flex-direction: column; gap: 5px; }
  .crow { flex-direction: column; align-items: flex-start; gap: 3px; text-align: left; background: var(--card); }
  .crow.sel { border-color: var(--border-3); background: #17352d; }
  .crow-top { display: flex; align-items: center; gap: 7px; width: 100%; min-width: 0; }
  .cdot { width: 8px; height: 8px; border-radius: 50%; }
  .cdot.busy { background: var(--accent); }
  .cdot.idle { background: #3a4560; }
  .cname { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cmode {
    margin-left: auto; flex: none; font-size: 10px; padding: 1px 6px; border-radius: 999px;
    background: var(--card-hover); color: var(--text-mut); white-space: nowrap;
  }
  /* Automation-only refuses requests from this UI, so it reads as a caution. */
  .cmode.warn { background: var(--warn-dim); color: var(--warn); }
  .ctask { font-size: 12px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
  .cidle { font-size: 11.5px; color: var(--text-mut); font-family: var(--mono); }
  .none { padding: 14px; color: var(--text-mut); font-size: 13px; }
  .detail { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .dhead { flex: none; display: flex; flex-direction: column; gap: 9px; padding: 12px 14px; border-bottom: 1px solid var(--border); }
  .dtop { display: flex; align-items: center; gap: 10px; }
  .dtitle { font-size: 15px; font-weight: 500; flex: 1; min-width: 0; }
  .prog { display: flex; flex-direction: column; gap: 6px; }
  .bar { height: 6px; border-radius: 999px; background: var(--card-hover); border: 1px solid var(--border-2); overflow: hidden; }
  .fill { height: 100%; background: var(--accent); transition: width 400ms ease; }
  .pmeta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; font-size: 11.5px; color: var(--text-mut); font-family: var(--mono); }
  .pmeta span { display: inline-flex; align-items: center; gap: 5px; }
  .pmeta .pct { color: var(--accent); font-weight: 500; }
  .pmeta .est { color: var(--warn); cursor: help; }
  .dactions { display: flex; gap: 7px; }
  .items { flex: 1; overflow: auto; padding: 14px; display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; align-content: start; }
  .cell { border: 1px solid var(--border-2); border-radius: var(--radius); padding: 10px; background: var(--card); }
  .cell.active { background: #1c2b12; border-color: #3a5416; }
  .cell.pending { background: #29260c; border-color: #4a4611; }
  .cell.storage { background: #17203a; }
  .ctop { display: flex; align-items: center; gap: 7px; margin-bottom: 7px; }
  .cn { font-size: 12.5px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .crow2 { display: flex; flex-wrap: wrap; gap: 5px; }
  .tag { font-size: 11px; padding: 2px 7px; border-radius: 999px; background: #223; color: var(--text-dim); }
  .tag.crafting { background: #24400f; color: #a6e57a; }
  .tag.sched { background: #3d3810; color: var(--warn); }
  .track { margin-top: 7px; font-size: 11px; color: var(--text-mut); font-family: var(--mono); }
  .empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: var(--text-mut); }
  @media (max-width: 720px) {
    .wrap { flex-direction: column; }
    .cpus { width: 100%; max-height: 38%; border-right: none; border-bottom: 1px solid var(--border); }
  }
</style>
