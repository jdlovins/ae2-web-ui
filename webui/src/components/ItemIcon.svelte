<script>
  import Icon from './Icon.svelte';
  import { iconFileName, isFluidId } from '../lib/format.js';

  let { item, size = 34, enabled = true } = $props();

  // Icons are static PNGs served by our container at /icons/<itemid>.png.
  // Generate the pack with `npm run icons` (see icons/README.md). Missing icons
  // fall back to a glyph via <img onerror>.
  const base = (typeof window !== 'undefined' && window.__AE2__?.iconBase) || '/icons';
  const src = $derived(enabled && item?.itemid ? `${base}/${iconFileName(item.itemid)}.png` : null);

  let failed = $state(false);
  $effect(() => { void src; failed = false; }); // reset when the item changes

  const isFluid = $derived(isFluidId(item?.itemid));
</script>

<span class="icon" style:width="{size}px" style:height="{size}px">
  {#if src && !failed}
    <img {src} alt="" width={size} height={size} loading="lazy" onerror={() => (failed = true)} />
  {:else}
    <Icon name={isFluid ? 'droplet' : 'box'} size={Math.round(size * 0.52)} />
  {/if}
</span>

<style>
  .icon {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: #1c2537;
    border: 1px solid var(--border-2);
    border-radius: 8px;
    color: var(--text-mut);
    overflow: hidden;
  }
  .icon img { image-rendering: pixelated; display: block; object-fit: contain; }
</style>
