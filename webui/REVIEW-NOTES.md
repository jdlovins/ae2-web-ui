# webui — known issues / deferred cleanups

Findings from the read-through of `webui/`. Line numbers in the original version
of this file had gone stale (they pointed past the ends of the files they cited),
so entries now name symbols rather than lines.

Last reconciled against the tree: 2026-08-12, before the first push to
`github.com/jdlovins/ae2-web-ui`.

## Fixed

- **`formatNumber(x, 2)` misused as "2 decimal places."** That argument is a
  format enum (`0 Local, 1 EN-US, 2 Compact, 3 Scientific, 4 None`), so a fast
  crafting rate rendered as `1.5K/s`. Added `formatRate()` in `src/lib/format.js`
  and used it for `craftsPerSec` in `CraftingView.svelte` and the two sites in
  `HistoryView.svelte`.
- **`autoRefresh` did nothing.** It was persisted and toggleable from two places
  but read by no code. Now implemented in `ItemsView.svelte` on a 15s period —
  longer than the gateway's 10s `/items` TTL, and a plain (non-`fresh`) read, so
  it mostly lands on a cache entry the collector already paid for.
- **Polling never paused on hidden tabs.** `App.svelte` (`/list`, 10s) and
  `CraftingView.svelte` (`/get`, 3s) polled forever in a backgrounded window,
  against routes that run on the Minecraft server tick. Both now go through
  `pollVisible()` in `src/lib/poll.js`, which stops on `visibilitychange` and
  fetches immediately on return.
- **The Items/Fluids filter was broken on GTNH 2.9.** It matched `ae2fc:fluid*`
  items, which 2.9 removed; fluids now report a bare FluidRegistry name with no
  colons. `isFluidId()` in `src/lib/format.js` is the single source of truth and
  both `ItemsView` and `ItemIcon` use it.
- **Hardcoded password default in test scripts.** `validate.mjs`, `craft-test.mjs`
  and `history-test.mjs` all defaulted `AE2_PW` to a literal. They now require the
  env var and exit non-zero without it. **The literal is still in git history** —
  see the note at the bottom.
- **`src/lib/icons.js`** — deleted (was a self-documented stub nothing imported).
- **`public/login.html`** — deleted. A standalone sign-in page superseded by
  `LoginGate.svelte`; nothing referenced it, but it was still copied into `dist/`,
  and it linked a `favicon.ico` that doesn't exist.

## Open

### 1. Admin password stored in plaintext in localStorage

`src/lib/api.js` caches the raw password under `ae2_pw` so it can silently
re-auth when the 7-day token expires ("type once"). Deliberate and commented, but
any XSS or a shared browser leaks the admin password itself, not just a token.

The mod also supports an HttpOnly `authenticationToken` cookie
(`AE2Controller.java` ~line 222) — that's the safer path if we want to drop the
cached password.

### 2. `mock/data.js` no longer matches the real API

- Fluids are modelled as `ae2fc:fluid_drop:0`, which GTNH 2.9 removed. Nothing in
  the mock exercises the bare-name fluid form, which is the form that actually
  broke the filter above.
- Some itemids are invented rather than real (e.g.
  `IC2:itemPurifiedCrushedIronOre`), so they have no icon and can't sanity-check
  icon coverage.

Worth regenerating from a real `/items` response.

### 3. Unused public component API

`ItemsView.svelte` and `HistoryView.svelte` both `export async function load()`,
but no parent binds a component ref — loading is driven by internal `$effect`.
Misleading public surface; make them private.

### 4. Minor

- `src/lib/api.js` `reauth()` hardcodes `username: 'Admin'`.
- `src/components/Icon.svelte` interpolates `title` into `{@html}` unescaped. All
  current call sites pass static literals, so it's latent only.
- `OrderDialog.svelte` `cpuState()` assumes `hashcode` is stable between `/items`
  and `/list` responses.
- `nginx.conf.template` proxy blocks don't set `X-Forwarded-Proto`.

## Not an issue (previously listed as one)

- **`vite-plugin-singlefile` in devDependencies.** Unused by `main`'s
  `vite.config.js`, but the `standalone-jar-build` branch imports it for the
  single-file build that gets embedded in the mod jar. Deleting it from `main`
  would leave that branch broken after a merge — a 3-way merge would carry the
  deletion — so it stays.

## The password in git history

The literal removed from the three scripts above is still present in the initial
commit. Removing it from the working tree does not remove it from history, and
pushing publishes it. Rotating the mod's admin password is the only complete fix;
scrubbing history helps only if it happens before the first push.
