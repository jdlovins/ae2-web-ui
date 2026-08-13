<script>
  import { settings } from '../lib/stores.js';
  import { logout } from '../lib/api.js';
  import Icon from './Icon.svelte';

  let { onClose } = $props();

  const NUMBER_FORMATS = [
    { v: 0, label: 'Local' },
    { v: 1, label: 'EN-US (1,234)' },
    { v: 2, label: 'Compact (1.2K)' },
    { v: 3, label: 'Scientific' },
    { v: 4, label: 'Raw' },
  ];

  function key(e) { if (e.key === 'Escape') onClose?.(); }

  // Press must both start and end on the backdrop — see Modal.svelte for why a
  // bare onclick closes the panel when a drag ends outside it.
  let pressedOnBackdrop = false;
  const down = (e) => { pressedOnBackdrop = e.target === e.currentTarget; };
  const click = (e) => { if (pressedOnBackdrop && e.target === e.currentTarget) onClose?.(); };
</script>

<svelte:window onkeydown={key} />

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions a11y_no_noninteractive_element_interactions -->
<div class="backdrop" onpointerdown={down} onclick={click} role="presentation">
  <div class="drawer" onclick={(e) => e.stopPropagation()} role="dialog" tabindex="-1" aria-label="Settings">
    <div class="head">
      <h2>Settings</h2>
      <button class="ghost" onclick={onClose} aria-label="Close"><Icon name="x" size={19} /></button>
    </div>

    <div class="body">
      <label class="field">
        <span>Number format</span>
        <select value={$settings.numberFormat} onchange={(e) => settings.update((s) => ({ ...s, numberFormat: Number(e.currentTarget.value) }))}>
          {#each NUMBER_FORMATS as f}<option value={f.v}>{f.label}</option>{/each}
        </select>
      </label>

      <label class="toggle">
        <input type="checkbox" checked={$settings.showIcons} onchange={(e) => settings.update((s) => ({ ...s, showIcons: e.currentTarget.checked }))} />
        <span>Show item icons</span>
      </label>

      <label class="toggle">
        <input type="checkbox" checked={$settings.showItemId} onchange={(e) => settings.update((s) => ({ ...s, showItemId: e.currentTarget.checked }))} />
        <span>Show item IDs</span>
      </label>

      <label class="toggle">
        <input type="checkbox" checked={$settings.autoRefresh} onchange={(e) => settings.update((s) => ({ ...s, autoRefresh: e.currentTarget.checked }))} />
        <span>Auto-refresh current view</span>
      </label>

      <div class="sep"></div>

      <button class="danger" onclick={logout}><Icon name="logout" size={15} /> Log out</button>

      <div class="about">
        <a href="https://github.com/kuba6000/AE2-Web-Integration" target="_blank" rel="noreferrer">AE2 Web Integration</a>
        {#if window.__AE2__?.isOutdated}<div class="upd"><Icon name="alert" size={13} /> A mod update is available.</div>{/if}
      </div>
    </div>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; z-index: 65; background: rgba(4,6,12,0.55); display: flex; justify-content: flex-end; }
  .drawer { width: min(360px, 92vw); height: 100%; background: var(--panel); border-left: 1px solid var(--border-2); display: flex; flex-direction: column; box-shadow: -12px 0 40px rgba(0,0,0,0.5); }
  .head { flex: none; display: flex; align-items: center; justify-content: space-between; padding: 13px 16px; border-bottom: 1px solid var(--border); }
  .head h2 { margin: 0; font-size: 16px; font-weight: 500; }
  .body { padding: 16px; display: flex; flex-direction: column; gap: 12px; overflow: auto; }
  .field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--text-dim); }
  .field select { width: 100%; }
  .toggle { display: flex; align-items: center; gap: 10px; font-size: 14px; cursor: pointer; }
  .toggle input { width: 16px; height: 16px; accent-color: var(--accent); }
  .sep { height: 1px; background: var(--border); margin: 4px 0; }
  .about { margin-top: 12px; font-size: 12.5px; color: var(--text-mut); display: flex; flex-direction: column; gap: 8px; }
  .upd { display: flex; align-items: center; gap: 6px; color: var(--warn); }
</style>
