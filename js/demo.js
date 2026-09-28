// A synthetic but structurally complete v46 character, used for the "Try a demo character" button
// and for exercising the UI without a real save.
import { encodeProfile, wrapContainer, stableHash, computeFlags, ITEM_FLAG, EXTRA_FLAG, VERSIONS } from './fch.js';

const STAT_COUNT = 205;

function statBlock() {
  const stats = new Array(STAT_COUNT).fill(0);
  stats[0] = 3; stats[6] = 412; stats[13] = 88;
  return {
    stats, knownWorlds: [['Demoheim', 36000]], knownWorldKeys: [], knownCommands: [],
    enemyStats: [[], [], [], [], []], itemPickup: [['Wood', 1200], ['Stone', 400]], itemCraft: [['SwordIron', 1]],
    pickable: [], foodEaten: [['CookedMeat', 40]], piecesPlaced: [['wood_wall', 120]],
  };
}

function item(prefab, over = {}) {
  const it = {
    durabilityX100: 10000, x: 0, y: 0, worldLevel: 0, flags: 0, quality: 1, stack: 1, variant: 0,
    crafterId: 0n, crafterName: '', prefabHash: stableHash(prefab), customData: [], extraFlags: 0, ...over,
  };
  it.flags = computeFlags(it) | (over.flags ?? 0);
  return it;
}

export async function demoFile() {
  const pid = 7734183920481n;
  const crafted = { crafterId: pid, crafterName: 'Sigrun' };
  const items = [
    item('SwordIron', { ...crafted, quality: 4, durabilityX100: 35000, flags: ITEM_FLAG.EQUIPPED, x: 0, y: 0 }),
    item('ShieldBanded', { ...crafted, quality: 3, durabilityX100: 30000, flags: ITEM_FLAG.EQUIPPED, x: 1, y: 0 }),
    item('BowHuntsman', { ...crafted, quality: 2, durabilityX100: 12000, x: 2, y: 0 }),
    item('PickaxeIron', { ...crafted, quality: 4, durabilityX100: 30000, x: 3, y: 0 }),
    item('AxeIron', { ...crafted, quality: 1, durabilityX100: 17500, x: 4, y: 0 }),
    item('Hammer', { ...crafted, quality: 3, durabilityX100: 20000, x: 6, y: 0 }),
    item('ArrowIron', { stack: 87, x: 7, y: 0 }),
    item('HelmetIron', { ...crafted, quality: 4, durabilityX100: 160000, flags: ITEM_FLAG.EQUIPPED, x: 0, y: 1 }),
    item('ArmorIronChest', { ...crafted, quality: 4, durabilityX100: 160000, flags: ITEM_FLAG.EQUIPPED, x: 1, y: 1 }),
    item('ArmorIronLegs', { ...crafted, quality: 3, durabilityX100: 140000, flags: ITEM_FLAG.EQUIPPED, x: 2, y: 1 }),
    item('CapeWolf', { ...crafted, quality: 2, durabilityX100: 120000, flags: ITEM_FLAG.EQUIPPED, x: 3, y: 1 }),
    item('Wood', { stack: 50, x: 0, y: 2 }),
    item('Stone', { stack: 50, x: 1, y: 2 }),
    item('Iron', { stack: 22, x: 2, y: 2 }),
    item('CookedMeat', { stack: 12, x: 3, y: 2 }),
    item('MeadHealthMedium', { stack: 6, x: 4, y: 2 }),
    item('Coins', { stack: 999, x: 7, y: 3, extraFlags: EXTRA_FLAG.CHEATED }), // a spawned stack, so the flag view has something to show
  ];
  const player = {
    version: VERSIONS.player, maxHealth: 25, health: 25, maxStamina: 75, timeSinceDeath: 5231.25,
    guardianPower: 'GP_Bonemass', guardianPowerCooldown: 0,
    inventoryVersion: VERSIONS.inventory, items,
    knownRecipes: ['Recipe_Hammer', 'Recipe_SwordIron'], knownStations: [['piece_workbench', 4], ['forge', 5]],
    knownMaterials: ['Wood', 'Stone', 'Iron'], shownTutorials: ['temple1'], uniques: ['invrows 4'],
    trophies: ['TrophyBoar', 'TrophyEikthyr'], knownBiomes: ['Meadows', 'BlackForest', 'Swamp'],
    knownTexts: [], beard: 'Beard5', hair: 'Hair14', skinColor: [0.72, 0.58, 0.45], hairColor: [0.62, 0.32, 0.12],
    modelIndex: 1, foods: [{ name: 'CookedMeat', time: 900 }],
    skillsVersion: VERSIONS.skills,
    skills: [
      { type: 1, level: 42.3, accumulator: 12.1 }, { type: 6, level: 31.7, accumulator: 3.3 }, { type: 8, level: 18.2, accumulator: 0.5 },
      { type: 7, level: 55.0, accumulator: 0 }, { type: 12, level: 27.9, accumulator: 4.4 }, { type: 13, level: 44.1, accumulator: 1 },
      { type: 100, level: 22.5, accumulator: 0 }, { type: 101, level: 14.0, accumulator: 0 }, { type: 102, level: 38.6, accumulator: 7.7 },
      { type: 103, level: 9.5, accumulator: 0 },
    ],
    customData: [], stamina: 75, maxEitr: 0, eitr: 0, buildUiState: new Uint8Array(0),
  };
  const profile = {
    version: VERSIONS.profile, statCount: STAT_COUNT, statBlocks: Array.from({ length: 10 }, statBlock),
    firstSpawn: false,
    worlds: [{ uid: 198234981234n, haveCustomSpawn: false, spawn: [0, 0, 0], haveLogout: true, logout: [120.5, 31.2, -88.7], haveDeath: true, death: [400, 12, 900], home: [0, 30, 0], mapData: null }],
    // usedCheats is set on the demo so the clear-flag controls have something to do.
    name: 'Sigrun', playerId: pid, startSeed: 'demoSeed', usedCheats: true, dateCreated: 1757900000n, player, playerRaw: null,
  };
  return wrapContainer(encodeProfile(profile));
}
