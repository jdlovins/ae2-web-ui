<script>
  import GridSelector from './GridSelector.svelte';
  import Icon from './Icon.svelte';
  import { logout } from '../lib/api.js';

  let { onSelect, busyCount = 0, connected = true } = $props();
  const username = window.__AE2__?.username || 'Admin';
</script>

<header class="topbar">
  <div class="brand">
    <Icon name="cpu" size={22} />
    <span class="title">ME Terminal</span>
  </div>

  <GridSelector {onSelect} />

  <div class="spacer"></div>

  <div class="status" title={connected ? 'Connected' : 'Reconnecting…'}>
    <span class="dot {connected ? 'ok' : 'bad'}"></span>
    {#if busyCount > 0}
      <span class="busy"><Icon name="loader" size={14} spin /> {busyCount} crafting</span>
    {:else}
      <span class="idle">idle</span>
    {/if}
  </div>

  <div class="user">
    <Icon name="user" size={16} />
    <span class="uname">{username}</span>
    <button class="ghost logout" onclick={logout} title="Log out" aria-label="Log out">
      <Icon name="logout" size={17} />
    </button>
  </div>
</header>

<style>
  .topbar {
    flex: none;
    display: flex; align-items: center; gap: 12px;
    padding: 10px 14px;
    background: var(--panel); border-bottom: 1px solid var(--border);
  }
  .brand { display: flex; align-items: center; gap: 9px; color: var(--accent); }
  .brand .title { font-weight: 500; letter-spacing: 0.3px; }
  .spacer { flex: 1; }
  .status { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--text-mut); }
  .dot { width: 8px; height: 8px; border-radius: 50%; }
  .dot.ok { background: var(--good); }
  .dot.bad { background: var(--warn); }
  .busy { color: var(--accent); display: inline-flex; align-items: center; gap: 5px; }
  .user { display: flex; align-items: center; gap: 7px; color: var(--text-dim); font-size: 13px; }
  .logout { padding: 5px; }

  @media (max-width: 720px) {
    .brand .title { display: none; }
    .status .idle, .uname { display: none; }
    /* The bar was wrapping onto a second row, costing 36px on every view. */
    .topbar { padding: 6px 10px; gap: 8px; }
  }
</style>
