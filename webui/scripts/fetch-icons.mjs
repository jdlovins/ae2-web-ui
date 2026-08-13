// Build the item icon pack from the GTNH Calculator's published data exports.
//
// Rather than rendering icons in-game, this pulls the two artifacts
// ShadowTheAge already publishes per pack version:
//
//   https://github.com/ShadowTheAge/gtnh-data   (branch per version)
//     atlas.webp  — every icon in one sprite sheet, 256 tiles per row
//     data.bin    — gzipped int32 table: item id -> tile index (iconId)
//
// Their item ids are "i:<modid>:<internalName>:<damage>", which is exactly the
// mod's own itemid ("modid:name:meta", see AEItemStackMixin.web$getItemID())
// with an "i:" prefix. So each tile can be written straight out as
// icons/<iconFileName(itemid)>.png and the web app finds it with no mapping
// table and no frontend changes.
//
// Fluids work out too: since GTNH 2.9 removed AE2FC fluid drops, fluids appear
// in the network directly and the mod reports them as a bare FluidRegistry name
// ("chlorine", "molten.naquadah"), which matches the GTNH record's internalName.
//
// Usage:
//   node scripts/fetch-icons.mjs                     # latest known version
//   node scripts/fetch-icons.mjs --version 2.8.0-v6
//   node scripts/fetch-icons.mjs --out ../somewhere --cache /tmp/gtnh
//   node scripts/fetch-icons.mjs --clean             # wipe stale PNGs first
//
// The full pack is ~48k files / ~49 MB. To ship only what a network actually
// contains, save its /items response and pass it to --only:
//
//   curl -H "Authorization: Bearer $TOKEN" http://10.10.10.100:65500/items > items.json
//   node scripts/fetch-icons.mjs --clean --only items.json
//
// --only also accepts a plain newline-separated list of itemids.
//
// Icons are NOT committed (see .gitignore); run this before `docker build`.

import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { gunzipSync, deflateSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { iconFileName } from '../src/lib/format.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Atlas geometry, mirroring export/IconAtlas.cs + AtlasBuilder.cs upstream:
// tiles are laid out 2^8 per row at 64px, then the whole sheet is saved at 50%.
const TILES_PER_ROW = 256;
const TILE = 32;
// export/MemoryMappedPackConverter.cs DATA_VERSION
const DATA_VERSION = 7;
// Field offsets inside a Goods record (src/repository.ts: id at +4, iconId at +9).
const OFF_ID = 4;
const OFF_INTERNAL_NAME = 7;
const OFF_ICON_ID = 9;

const DEFAULT_VERSION = '2.9.0-v7';
const REPO = 'ShadowTheAge/gtnh-data';

function parseArgs(argv) {
  const out = { version: DEFAULT_VERSION, out: resolve(ROOT, 'icons'), cache: resolve(ROOT, '.icon-cache'), clean: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--version') out.version = argv[++i];
    else if (a === '--out') out.out = resolve(process.cwd(), argv[++i]);
    else if (a === '--cache') out.cache = resolve(process.cwd(), argv[++i]);
    else if (a === '--clean') out.clean = true;
    else if (a === '--only') out.only = resolve(process.cwd(), argv[++i]);
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

const MB = (n) => `${(n / 1e6).toFixed(1)} MB`;

/** Download to `dest` unless it's already there with a non-zero size. */
async function fetchCached(url, dest) {
  const have = await stat(dest).catch(() => null);
  if (have?.size > 0) {
    console.log(`  cached  ${dest.replace(ROOT + '/', '')} (${MB(have.size)})`);
    return;
  }
  process.stdout.write(`  fetch   ${url} … `);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  const got = await stat(dest);
  console.log(MB(got.size));
}

/**
 * Read the (itemid -> iconId) table out of data.bin.
 *
 * Layout: gzipped little-endian int32 array. Slot 0 is the version, slots 1..7
 * are absolute int-indices ("refs") to the top-level tables. A list at p is
 * [count, ...refs]; a string at p is [byteLength, ...utf8 packed 4-per-int].
 */
function parseData(buf) {
  const raw = gunzipSync(buf);
  const e = new Int32Array(raw.buffer, raw.byteOffset, raw.byteLength >> 2);
  if (e[0] !== DATA_VERSION) {
    throw new Error(
      `data.bin is version ${e[0]}, this script understands ${DATA_VERSION}. ` +
        `Re-check export/MemoryMappedPackConverter.cs upstream and update DATA_VERSION / field offsets.`,
    );
  }
  const readString = (p) => {
    if (p === -1) return null;
    const len = e[p];
    const begin = p * 4 + 4;
    return raw.subarray(begin, begin + len).toString('utf8');
  };
  const readList = (p) => e.subarray(p + 1, p + 1 + e[p]);

  // Plain items win over NBT variants; an NBT variant is only a fallback for a
  // base itemid we'd otherwise have no icon for at all.
  const icons = new Map();
  const fallback = new Map();
  let items = 0;
  for (const ptr of readList(e[1])) {
    const id = readString(e[ptr + OFF_ID]);
    if (!id || !id.startsWith('i:')) continue;
    items++;
    const iconId = e[ptr + OFF_ICON_ID];
    // "i:mod:name:damage" or "i:mod:name:damage:<sha1 of nbt>"
    const parts = id.slice(2).split(':');
    const hasNbt = parts.length > 3;
    const itemid = parts.slice(0, 3).join(':');
    if (hasNbt) {
      if (!fallback.has(itemid)) fallback.set(itemid, iconId);
    } else {
      icons.set(itemid, iconId);
    }
  }
  let nbtFallbacks = 0;
  for (const [itemid, iconId] of fallback) {
    if (!icons.has(itemid)) { icons.set(itemid, iconId); nbtFallbacks++; }
  }

  // Fluids. GTNH 2.9 dropped AE2FC "fluid drop" items, so fluids now show up in
  // the network directly and the mod reports them as a bare Forge FluidRegistry
  // name with no colons at all ("chlorine", "molten.naquadah"). That name is
  // exactly the GTNH record's internalName, so key the file on it.
  let fluids = 0;
  for (const ptr of readList(e[2])) {
    const id = readString(e[ptr + OFF_ID]);
    if (!id || !id.startsWith('f:')) continue;
    const internalName = readString(e[ptr + OFF_INTERNAL_NAME]);
    if (!internalName) continue;
    // Items always contain colons and so always render with underscores; a bare
    // fluid name never can, so these two keyspaces can't collide. Still, don't
    // let a fluid clobber an item.
    if (icons.has(internalName)) continue;
    icons.set(internalName, e[ptr + OFF_ICON_ID]);
    fluids++;
  }

  return { icons, items, nbtFallbacks, fluids };
}

// --- minimal PNG writer (32x32 RGBA, no filtering) --------------------------
// sharp round-trips cost ~2ms/tile; this is ~0.2ms for ~10% more bytes, which
// matters across 50k tiles.
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(b) {
  let c = -1;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const STRIDE = TILE * 4;
function encodePng(rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(TILE, 0);
  ihdr.writeUInt32BE(TILE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const rows = Buffer.alloc(TILE * (1 + STRIDE));
  for (let y = 0; y < TILE; y++) {
    rows[y * (1 + STRIDE)] = 0; // filter: none
    rgba.copy(rows, y * (1 + STRIDE) + 1, y * STRIDE, y * STRIDE + STRIDE);
  }
  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Read a --only list: either the mod's /items JSON (raw array, or the
 * {status,data} envelope) or a newline-separated list of itemids.
 */
async function readOnlyList(path) {
  const { readFile } = await import('node:fs/promises');
  const text = (await readFile(path, 'utf8')).trim();
  let ids;
  if (text.startsWith('{') || text.startsWith('[')) {
    const json = JSON.parse(text);
    const arr = Array.isArray(json) ? json : json.data;
    if (!Array.isArray(arr)) throw new Error(`${path}: expected a JSON array of items or a {data:[...]} envelope`);
    ids = arr.map((it) => (typeof it === 'string' ? it : it?.itemid)).filter(Boolean);
  } else {
    ids = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  }
  if (!ids.length) throw new Error(`${path}: no itemids found`);
  return new Set(ids);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('node scripts/fetch-icons.mjs [--version <branch>] [--out <dir>] [--cache <dir>] [--only <items.json>] [--clean]');
    return;
  }

  console.log(`AE2 icon pack ← ${REPO} @ ${args.version}`);
  await mkdir(args.cache, { recursive: true });
  const dataPath = resolve(args.cache, `${args.version}-data.bin`);
  const atlasPath = resolve(args.cache, `${args.version}-atlas.webp`);
  const base = `https://raw.githubusercontent.com/${REPO}/${args.version}`;
  await fetchCached(`${base}/data.bin`, dataPath);
  await fetchCached(`${base}/atlas.webp`, atlasPath);

  console.log('parsing data.bin …');
  const { readFile } = await import('node:fs/promises');
  const { icons, items, nbtFallbacks, fluids } = parseData(await readFile(dataPath));
  console.log(
    `  ${items.toLocaleString()} item records + ${fluids.toLocaleString()} fluids → ` +
      `${icons.size.toLocaleString()} unique ids (${nbtFallbacks} via NBT-variant fallback)`,
  );

  if (args.only) {
    const keep = await readOnlyList(args.only);
    let missing = 0;
    for (const id of keep) if (!icons.has(id)) missing++;
    for (const id of icons.keys()) if (!keep.has(id)) icons.delete(id);
    console.log(
      `  --only ${args.only.replace(ROOT + '/', '')}: ${keep.size.toLocaleString()} requested → ` +
        `${icons.size.toLocaleString()} matched, ${missing.toLocaleString()} not in the GTNH data (glyph fallback)`,
    );
  }

  // sharp is only needed to decode the webp; keep the import lazy so --help and
  // a data-only run don't require the native module.
  let sharp;
  try {
    ({ default: sharp } = await import('sharp'));
  } catch {
    throw new Error("sharp is required to decode atlas.webp. Run 'npm install' in webui/ first.");
  }

  console.log('decoding atlas.webp …');
  const { data: atlas, info } = await sharp(atlasPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: aw, height: ah, channels: ch } = info;
  console.log(`  ${aw}×${ah}, ${ch} channels (${MB(atlas.length)} raw)`);
  const rows = Math.ceil(ah / TILE);

  if (args.clean) {
    const existing = (await readdir(args.out).catch(() => [])).filter((f) => f.endsWith('.png'));
    if (existing.length) {
      console.log(`cleaning ${existing.length.toLocaleString()} existing PNGs …`);
      await Promise.all(existing.map((f) => rm(resolve(args.out, f), { force: true })));
    }
  }
  await mkdir(args.out, { recursive: true });

  // Cut one tile out of the decoded atlas. Returns null for a tile that would
  // render as an empty or solid block, so the app shows its glyph instead:
  //
  //  - fully transparent: nothing was rendered for this icon upstream
  //  - a single uniform colour: an upstream render failure. Every such tile in
  //    2.9.0-v7 (8 of them, incl. the fluids squidink / molten.rubber /
  //    liquid_medium_oil) is opaque pure black, which on a dark UI reads as a
  //    broken tile — and unlike a 404 it would load fine and show nothing.
  const tile = Buffer.alloc(TILE * TILE * 4);
  let blankTransparent = 0, blankUniform = 0;
  function cut(iconId) {
    const col = iconId % TILES_PER_ROW;
    const row = Math.floor(iconId / TILES_PER_ROW);
    if (row >= rows) return null; // iconId past the end of this atlas
    const ox = col * TILE;
    const oy = row * TILE;
    let opaque = false;
    for (let y = 0; y < TILE; y++) {
      let s = ((oy + y) * aw + ox) * ch;
      let d = y * STRIDE;
      for (let x = 0; x < TILE; x++, s += ch, d += 4) {
        tile[d] = atlas[s];
        tile[d + 1] = atlas[s + 1];
        tile[d + 2] = atlas[s + 2];
        const a = ch === 4 ? atlas[s + 3] : 255;
        tile[d + 3] = a;
        if (a > 8) opaque = true;
      }
    }
    if (!opaque) { blankTransparent++; return null; }
    return tile;
  }

  console.log(`writing PNGs to ${args.out.replace(ROOT + '/', '')}/ …`);
  const started = Date.now();
  // Cache encoded bytes per iconId: distinct itemids often share one tile.
  const encoded = new Map();
  let written = 0, empty = 0, shared = 0, bytes = 0, n = 0;
  const pending = [];
  for (const [itemid, iconId] of icons) {
    if (++n % 10000 === 0) console.log(`  ${n.toLocaleString()}/${icons.size.toLocaleString()} …`);
    let png = encoded.get(iconId);
    if (png === undefined) {
      const rgba = cut(iconId);
      png = rgba ? encodePng(rgba) : null;
      encoded.set(iconId, png);
    } else if (png !== null) {
      shared++;
    }
    if (png === null) { empty++; continue; }
    written++;
    bytes += png.length;
    pending.push(writeFile(resolve(args.out, `${iconFileName(itemid)}.png`), png));
    if (pending.length >= 512) { await Promise.all(pending); pending.length = 0; }
  }
  await Promise.all(pending);

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `\ndone in ${secs}s — ${written.toLocaleString()} icons (${MB(bytes)}, ~${Math.round(bytes / Math.max(1, written))} B avg)` +
      `\n  ${empty.toLocaleString()} skipped as fully transparent → glyph fallback` +
      `\n  ${shared.toLocaleString()} itemids reused another itemid's tile`,
  );
  console.log(`\nServe check:  npx vite   → http://localhost:5273  (icons come from ${args.out.replace(ROOT + '/', '')}/)`);
}

main().catch((e) => {
  console.error(`\nfetch-icons failed: ${e.message}`);
  process.exit(1);
});
