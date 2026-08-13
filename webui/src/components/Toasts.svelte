<script>
  import { toasts, dismissToast } from '../lib/stores.js';
  import Icon from './Icon.svelte';
</script>

<div class="wrap" role="status" aria-live="polite">
  {#each $toasts as t (t.id)}
    <button class="toast {t.type}" onclick={() => dismissToast(t.id)} title="Dismiss">
      <Icon name={t.type === 'success' ? 'check' : t.type === 'info' ? 'bolt' : 'alert'} size={16} />
      <span>{t.text}</span>
      <Icon name="x" size={15} />
    </button>
  {/each}
</div>

<style>
  .wrap {
    position: fixed; top: 12px; right: 12px; z-index: 80;
    display: flex; flex-direction: column; gap: 8px; max-width: min(380px, 90vw);
  }
  .toast {
    width: 100%; text-align: left;
    border-radius: var(--radius); padding: 10px 12px;
    display: flex; align-items: center; gap: 10px;
  }
  .toast span { flex: 1; word-break: break-word; }
  .toast.error { background: #2a1717; border: 1px solid var(--danger-border); color: #f0c9c6; }
  .toast.success { background: #14261f; border: 1px solid var(--accent-border); color: #a7f0dc; }
  .toast.info { background: #15233a; border: 1px solid #2f4a78; color: #cfe0ff; }
</style>
