// Number / byte / time formatting and Minecraft §-color-code rendering.
// Ported and cleaned up from the original webpage.html.

const BYTE_UNIT = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB', 'BB'];
const BYTE_LIMIT = [1, 1024, 1048576, 1.073741824e9, 1.099511627776e12, 1.125899906842624e15, 1.152921504606847e18, 1.1805916207174113e21, 1.2089258196146292e24, 1.2379400392853803e27];

/** @param {number} n @param {number} format 0 Local 1 EN-US 2 Compact 3 Scientific 4 None */
export function formatNumber(n, format = 1) {
  n = Number(n);
  switch (format) {
    case 0: return n.toLocaleString();
    case 2: return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(n);
    case 3: return n.toExponential(3);
    case 4: return String(n);
    case 1:
    default: return n.toLocaleString('en-US');
  }
}

export function formatBytes(bytes) {
  bytes = Number(bytes);
  for (let i = 1; i < BYTE_LIMIT.length; i++) {
    if (bytes < BYTE_LIMIT[i]) {
      const v = bytes / BYTE_LIMIT[i - 1];
      return `${v.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${BYTE_UNIT[i - 1]}`;
    }
  }
  return `${bytes} B`;
}

export function formatTime(ms) {
  let s = Number(ms) / 1000;
  let unit = 's';
  if (s >= 60) { s /= 60; unit = 'm'; }
  if (s >= 60) { s /= 60; unit = 'h'; }
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(s) + unit;
}

export function formatPercent(p) {
  return new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 2 }).format(Number(p));
}

export function formatDateTime(ms) {
  return new Date(Number(ms)).toLocaleString();
}

const MC_COLORS = {
  0: '#000000', 1: '#0000AA', 2: '#00AA00', 3: '#00AAAA', 4: '#AA0000', 5: '#AA00AA',
  6: '#FFAA00', 7: '#AAAAAA', 8: '#555555', 9: '#5555FF', a: '#55FF55', b: '#55FFFF',
  c: '#FF5555', d: '#FF55FF', e: '#FFFF55', f: '#FFFFFF',
};

/** Strip §-codes, returning plain text (for sorting / titles / search). */
export function stripMc(name) {
  if (!name || name.indexOf('§') === -1) return name || '';
  let out = '';
  for (let i = 0; i < name.length; i++) {
    if (name[i] === '§') { i++; continue; }
    out += name[i];
  }
  return out;
}

/**
 * Parse §-codes into an array of styled segments:
 * [{ text, color?, bold, italic, underline, strike }]
 * Rendered by the McText component (no innerHTML needed).
 */
export function parseMc(name) {
  const segs = [];
  let cur = { text: '', color: null, bold: false, italic: false, underline: false, strike: false };
  const push = () => { if (cur.text) segs.push({ ...cur }); cur = { ...cur, text: '' }; };
  if (!name) return segs;
  for (let i = 0; i < name.length; i++) {
    const ch = name[i];
    if (ch === '§' && i + 1 < name.length) {
      const code = name[++i].toLowerCase();
      push();
      if (code in MC_COLORS) { cur = { text: '', color: MC_COLORS[code], bold: false, italic: false, underline: false, strike: false }; }
      else if (code === 'l') cur.bold = true;
      else if (code === 'o') cur.italic = true;
      else if (code === 'n') cur.underline = true;
      else if (code === 'm') cur.strike = true;
      else if (code === 'r') cur = { text: '', color: null, bold: false, italic: false, underline: false, strike: false };
      continue;
    }
    cur.text += ch;
  }
  push();
  return segs.length ? segs : [{ text: stripMc(name), color: null, bold: false, italic: false, underline: false, strike: false }];
}

/**
 * Is this entry a fluid rather than an item?
 *
 * The mod builds an item's id as "modid:name:meta"
 * (AEItemStackMixin.web$getItemID), but since GTNH 2.9 removed AE2FC's "fluid
 * drop" items, fluids sit in the network directly and report a bare
 * FluidRegistry name with no colons at all ("chlorine", "molten.naquadah").
 * That absence is the only reliable discriminator the API gives us.
 */
export function isFluidId(itemid) {
  return !!itemid && !itemid.includes(':');
}

/** Mod id portion of an itemid ("minecraft:iron_ingot" -> "minecraft"). */
export function modOf(itemid) {
  const i = (itemid || '').indexOf(':');
  return i === -1 ? '' : itemid.substring(0, i);
}

/**
 * Filesystem-safe icon filename for an itemid (modid:name:meta).
 * The client-side icon exporter MUST use this exact rule.
 * e.g. "gregtech:gt.metaitem.01:12321" -> "gregtech_gt.metaitem.01_12321"
 */
export function iconFileName(itemid) {
  return (itemid || '').replace(/[^A-Za-z0-9._-]+/g, '_');
}
