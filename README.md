# AE2 Web Terminal

A web UI for the [AE2 Web Integration](https://github.com/kuba6000/AE2-Web-Integration)
Minecraft mod. Browse an ME network, request crafts, watch crafting CPUs, and
chart inventory levels over time.

![three containers: webui, gateway, timescale](https://img.shields.io/badge/deploy-docker%20compose-blue)

```bash
cp .env.example .env      # set AE2_URL and AE2_PASSWORD
cd webui && npm ci && npm run icons && cd ..
docker compose up -d --build
open http://localhost:8080
```

## What's here

| | |
|---|---|
| **[ARCHITECTURE.md](ARCHITECTURE.md)** | How it works and why — the caching gateway, the auth model, the icon pipeline, the mod quirks worked around |
| **[DEPLOYMENT.md](DEPLOYMENT.md)** | Runbook: compose, Kubernetes, configuration, backups, troubleshooting |
| **[webui/icons/README.md](webui/icons/README.md)** | The item icon pack and how it's generated |
| **[gateway/README.md](gateway/README.md)** | The gateway service in detail |
| **[webui/REVIEW-NOTES.md](webui/REVIEW-NOTES.md)** | Known issues and deferred cleanups |

## Features

- **Items** — virtualised grid over the whole network (tested at ~4,700 items),
  search, sort, filters, real item icons
- **Crafting** — request a craft, review the plan, pick a CPU, watch progress
- **History** — per-job breakdown with item and interface timelines
- **Trends** — inventory levels over time, from a TimescaleDB time series

## Why there's a gateway and not just a static site

Every read route on the mod runs **inline on the Minecraft server tick**, and the
SPA polls a few of them. So load scaled with the number of open browser tabs —
three tabs on the Crafting view was roughly one tick-blocking request per second.

The gateway fronts those reads with a request-collapsing cache, making the mod's
load **O(1) in users** instead of O(users): 12 simultaneous `/items` reads become
one upstream fetch. It also records the inventory history that Trends charts,
which is nearly free since it already sees every `/items` payload.

The mod itself is not in this repo — point `AE2_URL` at a server running it.
