<script>
  import { formatTime } from '../lib/format.js';
  // rows: [{ label, meta?, spans: [{ start, end, extra?: string[] }] }]
  let { rows = [], color = '#5fe3c9' } = $props();

  const bounds = $derived.by(() => {
    let min = Infinity, max = -Infinity;
    for (const r of rows) for (const s of r.spans) { if (s.start < min) min = s.start; if (s.end > max) max = s.end; }
    if (!isFinite(min)) { min = 0; max = 1; }
    if (max <= min) max = min + 1;
    return { min, max, span: max - min };
  });

  const pct = (t) => ((t - bounds.min) / bounds.span) * 100;
  const rel = (t) => formatTime(t - bounds.min);
  const ticks = $derived([0, 0.25, 0.5, 0.75, 1].map((f) => ({ f, label: formatTime(bounds.span * f) })));

  let hover = $state(null); // { x, y, title?, lines: [] }
  function show(e, s, label) {
    hover = {
      x: e.clientX, y: e.clientY,
      title: label,
      lines: [`+${rel(s.start)} → +${rel(s.end)}`, `Duration ${formatTime(s.end - s.start)}`, ...(s.extra || [])],
    };
  }
  // Lane names are clipped to keep every row one line tall, so hovering the
  // name shows it in full — otherwise a long item name is unreadable.
  function showLabel(e, r) {
    hover = { x: e.clientX, y: e.clientY, title: r.label, lines: r.meta ? [r.meta] : [] };
  }
  const move = (e) => { if (hover) { hover.x = e.clientX; hover.y = e.clientY; } };
  const hide = () => (hover = null);
</script>

<div class="tl">
  <div class="axis top">
    {#each ticks as t}<span class="tick" style:left="{t.f * 100}%">{t.label}</span>{/each}
  </div>
  <div class="grid">
    {#each ticks as t}<span class="gl" style:left="{t.f * 100}%"></span>{/each}
    {#each rows as r}
      <div class="lane">
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="label" onmouseenter={(e) => showLabel(e, r)} onmousemove={move} onmouseleave={hide}>{r.label}</div>
        {#if r.meta}<div class="meta">{r.meta}</div>{/if}
        <div class="track">
          {#each r.spans as s}
            <div
              class="bar"
              style:left="{pct(s.start)}%"
              style:width="{Math.max(0.5, pct(s.end) - pct(s.start))}%"
              style:background={color}
              role="img" aria-label="{r.label}: {formatTime(s.end - s.start)}"
              onmouseenter={(e) => show(e, s, r.label)} onmousemove={move} onmouseleave={hide}
            ></div>
          {/each}
        </div>
      </div>
    {/each}
  </div>
</div>

{#if hover}
  <div class="tip" style:left="{hover.x + 14}px" style:top="{hover.y + 14}px">
    {#if hover.title}<div class="tiptitle">{hover.title}</div>{/if}
    {#each hover.lines as l}<div>{l}</div>{/each}
  </div>
{/if}

<style>
  /* The axis and gridlines must start where the track starts, so derive that
     offset from the label/meta widths rather than repeating it as a literal. */
  .tl {
    position: relative; font-size: 12px;
    --label-w: 230px;
    --meta-w: 64px;
    --lane-gap: 8px;
    --track-x: calc(var(--label-w) + var(--meta-w) + var(--lane-gap) * 2);
  }
  .axis.top { position: relative; height: 16px; margin-left: var(--track-x); margin-bottom: 4px; }
  .tick { position: absolute; transform: translateX(-50%); color: var(--text-mut); font-family: var(--mono); font-size: 10.5px; white-space: nowrap; }
  .tick:first-child { transform: none; }
  .tick:last-child { transform: translateX(-100%); }
  .grid { position: relative; }
  .gl { position: absolute; top: 0; bottom: 0; width: 1px; background: #1e2740; margin-left: var(--track-x); }
  .lane { position: relative; display: flex; align-items: center; gap: var(--lane-gap); height: 24px; }
  .label {
    flex: none; width: var(--label-w); overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; color: var(--text-dim); cursor: default;
  }
  .label:hover { color: var(--text); }
  .meta { flex: none; width: var(--meta-w); text-align: right; color: var(--text-mut); font-family: var(--mono); font-size: 10.5px; }
  .track { position: relative; flex: 1; height: 15px; background: #10182a; border-radius: 4px; overflow: hidden; }
  .bar { position: absolute; top: 2px; height: 11px; border-radius: 3px; opacity: 0.92; cursor: pointer; min-width: 2px; }
  .bar:hover { opacity: 1; outline: 1px solid rgba(255,255,255,0.35); }
  .tip {
    position: fixed; z-index: 90; pointer-events: none;
    background: #0c1119; border: 1px solid var(--border-2); border-radius: 7px; padding: 7px 9px;
    font-size: 11.5px; line-height: 1.5; color: var(--text-dim); box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    max-width: min(420px, 80vw);
  }
  .tip > div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* The name is the point of the tooltip, so let it wrap rather than clip. */
  .tip > .tiptitle { color: var(--text); font-weight: 500; white-space: normal; overflow: visible; overflow-wrap: anywhere; margin-bottom: 2px; }

  @media (max-width: 720px) {
    .tl { --label-w: 120px; --meta-w: 52px; }
  }
</style>
