<script module>
  // Curated line-icon set (Tabler-style), inlined so the build stays
  // fully self-contained — no icon-font CDN dependency in production.
  export const PATHS = {
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.34 5.66"/><path d="M20 4v7h-7"/>',
    box: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5"/><path d="M12 12v9"/>',
    droplet: '<path d="M12 3s6 6.4 6 10.5a6 6 0 0 1-12 0C6 9.4 12 3 12 3z"/>',
    cpu: '<rect x="7" y="7" width="10" height="10" rx="1"/><rect x="10.5" y="10.5" width="3" height="3"/><path d="M10 4v2M14 4v2M10 18v2M14 18v2M4 10h2M4 14h2M18 10h2M18 14h2"/>',
    hammer: '<path d="M14.5 3.5l6 6-3 3-6-6z"/><path d="M12.5 5.5l-8.5 8.5 3.5 3.5 8.5-8.5"/>',
    tools: '<path d="M7 10L4 7a3 3 0 0 1 4-4l3 3"/><path d="M13 14l6 6M17 20l3-3M11 12l7-7"/>',
    history: '<path d="M4 12a8 8 0 1 0 8-8 8 8 0 0 0-7 4"/><path d="M5 4v4h4"/><path d="M12 8v4.5l3 1.7"/>',
    grid: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
    settings: '<path d="M4 7h9M4 12h4M4 17h11"/><circle cx="17" cy="7" r="2.4"/><circle cx="11" cy="12" r="2.4"/><circle cx="18" cy="17" r="2.4"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    chevron: '<path d="M6 9l6 6 6-6"/>',
    left: '<path d="M15 6l-6 6 6 6"/>',
    sort: '<path d="M7 4v16M7 4L4 7.5M7 4l3 3.5M17 20V4M17 20l-3-3.5M17 20l3-3.5"/>',
    filter: '<path d="M4 5h16l-6 8v6l-4-2v-4z"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-6.5 8-6.5s8 2.5 8 6.5"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    loader: '<path d="M12 3v3M12 18v3M4.9 4.9l2.1 2.1M16.95 16.95l2.15 2.15M3 12h3M18 12h3M4.9 19.1l2.1-2.1M16.95 7.05l2.15-2.15"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    alert: '<path d="M12 4L2.5 20.5h19z"/><path d="M12 10v4.5M12 18h.01"/>',
    trash: '<path d="M5 7h14M9 7V5h6v2M6.5 7l1 13h9l1-13"/>',
    logout: '<path d="M14 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-2"/><path d="M9 12h11M17 9l3 3-3 3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    chart: '<path d="M4 4v16h16"/><path d="M8 16v-4M12 16V8M16 16v-6"/>',
    bolt: '<path d="M13 3L4 14h6l-1 7 9-11h-6z"/>',
    network: '<circle cx="12" cy="5" r="2.2"/><circle cx="5" cy="19" r="2.2"/><circle cx="19" cy="19" r="2.2"/><path d="M12 7.2V12M12 12L6.2 17.2M12 12l5.8 5.2"/>',
    stack: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
    clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4.5l3 1.7"/>',
    dot: '<circle cx="12" cy="12" r="3.5"/>',
  };
</script>

<script>
  let { name, size = 18, stroke = 1.9, spin = false, title = '' } = $props();
  const d = $derived(PATHS[name] || '');
</script>

<svg
  class="ic {spin ? 'spin' : ''}"
  width={size} height={size} viewBox="0 0 24 24"
  fill="none" stroke="currentColor" stroke-width={stroke}
  stroke-linecap="round" stroke-linejoin="round"
  role={title ? 'img' : 'presentation'} aria-label={title || undefined} aria-hidden={title ? undefined : 'true'}
>{@html title ? `<title>${title}</title>${d}` : d}</svg>

<style>
  .ic { flex: none; display: inline-block; vertical-align: -0.18em; }
  .spin { animation: sp 0.9s linear infinite; transform-origin: 50% 50%; }
  @keyframes sp { to { transform: rotate(360deg); } }
</style>
