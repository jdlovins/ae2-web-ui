<script>
  import { grids, selectedGrid, settings, toast } from '../lib/stores.js';
  import { api } from '../lib/api.js';
  import { formatNumber } from '../lib/format.js';
  import Icon from './Icon.svelte';

  let { onSelect } = $props();
  let open = $state(false);

  // Attached, selectable grids only; the mod also reports many key:-1
  // "unattached" networks (no security terminal) that can't be opened.
  const real = $derived($grids.filter((g) => g.key !== -1));
  const hidden = $derived($grids.length - real.length);
  const current = $derived($grids.find((g) => String(g.key) === String($selectedGrid)) || null);

  function pick(g) {
    if (g.key === -1) return;
    open = false;
    onSelect?.(String(g.key));
  }

  async function toggleTrack(g, e) {
    e.stopPropagation();
    try {
      const r = await api.gridSettings(g.key, !g.isTrackingEnabled);
      grids.update((list) => list.map((x) => (x.key === g.key ? { ...x, isTrackingEnabled: r.isTracked } : x)));
    } catch (err) { toast(err.message); }
  }

  function setDefault(g, e) {
    e.stopPropagation();
    settings.update((s) => ({ ...s, defaultGrid: s.defaultGrid === g.key ? null : g.key }));
  }

  function close(e) { if (!e.target.closest('.gridsel')) open = false; }
</script>

<svelte:window onclick={close} />

<div class="gridsel">
  <button class="trigger" onclick={() => (open = !open)} aria-expanded={open}>
    <Icon name="network" size={17} />
    {#if current}
      <span class="label">Grid {current.key}</span>
      <span class="meta">{current.owner} · {current.cpuCount} CPU{current.cpuCount === 1 ? '' : 's'}</span>
    {:else}
      <span class="label">Select grid</span>
    {/if}
    <Icon name="chevron" size={15} />
  </button>

  {#if open}
    <div class="menu" role="listbox">
      {#if real.length === 0}
        <div class="empty">No selectable grids. Place a wireless access point on the network you want to manage.</div>
      {/if}
      {#each real as g}
        <div
          class="row {String(g.key) === String($selectedGrid) ? 'sel' : ''}"
          role="option" aria-selected={String(g.key) === String($selectedGrid)}
          tabindex="0"
          onclick={() => pick(g)}
          onkeydown={(e) => e.key === 'Enter' && pick(g)}
        >
          <div class="rowmain">
            <span class="gname">Grid {g.key}</span>
            <span class="gmeta">
              {g.owner === 'N/A' ? 'no security' : `owner ${g.owner}`} · {formatNumber(g.cpuCount, 1)} CPU{g.cpuCount === 1 ? '' : 's'}
            </span>
          </div>
          <div class="rowactions">
            <button class="chip {$settings.defaultGrid === g.key ? 'on' : ''}" onclick={(e) => setDefault(g, e)} title="Open this grid by default">
              <Icon name="check" size={13} /> Default
            </button>
            <button class="chip {g.isTrackingEnabled ? 'on' : ''}" onclick={(e) => toggleTrack(g, e)} title="Track crafting jobs on this grid">
              <Icon name="chart" size={13} /> Track
            </button>
          </div>
        </div>
      {/each}
      {#if hidden > 0}
        <div class="note">{hidden} unattached network{hidden === 1 ? '' : 's'} hidden (no security terminal)</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .gridsel { position: relative; }
  .trigger { background: #1c2537; border-color: var(--border-2); }
  .trigger .label { font-weight: 500; }
  .trigger .meta { color: var(--text-mut); font-size: 12px; }
  .menu {
    position: absolute; top: calc(100% + 6px); left: 0; z-index: 50;
    min-width: 300px; max-width: min(92vw, 420px);
    background: var(--panel); border: 1px solid var(--border-2); border-radius: var(--radius-lg);
    padding: 6px; box-shadow: 0 12px 32px rgba(0,0,0,0.5);
    max-height: 60vh; overflow: auto;
  }
  .empty { padding: 12px; color: var(--text-mut); font-size: 13px; }
  .note { padding: 8px 10px 4px; color: var(--text-faint); font-size: 11.5px; }
  .row {
    padding: 9px 10px; border-radius: var(--radius); cursor: pointer;
    display: flex; align-items: center; gap: 10px; justify-content: space-between;
  }
  .row:hover { background: var(--card-hover); }
  .row.sel { background: #17352d; }
  .rowmain { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .gname { font-weight: 500; }
  .gmeta { font-size: 12px; color: var(--text-mut); }
  .rowactions { display: flex; gap: 6px; flex: none; }
  .chip {
    font-size: 11.5px; padding: 4px 8px; background: transparent;
    border: 1px solid var(--border-2); color: var(--text-mut);
  }
  .chip.on { background: var(--accent-dim); border-color: var(--accent-border); color: var(--accent); }
</style>
