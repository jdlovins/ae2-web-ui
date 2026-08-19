<script>
  import { formatNumber, formatChange } from '../lib/format.js';
  import ItemIcon from './ItemIcon.svelte';
  import McText from './McText.svelte';

  // Small multiples: one panel per item, for group sizes the overlaid chart
  // cannot honestly draw. TrendsView switches to this past MAX_SERIES.
  //
  // Every panel scales to ITS OWN range, which is the whole point and also the
  // one thing to understand before reading it: a panel showing a steep fall may
  // be a drop of forty items or of forty thousand. Shape is comparable across
  // panels, magnitude is not — that is the trade that makes a 900-count series
  // and a 400k one legible side by side, and it is why the current value sits
  // on every panel in figures.
  let { series = [], numberFormat = 1, showIcons = true, loading = false } = $props();

  const W = 150;
  const H = 34;
  const PAD = 3;

  // One pass per panel: the extent, the polyline, and the numbers beneath it.
  const panels = $derived(
    series.map((s) => {
      const qs = s.points.map((p) => p.quantity);
      const first = qs.length ? qs[0] : null;
      const last = qs.length ? qs[qs.length - 1] : null;
      const min = qs.length ? Math.min(...qs) : null;
      const max = qs.length ? Math.max(...qs) : null;
      // A flat series has no range to scale against; drawing it down the middle
      // is honest, where dividing by zero would put it at the top or the bottom
      // and imply a move that never happened.
      const span = max === min ? 0 : max - min;
      const pts = qs
        .map((q, i) => {
          const x = PAD + (qs.length === 1 ? (W - PAD * 2) / 2 : (i / (qs.length - 1)) * (W - PAD * 2));
          const y = span === 0 ? H / 2 : H - PAD - ((q - min) / span) * (H - PAD * 2);
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(' ');
      const frac = first ? (last - first) / first : null;
      return { ...s, first, last, min, max, pts, frac, empty: !qs.length };
    }),
  );
</script>

<div class="grid" class:loading>
  {#each panels as p (p.itemid)}
    {@const chg = formatChange(p.frac)}
    <div class="cell">
      <div class="chead">
        <ItemIcon item={{ itemid: p.itemid, itemname: p.label }} size={18} enabled={showIcons} />
        <span class="cname" title={p.label}><McText name={p.label} /></span>
      </div>
      {#if p.empty}
        <div class="none">No samples in range</div>
      {:else}
        <svg
          class="spark"
          viewBox="0 0 {W} {H}"
          preserveAspectRatio="none"
          role="img"
          aria-label="{p.label}: {formatNumber(p.last, numberFormat)}{chg ? `, ${chg} over the range` : ''}"
        >
          <polyline points={p.pts} fill="none" stroke={p.color} stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round" />
        </svg>
        <div class="cfoot">
          <span class="cnow mono">{formatNumber(p.last, numberFormat)}</span>
          {#if chg}
            <span class="cchg mono {p.frac > 0 ? 'up' : p.frac < 0 ? 'down' : ''}">{chg}</span>
          {:else if p.first === 0 && p.last > 0}
            <span class="cchg mono up">new</span>
          {/if}
        </div>
      {/if}
    </div>
  {/each}
</div>

<style>
  /* auto-fill, not auto-fit: with a handful of panels auto-fit would stretch
     each one across the whole card, so the same group would draw at wildly
     different widths depending on how many items survived a filter. */
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(158px, 1fr)); gap: 8px; }
  .loading { opacity: 0.55; transition: opacity 0.15s; }
  .cell {
    background: var(--panel-2); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 7px 8px 6px; min-width: 0; display: flex; flex-direction: column; gap: 4px;
  }
  .chead { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .cname { flex: 1; min-width: 0; font-size: 11.5px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .spark { width: 100%; height: 34px; display: block; }
  .cfoot { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; }
  .cnow { font-size: 12px; color: var(--text); }
  .cchg { font-size: 11px; color: var(--text-faint); }
  .cchg.up { color: var(--good); }
  .cchg.down { color: var(--danger); }
  .none { font-size: 11px; color: var(--text-mut); padding: 12px 0 14px; }

  @media (max-width: 720px) {
    .grid { grid-template-columns: repeat(auto-fill, minmax(132px, 1fr)); }
  }
</style>
