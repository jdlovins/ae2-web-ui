# AE2 Icon Exporter (client-side, 1.7.10)

> **You probably don't need this.** `cd webui && npm run icons` downloads a
> ready-made icon pack from the GTNH Calculator's published data and covers
> ~96% of a live GTNH 2.9 network in about 10 seconds, with no build toolchain
> and no game client. See [`webui/icons/README.md`](../webui/icons/README.md).
>
> Use this exporter when you need the rest: it renders from your exact pack, so
> it catches items the GTNH export omits or bans. Both paths write the same
> filenames, so you can run this afterwards to fill the gaps.

The dedicated server can't render item icons (no GPU/atlas, and GregTech items
are drawn procedurally). This tiny **client** mod renders every item to a PNG so
the web terminal can show real icons.

It writes one transparent PNG per item, named by the **same itemid** the web API
uses — `modid:name:meta` → `modid_name_meta.png` (e.g. `minecraft_paper_0.png`,
`gregtech_gt.metaitem.01_12321.png`). That's exactly what the web app requests at
`/icons/<name>.png`, so no mapping table is needed.

## Build

Easiest path — reuse GTNH's proven 1.7.10 build harness:

1. Clone the template:
   ```bash
   git clone https://github.com/GTNewHorizons/ExampleMod1.7.10 ae2iconexporter
   cd ae2iconexporter
   ```
2. Delete the example sources under `src/main/java/...` and drop in
   [`IconExporterMod.java`](IconExporterMod.java) (keep its package
   `pl.kuba6000.ae2iconexporter`, or change it — just keep the file together).
3. Build:
   ```bash
   ./gradlew build      # Windows: gradlew.bat build
   ```
   The mod jar lands in `build/libs/`.

(You need a JDK the GTNH toolchain accepts — Java 17 works with the current
RetroFuturaGradle. First build downloads the deobf Minecraft; needs internet.)

## Run

1. Put the built jar in your **client**'s `mods/` folder (the same GTNH pack).
2. Launch the client and **load any world** (single-player is fine — icons need a
   live GL context + stitched textures).
3. Run the command in chat:
   ```
   /ae2icons          # 64px icons (default)
   /ae2icons 32       # optional size, 16–256
   ```
   The game may freeze for ~30–60s while it renders thousands of items.
4. Icons are written to `<your minecraft instance>/ae2icons/`.

## Hand off the pack

Zip the `ae2icons` folder and either:
- drop its PNGs into `webui/icons/` in this repo (they get baked into the Docker
  image and served at `/icons/`), or
- mount the folder into the container at `/usr/share/nginx/html/icons/`.

That's it — refresh the web terminal and items show real icons. Missing icons
fall back to a glyph automatically, so a partial pack is fine.

## Notes / troubleshooting
- If icons come out upside-down or empty, it's a GL quirk of the pack; ping me
  and it's a one-line flip/blend tweak in `renderStack`.
- Re-run any time (e.g. after adding mods) to refresh the pack.
