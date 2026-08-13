<script>
  import { untrack } from 'svelte';
  import { maintain } from '../lib/maintain.js';
  import { selectedGrid, settings, toast } from '../lib/stores.js';
  import { formatNumber, parseQuantity, stripMc } from '../lib/format.js';
  import Icon from './Icon.svelte';
  import ItemIcon from './ItemIcon.svelte';
  import McText from './McText.svelte';
  import Modal from './Modal.svelte';

  let { draft, items, onClose, onSaved } = $props();

  // The dialog edits a copy, taken once when it opens. Untracked deliberately:
  // these fields must NOT snap back to the rule while you are typing in them,
  // and the dialog is unmounted between edits, so there is nothing to sync.
  const seed = untrack(() => ({ ...draft }));
  let itemid = $state(seed.itemid);
  let itemname = $state(seed.itemname);
  let targetText = $state(seed.target);
  let batchText = $state(seed.batch);
  let query = $state('');
  let saving = $state(false);

  const target = $derived(parseQuantity(targetText));
  const batch = $derived(parseQuantity(batchText));
  // Distinguish "empty" from "typed something nonsensical": an empty field is
  // just unfinished, and reddening it while the user is still typing is noise.
  const targetBad = $derived(targetText.trim() !== '' && !(target > 0));
  const batchBad = $derived(batchText.trim() !== '' && !(batch > 0));
  const valid = $derived(!!itemid && target > 0 && batch > 0);

  // Only craftable items can be maintained — there is no point tracking a floor
  // for something the network has no pattern for.
  const matches = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return items
      .filter((i) => i.craftable && stripMc(i.itemname).toLowerCase().includes(q))
      .slice(0, 8);
  });

  const chosen = $derived(items.find((i) => i.itemid === itemid) || null);

  function choose(item) {
    itemid = item.itemid;
    itemname = item.itemname;
    query = '';
  }

  async function save() {
    if (!valid || saving) return;
    saving = true;
    try {
      if (draft.id) {
        await maintain.update(draft.id, { target, batch });
      } else {
        await maintain.create($selectedGrid, { itemid, itemname, target, batch });
      }
      onSaved?.();
    } catch (e) {
      toast(e.message);
    } finally {
      saving = false;
    }
  }
</script>

<Modal title={draft.id ? 'Edit rule' : 'Add rule'} {onClose}>
  {#if chosen || itemid}
    <div class="chosen">
      <ItemIcon item={chosen || { itemid }} size={28} enabled={$settings.showIcons} />
      <span class="cname"><McText name={itemname} /></span>
      {#if chosen}
        <span class="mut mono">{formatNumber(chosen.quantity, $settings.numberFormat)} stored</span>
      {/if}
      {#if !draft.id}
        <button class="ghost sm" onclick={() => { itemid = ''; itemname = ''; }} aria-label="Change item"><Icon name="x" size={15} /></button>
      {/if}
    </div>
  {:else}
    <label class="fl" for="rd-item">Item</label>
    <input id="rd-item" bind:value={query} placeholder="Search craftable items" autocomplete="off" />
    {#if query.trim() && !matches.length}
      <p class="mut hint">No craftable item matches. Only items the network has a pattern for can be maintained.</p>
    {/if}
    {#if matches.length}
      <ul class="matches">
        {#each matches as m (m.itemid)}
          <li>
            <button class="mrow" onclick={() => choose(m)}>
              <ItemIcon item={m} size={22} enabled={$settings.showIcons} />
              <span class="mname"><McText name={m.itemname} /></span>
              <span class="mut mono">{formatNumber(m.quantity, $settings.numberFormat)}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}

  <div class="fields">
    <div>
      <label class="fl" for="rd-target">Keep at least</label>
      <input id="rd-target" bind:value={targetText} class={targetBad ? 'bad' : ''} placeholder="128k" autocomplete="off" />
    </div>
    <div>
      <label class="fl" for="rd-batch">Craft in batches of</label>
      <input id="rd-batch" bind:value={batchText} class={batchBad ? 'bad' : ''} placeholder="32k" autocomplete="off" />
    </div>
  </div>

  <p class="mut hint">
    Shorthand works: 1.5k, 2m, 1b. AE2 rounds a request up to whole pattern
    outputs, so a batch usually lands a little above the target — that overshoot
    is what stops the rule firing again on the next check.
  </p>

  <div class="actions">
    <span class="mut">{draft.id ? 'Saving clears any backoff' : ''}</span>
    <span class="spacer"></span>
    <button onclick={onClose}>Cancel</button>
    <button class="accent" disabled={!valid || saving} onclick={save}>{saving ? 'Saving…' : 'Save rule'}</button>
  </div>
</Modal>

<style>
  .fl { display: block; font-size: 12px; color: var(--text-dim); margin: 0 0 4px; }
  input { width: 100%; }
  input.bad { border-color: var(--danger-border); }
  .hint { line-height: 1.6; font-size: 12.5px; margin: 10px 0 0; }
  .mut { color: var(--text-mut); font-size: 12.5px; }
  .mono { font-family: var(--mono); }
  .spacer { margin-left: auto; }

  .chosen {
    display: flex; align-items: center; gap: 9px;
    background: var(--panel-2); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 8px 10px;
  }
  .cname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .matches { list-style: none; margin: 7px 0 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
  .mrow {
    width: 100%; justify-content: flex-start; gap: 9px;
    background: var(--card); border-color: var(--border); text-align: left;
  }
  .mname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .fields { display: grid; grid-template-columns: 1fr 1fr; gap: 11px; margin-top: 13px; }
  .actions { display: flex; align-items: center; gap: 8px; margin-top: 16px; }
  button.sm { padding: 4px 6px; }

  @media (max-width: 480px) {
    .fields { grid-template-columns: 1fr; }
  }
</style>
