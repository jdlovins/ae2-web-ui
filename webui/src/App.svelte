<script>
  import { api, ApiError, hasCredentials } from './lib/api.js';
  import { grids, selectedGrid, settings, cpuList, orderTarget, activeView, toast } from './lib/stores.js';
  import { get } from 'svelte/store';
  import TopBar from './components/TopBar.svelte';
  import Sidebar from './components/Sidebar.svelte';
  import ItemsView from './components/ItemsView.svelte';
  import CraftingView from './components/CraftingView.svelte';
  import HistoryView from './components/HistoryView.svelte';
  import TrendsView from './components/TrendsView.svelte';
  import OrderDialog from './components/OrderDialog.svelte';
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
      const def = real.find((g) => g.key === get(settings).defaultGrid);
      const pick = def || real[0];
      selectedGrid.set(pick ? String(pick.key) : null);
    }
  }

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

  // Poll CPU list for the busy indicator + crafting view.
  $effect(() => {
    if (!authed) return;
    $selectedGrid; // re-run when grid changes
    refreshCpus();
    const t = setInterval(refreshCpus, 10000);
    return () => clearInterval(t);
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
      <Sidebar onSettings={() => (settingsOpen = true)} />
      <main>
        {#if $activeView === 'items'}
          <ItemsView />
        {:else if $activeView === 'crafting'}
          <CraftingView />
        {:else if $activeView === 'history'}
          <HistoryView />
        {:else}
          <TrendsView />
        {/if}
      </main>
    </div>
  </div>

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
