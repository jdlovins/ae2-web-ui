# Deployment

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the pieces fit together and why.

## Prerequisites

- A Minecraft server running the [AE2 Web Integration](https://github.com/kuba6000/AE2-Web-Integration)
  mod, with its HTTP API reachable from wherever you deploy this. **Not
  `127.0.0.1`** — containers can't reach the host's loopback.
- The mod's admin password (what you type on its login screen).
- Docker with Compose v2, or a Kubernetes cluster.
- Node 22 to generate the icon pack (once, on the build host).

### GTNH: use a recent mod build

If you run GTNH with fluids in the network, the mod needs to be newer than the
`1.0.3-GTNH-Native-Fluids-Support` prerelease. That build crashes the **entire
Minecraft server** when you order a fluid: `Order.java` looks the stack up in
AE2's item-only list, which casts to `IAEItemStack` and throws
`ClassCastException` inside the server tick loop.

The fix landed later on the `gtnh-native-fluid` branch (`84813d7`, "Port GTNH to
unified IStackList core API with fluid crafting fixes"), along with exception
isolation so no web request can take the server down again. There's no release
containing it yet, so build from that branch — and don't forget the submodule:

```bash
git clone -b gtnh-native-fluid https://github.com/kuba6000/AE2-Web-Integration
cd AE2-Web-Integration
git submodule update --init --recursive     # the build fails confusingly without this
./gradlew build -x test
# use build/libs/*.jar — the one without -dev, -sources or -preshadow
```

## Docker Compose

```bash
cp .env.example .env      # then set AE2_URL and AE2_PASSWORD
cd webui && npm ci && npm run icons && cd ..
docker compose up -d --build
open http://localhost:8080
```

Three containers come up: `webui` (:8080), `gateway` (:8081), `timescale`
(:5433). Only `webui` needs to be reachable by browsers — it serves the app and
routes the API onward. **Don't expose the gateway directly**; it has no
rate limiting and no reason to be public.

### The icon pack is a separate step

`npm run icons` downloads the GTNH icon atlas and slices ~50k PNGs (~50 MB) into
`webui/icons/`. They're gitignored, and `npm run build` does **not** produce
them — the Dockerfile only `COPY`s them. Skip this and the image ships without
icons; every item falls back to a glyph, which works but looks bare.

Details and options (trimming the pack, other pack versions) are in
[`webui/icons/README.md`](webui/icons/README.md).

### Configuration

All via `.env`, which Compose reads automatically. Full list in `.env.example`.

| Variable | Default | Notes |
|---|---|---|
| `AE2_URL` | *required* | Mod API base URL, no trailing slash |
| `AE2_PASSWORD` | *required* | Mod admin password |
| `SAMPLE_INTERVAL_SEC` | `60` | Seconds between inventory snapshots |
| `SAMPLE_GRIDS` | *(all)* | Comma-separated grid keys; empty = every attached grid |
| `SAMPLE_RETENTION` | *(none)* | e.g. `365 days`; unset keeps history forever |
| `WEBUI_HOST_PORT` | `8080` | |
| `GATEWAY_HOST_PORT` | `8081` | Only needed for debugging |
| `POSTGRES_HOST_PORT` | `5433` | Non-default so it can't clash with a local Postgres |

> **Editing `.env` requires `docker compose up -d`, not `restart`.** Compose
> injects environment at container *creation*, so `restart` reuses the old
> values. This is the single most common way to get stuck.

#### Don't sample too fast

`/items` walks the whole network **on the Minecraft server tick**. At 60s that's
invisible; below ~15s it will visibly lag the game. The gateway warns but won't
stop you.

## Day-to-day operations

```bash
docker compose ps                         # what's running
docker compose logs -f gateway            # collector ticks and errors
docker compose up -d --build              # after any code change
docker compose up -d --build webui        # only the SPA changed
docker compose down                       # stop (keeps the database volume)
```

Any change under `webui/src/` needs `--build`: the SPA is compiled into the image
by the Dockerfile, so restarting alone serves the old bundle.

### Health

```bash
curl localhost:8081/history/ping                     # unauthenticated liveness
curl -H "Authorization: Bearer $TOKEN" localhost:8081/history/health
```

`/history/ping` returns only `{"ok":true}` and is the endpoint to point probes
at. `/history/health` needs a token and returns collector counters, cache hit
rates, and database size.

### Backups

All state is the `timescale-data` volume — the icon pack and images are
reproducible, and `.env` is your only other irreplaceable file.

```bash
docker compose exec -T timescale pg_dump -U ae2 ae2 | gzip > ae2-$(date +%F).sql.gz
```

Restore into an empty database with `gunzip -c … | docker compose exec -T timescale psql -U ae2 -d ae2`.

## Kubernetes

`k8s/ae2-web.yaml` deploys all three services into an `ae2` namespace: a
StatefulSet with a PVC for TimescaleDB, plus Deployments and Services for the
gateway and webui, and a Traefik `IngressRoute` for the webui.

It targets k3s with Traefik's CRDs and a `freenas-iscsi` storage class. If you
run a different setup, two lines change: swap the `IngressRoute` for a plain
`Ingress` (`ingressClassName: traefik`) pointing at the `ae2-webui` Service on
port 80, and set `storageClassName` on the volume claim template to your own.

The manifest is self-contained — Namespace, Secret, ConfigMap and workloads — so
it applies in one step with no imperative setup. That suits Argo CD, but it also
means **the filled-in file holds your passwords: keep it in a private repo.**

```bash
# 1. Fill in AE2_PASSWORD and POSTGRES_PASSWORD in the Secret.
# 2. Set AE2_URL in the ConfigMap, and the host in the IngressRoute.
kubectl apply -f k8s/ae2-web.yaml
kubectl -n ae2 rollout status deploy/ae2-webui
```

`POSTGRES_PASSWORD` is read once, when the database initialises. Changing it
afterwards does not change the password stored in the PVC, so the gateway starts
failing authentication until you `ALTER ROLE` or wipe the volume. Choose it
before the first deploy.

Prefer to keep credentials out of Git? Delete the `Secret` from the manifest and
supply it another way — Sealed Secrets, External Secrets, or imperatively:

```bash
kubectl -n ae2 create secret generic ae2-web \
  --from-literal=AE2_PASSWORD='your-mod-admin-password' \
  --from-literal=POSTGRES_PASSWORD="$(openssl rand -hex 24)"
```

Nothing else changes; the workloads reference the Secret by name either way.

### Sizing

Measured against a synthetic network of 4,700 items × 2 grids, with the
collector running 4× faster than its default and 20 simulated browser tabs plus
a refresh storm:

| Container | Peak memory | Peak CPU | Request | Limit |
|---|---|---|---|---|
| `timescale` | 280 MiB | 0.26 core | 512Mi / 250m | 2Gi |
| `gateway` | 54 MiB | 0.18 core | 128Mi / 100m | 512Mi |
| `webui` | 26 MiB | 0.12 core | 64Mi / 50m | 256Mi |

Requests sit near real steady-state usage, because requests reserve node
capacity; limits are set well above it, because limits reserve nothing and only
decide when the kernel kills you.

The database's limit is the least like its measurement, deliberately. Neither
memory-hungry job ran during the test: compression only touches chunks older
than 7 days, and the continuous-aggregate refresh runs hourly. Postgres also
uses spare memory as cache, so headroom isn't waste there.

The gateway's cache is keyed by route × grid, so it does **not** grow with the
number of users — 20 tabs cost what one tab costs. Its limit is headroom for a
larger network: one `/items` payload measured 707 KB at 4,700 items and grows
linearly.

Two constraints are load-bearing, and both are commented in the manifest:

- **`ae2-gateway` must stay at `replicas: 1`.** Its read cache is in-process
  memory, so N replicas means N independent caches and N× the load on the
  Minecraft server — the opposite of the point. Scale `ae2-webui` instead; it's
  stateless.
- **Probes must target `/history/ping`.** Every other gateway route requires a
  valid mod token, so probing one would 401 and restart a healthy pod forever.

The gateway retries its schema migration for 60s, so it tolerates starting before
TimescaleDB is accepting connections.

## Container images

`.github/workflows/docker-publish.yml` builds and pushes to GHCR
(`ghcr.io/jdlovins/ae2-web-ui/webui` and `/gateway`) for `linux/amd64`. GHCR
rather than Docker Hub: free for public images, authenticated by the built-in
`GITHUB_TOKEN` with no secrets to configure, and no pull rate limits.

`linux/amd64` only, deliberately. The runners are amd64, so an arm64 image has
to be produced under QEMU emulation — and emulated Node is fragile: webui's
`npm ci` died there with `signal 4 (Illegal instruction)`. If you need arm64,
don't just re-add the platform: pin the Node build stage to
`--platform=$BUILDPLATFORM` (it emits static assets, so it never needs to be
emulated) or build on a native arm64 runner.

It only rebuilds what changed — a gateway-only edit doesn't pay for the webui's
50k-icon build — caches the atlas download between runs, and runs `npm run icons`
before the image build since the pack is gitignored.

> Untested end to end. It needs a repository you own; a fork of the mod repo
> won't grant `packages: write`.

## Troubleshooting

**Trends shows "No samples for grid …"**
The gateway is polling a different server than the SPA is talking to. Compare
`AE2_URL` with what the grid selector shows. The banner lists which grids it *is*
recording.

**Trends shows "Gateway's last poll failed: AUTH_FAILED: HTTP 400"**
Wrong `AE2_PASSWORD` (the mod answers 400 for a bad password). Fix `.env`, then
`docker compose up -d` — not `restart`.

**Ordering fails with `ITEM_NOT_FOUND`**
Should be fixed: the gateway repairs the mod's global stack map before forwarding
orders. If it recurs, check that `/order` is routed to the gateway and not
straight to the mod — `curl -D- localhost:8080/order` should return a
`WWW-Authenticate` header, which only the gateway sends.

**Everything 401s / you're asked to log in repeatedly**
`localStorage` is per-origin, so `:8080` and a dev server on `:5273` hold
separate sessions. Also note a Minecraft server restart invalidates all tokens;
the SPA re-authenticates itself from the cached password, and only shows the login
screen if the mod actively *rejects* the credentials.

**Icons missing for some items**
Expected for ~4% — entries the GTNH export omits. They render a glyph. If
*everything* is missing, `npm run icons` didn't run before the image build.

**Colours look wrong / chart legend keys are grey**
A dark-mode browser extension (e.g. Dark Reader) rewriting inline styles. The app
is already dark; allowlist it in the extension.

**The Minecraft server crashed**
Check the crash report for `pl.kuba6000.ae2webintegration` in the stack. On mod
builds with the tick-drain fix these surface as `ERROR` log lines instead —
"Server-thread task … failed" — and the server survives. If you get a genuine
crash, you're on an older jar; see the GTNH note above.

## Development

```bash
cd webui
npm ci
npm run icons                                   # once
AE2_TARGET=http://<mod-host>:<port> npm run dev # against a real server
npm run dev                                     # against canned mock data
```

Vite serves on `:5273`, proxies the API to `AE2_TARGET` (or the built-in mock),
and proxies `/history` to `127.0.0.1:8081` (override with `AE2_GATEWAY`). The
Trends view degrades to an explanatory empty state when the gateway is absent.

Note the mock is a convenience, not a faithful double: its `/gridsettings`
ignores auth, so the gateway's token check passes anything when pointed at it.
