# Item icon pack

The web app requests item icons as static files at `/icons/<itemid>.png`, where
the filename comes from `iconFileName()` in `src/lib/format.js`
(`modid:name:meta` → `modid_name_meta`). Missing icons fall back to a glyph, so
a partial pack is fine.

The PNGs are **not committed** (`icons/*.png` is gitignored — the full pack is
~50k files). Generate them before building the image:

```bash
npm install
npm run icons
```

## Where they come from

`scripts/fetch-icons.mjs` pulls the two artifacts the
[GTNH Calculator](https://github.com/ShadowTheAge/gtnh) publishes per pack
version at [ShadowTheAge/gtnh-data](https://github.com/ShadowTheAge/gtnh-data)
(branch per version):

- `atlas.webp` — every icon in one sprite sheet, 256 tiles per row, 32px tiles
- `data.bin` — gzipped int32 table mapping each id to its tile index (`iconId`)

Their ids line up with ours with no mapping table:

| Kind | GTNH id | Mod's `itemid` | Icon file |
|---|---|---|---|
| Item | `i:minecraft:iron_ingot:0` | `minecraft:iron_ingot:0` | `minecraft_iron_ingot_0.png` |
| Fluid | `f:gregtech:chlorine` (internalName `chlorine`) | `chlorine` | `chlorine.png` |

Items are `i:<modid>:<internalName>:<damage>`, which is exactly what
`AEItemStackMixin.web$getItemID()` produces with an `i:` prefix.

Fluids need the `internalName` rather than the full id: GTNH 2.9 removed AE2FC
"fluid drop" items, so fluids now sit in the network directly and the mod
reports them as a bare Forge FluidRegistry name with no colons at all
(`chlorine`, `molten.naquadah`, `hydrochloricacid_gt5u`). Because item filenames
always contain underscores from their colons and bare fluid names never do, the
two keyspaces can't collide.

## Options

```bash
npm run icons -- --version 2.8.0-v6   # a different pack version (branch name)
npm run icons -- --clean              # delete stale PNGs first
npm run icons -- --out ../elsewhere   # write somewhere else
```

The full pack is ~50k files / ~50 MB, which is a lot of image layer for a
network holding a few thousand items. To ship only what a network actually
contains, save its `/items` response and pass it to `--only`:

```bash
curl -H "Authorization: Bearer $TOKEN" http://<mod-host>:<port>/items > items.json
npm run icons -- --clean --only items.json
```

`--only` also accepts a plain newline-separated list of itemids.

## Coverage

Measured against a live GTNH 2.9 network (4,567 distinct ids): **95.9%**, with
395 of 395 fluids resolved. The rest are items the GTNH export omits or bans
(mostly GregTech tool/spray-can variants and spawn eggs), and all fall back to
the glyph.

Only **fully transparent** tiles are skipped (37 in `2.9.0-v7`) — nothing was
rendered for them upstream, so the glyph is the best available.

Single-colour tiles are **kept**, deliberately. GTNH draws fluid icons as flat
colour swatches, so a black fluid is legitimately a solid black square. All 8
uniform tiles in `2.9.0-v7` are genuinely black substances — the five oils,
Molten Black Dwarf Matter, Squid Ink and Molten Rubber — and an earlier version
of this script wrongly discarded them as "render failures".

A missing icon must 404. Both nginx (`try_files $uri =404`) and the dev-server
middleware in `vite.config.js` do this — returning a placeholder image instead
silently defeats `ItemIcon.svelte`'s `<img onerror>` glyph fallback.

## Alternative: render them yourself

`../../icon-exporter/` is a small client-side Forge mod that renders icons from
a live game instance instead. It needs a build toolchain and a running client,
but it captures *everything* in your exact pack, including items missing from
the GTNH export. Both produce the same filenames, so the outputs are
interchangeable and can be layered.
