<script>
  import ItemIcon from './ItemIcon.svelte';
  import McText from './McText.svelte';
  import Icon from './Icon.svelte';
  import { formatNumber, stripMc } from '../lib/format.js';

  let { item, showId = false, showIcon = true, numberFormat = 1, onOrder } = $props();
</script>

<div class="card {item.craftable ? 'craftable' : ''}">
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
    height: 128px; overflow: hidden;
  }
  .card:hover { border-color: var(--border-3); }
  .top { display: flex; gap: 9px; align-items: flex-start; min-width: 0; }
  .info { min-width: 0; flex: 1; }
  .name { font-size: 13px; font-weight: 500; line-height: 1.28; overflow: hidden; overflow-wrap: anywhere; }
  .name.clamp2 { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; }
  .name.clamp1 { white-space: nowrap; text-overflow: ellipsis; }
  .id { font-size: 10.5px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); margin-top: 2px; }
  .qty { margin-top: auto; font-size: 16px; color: var(--text); }
  .order { width: 100%; justify-content: center; padding: 5px; font-size: 12px; margin-top: 0; }
</style>
