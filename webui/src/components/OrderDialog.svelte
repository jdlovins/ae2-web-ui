<script>
  import { api } from '../lib/api.js';
  import { selectedGrid, cpuList, orderTarget, activeView, focusCpu, toast, settings } from '../lib/stores.js';
  import { formatNumber, formatBytes, formatPercent, stripMc } from '../lib/format.js';
  import Modal from './Modal.svelte';
  import McText from './McText.svelte';
  import ItemIcon from './ItemIcon.svelte';
  import Icon from './Icon.svelte';

  let { item } = $props();

  let phase = $state('quantity'); // quantity | calculating | plan | submitting
  let quantity = $state(1);
  let jobID = $state(null);
  let plan = $state(null);
  let selectedCpu = $state('');
  let alive = true;

  function close() {
    alive = false;
    if (jobID && (phase === 'plan' || phase === 'calculating')) {
      api.cancelJob($selectedGrid, jobID).catch(() => {});
    }
    orderTarget.set(null);
  }

  async function calculate() {
    if (!(quantity > 0)) return;
    phase = 'calculating';
    try {
      const r = await api.order($selectedGrid, item.hashcode, quantity);
      jobID = r.jobID;
      await poll();
    } catch (e) { toast(e.message); close(); }
  }

  async function poll() {
    while (alive) {
      const r = await api.job($selectedGrid, jobID);
      if (!alive) return;
      if (r.isDone) {
        plan = r;
        pickDefaultCpu();
        // "Skip plan review" fires the job straight off, but never silently: a
        // simulation is an incomplete job worth looking at, and with no usable
        // CPU there's nothing to submit to. Both fall back to the plan screen.
        if ($settings.skipPlanReview) {
          if (r.isSimulating) {
            toast('Job is a simulation — some items are missing. Review before starting.', 'info');
          } else if (!selectedCpu) {
            toast('No CPU is free for this job — pick a target.', 'info');
          } else {
            await start();
            return;
          }
        }
        phase = 'plan';
        return;
      }
      await new Promise((res) => setTimeout(res, 900));
    }
  }

  function cpuState(name, cluster) {
    if (!cluster.finalOutput) return 'idle';
    if (cluster.usedStorage !== -1 && item.hashcode === cluster.finalOutput.hashcode
        && cluster.availableStorage >= cluster.usedStorage + (plan?.bytesTotal || 0)) return 'mergeable';
    return 'invalid';
  }

  function pickDefaultCpu() {
    for (const [name, cluster] of Object.entries($cpuList)) {
      const st = cpuState(name, cluster);
      if (st === 'idle' || st === 'mergeable') { selectedCpu = name; return; }
    }
    selectedCpu = '';
  }

  async function start() {
    phase = 'submitting';
    try {
      await api.submitJob($selectedGrid, jobID, selectedCpu);
      toast(`Crafting ${formatNumber(quantity, 1)}× ${stripMc(item.itemname)} on ${selectedCpu}`, 'success');
      jobID = null;
      alive = false;
      orderTarget.set(null);
      focusCpu.set(selectedCpu);
      activeView.set('crafting');
    } catch (e) { toast(e.message); phase = 'plan'; }
  }

  const bump = (n) => (quantity = Math.max(1, Math.min(2147483647, Math.floor(quantity + n))));
</script>

<Modal title="Order item" onClose={close} wide={phase === 'plan'}>
  <div class="head">
    <ItemIcon {item} size={40} enabled={$settings.showIcons} />
    <div>
      <div class="nm"><McText name={item.itemname} /></div>
      <div class="sub">{item.itemid}</div>
    </div>
  </div>

  {#if phase === 'quantity'}
    <label class="lbl" for="qty">How many to craft?</label>
    <div class="qtyrow">
      <input id="qty" type="number" min="1" bind:value={quantity} />
    </div>
    <div class="quick">
      {#each [1, 8, 64, 128, 512] as n}
        <button onclick={() => bump(n)}>+{n}</button>
      {/each}
      <button onclick={() => (quantity = 1)}>Reset</button>
    </div>
    <label class="skip">
      <input
        type="checkbox"
        checked={$settings.skipPlanReview}
        onchange={(e) => settings.update((s) => ({ ...s, skipPlanReview: e.currentTarget.checked }))}
      />
      <span>
        Skip plan review
        <small>Start the job as soon as its plan is ready</small>
      </span>
    </label>
    <div class="actions">
      <button onclick={close}>Cancel</button>
      <button class="accent" onclick={calculate}>
        <Icon name="hammer" size={15} /> {$settings.skipPlanReview ? 'Craft' : 'Calculate'}
      </button>
    </div>

  {:else if phase === 'calculating'}
    <div class="calc"><Icon name="loader" size={22} spin /> Calculating crafting plan…</div>

  {:else if phase === 'plan'}
    <div class="planhead">
      {#if plan.isSimulating}
        <span class="simbadge"><Icon name="alert" size={14} /> Simulation — missing items</span>
      {/if}
      <span class="bytes">{formatBytes(plan.bytesTotal)} required</span>
    </div>

    <div class="plangrid">
      {#each plan.plan as p (p.itemid + p.itemname)}
        <div class="pcell {p.missing > 0 ? 'missing' : ''}">
          <div class="ptop"><ItemIcon item={{ ...p, hashcode: p.itemid }} size={28} enabled={false} /><span class="pn"><McText name={p.itemname} /></span></div>
          <div class="pmeta">
            {#if p.missing > 0}<span class="mss">Missing {formatNumber(p.missing)}</span>{/if}
            {#if p.requested > 0}<span>Craft {formatNumber(p.requested)}</span>{/if}
            {#if p.steps > 0}<span>{formatNumber(p.steps)} steps</span>{/if}
            {#if p.stored > 0}<span class="dim">Have {formatNumber(p.stored)}</span>{/if}
            {#if p.usedPercent > 0}<span class="dim">Uses {formatPercent(p.usedPercent)}</span>{/if}
          </div>
        </div>
      {/each}
    </div>

    {#if !plan.isSimulating}
      <div class="lbl">Target CPU</div>
      <div class="cpus">
        {#each Object.entries($cpuList) as [name, cluster]}
          {@const st = cpuState(name, cluster)}
          <button
            class="cpu {st} {selectedCpu === name ? 'sel' : ''}"
            disabled={st === 'invalid'}
            onclick={() => (selectedCpu = name)}
          >
            <span class="cn">{name}</span>
            <span class="cinfo">
              {cluster.usedStorage && cluster.usedStorage !== -1 ? `${formatBytes(cluster.usedStorage)} / ${formatBytes(cluster.availableStorage)}` : formatBytes(cluster.availableStorage)}
              · {cluster.coProcessors} co-proc
              {#if st === 'mergeable'} · merge{/if}
            </span>
          </button>
        {/each}
        {#if Object.keys($cpuList).length === 0}<div class="dim">No crafting CPUs available.</div>{/if}
      </div>
    {/if}

    <div class="actions">
      <button onclick={close}>Cancel</button>
      {#if !plan.isSimulating}
        <button class="accent" onclick={start} disabled={!selectedCpu}><Icon name="check" size={15} /> Start job</button>
      {/if}
    </div>

  {:else if phase === 'submitting'}
    <div class="calc"><Icon name="loader" size={22} spin /> Submitting job…</div>
  {/if}
</Modal>

<style>
  .head { display: flex; gap: 11px; align-items: center; margin-bottom: 14px; }
  .nm { font-weight: 500; }
  .sub { font-size: 11.5px; color: var(--text-faint); font-family: var(--mono); word-break: break-all; }
  .lbl { font-size: 12.5px; color: var(--text-mut); margin: 12px 0 7px; }
  .qtyrow input { width: 100%; font-size: 18px; font-family: var(--mono); }
  .quick { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .quick button { font-size: 12.5px; padding: 6px 10px; }
  .skip { display: flex; align-items: flex-start; gap: 10px; margin-top: 16px; cursor: pointer; font-size: 13.5px; }
  .skip input { width: 16px; height: 16px; margin: 1px 0 0; accent-color: var(--accent); flex: none; }
  .skip small { display: block; color: var(--text-mut); font-size: 11.5px; margin-top: 2px; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
  .calc { display: flex; align-items: center; gap: 10px; padding: 26px 4px; color: var(--text-dim); }
  .planhead { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
  .bytes { font-size: 13px; color: var(--text-mut); font-family: var(--mono); }
  .simbadge { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--warn); background: var(--warn-dim); border: 1px solid #4a3f16; border-radius: var(--radius); padding: 4px 9px; }
  .plangrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 8px; }
  .pcell { background: var(--card); border: 1px solid var(--border-2); border-radius: var(--radius); padding: 9px; }
  .pcell.missing { background: #2a1414; border-color: var(--danger-border); }
  .ptop { display: flex; align-items: center; gap: 7px; margin-bottom: 6px; }
  .pn { font-size: 12.5px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pmeta { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 11.5px; color: var(--text-dim); }
  .pmeta .mss { color: var(--danger); }
  .pmeta .dim { color: var(--text-mut); }
  .cpus { display: flex; flex-direction: column; gap: 6px; }
  .cpu { flex-direction: column; align-items: flex-start; gap: 2px; text-align: left; }
  .cpu.idle { border-color: var(--border-2); }
  .cpu.mergeable { border-color: #7a6a12; background: #211d0b; color: var(--warn); }
  .cpu.invalid { opacity: 0.45; }
  .cpu.sel { border-color: var(--accent-border); background: var(--accent-dim); color: var(--accent); }
  .cn { font-weight: 500; }
  .cinfo { font-size: 11px; color: var(--text-mut); font-family: var(--mono); }
  .dim { color: var(--text-mut); font-size: 12.5px; }
</style>
