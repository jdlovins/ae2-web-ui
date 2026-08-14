<script>
  // Copies a link to whatever is on screen. The URL is already kept in sync, so
  // this is a convenience over reaching for the address bar — and on a phone,
  // where there may not be a visible address bar at all, it's the only way.
  import { shareUrl, copyText } from '../lib/router.js';
  import { toast } from '../lib/stores.js';
  import Icon from './Icon.svelte';

  let { label = 'Copy link', compact = false } = $props();

  let done = $state(false);
  let timer;

  async function copy() {
    const ok = await copyText(shareUrl());
    if (!ok) {
      // Both clipboard paths can be refused (permissions, or a browser that has
      // dropped execCommand). Saying so beats a button that silently does nothing.
      toast('Could not copy — select the address bar instead.');
      return;
    }
    done = true;
    clearTimeout(timer);
    timer = setTimeout(() => (done = false), 1800);
  }
</script>

<button class="ghost copy" onclick={copy} title={label} aria-label={label}>
  <Icon name={done ? 'check' : 'link'} size={15} />
  {#if !compact}<span class="lbl">{done ? 'Copied' : label}</span>{/if}
</button>

<style>
  .copy { font-size: 12.5px; padding: 6px 9px; color: var(--text-mut); }
  .copy:hover { color: var(--text-dim); }
  .lbl { white-space: nowrap; }
  @media (max-width: 720px) {
    .lbl { display: none; }
  }
</style>
