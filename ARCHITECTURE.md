# Architecture

A web terminal for the [AE2 Web Integration](https://github.com/kuba6000/AE2-Web-Integration)
Minecraft mod: browse an ME network's contents, request crafts, watch CPUs, and
chart inventory levels over time.

The mod is not part of this repo. It runs inside your Minecraft server and
exposes a small HTTP API; everything here sits in front of that.

## The pieces

```
                    ┌──────────────── webui (nginx :8080) ─────────────────┐
   browser ─────────▶ /                        the SPA (one HTML + JS/CSS) │
                    │ /icons/<itemid>.png      static icon pack            │
                    │                                                      │
                    │ /items /list /get /grids ─┐  cached reads            │
                    │ /order                   ─┤  cached-map repair       │
                    │ /history/*               ─┤  inventory time-series   │
                    │ /job /cancelcpu /auth ────┼──────────────┐           │
                    └──────────────────────────┼──────────────┼───────────┘
                                               │              │
                    ┌── gateway (node :8081) ◀─┘              │
                    │  shared cache (single-flight)           │
                    │  poller ─────────┐                      │
                    └──────────────────┼──────────────────────┼──▶ THE MOD
                                       ▼                         (Minecraft
                              TimescaleDB :5432                   server)
```

Three containers: `webui`, `gateway`, `timescale`. The mod is a fourth
*component* but not a container.

| Component | What it is | Why |
|---|---|---|
| `webui/` | Svelte 5 SPA + nginx | Serves the app and the icon pack, and decides which upstream each API route goes to |
| `gateway/` | Node service | Caches the mod's expensive reads, and records inventory history |
| `timescale` | TimescaleDB (Postgres) | Time-series storage for the Trends view |

## Why the gateway exists

This is the least obvious part of the design, and the most important.

Every read route on the mod is an `ISyncedRequest`: it executes **inline on the
Minecraft server tick**, walking the whole network. And the SPA polls:

| Consumer | Route | Rate |
|---|---|---|
| each browser tab | `/list` | every 10s |
| each tab on the Crafting view | `/get` | every 3s |
| each tab | `/items` | on refresh / grid switch |
| the poller | `/items` | every 60s |

So load scaled with the number of **open browser tabs** — three tabs on the
Crafting view was roughly one tick-blocking request per second, which dwarfs the
poller. Leave a tab open overnight and the game pays for it.

The gateway makes the mod's load **O(1) in users** instead of O(users), via two
mechanisms in `gateway/src/cache.mjs`:

- **Single-flight.** Concurrent callers for the same key collapse onto one
  upstream request. Measured against a live network: 12 simultaneous `/items`
  reads → **1** upstream fetch; 8 simultaneous *forced-fresh* reads → 2 (two only
  because browsers cap ~6 connections per origin, so they arrive in waves).
- **Short TTLs**, tuned to how fast each thing actually changes:
  `/items` 10s, `/list` 3s, `/get` 2.5s, `/grids` 15s.

Writes (`/order`, `/job`, `/cancelcpu`) and `/auth` go **straight to the mod and
are never cached**.

Two details make it cheap:

- The poller's `/items` call goes through the same cache with the same key, so it
  *warms the entry the item grid reads*. Browsing usually costs the mod nothing
  extra.
- The UI's explicit Refresh sends `Cache-Control: no-cache`, which skips a warm
  entry but **still joins an in-flight fetch** — so a refresh storm is still one
  hit on the game server.

The cache lives in the gateway process's heap, not in nginx. That's deliberate:
the poller talks to the mod directly, so an nginx cache would miss it entirely
and you'd fetch `/items` twice. Putting it in the Node process is what lets one
fetch serve both.

### Consequences

- **The gateway must run exactly one replica.** N replicas = N independent
  caches = N× the mod's load, which defeats the point.
- The cache is empty after a restart; the first read of each key goes upstream.
- Only the four hot read routes are proxied. `/trackinghistory` and
  `/gettracking` go straight to the mod — they're async handlers there, so they
  don't block the tick.

## Authentication

One credential, one source of truth: **the mod's own session**.

The mod issues tokens (`POST /auth`) and keeps them in a private in-memory map,
so the gateway can't validate one locally. Rather than add a second user store or
a shared secret, it **asks the mod**: it replays the caller's bearer token
against `/gridsettings` and treats 401 as a rejection.

That route is chosen carefully. It's an `ASyncRequestHandler`, so the probe never
touches the server tick, and called with no parameters it fails a missing-param
check before doing real work — so a *valid* token costs nothing either.
`checkAuth` runs before any handler logic, so the status code alone is the answer.

- Verdicts cache for 60s (10s for failures): a busy dashboard costs at most one
  probe per token per minute, and a logout stops working promptly.
- It **fails closed** — if the mod is unreachable, requests are rejected.
- `/history/ping` is the one exception: unauthenticated, and returns only "the
  process is up". Health probes can't hold a session, and a 401 would make an
  orchestrator restart a healthy pod forever.

On the browser side the SPA caches the password in `localStorage` so it can
silently re-auth when the 7-day token expires. It distinguishes *rejected*
credentials from an *unreachable* server, so a Minecraft server restart shows a
reconnecting state instead of a login prompt.

> `localStorage` is per-origin, so `:8080` and a dev server on `:5273` each need
> their own login. That's browser security, not a bug.

## Items, fluids, and icons

**Item ids.** The mod builds them as `modid:name:meta`
(`AEItemStackMixin.web$getItemID()`).

**Fluids have no colons at all.** GTNH 2.9 removed AE2FC's "fluid drop" items, so
fluids sit in the network directly and report a bare Forge FluidRegistry name —
`chlorine`, `molten.naquadah`, `hydrochloricacid_gt5u`. On a real network that's
~400 of ~4,700 entries. The absence of a colon is the only reliable
discriminator the API gives us, which is what `isFluidId()` in
`webui/src/lib/format.js` encodes.

**Icons** are static PNGs at `/icons/<iconFileName(itemid)>.png`, sliced out of
the icon atlas published by the [GTNH Calculator](https://github.com/ShadowTheAge/gtnh)
project. The ids line up with no mapping table:

| Kind | GTNH id | our `itemid` | file |
|---|---|---|---|
| item | `i:minecraft:iron_ingot:0` | `minecraft:iron_ingot:0` | `minecraft_iron_ingot_0.png` |
| fluid | `f:gregtech:chlorine` (internalName `chlorine`) | `chlorine` | `chlorine.png` |

Coverage on a live network is ~96%; the rest are entries the GTNH export omits
and they fall back to a glyph. See `webui/icons/README.md` for the pipeline.

## Inventory history

The poller snapshots every item on every tick — no watchlist — so any question
you think of later is already answerable.

Series are keyed on **`itemid`, not the API's `hashcode`**: hashcode comes from
`ItemStack.hashCode()` and isn't stable across server restarts. Stacks sharing an
itemid but differing in NBT (~170 of 4,700) are summed, so a series means "how
much of this item does the network hold".

Storage (`gateway/schema.sql`):

- `sample` is a hypertable with 1-day chunks, compressed after 7 days
  (`segmentby item_id`, which compresses hard because one item's quantity changes
  slowly).
- A `sample_hourly` continuous aggregate serves wide chart ranges, so 30 days
  reads ~720 rows per item instead of ~43k.
- It's set `materialized_only = false` for real-time aggregation — otherwise the
  view returns nothing until the refresh policy first runs, and a long range
  would look empty while the raw data sat right there.

Failed ticks leave gaps rather than interpolating, so downtime is visible as
holes. That's intentional: an invented value is worse than a missing one.

### Trend groups

A saved set of items to look at together, in two halves that never sync:

- **Personal** — `localStorage` (`ae2_trend_groups`), keyed by grid. Never leaves
  the browser.
- **Shared** — the gateway's `trend_group` table, served under
  `/history/trendgroups`. Visible to every session.

The split exists because **everyone signs in as the same admin account**, so the
server cannot tell two people apart — anything it stores is by definition
everybody's. "Mine" is therefore something only the browser can hold. Neither
half should grow a "copy to the other" button: that would silently publish a
scratch selection, or fork a group two people are both maintaining.

Members are `JSONB`, not a child table — a group is read and written whole, is
never joined against, and its itemids are deliberately *not* foreign keys to
`item`, so a group may name something this grid hasn't stocked yet without
failing an insert or vanishing on cascade.

Each group also stores the view it opens in (`mode`: `chart` or `change`). The
change view drops the chart for one row per item — start, now, low, high, delta,
percent, and net per hour over the selected range, biggest fallers first. That is
the "are we keeping up on inputs?" question, which a chart answers badly.

Member order is significant and arrangeable: the pinned selection at the top of
the picker drags to reorder (Alt+arrow from the keyboard), and that order is the
colour order, the legend order and the small-multiple panel order, stored with
the group. `chartSeries` is therefore derived from the selection rather than from
the response, which arrives in whatever order the request batches resolved.

Groups are uncapped, so chart mode has two renderings and picks by series count:

- **≤ 8** — the overlaid `LineChart`, one shared y-axis. Eight is the size of the
  categorical palette, whose hues are validated for adjacent-pair CVD separation
  against this app's chart surface; a ninth is not a generated hue.
- **> 8** — `SparkGrid`, one small panel per item, **each scaled to its own
  range**. Shape is comparable across panels, magnitude is not, which is why the
  current value is printed on every panel. Colours repeat every 8 here and that
  is harmless: each panel is separately labelled, so hue is decoration rather
  than the identifier. Each panel carries a crosshair and a readout on hover —
  without one, a self-scaled sparkline with no axes is a shape and nothing more.

Series loading batches accordingly: `/history/series` refuses more than 20 ids
per call (a guard on the database), so `lib/history.js` splits a larger selection
across parallel requests and stitches the responses back together.

Saving is an upsert on `(grid, name)` in both halves, so saving twice under one
name edits that group rather than creating a twin that is indistinguishable in
the chip strip.

### Scheduling

The poller is a **self-scheduling `setTimeout` chain, not `setInterval`**.
`setInterval` fires on a fixed cadence regardless of whether the previous run
finished, so a slow or hung mod makes ticks overlap and pile up — each holding a
lock or waiting on a socket, and all firing at once when the mod recovers.
Measured with a tick deliberately slower than the period: `setInterval` reached 4
concurrent runs and completed *fewer* of them; the self-scheduling loop never
exceeded 1.

All upstream calls carry a 30s timeout, so a hung server fails a tick instead of
wedging it forever.

## Mod quirks worked around here

**The stack map is global.** `GetItems.handle()` does
`hashcodeToStack.clear()` and refills it with only the grid just polled. `/order`
resolves its `item` hashcode out of that map — so an `/items` call for a
*different* grid in between makes a valid order fail with `ITEM_NOT_FOUND`. With
two grids and a background poller sampling both, that map flips every minute.

Since the gateway is the only thing talking to the mod, it fixes this without mod
changes (`gateway/src/modmap.mjs`): it tracks which grid last filled the map,
refills it for the right grid before forwarding an order, and holds a lock across
those two calls so nothing — including the poller — can clobber it in between.

The proper fix is upstream: key that map per grid.

**Open stack-type registry.** `web$getItemID()` assumed "not an item ⇒ a fluid",
but Thaumic Energistics adds `AEEssentiaStack`, and a crafting plan can contain
one — which threw `ClassCastException` from inside the server tick. Fixed in the
mod, not here.

## Repo layout

```
webui/          Svelte 5 SPA, nginx config, Dockerfile, icon tooling
  src/lib/      api.js (auth + fetch), history.js, format.js, stores.js
  src/components/
  scripts/      fetch-icons.mjs (icon pack), Playwright checks
  icons/        generated pack — gitignored, see its README
gateway/        Node service
  src/          cache, proxy, auth, collector, db, modmap
  schema.sql    TimescaleDB schema (idempotent, applied on boot)
k8s/            Kubernetes manifests
docker-compose.yml
```

`webui/REVIEW-NOTES.md` tracks known issues and deferred cleanups.
