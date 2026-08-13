// Canned data for local development, shaped exactly like the mod's JSON API.
// Item names may contain Minecraft section-sign color codes (e.g. §b) to
// exercise the color parser.

let hash = 1000;
const h = () => ++hash;

function item(itemid, itemname, quantity, craftable) {
  return { itemid, itemname, quantity, craftable, hashcode: h() };
}

export const ITEMS = [
  item('appliedenergistics2:item.ItemMultiMaterial:0', 'Certus Quartz Crystal', 12480, false),
  item('appliedenergistics2:item.ItemMultiMaterial:7', 'Fluix Crystal', 3204, true),
  item('appliedenergistics2:item.ItemMultiMaterial:8', 'Pure Fluix Crystal', 96, true),
  item('appliedenergistics2:item.ItemMultiMaterial:22', '§bLogic Processor', 512, true),
  item('appliedenergistics2:item.ItemMultiMaterial:23', '§bCalculation Processor', 384, true),
  item('appliedenergistics2:item.ItemMultiMaterial:24', '§bEngineering Processor', 128, true),
  item('minecraft:iron_ingot', 'Iron Ingot', 40960, true),
  item('minecraft:gold_ingot', 'Gold Ingot', 1024, true),
  item('minecraft:diamond', '§dDiamond', 233, false),
  item('minecraft:redstone', 'Redstone Dust', 99999, false),
  item('minecraft:glowstone_dust', 'Glowstone Dust', 8640, false),
  item('minecraft:coal', 'Coal', 20480, false),
  item('IC2:itemPurifiedCrushedIronOre', 'Purified Crushed Iron Ore', 15000, true),
  item('gregtech:gt.metaitem.01:11020', '§6Aluminium Dust', 5120, true),
  item('gregtech:gt.metaitem.01:11046', '§7Titanium Dust', 640, true),
  item('gregtech:gt.metaitem.01:17324', '§5Tungstensteel Ingot', 256, true),
  item('gregtech:gt.blockmachines:32', '§eLV Circuit Assembler', 4, true),
  item('minecraft:cobblestone', 'Cobblestone', 524288, false),
  item('minecraft:sand', 'Sand', 65536, false),
  item('minecraft:gravel', 'Gravel', 32768, false),
  item('minecraft:oak_log', 'Oak Log', 8192, false),
  item('minecraft:oak_planks', 'Oak Planks', 16384, true),
  item('minecraft:stick', 'Stick', 40000, true),
  item('minecraft:glass', '§fGlass', 12000, true),
  item('minecraft:emerald', '§aEmerald', 512, false),
  item('minecraft:lapis_lazuli', '§1Lapis Lazuli', 4096, false),
  item('minecraft:ender_pearl', '§5Ender Pearl', 320, true),
  item('minecraft:blaze_powder', '§6Blaze Powder', 1536, true),
  item('minecraft:nether_star', '§l§eNether Star', 3, true),
  item('ae2fc:fluid_drop:0', '§9Water (drop)', 8200000, false),
  item('ae2fc:fluid_drop:0', '§6Lava (drop)', 512000, false),
  item('thaumcraft:ItemResource:14', '§5Vis Crystal', 777, true),
];

export const GRIDS = [
  { key: 100234, cpuCount: 4, owner: 'josh', isOwned: true, isTrackingEnabled: true },
  { key: 100999, cpuCount: 2, owner: 'steve', isOwned: false, isTrackingEnabled: false },
  { key: -1, cpuCount: 1, owner: 'N/A', isOwned: false, isTrackingEnabled: false },
];

function out(itemid, itemname, quantity) {
  return { itemid, itemname, quantity, hashcode: h() };
}

export const CPUS = {
  'CPU #1': {
    finalOutput: out('appliedenergistics2:item.ItemMultiMaterial:8', 'Pure Fluix Crystal', 64),
    usedStorage: 3_500_000,
    availableStorage: 8_388_608,
    coProcessors: 4,
  },
  'CPU #2': {
    finalOutput: null,
    usedStorage: -1,
    availableStorage: 8_388_608,
    coProcessors: 8,
  },
  'Big Bertha': {
    finalOutput: out('minecraft:nether_star', '§l§eNether Star', 2),
    usedStorage: 41_000_000,
    availableStorage: 67_108_864,
    coProcessors: 32,
  },
  'CPU #4': {
    finalOutput: null,
    usedStorage: -1,
    availableStorage: 2_097_152,
    coProcessors: 0,
  },
};

export function cpuDetail(name) {
  const cpu = CPUS[name];
  if (!cpu || !cpu.finalOutput) {
    return { finalOutput: null, hasTrackingInfo: false, items: [] };
  }
  return {
    finalOutput: cpu.finalOutput,
    hasTrackingInfo: true,
    items: [
      {
        itemid: 'appliedenergistics2:item.ItemMultiMaterial:7', itemname: 'Fluix Crystal',
        active: 12, pending: 240, stored: 3204, hashcode: h(),
        timeSpentCrafting: 41000, craftedTotal: 8600, shareInCraftingTimeCombined: 0.42, craftsPerSec: 21.4,
      },
      {
        itemid: 'minecraft:redstone', itemname: 'Redstone Dust',
        active: 0, pending: 64, stored: 99999, hashcode: h(),
        timeSpentCrafting: 15000, craftedTotal: 4096, shareInCraftingTimeCombined: 0.18, craftsPerSec: 12.1,
      },
      {
        itemid: 'appliedenergistics2:item.ItemMultiMaterial:8', itemname: 'Pure Fluix Crystal',
        active: 4, pending: 0, stored: 60, hashcode: h(),
        timeSpentCrafting: 60000, craftedTotal: 64, shareInCraftingTimeCombined: 0.40, craftsPerSec: 1.1,
      },
    ],
  };
}

export function craftingPlan() {
  return {
    isDone: true,
    isSimulating: false,
    bytesTotal: 40960,
    plan: [
      { itemid: 'appliedenergistics2:item.ItemMultiMaterial:8', itemname: 'Pure Fluix Crystal', missing: 0, requested: 64, steps: 64, stored: 0, usedPercent: 0 },
      { itemid: 'appliedenergistics2:item.ItemMultiMaterial:7', itemname: 'Fluix Crystal', missing: 0, requested: 128, steps: 32, stored: 3204, usedPercent: 0.04 },
      { itemid: 'minecraft:redstone', itemname: 'Redstone Dust', missing: 0, requested: 0, steps: 0, stored: 99999, usedPercent: 0.0006 },
      { itemid: 'minecraft:diamond', itemname: '§dDiamond', missing: 12, requested: 0, steps: 0, stored: 0, usedPercent: 0 },
      { itemid: 'appliedenergistics2:item.ItemMultiMaterial:0', itemname: 'Certus Quartz Crystal', missing: 0, requested: 0, steps: 0, stored: 12480, usedPercent: 0.01 },
    ],
  };
}

const now = Date.now();
export const HISTORY = [
  { id: 1, finalOutput: out('minecraft:nether_star', '§l§eNether Star', 2), wasCancelled: false, timeStarted: now - 3_600_000, timeDone: now - 3_300_000 },
  { id: 2, finalOutput: out('appliedenergistics2:item.ItemMultiMaterial:24', '§bEngineering Processor', 128), wasCancelled: false, timeStarted: now - 86_400_000, timeDone: now - 86_100_000 },
  { id: 3, finalOutput: out('gregtech:gt.metaitem.01:17324', '§5Tungstensteel Ingot', 256), wasCancelled: true, timeStarted: now - 172_800_000, timeDone: now - 172_700_000 },
];

export function trackingData(id) {
  const entry = HISTORY.find((e) => e.id === Number(id)) || HISTORY[0];
  const t0 = entry.timeStarted;
  return {
    finalOutput: entry.finalOutput,
    wasCancelled: entry.wasCancelled,
    timeStarted: entry.timeStarted,
    timeDone: entry.timeDone,
    items: [
      { itemid: 'appliedenergistics2:item.ItemMultiMaterial:7', itemname: 'Fluix Crystal', craftedTotal: 8600, timeSpentOn: 120000, shareInCraftingTimeCombined: 0.42, craftsPerSec: 21.4, timings: [{ started: t0 + 1000, ended: t0 + 60000 }, { started: t0 + 90000, ended: t0 + 150000 }] },
      { itemid: 'minecraft:redstone', itemname: 'Redstone Dust', craftedTotal: 4096, timeSpentOn: 60000, shareInCraftingTimeCombined: 0.18, craftsPerSec: 12.1, timings: [{ started: t0 + 2000, ended: t0 + 50000 }] },
      { itemid: 'appliedenergistics2:item.ItemMultiMaterial:8', itemname: 'Pure Fluix Crystal', craftedTotal: 64, timeSpentOn: 90000, shareInCraftingTimeCombined: 0.40, craftsPerSec: 1.1, timings: [{ started: t0 + 60000, ended: t0 + 150000 }] },
    ],
    interfaceShare: [
      { name: 'Interface A', location: [{ dimid: 0, x: 100, y: 64, z: -220 }], timings: [{ started: t0 + 1000, ended: t0 + 80000 }] },
      { name: 'Interface B', location: [{ dimid: 0, x: 104, y: 64, z: -220 }], timings: [{ started: t0 + 5000, ended: t0 + 150000 }] },
    ],
  };
}

// A tiny 2x2 PNG (teal) used as a placeholder item icon in dev.
export const PLACEHOLDER_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGNgYGD4z4AGmBhQAQMDAwAMBwEBQOZ2vwAAAABJRU5ErkJggg==';
