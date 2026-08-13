<script module>
  // Categorical palette, assigned by fixed slot order and never cycled — a 9th
  // series is not a generated hue (TrendsView caps selection at 8).
  //
  // These are the dark steps validated against this app's chart surface
  // (#151b2a) with the dataviz validator: lightness band, chroma floor,
  // adjacent-pair CVD separation (worst ΔE 8.4 protan), normal-vision floor
  // (worst ΔE 19.3) and 3:1 contrast all PASS. Re-run the validator before
  // touching these values or their order — the order is the CVD-safety
  // mechanism, not cosmetic.
  export const SERIES_COLORS = [
    '#3987e5', // blue
    '#d95926', // orange
    '#199e70', // aqua
    '#c98500', // yellow
    '#d55181', // magenta
    '#008300', // green
    '#9085e9', // violet
    '#e66767', // red
  ];
  export const MAX_SERIES = SERIES_COLORS.length;
</script>

<script>
  import { formatNumber } from '../lib/format.js';

  // series: [{ itemid, label, color, points: [{ ts, quantity }] }]
  let { series = [], loading = false, numberFormat = 1, height = 320 } = $props();

  const M = { top: 12, right: 16, bottom: 26, left: 68 };

  let box = $state(null);
  let w = $state(900);
  const innerW = $derived(Math.max(80, w - M.left - M.right));
  const innerH = $derived(Math.max(60, height - M.top - M.bottom));

  // Union of timestamps across series: the crosshair snaps to these, and a
  // series missing one renders as a gap rather than a straight-line lie.
  const xs = $derived.by(() => {
    const set = new Set();
    for (const s of series) for (const p of s.points) set.add(new Date(p.ts).getTime());
    return [...set].sort((a, b) => a - b);
  });

  const lookup = $derived.by(() =>
    series.map((s) => {
      const m = new Map();
      for (const p of s.points) m.set(new Date(p.ts).getTime(), Number(p.quantity));
      return m;
    }),
  );

  const xMin = $derived(xs.length ? xs[0] : 0);
  const xMax = $derived(xs.length ? xs[xs.length - 1] : 1);
  // Quantities are magnitudes, so the scale is anchored at zero — a truncated
  // baseline would exaggerate stock swings.
  const yMax = $derived.by(() => {
    let m = 0;
    for (const s of series) for (const p of s.points) if (Number(p.quantity) > m) m = Number(p.quantity);
    return m > 0 ? m : 1;
  });
  // Round the top up to a clean power-of-ten-ish step so gridlines read well.
  const yTop = $derived.by(() => {
    const raw = yMax * 1.05;
    const mag = 10 ** Math.floor(Math.log10(raw));
    return Math.ceil(raw / mag) * mag;
  });

  const sx = (t) => (xMax === xMin ? innerW / 2 : ((t - xMin) / (xMax - xMin)) * innerW);
  const sy = (v) => innerH - (v / yTop) * innerH;

  const path = (i) => {
    const m = lookup[i];
    let d = '';
    let pen = false;
    for (const t of xs) {
      const v = m.get(t);
      if (v === undefined) { pen = false; continue; } // gap
      d += `${pen ? 'L' : 'M'}${sx(t).toFixed(1)},${sy(v).toFixed(1)}`;
      pen = true;
    }
    return d;
  };

  const yTicks = $derived([0, 0.25, 0.5, 0.75, 1].map((f) => ({ v: yTop * f, y: sy(yTop * f) })));
  const xTicks = $derived.by(() => {
    if (xs.length < 2) return [];
    return [0, 0.5, 1].map((f) => {
      const t = xMin + (xMax - xMin) * f;
      return { t, x: sx(t), label: fmtTime(t, xMax - xMin) };
    });
  });

  function fmtTime(t, spanMs) {
    const d = new Date(t);
    if (spanMs > 3 * 86400e3) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  // --- crosshair: readers aim at a time, never at a 2px line ---------------
  let hoverIdx = $state(-1);
  const hoverT = $derived(hoverIdx >= 0 && hoverIdx < xs.length ? xs[hoverIdx] : null);

  function nearest(clientX) {
    if (!box || !xs.length) return -1;
    const rect = box.getBoundingClientRect();
    const px = clientX - rect.left - M.left;
    const t = xMin + (px / innerW) * (xMax - xMin);
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < xs.length; i++) {
      const d = Math.abs(xs[i] - t);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }
  const onMove = (e) => (hoverIdx = nearest(e.clientX));
  const onLeave = () => (hoverIdx = -1);
  function onKey(e) {
    if (!xs.length) return;
    if (e.key === 'ArrowRight') { hoverIdx = Math.min(xs.length - 1, (hoverIdx < 0 ? -1 : hoverIdx) + 1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { hoverIdx = Math.max(0, (hoverIdx < 0 ? xs.length : hoverIdx) - 1); e.preventDefault(); }
    else if (e.key === 'Escape') hoverIdx = -1;
  }

  // Tooltip rows: value leads (Strong), series name follows (secondary).
  const readout = $derived.by(() => {
    if (hoverT === null) return [];
    return series
      .map((s, i) => ({ label: s.label, color: s.color, v: lookup[i].get(hoverT) }))
      .filter((r) => r.v !== undefined)
      .sort((a, b) => b.v - a.v);
  });

  // Direct labels at the line end for small series counts; beyond 4 the legend
  // carries identity alone (a label per line would collide).
  const LABEL_MIN_GAP = 14;
  const endLabels = $derived.by(() => {
    if (series.length > 4 || !xs.length) return [];
    const found = series
      .map((s, i) => {
        for (let k = xs.length - 1; k >= 0; k--) {
          const v = lookup[i].get(xs[k]);
          if (v !== undefined) return { label: s.label, color: s.color, x: sx(xs[k]), y: sy(v) };
        }
        return null;
      })
      .filter(Boolean)
      .sort((a, b) => a.y - b.y);
    // Items with similar stock levels put their labels on top of each other, so
    // nudge them apart vertically (keeping order) and clamp to the plot.
    for (let i = 1; i < found.length; i++) {
      const gap = found[i].y - found[i - 1].y;
      if (gap < LABEL_MIN_GAP) found[i].y = found[i - 1].y + LABEL_MIN_GAP;
    }
    const overflow = found.length ? found[found.length - 1].y - innerH : 0;
    if (overflow > 0) for (const l of found) l.y -= overflow;
    return found;
  });
</script>

{#snippet keyMark(color, w = 14)}
  <svg class="keysvg" width={w} height="4" viewBox="0 0 {w} 4" aria-hidden="true" focusable="false">
    <line x1="0.5" y1="2" x2={w - 0.5} y2="2" stroke={color} stroke-width="2" stroke-linecap="round" />
  </svg>
{/snippet}

<div class="chartwrap" bind:this={box} bind:clientWidth={w} class:loading>
  <!-- tabindex is deliberate: the crosshair is keyboard-navigable (arrows move
       between samples, Escape dismisses), which is what makes the values
       reachable without a pointer. -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <svg
    {height} width="100%" viewBox="0 0 {w} {height}" role="img"
    aria-label="Inventory level over time for {series.length} item{series.length === 1 ? '' : 's'}"
    onpointermove={onMove} onpointerleave={onLeave} onkeydown={onKey} tabindex="0"
  >
    <g transform="translate({M.left},{M.top})">
      <!-- recessive gridlines; horizontal only -->
      {#each yTicks as t}
        <line class="gl" x1="0" x2={innerW} y1={t.y} y2={t.y} />
        <text class="ylab" x="-10" y={t.y} dominant-baseline="middle" text-anchor="end">
          {formatNumber(t.v, 2)}
        </text>
      {/each}

      {#each xTicks as t}
        <text class="xlab" x={t.x} y={innerH + 18} text-anchor="middle">{t.label}</text>
      {/each}

      {#if hoverT !== null}
        <line class="crosshair" x1={sx(hoverT)} x2={sx(hoverT)} y1="0" y2={innerH} />
      {/if}

      {#each series as s, i (s.itemid)}
        <path class="line" d={path(i)} stroke={s.color} />
      {/each}

      <!-- markers on the hovered X, ringed in the surface colour so overlapping
           series stay separable -->
      {#if hoverT !== null}
        {#each series as s, i (s.itemid)}
          {@const v = lookup[i].get(hoverT)}
          {#if v !== undefined}
            <circle class="dot" cx={sx(hoverT)} cy={sy(v)} r="5" fill={s.color} />
          {/if}
        {/each}
      {/if}

      {#each endLabels as l}
        <text class="endlab" x={Math.min(l.x + 6, innerW - 2)} y={l.y - 8} text-anchor="end">{l.label}</text>
      {/each}
    </g>
  </svg>

  {#if hoverT !== null && readout.length}
    <div class="tip" style:left="{Math.min(Math.max(sx(hoverT) + M.left + 14, 8), Math.max(8, w - 240))}px">
      <div class="tipwhen">{new Date(hoverT).toLocaleString()}</div>
      {#each readout as r}
        <div class="tiprow">
          {@render keyMark(r.color, 10)}
          <span class="val">{formatNumber(r.v, numberFormat)}</span>
          <span class="nm">{r.label}</span>
        </div>
      {/each}
    </div>
  {/if}
</div>

{#if series.length >= 2}
  <div class="legend">
    {#each series as s (s.itemid)}
      <span class="li">{@render keyMark(s.color)}{s.label}</span>
    {/each}
  </div>
{/if}

<style>
  /* Refetch holds the previous render at reduced opacity — no skeleton, no jump. */
  .chartwrap { position: relative; }
  .chartwrap.loading { opacity: 0.55; transition: opacity 0.15s; }
  svg { display: block; overflow: visible; outline: none; }
  svg:focus-visible { outline: 1px solid var(--accent-border); outline-offset: 2px; }

  .gl { stroke: #1e2740; stroke-width: 1; }
  .ylab, .xlab { fill: var(--text-mut); font-size: 10.5px; font-family: var(--mono); }
  .endlab { fill: var(--text-dim); font-size: 11px; }
  .crosshair { stroke: #3b4a6b; stroke-width: 1; stroke-dasharray: 3 3; }
  .line { fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .dot { stroke: var(--card); stroke-width: 2; }

  .tip {
    position: absolute; top: 8px; z-index: 5; pointer-events: none;
    background: #0c1119; border: 1px solid var(--border-2); border-radius: 7px;
    padding: 7px 9px; min-width: 150px; max-width: 240px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  }
  .tipwhen { color: var(--text-mut); font-size: 10.5px; font-family: var(--mono); margin-bottom: 4px; }
  .tiprow { display: flex; align-items: baseline; gap: 7px; font-size: 12px; line-height: 1.55; }
  /* Line key, not a filled box: at tooltip density a box is data-weight ink. */
  .keysvg { flex: none; overflow: visible; }
  /* Value leads, label follows — the reader already has the series. */
  .tiprow .val { color: var(--text); font-family: var(--mono); font-weight: 500; }
  .tiprow .nm { color: var(--text-mut); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .legend { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 10px; padding-left: 68px; }
  .li { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; color: var(--text-dim); }

  @media (max-width: 720px) {
    .legend { padding-left: 0; }
  }
</style>
