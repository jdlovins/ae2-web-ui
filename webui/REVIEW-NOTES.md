# webui — known issues / deferred cleanups

Findings from the 2026-08-12 read-through of `webui/`. None are blockers; they're
parked here so they don't get lost while other work (icons) happens first.

## 1. `formatNumber(x, 2)` misused as "2 decimal places"

`formatNumber`'s second arg is a **format enum**, not a precision:
`0 Local, 1 EN-US, 2 Compact, 3 Scientific, 4 None` (`src/lib/format.js`).

Call sites that clearly meant "two decimals" but get Compact notation:

- `src/components/CraftingView.svelte:326` — `formatNumber(it.craftsPerSec, 2)`
- `src/components/HistoryView.svelte:537` — `formatNumber(it.craftsPerSec, 2)`
- `src/components/HistoryView.svelte:593` — `formatNumber(it.craftsPerSec, 2)`

Looks fine for small values (Compact keeps `maximumFractionDigits: 2`), but a fast
crafting rate renders as `1.5K/s`. Fix: add a dedicated `formatRate()`/`formatFixed()`
helper and use it for `craftsPerSec`.

Related but harmless: `src/components/GridSelector.svelte:445` passes `1` for
`cpuCount`, which happens to be the correct EN-US enum value.

## 2. `autoRefresh` setting does nothing

Persisted in `src/lib/stores.js:26`, toggleable from **two** places
(`ItemsView.svelte:87` toolbar button and `SettingsPanel.svelte:48`), but no code
ever reads it to schedule a refresh. Users flip it and nothing happens.

Fix: either implement an interval in `ItemsView`/`HistoryView` gated on the flag,
or remove the toggle.

## 3. Admin password stored in plaintext in localStorage

`src/lib/api.js` caches the raw password under `ae2_pw` so it can silently re-auth
when the 7-day token expires ("type once"). Deliberate and commented, but it means
any XSS or a shared browser leaks the admin password itself, not just a token.

The mod also supports an HttpOnly `authenticationToken` cookie
(`AE2Controller.java` ~line 222) — that's the safer path if we want to drop the
cached password.

## 4. Hardcoded password default in test scripts

`scripts/validate.mjs:12` and `scripts/craft-test.mjs:8` both default
`AE2_PW` to a literal password. Strip these before `webui/` is committed if that
value is live anywhere.

## 5. Polling never pauses on hidden tabs

- `App.svelte` polls `/list` every 10s
- `CraftingView.svelte` polls `/get` every 3s

Neither checks `document.hidden`, so a backgrounded tab keeps loading the
Minecraft server thread indefinitely. Fix: pause on `visibilitychange`.

## 6. Dead code

- `src/lib/icons.js` — self-documented stub, nothing imports it. Delete.
- `public/login.html` — unreferenced by the SPA, but still copied into `dist/`.
- `vite-plugin-singlefile` in `package.json` devDependencies — not used by
  `vite.config.js`.
- `docker-entrypoint.sh:11` — `rm -f default.conf.bak` is a no-op; the comment
  claims it removes the stock default server, but what actually prevents the
  port-80 conflict is `envsubst` overwriting `conf.d/default.conf` itself.

## 7. Unused public component API

`ItemsView.svelte:792` and `HistoryView.svelte:513` both `export async function load()`,
but no parent binds a component ref — loading is driven by internal `$effect`.
Misleading public surface; make them private.

## 8. The Items/Fluids filter is broken on GTNH 2.9 (found 2026-08-12)

`ItemsView.svelte:790`:

```js
const isFluid = (it) => it.itemid === 'ae2fc:fluid_drop:0' || (it.itemid || '').startsWith('ae2fc:fluid');
```

GTNH 2.9 removed AE2FC "fluid drop" items. Fluids now sit in the network
directly and the mod reports them as a **bare Forge FluidRegistry name with no
colons** — `chlorine`, `molten.naquadah`, `hydrochloricacid_gt5u`. Verified
against a live network: 395 of 4,567 distinct ids are fluids and **none** match
`ae2fc:fluid*`.

So the toolbar's "Items / Fluids / Items + fluids" cycle is wrong in both
directions: picking "Fluids" shows nothing, and "Items" does not exclude fluids.

Fix is one line — fluids are exactly the ids without a colon:

```js
const isFluid = (it) => !(it.itemid || '').includes(':');
```

The same stale assumption in `ItemIcon.svelte` (droplet vs box glyph) was fixed
while wiring up the icon pack.

## 9. mock/data.js no longer matches the real API

Two ways it misleads, both of which cost real debugging time:

- Fluids are modelled as `ae2fc:fluid_drop:0` (see above), which 2.9 removed.
  Nothing in the mock exercises the bare-name fluid form.
- Some itemids are invented rather than real (e.g.
  `IC2:itemPurifiedCrushedIronOre`), so they have no icon and can't be used to
  sanity-check icon coverage.

Worth regenerating the canned data from a real `/items` response.

## 10. Minor

- `src/lib/api.js` `reauth()` hardcodes `username: 'Admin'`.
- `src/components/Icon.svelte:684` interpolates `title` into `{@html}` unescaped.
  All current call sites pass static literals, so it's latent only.
- `OrderDialog.svelte` `cpuState()` assumes `hashcode` is stable between `/items`
  and `/list` responses.
- `nginx.conf.template` proxy block doesn't set `X-Forwarded-Proto`.
