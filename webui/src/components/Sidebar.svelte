<script>
  import Icon from './Icon.svelte';
  import { activeView } from '../lib/stores.js';
  let { onSettings, onSelect } = $props();

  const nav = [
    { id: 'items', icon: 'grid', label: 'Items' },
    { id: 'crafting', icon: 'tools', label: 'Crafting' },
    { id: 'maintain', icon: 'gauge', label: 'Maintain' },
    { id: 'history', icon: 'history', label: 'History' },
    { id: 'trends', icon: 'chart', label: 'Trends' },
  ];
</script>

<nav class="rail" aria-label="Views">
  {#each nav as n}
    <button
      class="tab {$activeView === n.id ? 'active' : ''}"
      onclick={() => onSelect(n.id)}
      title={n.label} aria-label={n.label} aria-current={$activeView === n.id}
    >
      <Icon name={n.icon} size={21} />
      <span class="lbl">{n.label}</span>
    </button>
  {/each}
  <button class="tab settings" onclick={onSettings} title="Settings" aria-label="Settings">
    <Icon name="settings" size={21} />
    <span class="lbl">Settings</span>
  </button>
</nav>

<style>
  .rail {
    flex: none;
    background: var(--rail);
    border-right: 1px solid var(--border);
    display: flex; flex-direction: column; gap: 4px;
    padding: 10px 8px;
    width: 76px;
  }
  .tab {
    background: transparent; border: 1px solid transparent; color: var(--text-mut);
    width: 100%; flex-direction: column; gap: 4px; padding: 9px 4px;
    border-radius: 10px;
  }
  .tab .lbl { font-size: 11px; }
  .tab:hover { background: var(--card-hover); color: var(--text-dim); border-color: transparent; }
  .tab.active { background: #1c2537; border-color: var(--border-3); color: var(--accent); }
  .settings { margin-top: auto; }

  @media (max-width: 720px) {
    .rail {
      width: 100%; flex-direction: row; padding: 6px 8px;
      border-right: none; border-top: 1px solid var(--border);
      position: sticky; bottom: 0; z-index: 30;
      order: 3;
    }
    .tab { flex: 1; padding: 7px 4px; }
    .settings { margin-top: 0; }
  }
</style>
