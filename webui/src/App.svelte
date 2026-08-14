<script>
  import { api, ApiError, hasCredentials } from './lib/api.js';
  import { grids, selectedGrid, settings, cpuList, orderTarget, detailTarget, activeView, toast } from './lib/stores.js';
  import { pollVisible } from './lib/poll.js';
  import { current, setView, setGrid, startRouter, routeEpoch, updateParams } from './lib/router.js';
  import { get } from 'svelte/store';
  import TopBar from './components/TopBar.svelte';
  import Sidebar from './components/Sidebar.svelte';
  import ItemsView from './components/ItemsView.svelte';
  import CraftingView from './components/CraftingView.svelte';
  import MaintainView from './components/MaintainView.svelte';
  import HistoryView from './components/HistoryView.svelte';
  import TrendsView from './components/TrendsView.svelte';
  import OrderDialog from './components/OrderDialog.svelte';
  import ItemDetail from './components/ItemDetail.svelte';
  import SettingsPanel from './components/SettingsPanel.svelte';
  import LoginGate from './components/LoginGate.svelte';
  import Toasts from './components/Toasts.svelte';

  let settingsOpen = $state(false);
  let authed = $state(false);
  let booting = $state(true);
  let connected = $state(true);

  const busyCount = $derived(Object.values($cpuList).filter((c) => c.isBusy || c.finalOutput).length);

  async function loadGrids() {
    const list = await api.grids();
    grids.set(list);
    const real = list.filter((g) => g.key !== -1);
    if (get(selectedGrid) == null || !real.some((g) => String(g.key) === String(get(selectedGrid)))) {
      // A link's grid outranks the saved default — otherwise opening someone
      // else's link would silently show them YOUR network. Only honoured if the
      // grid actually exists here.
      const linked = current().params.get('grid');
      const fromUrl = linked && real.find((g) => String(g.key) === String(linked));
      const def = real.find((g) => g.key === get(settings).defaultGrid);
      const pick = fromUrl || def || real[0];
      selectedGrid.set(pick ? String(pick.key) : null);
    }
  }

  // URL -> state. Runs after boot (the grid has to be checked against the real
  // list) and again whenever the URL changes from outside: back/forward, or a
  // link pasted into the same tab. Views seed their own params off routeEpoch.
  function applyRoute() {
    const { view, params } = current();
    if (view) activeView.set(view);
    const g = params.get('grid');
    if (g && get(grids).some((x) => String(x.key) === String(g))) selectedGrid.set(String(g));
    // `detail`, not `item`: Trends uses repeated item= params for its series,
    // and reusing the name made landing on a chart link open the detail panel
    // AND collapse the series list to one entry.
    const detail = params.get('detail');
    detailTarget.set(detail ? { itemid: detail, item: null } : null);
  }

  // state -> URL. Each of these fires on any change, including the ones
  // applyRoute() just made, so each is guarded by "did the value actually
  // change" and the writers themselves no-op when the URL already says this.
  // Two independent brakes, because a routing loop is silent and miserable.
  //
  // setView keeps `grid` and drops the outgoing view's params — and returns
  // early when the URL already names this view, so applying a link can't wipe
  // the params that link exists to carry.
  // Clearing the outgoing view's params must happen BEFORE the incoming view
  // mounts, or that view's own first write gets wiped a moment later — which is
  // exactly what swallowed the auto-selected CPU on arrival. The nav calls this
  // directly; the effect below is the safety net for programmatic changes (the
  // order dialog jumps to Crafting on submit).
  function onSelectView(view) {
    setView(view);
    activeView.set(view);
  }

  let lastView;
  $effect(() => {
    const v = $activeView;
    if (!authed || v === lastView) return;
    lastView = v;
    setView(v);
  });

  let lastGrid;
  $effect(() => {
    const g = $selectedGrid;
    if (!authed || g === lastGrid) return;
    lastGrid = g;
    if (g != null) setGrid(g);
  });

  let lastDetail;
  $effect(() => {
    const id = $detailTarget?.itemid ?? null;
    if (!authed || id === lastDetail) return;
    lastDetail = id;
    // Closing it drops the panel's own params too, so a stale range/band can't
    // leak onto the next item opened.
    updateParams(id ? { detail: id } : { detail: null, drange: null, dband: null });
  });

  $effect(() => startRouter());
  $effect(() => { $routeEpoch; if (authed) applyRoute(); });

  // A cached password is meant to be permanent, so the login screen is only for
  // when we genuinely have no usable credentials. The mod restarting must never
  // prompt for a password we already have — we sit in a reconnecting state and
  // keep retrying instead.
  let bootRetry;
  async function boot() {
    booting = true;
    clearTimeout(bootRetry);
    try {
      await loadGrids();
      authed = true;
      connected = true;
      // Only now: the URL's grid had to be checked against the real list. This
      // is also what makes a shared link survive the login screen — signing in
      // never navigates, so the hash is still sitting there when boot re-runs.
      applyRoute();
    } catch (e) {
      const status = e instanceof ApiError ? e.status : null;
      if (status === 'UNAUTHORIZED') {
        authed = false; // credentials rejected (or none) -> ask the user
      } else if (status === 'OFFLINE' && hasCredentials()) {
        authed = true; // stay in the app; TopBar shows "Reconnecting…"
        connected = false;
        bootRetry = setTimeout(boot, 5000);
      } else if (status === 'OFFLINE') {
        authed = false;
      } else {
        authed = true;
        toast(e.message);
      }
    } finally {
      booting = false;
    }
  }

  async function refreshCpus() {
    const grid = get(selectedGrid);
    if (grid == null) { cpuList.set({}); return; }
    try {
      cpuList.set(await api.cpuList(grid));
      connected = true;
    } catch (e) {
      connected = false;
      // OFFLINE means the mod is away, not that we lost our credentials.
      if (e instanceof ApiError && e.status === 'UNAUTHORIZED') authed = false;
    }
  }

  // Poll CPU list for the busy indicator + crafting view. Pauses while the tab
  // is hidden — /list runs on the Minecraft server tick.
  $effect(() => {
    if (!authed) return;
    $selectedGrid; // re-run when grid changes
    refreshCpus();
    return pollVisible(refreshCpus, 10000);
  });

  function onSelectGrid(key) {
    selectedGrid.set(key);
  }

  boot();
</script>

<svelte:head><title>ME Terminal</title></svelte:head>

{#if booting}
  <div class="boot"></div>
{:else if !authed}
  <LoginGate onSuccess={boot} />
{:else}
  <div class="app">
    <TopBar onSelect={onSelectGrid} {busyCount} {connected} />
    <div class="body">
      <Sidebar onSettings={() => (settingsOpen = true)} onSelect={onSelectView} />
      <main>
        {#if $activeView === 'items'}
          <ItemsView />
        {:else if $activeView === 'crafting'}
          <CraftingView />
        {:else if $activeView === 'maintain'}
          <MaintainView />
        {:else if $activeView === 'history'}
          <HistoryView />
        {:else}
          <TrendsView />
        {/if}
      </main>
    </div>
  </div>

  <!-- Before OrderDialog on purpose: both sit at the same z-index, so the one
       mounted later paints on top — and Craft opens the order dialog from here. -->
  {#if $detailTarget}
    <ItemDetail itemid={$detailTarget.itemid} item={$detailTarget.item} />
  {/if}
  {#if $orderTarget}
    <OrderDialog item={$orderTarget} />
  {/if}
  {#if settingsOpen}
    <SettingsPanel onClose={() => (settingsOpen = false)} />
  {/if}
{/if}

<Toasts />

<style>
  .app { height: 100%; display: flex; flex-direction: column; min-height: 0; }
  .body { flex: 1; display: flex; min-height: 0; }
  main { flex: 1; min-width: 0; min-height: 0; display: flex; }
  main :global(> *) { flex: 1; min-width: 0; }
  .boot { height: 100%; background: var(--bg); }
  @media (max-width: 720px) {
    .body { flex-direction: column; }
  }
</style>
