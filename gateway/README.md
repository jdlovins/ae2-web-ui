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
| `DATABASE_URL` | *required* | `postgres://user:pass@host:5432/db` |
| `SAMPLE_INTERVAL_SEC` | `60` | Seconds between snapshots |
| `SAMPLE_GRIDS` | *(all)* | Comma-separated grid keys; empty = discover via `/grids` |
| `SAMPLE_RETENTION` | *(none)* | e.g. `365 days`. Unset keeps everything |
| `PORT` | `8081` | Read API port |

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
| `GET /history/items?grid=&q=&limit=` | Known items, biggest current stock first |
| `GET /history/series?grid=&items=a,b&from=-24h&to=&points=` | Bucketed series, ≤20 items |

`from`/`to` take an ISO instant or a relative offset (`-90m`, `-24h`, `-7d`).
`points` caps how many buckets come back so the browser never gets more than it
can draw.

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
