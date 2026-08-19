<script>
  import { untrack } from 'svelte';
  import { personalGroups, sharedGroups, SCOPES } from '../lib/trendgroups.js';
  import { selectedGrid, settings, toast } from '../lib/stores.js';
  import Icon from './Icon.svelte';
  import ItemIcon from './ItemIcon.svelte';
  import McText from './McText.svelte';
  import Modal from './Modal.svelte';

  // `members` is the current chart selection; `personal`/`shared` are the
  // existing groups, needed only to warn that a name is about to be overwritten.
  let {
    members,
    personal = [],
    shared = [],
    scope: initialScope = 'personal',
    name: initialName = '',
    mode: initialMode = 'chart',
    cap = 8,
    onClose,
    onSaved,
  } = $props();

  // Seeded once, untracked, for the same reason RuleDialog does it: these fields
  // must not snap back while they are being typed in.
  let name = $state(untrack(() => initialName));
  let scope = $state(untrack(() => initialScope));
  // Seeded from the view you are looking at, which is almost always the one you
  // want the group to open in — you built the selection while looking at it.
  let mode = $state(untrack(() => initialMode));
  let saving = $state(false);

  const clean = $derived(name.trim());
  const valid = $derived(!!clean && clean.length <= 60 && members.length > 0);

  // Saving under a name that already exists edits that group — the same rule on
  // both halves. Say so before the click rather than after, since from the
  // strip the two outcomes look identical.
  const existing = $derived(
    (scope === 'shared' ? shared : personal).find((g) => g.name.toLowerCase() === clean.toLowerCase()) || null,
  );

  async function save() {
    if (!valid || saving) return;
    saving = true;
    try {
      if (scope === 'shared') await sharedGroups.save($selectedGrid, clean, members, mode);
      else personalGroups.save($selectedGrid, clean, members, mode, cap);
      onSaved?.(scope);
    } catch (e) {
      toast(e.message);
    } finally {
      saving = false;
    }
  }

  // Enter saves, since this dialog is one field and two buttons.
  const key = (e) => { if (e.key === 'Enter' && valid) save(); };

  // The `autofocus` attribute does not fire for an element mounted after the
  // document has loaded, which is every time this dialog opens — focus has to
  // be moved explicitly. Selected, not just focused: the field is prefilled
  // when saving over an existing group, and typing should replace that name
  // rather than append to it.
  //
  // The name read is untracked: this effect must run when the field mounts and
  // never again, or every keystroke would re-select what had just been typed.
  let field = $state(null);
  $effect(() => {
    const el = field;
    if (!el) return;
    untrack(() => {
      el.focus();
      if (name) el.select();
    });
  });
</script>

<Modal title={initialName ? 'Save group' : 'New group'} {onClose}>
  <label class="fl" for="gd-name">Name</label>
  <input
    id="gd-name"
    bind:this={field}
    bind:value={name}
    onkeydown={key}
    placeholder="e.g. Ore inputs"
    autocomplete="off"
    maxlength="60"
  />

  <div class="scopes" role="group" aria-label="Where to save">
    {#each SCOPES as s}
      <button
        class="scope {scope === s.id ? 'on' : ''}"
        onclick={() => (scope = s.id)}
        aria-pressed={scope === s.id}
      >
        <Icon name={s.icon} size={15} />
        <span class="slab">{s.label}</span>
        <span class="shint">{s.hint}</span>
      </button>
    {/each}
  </div>

  <div class="opens">
    <span class="ol">Opens as</span>
    <div class="oseg" role="group" aria-label="View this group opens in">
      <button class={mode === 'chart' ? 'on' : ''} onclick={() => (mode = 'chart')} aria-pressed={mode === 'chart'}>
        <Icon name="chart" size={14} /> Chart
      </button>
      <button class={mode === 'change' ? 'on' : ''} onclick={() => (mode = 'change')} aria-pressed={mode === 'change'}>
        <Icon name="grid" size={14} /> Change
      </button>
    </div>
  </div>

  {#if existing}
    <p class="mut hint">
      <Icon name="alert" size={13} />
      Replaces the {scope === 'shared' ? 'shared' : 'personal'} group
      <strong>{existing.name}</strong> ({existing.items?.length ?? 0} items).
    </p>
  {/if}

  <div class="members">
    <div class="mhead">{members.length} {members.length === 1 ? 'item' : 'items'}</div>
    <ul>
      {#each members as m (m.itemid)}
        <li>
          <ItemIcon item={m} size={20} enabled={$settings.showIcons} />
          <span class="mname"><McText name={m.itemname} /></span>
        </li>
      {/each}
    </ul>
  </div>

  <div class="actions">
    <span class="spacer"></span>
    <button onclick={onClose}>Cancel</button>
    <button class="accent" disabled={!valid || saving} onclick={save}>
      {saving ? 'Saving…' : existing ? 'Replace' : 'Save group'}
    </button>
  </div>
</Modal>

<style>
  .fl { display: block; font-size: 12px; color: var(--text-dim); margin: 0 0 4px; }
  input { width: 100%; }
  .mut { color: var(--text-mut); font-size: 12.5px; }
  .hint { display: flex; align-items: center; gap: 6px; line-height: 1.5; margin: 10px 0 0; }
  .spacer { margin-left: auto; }

  .scopes { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px; }
  .scope {
    display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
    padding: 9px 11px; text-align: left; background: var(--card); border-color: var(--border);
  }
  .scope.on { background: var(--accent-dim); border-color: var(--accent-border); color: var(--accent); }
  .slab { font-size: 13px; }
  .shint { font-size: 11px; color: var(--text-mut); line-height: 1.35; }
  .scope.on .shint { color: var(--accent); opacity: 0.75; }

  .opens { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
  .ol { font-size: 12px; color: var(--text-dim); }
  .oseg { display: flex; gap: 4px; }
  .oseg button { font-size: 12px; padding: 6px 10px; }
  .oseg button.on { background: var(--accent-dim); border-color: var(--accent-border); color: var(--accent); }

  .members { margin-top: 13px; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
  .mhead { padding: 6px 10px; background: var(--panel-2); font-size: 11.5px; color: var(--text-mut); border-bottom: 1px solid var(--border); }
  .members ul { list-style: none; margin: 0; padding: 6px; display: flex; flex-direction: column; gap: 3px; max-height: 190px; overflow: auto; }
  .members li { display: flex; align-items: center; gap: 8px; padding: 3px 4px; font-size: 12.5px; }
  .mname { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .actions { display: flex; align-items: center; gap: 8px; margin-top: 16px; }

  @media (max-width: 480px) {
    .scopes { grid-template-columns: 1fr; }
  }
</style>
