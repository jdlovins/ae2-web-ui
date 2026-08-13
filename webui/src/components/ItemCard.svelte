<script>
  import ItemIcon from './ItemIcon.svelte';
  import McText from './McText.svelte';
  import Icon from './Icon.svelte';
  import { formatNumber, stripMc } from '../lib/format.js';

  let { item, showId = false, showIcon = true, numberFormat = 1, onOrder, onOpen } = $props();
</script>

<div class="card {item.craftable ? 'craftable' : ''}">
  <!-- A stretched transparent button rather than making the card itself a
       button: the card already contains the Craft button, and nesting
       interactive elements is invalid and breaks keyboard semantics. This gives
       the whole surface a pointer target and its own tab stop, while Craft keeps
       its own (it sits above this via z-index). -->
  <button class="hit" onclick={() => onOpen?.(item)} aria-label="Details for {stripMc(item.itemname)}"></button>
  <div class="top">
    {#if showIcon}<ItemIcon {item} size={36} enabled={showIcon} />{/if}
    <div class="info">
      <div class="name {showId ? 'clamp1' : 'clamp2'}" title={stripMc(item.itemname)}><McText name={item.itemname} /></div>
      {#if showId}<div class="id" title={item.itemid}>{item.itemid}</div>{/if}
    </div>
  </div>
  <div class="qty mono">{formatNumber(item.quantity, numberFormat)}</div>
  {#if item.craftable}
    <button class="accent order" onclick={() => onOrder?.(item)}>
      <Icon name="hammer" size={14} /> Craft
    </button>
  {/if}
</div>

<style>
  .card {
    background: var(--card); border: 1px solid var(--border-2); border-radius: var(--radius-lg);
    padding: 10px 11px; display: flex; flex-direction: column; gap: 6px; min-width: 0;
    height: 128px; overflow: hidden; position: relative;
  }
  .card:hover { border-color: var(--border-3); background: var(--card-hover); }
  .hit {
    position: absolute; inset: 0; z-index: 0;
    background: none; border: 0; padding: 0; border-radius: var(--radius-lg);
  }
  .hit:hover { background: none; }
  .hit:focus-visible { outline: 1px solid var(--border-3); outline-offset: -2px; }
  /* Let clicks fall through the display layers to the hit area beneath them. */
  .top, .qty { pointer-events: none; }
  .top { display: flex; gap: 9px; align-items: flex-start; min-width: 0; }
  .info { min-width: 0; flex: 1; }
  .name { font-size: 13px; font-weight: 500; line-height: 1.28; overflow: hidden; overflow-wrap: anywhere; }
  .name.clamp2 { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; }
  .name.clamp1 { white-space: nowrap; text-overflow: ellipsis; }
  .id { font-size: 10.5px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); margin-top: 2px; }
  .qty { margin-top: auto; font-size: 16px; color: var(--text); }
  .order { width: 100%; justify-content: center; padding: 5px; font-size: 12px; margin-top: 0; position: relative; z-index: 1; }
</style>
