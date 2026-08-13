<script>
  import { api, ApiError } from '../lib/api.js';
  import { maintain, ruleStatus, noteShortfall } from '../lib/maintain.js';
  import { pollVisible } from '../lib/poll.js';
  import { selectedGrid, cpuList, settings, toast } from '../lib/stores.js';
  import { formatNumber, formatDateTime, stripMc } from '../lib/format.js';
  import Icon from './Icon.svelte';
  import ItemIcon from './ItemIcon.svelte';
  import McText from './McText.svelte';
  import Modal from './Modal.svelte';
  import RuleDialog from './RuleDialog.svelte';

  let rules = $state([]);
  let items = $state([]);
  let maint = $state(null); // gateway's maintainer status; null until loaded
  let loading = $state(true);
  let editing = $state(null); // the rule being edited, or a new draft
  let events = $state(null);  // { rule, list } for the activity popover

  // Quantities come from the same /items the grid view uses, so this costs the
  // mod nothing beyond what is already cached.
  const byId = $derived(new Map(items.map((i) => [i.itemid, i])));

  // Rules, stock and maintainer status in one pass. The status is optional — it
  // only sharpens the chip — so a gateway hiccup must degrade the label, not
  // blank the screen.
  async function pull(grid) {
    const [r, i, m] = await Promise.all([
      maintain.list(grid),
      api.items(grid),
      maintain.status().catch(() => null),
    ]);
    rules = r;
    items = i;
    maint = m;
    noteShortfall(r, new Map(i.map((x) => [x.itemid, x])));
  }

  async function load() {
    const grid = $selectedGrid;
    if (grid == null) { rules = []; items = []; loading = false; return; }
    loading = true;
    try {
      await pull(grid);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 'OFFLINE')) toast(e.message);
    } finally {
      loading = false;
    }
  }

  // Refreshes BOTH rules and stock levels, without touching `loading` so the
  // list doesn't flash on every poll.
  //
  // An earlier version polled only the rules, on the theory that re-pulling the
  // whole item list every few seconds wasn't worth it. That was the wrong call:
  // the stock number and the fill bar are the whole point of this screen, and
  // freezing them made the page look broken until you hit reload. /items is
  // cached by the gateway for 10s and warmed by the collector anyway, so this
  // costs bandwidth, not Minecraft server tick.
  async function refresh() {
    const grid = $selectedGrid;
    if (grid == null) return;
    try {
      await pull(grid);
    } catch { /* transient; the next poll picks it up */ }
  }

  $effect(() => {
    $selectedGrid;
    load();
    return pollVisible(refresh, 10000);
  });

  function newRule() {
    editing = { id: null, itemid: '', itemname: '', target: '', batch: '', enabled: true };
  }

  function edit(rule) {
    editing = {
      id: rule.id,
      itemid: rule.itemid,
      itemname: rule.itemname,
      target: String(rule.target),
      batch: String(rule.batch),
      enabled: rule.enabled,
    };
  }

  async function toggle(rule) {
    try {
      await maintain.update(rule.id, { enabled: !rule.enabled });
      await load();
    } catch (e) { toast(e.message); }
  }

  async function remove(rule) {
    try {
      await maintain.remove(rule.id);
      await load();
    } catch (e) { toast(e.message); }
  }

  async function showEvents(rule) {
    try {
      events = { rule, list: await maintain.events(rule.id) };
    } catch (e) { toast(e.message); }
  }

  // How full the bar is. Capped at 100% because overshoot is normal — AE2
  // rounds a request up to whole pattern outputs, so a batch routinely lands
  // above target and a bar past the end would read as an error.
  function fill(rule, item) {
    if (!item || !rule.target) return 0;
    return Math.min(100, Math.round((item.quantity / rule.target) * 100));
  }

  const TONE_FILL = { good: 'var(--good)', accent: 'var(--accent)', warn: 'var(--warn)', danger: 'var(--danger)', mute: 'var(--border-2)' };

  function retryIn(rule) {
    const ms = new Date(rule.retry_after) - Date.now();
    if (ms <= 0) return '';
    const mins = Math.round(ms / 60000);
    return mins >= 60 ? `${Math.round(mins / 60)}h` : `${mins}m`;
  }
</script>

<div class="wrap">
  <div class="bar">
    <h2>Level maintainer</h2>
    {#if rules.length}
      <span class="mut">{rules.filter((r) => r.enabled).length} of {rules.length} active</span>
    {/if}
    <span class="spacer"></span>
    <button onclick={load} title="Reload"><Icon name="refresh" size={17} /></button>
    <button class="accent" onclick={newRule}><Icon name="plus" size={17} /> Add rule</button>
  </div>

  <p class="policy">
    <Icon name="cpu" size={15} />
    Orders land on an <b>automation only</b> CPU when one is free, otherwise an unrestricted one.
    Player only CPUs are never used.
  </p>

  <div class="list">
    {#if loading}
      <p class="empty">Loading…</p>
    {:else if !rules.length}
      <div class="empty">
        <p>Nothing is being maintained yet.</p>
        <p class="mut">Add a rule to keep an item above a stock floor. It's checked once per collector tick, and orders a fixed batch whenever the level drops below your target.</p>
      </div>
    {:else}
      {#each rules as rule (rule.id)}
        {@const item = byId.get(rule.itemid)}
        {@const st = ruleStatus(rule, item, $cpuList, maint)}
        <div class="rule {rule.enabled ? '' : 'off'}">
          <div class="top">
            <ItemIcon {item} size={26} enabled={$settings.showIcons} />
            <span class="name"><McText name={rule.itemname} /></span>
            <span class="pill {st.tone}">{st.label}</span>
            <span class="qty mono">{item ? formatNumber(item.quantity, $settings.numberFormat) : '—'}</span>
            <span class="mut mono">/ {formatNumber(rule.target, $settings.numberFormat)}</span>
            <button class="ghost sm" onclick={() => toggle(rule)} title={rule.enabled ? 'Pause this rule' : 'Resume this rule'} aria-label={rule.enabled ? 'Pause' : 'Resume'}>
              <Icon name={rule.enabled ? 'pause' : 'play'} size={15} />
            </button>
            <button class="ghost sm" onclick={() => edit(rule)} title="Edit" aria-label="Edit"><Icon name="settings" size={15} /></button>
            <button class="ghost sm" onclick={() => remove(rule)} title="Delete" aria-label="Delete"><Icon name="trash" size={15} /></button>
          </div>
          <div class="track"><i style:width="{fill(rule, item)}%" style:background={TONE_FILL[st.tone]}></i></div>
          <div class="foot">
            <span class="mut">Batch {formatNumber(rule.batch, $settings.numberFormat)}</span>
            {#if st.id === 'crafting'}
              <span class="mut">on {st.cpu}</span>
            {:else if st.id === 'backoff'}
              <span class="danger">{rule.last_error} · retry in {retryIn(rule)}</span>
            {:else if rule.last_ordered_at}
              <span class="mut">last ordered {formatDateTime(new Date(rule.last_ordered_at).getTime())}</span>
            {/if}
            <span class="spacer"></span>
            <button class="ghost sm mut" onclick={() => showEvents(rule)}>Activity</button>
          </div>
        </div>
      {/each}
    {/if}
  </div>
</div>

{#if editing}
  <RuleDialog draft={editing} {items} onClose={() => (editing = null)} onSaved={() => { editing = null; load(); }} />
{/if}

{#if events}
  <Modal title="Activity — {stripMc(events.rule.itemname)}" onClose={() => (events = null)}>
    {#if !events.list.length}
      <p class="mut">Nothing recorded yet.</p>
    {:else}
      <ul class="events">
        {#each events.list as e (e.id)}
          <li>
            <span class="ekind {e.kind}">{e.kind}</span>
            <span class="mut">{formatDateTime(new Date(e.ts).getTime())}</span>
            <span class="edetail">{e.detail || (e.quantity ? `×${formatNumber(e.quantity, $settings.numberFormat)}${e.cpu ? ` on ${e.cpu}` : ''}` : '')}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </Modal>
{/if}

<style>
  .wrap { display: flex; flex-direction: column; min-height: 0; padding: 14px 16px; gap: 10px; overflow: auto; }
  .bar { display: flex; align-items: center; gap: 11px; }
  h2 { margin: 0; font-size: 18px; font-weight: 500; }
  .spacer { margin-left: auto; }
  .mut { color: var(--text-mut); font-size: 12.5px; }
  .mono { font-family: var(--mono); }
  .danger { color: var(--danger); font-size: 12.5px; }

  .policy {
    display: flex; align-items: center; gap: 7px; margin: 0;
    padding: 8px 11px; background: var(--panel-2); border: 1px solid var(--border);
    border-radius: var(--radius); color: var(--text-mut); font-size: 12.5px;
  }
  .policy b { color: var(--warn); font-weight: 500; }

  .list { display: flex; flex-direction: column; gap: 7px; }
  .empty { padding: 26px 4px; color: var(--text-dim); }
  .empty p { margin: 0 0 7px; max-width: 54ch; line-height: 1.6; }

  .rule { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 9px 11px; }
  .rule.off { opacity: 0.55; }
  .top { display: flex; align-items: center; gap: 9px; min-width: 0; }
  .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .qty { font-size: 13.5px; }

  .pill { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid; white-space: nowrap; }
  .pill.good { background: var(--accent-dim); color: var(--good); border-color: var(--accent-border); }
  .pill.accent { background: #1c2537; color: var(--accent); border-color: var(--border-3); }
  .pill.warn { background: var(--warn-dim); color: var(--warn); border-color: #4a3d18; }
  .pill.danger { background: var(--danger-dim); color: var(--danger); border-color: var(--danger-border); }
  .pill.mute { background: var(--card-hover); color: var(--text-mut); border-color: var(--border-2); }

  .track { height: 5px; background: var(--rail); border-radius: 3px; margin-top: 7px; overflow: hidden; }
  .track i { display: block; height: 100%; border-radius: 3px; }
  .foot { display: flex; align-items: center; gap: 10px; margin-top: 6px; flex-wrap: wrap; }

  button.sm { padding: 4px 6px; }

  .events { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
  .events li { display: flex; gap: 9px; align-items: baseline; font-size: 13px; flex-wrap: wrap; }
  .ekind { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: var(--card-hover); color: var(--text-dim); }
  .ekind.ordered { background: var(--accent-dim); color: var(--accent); }
  .ekind.failed, .ekind.error { background: var(--danger-dim); color: var(--danger); }
  .ekind.timeout, .ekind.unknown { background: var(--warn-dim); color: var(--warn); }
  .edetail { color: var(--text-dim); flex: 1; min-width: 0; }
</style>
