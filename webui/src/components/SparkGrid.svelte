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

  // Which panel is being pointed at, and where. One object rather than per-panel
  // state: only one panel can be hovered at a time, and forty pieces of state
  // that are always all-but-one null is just a slower way of saying that.
  let hover = $state(null); // { itemid, i }

  // The panels are ~150px wide, so toLocaleString()'s full date+seconds does not
  // fit and would be mostly redundant across a grid sharing one time range.
  const stamp = (ts) =>
    new Date(ts).toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  const xAt = (i, n) => (n <= 1 ? W / 2 : PAD + (i / (n - 1)) * (W - PAD * 2));
  const yAt = (q, min, span) => (span === 0 ? H / 2 : H - PAD - ((q - min) / span) * (H - PAD * 2));

  // Nearest sample to the pointer, in the panel's own coordinates. Reading the
  // rect each time rather than caching it keeps this correct when the grid
  // reflows underneath a held pointer.
  function move(e, p) {
    if (!p.qs.length) return;
    const r = e.currentTarget.getBoundingClientRect();
    const f = r.width ? (e.clientX - r.left) / r.width : 0;
    const i = Math.min(p.qs.length - 1, Math.max(0, Math.round(f * (p.qs.length - 1))));
    hover = { itemid: p.itemid, i };
  }

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
      // qs/ts survive onto the panel so the hover layer can answer "what value,
      // at what time" without re-walking the points on every pointer move.
      return { ...s, first, last, min, max, span, qs, ts: s.points.map((pt) => pt.ts), pts, frac, empty: !qs.length };
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
        {@const h = hover?.itemid === p.itemid ? hover.i : null}
        <div class="sparkwrap">
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <svg
          class="spark"
          viewBox="0 0 {W} {H}"
          preserveAspectRatio="none"
          role="img"
          aria-label="{p.label}: {formatNumber(p.last, numberFormat)}{chg ? `, ${chg} over the range` : ''}. Low {formatNumber(p.min, numberFormat)}, high {formatNumber(p.max, numberFormat)}."
          onpointermove={(e) => move(e, p)}
          onpointerleave={() => (hover = null)}
        >
          <!-- Transparent, not fill="none": the pointer has to land somewhere,
               and a 1.75px line is not a hit target. -->
          <rect x="0" y="0" width={W} height={H} fill="transparent" />
          <polyline points={p.pts} fill="none" stroke={p.color} stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round" />
          {#if h !== null}
            {@const cx = xAt(h, p.qs.length)}
            <!-- vector-effect, because this viewBox is stretched horizontally to
                 fill the cell and the stroke width would stretch with it. -->
            <line class="cross" x1={cx} y1="0" x2={cx} y2={H} vector-effect="non-scaling-stroke" />
          {/if}
        </svg>
        {#if h !== null}
          <!-- The marker is HTML, not a <circle>: preserveAspectRatio="none"
               scales x and y by different factors, so a circle in this viewBox
               draws as an ellipse on any cell wider than 150px. Positioned in
               percentages over the same box instead, it stays round. -->
          <span
            class="hdot"
            style:left="{(xAt(h, p.qs.length) / W) * 100}%"
            style:top="{(yAt(p.qs[h], p.min, p.span) / H) * 100}%"
            style:background={p.color}
          ></span>
        {/if}
        </div>
        <div class="cfoot">
          <span class="cnow mono">{formatNumber(p.last, numberFormat)}</span>
          {#if chg}
            <span class="cchg mono {p.frac > 0 ? 'up' : p.frac < 0 ? 'down' : ''}">{chg}</span>
          {:else if p.first === 0 && p.last > 0}
            <span class="cchg mono up">new</span>
          {/if}
        </div>
        {#if h !== null}
          <!-- Anchored over the footer rather than following the cursor: at this
               size a floating tip would cover the panel it describes, and pinning
               it to one spot means the eye does not chase it across forty cells.
               It also cannot clip out of the grid. -->
          <div class="tip">
            <span class="twhen">{stamp(p.ts[h])}</span>
            <span class="tval mono">{formatNumber(p.qs[h], numberFormat)}</span>
          </div>
        {/if}
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
    position: relative;
  }
  .cell:hover { border-color: var(--border-2); }
  .chead { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .cname { flex: 1; min-width: 0; font-size: 11.5px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .spark { width: 100%; height: 34px; display: block; }
  .cfoot { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; }
  .cnow { font-size: 12px; color: var(--text); }
  .cchg { font-size: 11px; color: var(--text-faint); }
  .cchg.up { color: var(--good); }
  .cchg.down { color: var(--danger); }
  .none { font-size: 11px; color: var(--text-mut); padding: 12px 0 14px; }

  .sparkwrap { position: relative; }
  .spark { cursor: crosshair; }
  .hdot {
    position: absolute; width: 6px; height: 6px; border-radius: 50%;
    transform: translate(-50%, -50%); pointer-events: none;
    box-shadow: 0 0 0 1.5px var(--panel-2);
  }
  .cross { stroke: var(--border-3); stroke-width: 1; vector-effect: non-scaling-stroke; }
  /* Covers the footer exactly, so the panel does not change height on hover. */
  .tip {
    position: absolute; left: 7px; right: 7px; bottom: 6px;
    display: flex; align-items: baseline; justify-content: space-between; gap: 6px;
    background: var(--panel-2); border-radius: 3px; pointer-events: none;
  }
  .twhen { font-size: 10.5px; color: var(--text-mut); white-space: nowrap; }
  .tval { font-size: 12px; color: var(--text); white-space: nowrap; }

  @media (max-width: 720px) {
    .grid { grid-template-columns: repeat(auto-fill, minmax(132px, 1fr)); }
  }
</style>
