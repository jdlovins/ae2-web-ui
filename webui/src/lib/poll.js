// Interval polling that pauses while the tab is hidden.
//
// Every route polled through here is an ISyncedRequest in the mod — it runs
// inline on the Minecraft server tick. The gateway's cache means N tabs cost
// roughly what one tab costs, but a tab left open in a background window still
// keeps a poller alive against a live game server for nobody's benefit. A tab
// nobody is looking at should not be asking.
//
// On becoming visible again we fetch immediately rather than waiting out the
// interval, so returning to a tab never shows stale data.
//
// Returns a teardown function, so it drops straight into a Svelte $effect:
//
//   $effect(() => pollVisible(refresh, 10000));

export function pollVisible(fn, ms) {
  let timer = null;

  const start = () => { if (timer === null) timer = setInterval(fn, ms); };
  const stop = () => { if (timer !== null) { clearInterval(timer); timer = null; } };

  const onVisibility = () => {
    if (document.hidden) { stop(); return; }
    fn();
    start();
  };

  if (!document.hidden) start();
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    stop();
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
