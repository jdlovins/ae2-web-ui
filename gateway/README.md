# AE2 gateway

The single point of contact with the AE2 Web Integration mod. Everything the web
terminal reads flows through here, which is what keeps the Minecraft server's
load from scaling with the number of open browser tabs.

It also records inventory levels into TimescaleDB for the **Trends** view — a
natural side-job, since it already sees every `/items` payload.

```
                    ┌─────────── this service ───────────┐
mod /items ──▶ poll │ shared cache ──▶ TimescaleDB       │──▶ /history/*  ──▶ Trends
mod reads  ──▶ proxy│ (single-flight) │  (hypertable)     │──▶ /items /list ──▶ Items,
                    └────────────────────────────────────┘    /get /grids     Crafting
```

Two jobs, colocated deliberately: both need to be the *sole* reader of the mod's
API, and running them in one process is what lets the poller's fetch and the
SPA's read share a single cache entry.

1. **Fronts the mod's expensive read routes** with a caching, request-collapsing
   proxy.
2. **Records** inventory levels into TimescaleDB and serves them at `/history/*`.

## The caching proxy

Every read route on the mod is an `ISyncedRequest` — it runs **inline on the
Minecraft server tick**. So load scaled with the number of open browser tabs:
each tab polled `/list` every 10s and `/get` every 3s. Three tabs on the
Crafting view was ~1 tick-blocking request per second, dwarfing this
collector's one poll per minute.

nginx now sends the read routes here instead of to the mod:

| Route | TTL | Notes |
|---|---|---|
| `/items` | 10s | The whole-network walk. Shared with the collector's poll |
| `/list` | 3s | CPU list |
| `/get` | 2.5s | Open CPU detail |
| `/grids` | 15s | Changes rarely |

Writes (`/order`, `/job`, `/cancelcpu`), `/auth` and the async tracking routes go
**straight to the mod and are never cached**.

Two properties do the work:

- **Single-flight.** Concurrent callers for the same key collapse onto one
  upstream request. Measured: 8 simultaneous forced-fresh `/items` reads → 2
  upstream fetches (2 only because browsers cap ~6 connections per origin, so it
  arrives in waves); 12 normal concurrent reads → 1. Mod load is O(1) in users.
- **The collector's poll warms the same entry** the SPA reads, so browsing the
  item grid usually costs the mod nothing extra.

An explicit Refresh in the UI sends `Cache-Control: no-cache`, which skips a warm
entry but still joins an in-flight fetch — so a refresh storm is still one hit on
the game server.

The SPA needed no changes: same paths, same envelope.

Cache fills use the **collector's** mod session, not the caller's, so one warm
entry serves every tab. That's sound because this API is admin-only and the read
routes don't vary by player; if the mod ever grows per-player scoping, the cache
key must include the caller.

## Why a separate container

`webui` is a static SPA behind nginx — nothing there can hold a DB connection or
run a scheduler, so this needs its own container.

Inside it, though, there is exactly **one Node process** running two concurrent
jobs: the poller (a `setInterval`) and the HTTP API. They share `cache.mjs`'s
in-memory Maps by ordinary module state, which is the whole trick — see
"the caching proxy" above. Splitting them into separate containers would put
them in separate heaps and the shared cache would need Redis.

Consequences worth knowing: the cache is empty after a restart, and running more
than one replica gives you N independent caches (N× the mod's load).

## Run it

The whole stack (this service + TimescaleDB + the web UI) comes up from the
**repo root**, not here:

```bash
cp .env.example .env    # then set AE2_URL and AE2_PASSWORD
docker compose up -d --build
```

Note that editing `.env` needs `up -d` to take effect — `docker compose restart`
does *not* re-read it.

For frontend work, run the SPA from source against the same services:

```bash
cd webui && AE2_TARGET=$AE2_URL npm run dev
```

Vite proxies `/history` to `127.0.0.1:8081` by default (override with
`AE2_GATEWAY`). If this service is down, Trends shows an explanatory empty state
rather than breaking.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `AE2_URL` | *required* | Mod API base URL, no trailing slash |
| `AE2_PASSWORD` | *required* | Admin password for `POST /auth` |
| `AE2_USERNAME` | `Admin` | Auth username |
| `DATABASE_URL` | † | `postgres://user:pass@host:5432/db` |
| `PGHOST` / `PGPORT` / `PGDATABASE` / `PGUSER` / `PGPASSWORD` | † | Standard libpq variables, read by node-pg directly |
| `SAMPLE_INTERVAL_SEC` | `60` | Seconds between snapshots |
| `SAMPLE_GRIDS` | *(all)* | Comma-separated grid keys; empty = discover via `/grids` |
| `SAMPLE_RETENTION` | *(none)* | e.g. `365 days`. Unset keeps everything |
| `PORT` | `8081` | Read API port |
| `MAINTAIN_ENABLED` | `true` | Set `false` to stop the level maintainer ordering anything |
| `MAINTAIN_MAX_JOBS` | `3` | Ceiling on jobs **the maintainer** has in flight, per grid. Hand-started crafts don't count |
| `MAINTAIN_BACKOFF_SEC` | `300` | How long a rule waits before retrying after it fails to plan (flat, not exponential) |
| `MAINTAIN_PLAN_TIMEOUT_SEC` | `30` | How long to wait for a plan before abandoning it |

† Configure the database one way or the other; `DATABASE_URL` wins if both are
set. **Prefer the `PG*` variables when you don't control the password.** A
password may legally contain `@`, `:` or `/`, all of which corrupt a URL — and
`@` is the dangerous one, because the driver then reads everything after it as
the hostname. The result is a DNS failure, not an authentication failure, so it
looks like the database is missing rather than like a bad password.

### Don't sample too fast

`GetItems` extends `ISyncedRequest`, so `/items` walks the entire network **on the
Minecraft server tick**. At 60s that's invisible; at 1s it will visibly lag the
game. The service warns below 15s but won't stop you.

## What gets stored

One row per item per tick — every item, no watchlist, so any question you think
of later is already answerable.

Series are keyed on `itemid`, not the API's `hashcode`: hashcode comes from
`ItemStack.hashCode()` and isn't stable across server restarts. Stacks that share
an itemid but differ in NBT (~170 of 4,700 on a real network) are summed, so a
series means "how much of this item does the network hold".

Fluids work naturally — since GTNH 2.9 they appear as ordinary entries with a
bare FluidRegistry name (`chlorine`), flagged `is_fluid` when the id has no colon.

### Storage

`sample` is a hypertable with 1-day chunks, compressed after 7 days
(`segmentby item_id`, which compresses hard because one item's quantity changes
slowly). A `sample_hourly` continuous aggregate serves ranges wide enough to
bucket hourly, so a 30-day chart reads ~720 rows per item instead of ~43k.

It's set `materialized_only = false` for real-time aggregation — otherwise the
view returns nothing until the refresh policy first runs, and a long chart range
would look empty while the raw data sat right there.

## API

All responses use the mod's `{status:"OK", data}` envelope.

| Route | Purpose |
|---|---|
| `GET /history/health` | Collector counters + DB size. Drives the empty states |
| `GET /history/grids` | Grids that have samples |
| `GET /history/items?grid=&q=&limit=&from=&sort=&dir=&min=` | Known items, biggest current stock first |
| `GET /history/item?grid=&itemid=&from=&points=` | One item: identity, range min/avg/max, series |
| `GET /history/series?grid=&items=a,b&from=-24h&to=&points=` | Bucketed series, ≤20 items |
| `GET /history/maintain?grid=` | Level maintainer rules |
| `POST /history/maintain` | Create or replace a rule (JSON body) |
| `PATCH /history/maintain/:id` | Edit thresholds or enable/disable; clears backoff |
| `DELETE /history/maintain/:id` | Remove a rule |
| `GET /history/maintain/:id/events?limit=` | Recent activity for one rule |
| `GET /history/trendgroups?grid=` | Shared trend groups |
| `POST /history/trendgroups` | Create or replace a group by name (JSON body) |
| `PATCH /history/trendgroups/:id` | Rename, or replace members/mode |
| `DELETE /history/trendgroups/:id` | Remove a group |

`from`/`to` take an ISO instant or a relative offset (`-90m`, `-24h`, `-7d`).
`points` caps how many buckets come back so the browser never gets more than it
can draw. On `/history/items`, `from` adds a `change` column, `sort=change`
orders by it, and `min` hides anything holding less than that.

The maintainer and trend-group routes are the only ones taking a JSON request
body; everything else, here and in the mod, is query parameters.

Trend groups are named item sets for the Trends view, stored per grid and unique
on `(grid, name)` so a repeat save edits rather than duplicates. Each carries a
`mode` (`chart` or `change`) — the view it opens in. **These are the SHARED half
only**: the personal half lives in the browser's `localStorage` and never reaches
this service, because every session authenticates as the same admin account and
so anything stored here is visible to everyone by design.

## Level maintainer

Rules keep an item above a stock floor: when the level drops below `target`, the
maintainer orders exactly `batch`. A fixed batch rather than topping up to the
target is deliberate — AE2 rounds any request up to whole pattern outputs, so
asking for an exact shortfall buys precision the crafting system can't honour,
and the overshoot is what stops the rule firing again on the next check.

It runs at the end of each collector tick, off the snapshot that tick just took,
so its cadence is `SAMPLE_INTERVAL_SEC` and it costs the game nothing extra until
a rule actually needs to order.

**Everything is scoped per grid.** Rules are unique on `(grid_key, itemid)`, so
the same item on two networks is two independent rules with their own targets and
backoff. Each grid is evaluated against its own snapshot, its own CPU list and
its own copy of the job cap, so a saturated network can't starve another, and one
unreachable grid doesn't stop the others being maintained. `/history/health`
reports current state (`inFlight`, `othersCrafting`, `skipped`) per grid under
`maintainer.grids`; the top-level counters are lifetime totals.

**The job cap counts only jobs the maintainer placed.** A craft you started by
hand is not its doing and never consumes the budget, even when it is for a
maintained item — that is what `othersCrafting` reports separately. Ownership is
tracked by the CPU each job was submitted to and re-derived every tick from the
live CPU list, so it needs no job ids and cannot leak; after a restart it is
rebuilt from the `ordered` events, which already record the CPU.

This is deliberately separate from the rule that the maintainer never orders an
item **anyone** is already crafting. That check still looks at every craft on the
grid, whoever started it, so excluding other people's work from the cap cannot
produce a duplicate job. Total load on the network stays bounded by CPU
availability: `pickCpu()` never takes a busy one.

⚠️ The maintainer only runs for grids the **collector samples**. If
`SAMPLE_GRIDS` is set, rules on any other grid stay enabled and simply never
fire, with nothing warning you.

**CPU choice is ours, not AE2's.** AE2 only honours a CPU's "Accept request"
setting when it picks the CPU itself; an explicitly named target skips the check
(`CraftingGridCache.submitJob`). Every request this mod makes carries a
`PlayerSource`, and `PlayerSource.isPlayer()` is unconditionally true even for a
fake player — so letting AE2 choose would make the maintainer compete for the
CPUs you use by hand and be refused by the ones you reserved for automation.
Instead it filters the list itself: automation-only CPUs first, then
unrestricted, never player-only, and within a tier the *smallest* CPU that fits
the plan. The tradeoff is that this leans on AE2 not enforcing allow-mode for
named targets; if that's ever tightened upstream, the durable fix is a non-player
order path in the mod.

Only a returned simulation counts as a failure and triggers backoff — planning is
the expensive part. `ALL_CPU_BUSY`, "no eligible CPU" and a stale hashcode all
retry on the next tick at no cost. Backoff state lives on the rule row rather
than in memory, so a crash-looping container resumes its backoff instead of
turning into an order storm.

## Auth

Every route here — proxied reads and `/history/*` alike — requires a bearer token
that **the mod** considers valid. Since the mod keeps its tokens in a private
in-memory map, this service replays the caller's token against `/gridsettings`
and treats 401 as reject. That route is an `ASyncRequestHandler`, so the probe
never touches the server tick, and with no params it fails a missing-param check
before doing real work — `checkAuth` runs first, so the status code alone is the
answer.

Verdicts cache for 60s (10s for failures), so a busy dashboard costs at most one
probe per token per minute and a logout stops working quickly. It **fails
closed**: if the mod is unreachable, requests are rejected.

No second user store, no shared secret — access is exactly what the mod grants.

> Dev caveat: against the **mock** dev server any token passes, because the
> mock's `/gridsettings` ignores auth. The gate is only as strong as the upstream
> it asks.

## Known gaps

- **Restart gaps aren't backfilled.** A tick that fails (server down, restarting)
  is simply missing; the chart draws a gap rather than interpolating, which is
  honest but means downtime is visible as holes.
- **No k8s manifest yet.** `docker-compose.yml` covers local use;
  `../webui/k8s/ae2-webui.yaml` still needs a Deployment/Service for this and a
  `GATEWAY_UPSTREAM` wired into the webui container.
- **Only the four hot read routes are proxied.** `/trackinghistory` and
  `/gettracking` still go straight to the mod — they're async handlers there, so
  they don't block the server tick, but they're uncached.
