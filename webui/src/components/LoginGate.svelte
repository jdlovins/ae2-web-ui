<script>
  import { login, AUTH } from '../lib/api.js';
  import Icon from './Icon.svelte';

  let { onSuccess } = $props();
  let password = $state('');
  let error = $state('');
  let busy = $state(false);

  async function submit(e) {
    e?.preventDefault();
    if (!password) return;
    busy = true; error = '';
    const result = await login(password);
    busy = false;
    if (result === AUTH.OK) onSuccess?.();
    else if (result === AUTH.UNREACHABLE) error = "Can't reach the server — is it running?";
    else { error = 'Invalid password'; password = ''; }
  }
</script>

<div class="screen">
  <form class="card" onsubmit={submit}>
    <div class="brand"><Icon name="cpu" size={26} /> <span>ME Terminal</span></div>
    <p class="hint">This service requires authentication.</p>
    <div class="ipt {error ? 'err' : ''}">
      <Icon name="lock" size={16} />
      <input type="password" placeholder="Password" bind:value={password} autocomplete="current-password" />
    </div>
    {#if error}<div class="error">{error}</div>{/if}
    <button class="accent submit" type="submit" disabled={busy}>
      {#if busy}<Icon name="loader" size={16} spin /> Signing in…{:else}<Icon name="check" size={16} /> Sign in{/if}
    </button>
    <p class="note">You'll stay signed in on this device.</p>
  </form>
</div>

<style>
  .screen { height: 100%; display: flex; align-items: center; justify-content: center; padding: 20px; }
  .card { width: 100%; max-width: 320px; background: var(--panel); border: 1px solid var(--border-2); border-radius: var(--radius-lg); padding: 26px 22px; display: flex; flex-direction: column; gap: 12px; }
  .brand { display: flex; align-items: center; gap: 10px; color: var(--accent); font-weight: 500; font-size: 17px; }
  .hint { margin: 0; color: var(--text-mut); font-size: 13px; }
  .ipt { display: flex; align-items: center; gap: 8px; background: var(--card-hover); border: 1px solid var(--border-2); border-radius: var(--radius); padding: 0 11px; color: var(--text-faint); }
  .ipt.err { border-color: var(--danger-border); }
  .ipt input { flex: 1; background: transparent; border: none; padding: 10px 0; }
  .error { color: var(--danger); font-size: 12.5px; }
  .submit { justify-content: center; padding: 10px; }
  .note { margin: 2px 0 0; color: var(--text-faint); font-size: 11.5px; text-align: center; }
</style>
