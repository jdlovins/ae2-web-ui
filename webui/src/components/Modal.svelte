<script>
  import Icon from './Icon.svelte';
  // closeOnEscape lets a modal opt out while another one is stacked on top of it.
  // The listener below is on the window, so two open modals would otherwise both
  // see the same Escape and close together.
  let { title = '', onClose, children, wide = false, closeOnEscape = true } = $props();

  function key(e) { if (e.key === 'Escape' && closeOnEscape) onClose?.(); }

  // Close only when the press BOTH started and ended on the backdrop.
  //
  // A bare onclick isn't enough: press inside a field, drag out to extend the
  // selection, release over the backdrop, and the browser dispatches the click
  // on their nearest common ancestor — the backdrop — so the modal's own
  // stopPropagation never runs and the dialog vanishes mid-drag, taking whatever
  // was typed with it. Selecting a quantity by dragging is the obvious way to
  // retype one, so this fired constantly.
  let pressedOnBackdrop = false;
  const down = (e) => { pressedOnBackdrop = e.target === e.currentTarget; };
  const click = (e) => { if (pressedOnBackdrop && e.target === e.currentTarget) onClose?.(); };
</script>

<svelte:window onkeydown={key} />

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions a11y_no_noninteractive_element_interactions -->
<div class="backdrop" onpointerdown={down} onclick={click} role="presentation">
  <div class="modal {wide ? 'wide' : ''}" onclick={(e) => e.stopPropagation()} role="dialog" tabindex="-1" aria-modal="true" aria-label={title}>
    <div class="head">
      <h2>{title}</h2>
      <button class="ghost" onclick={onClose} aria-label="Close"><Icon name="x" size={19} /></button>
    </div>
    <div class="content">
      {@render children?.()}
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed; inset: 0; z-index: 70;
    background: rgba(4, 6, 12, 0.66);
    display: flex; align-items: center; justify-content: center; padding: 16px;
  }
  .modal {
    background: var(--panel); border: 1px solid var(--border-2); border-radius: var(--radius-lg);
    width: 100%; max-width: 460px; max-height: 88vh; display: flex; flex-direction: column;
    box-shadow: 0 20px 60px rgba(0,0,0,0.6);
  }
  .modal.wide { max-width: 820px; }
  .head {
    flex: none; display: flex; align-items: center; justify-content: space-between;
    padding: 13px 16px; border-bottom: 1px solid var(--border);
  }
  .head h2 { margin: 0; font-size: 16px; font-weight: 500; }
  .content { padding: 16px; overflow: auto; }
</style>
