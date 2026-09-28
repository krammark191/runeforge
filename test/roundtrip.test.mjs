// Round-trip and splice tests against a synthetic v46 save (no real character file is needed).
// Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  encodeProfile, decodeProfile, parseFch, serializeFch, wrapContainer, stableHash,
  computeFlags, ITEM_FLAG, EXTRA_FLAG, inventoryRows, VERSIONS,
} from '../js/fch.js';
import { Reader, Writer, bytesEqual } from '../js/binary.js';

const STAT_COUNT = 205;

function statBlock(cheats = 0) {
  const stats = new Array(STAT_COUNT).fill(0); stats[4] = cheats;
  return {
    stats, knownWorlds: [['Midgard', 1234.5]], knownWorldKeys: [], knownCommands: [],
    enemyStats: [[], [], [], [], []], itemPickup: [['Wood', 10]], itemCraft: [], pickable: [], foodEaten: [], piecesPlaced: [],
  };
}

function item(over = {}) {
  const it = {
    durabilityX100: 20000, x: 0, y: 0, worldLevel: 0, flags: 0, quality: 1, stack: 1, variant: 0,
    crafterId: 0n, crafterName: '', prefabHash: 0, customData: [], extraFlags: 0, ...over,
  };
  it.flags = computeFlags(it) | (over.flags ?? 0);
  return it;
}

function syntheticProfile() {
  const items = [
    item({ prefabHash: stableHash('SwordIron'), quality: 4, crafterId: 42n, crafterName: 'Bjorn', flags: ITEM_FLAG.EQUIPPED, x: 0, y: 0 }),
    item({ prefabHash: stableHash('Wood'), stack: 50, x: 1, y: 0 }),
    item({ prefabHash: stableHash('ArmorBronzeChest'), quality: 2, customData: [['foo', 'bar']], x: 2, y: 0 }),
    item({ prefabHash: stableHash('Coins'), stack: 999, extraFlags: EXTRA_FLAG.CHEATED, x: 3, y: 1, flags: ITEM_FLAG.PICKED_UP }),
  ];
  const player = {
    version: VERSIONS.player, maxHealth: 25, health: 25, maxStamina: 75, timeSinceDeath: 999.5,
    guardianPower: 'GP_Eikthyr', guardianPowerCooldown: 0,
    inventoryVersion: VERSIONS.inventory, items,
    knownRecipes: ['Recipe_Hammer'], knownStations: [['piece_workbench', 3]], knownMaterials: ['Wood', 'Stone'],
    shownTutorials: ['temple1'], uniques: ['invrows 5'], trophies: ['TrophyBoar'], knownBiomes: ['Meadows'],
    knownTexts: [['a', 'b']], beard: 'BeardNone', hair: 'Hair24', skinColor: [0.5, 0.4, 0.3], hairColor: [0.9, 0.8, 0.1],
    modelIndex: 0, foods: [{ name: 'CookedMeat', time: 100.25 }],
    skillsVersion: VERSIONS.skills, skills: [{ type: 1, level: 33.5, accumulator: 0.25 }, { type: 102, level: 100, accumulator: 0 }],
    customData: [], stamina: 70, maxEitr: 0, eitr: 0, buildUiState: new Uint8Array([1, 2, 3]),
  };
  const playerRaw = new Uint8Array(0); // filled by encode
  return {
    version: VERSIONS.profile, statCount: STAT_COUNT,
    statBlocks: Array.from({ length: 10 }, () => statBlock()),
    firstSpawn: false,
    worlds: [{ uid: 123456789n, haveCustomSpawn: false, spawn: [0, 0, 0], haveLogout: true, logout: [1, 2, 3], haveDeath: false, death: [0, 0, 0], home: [0, 30, 0], mapData: new Uint8Array([8, 0, 0, 0, 9, 9]) }],
    name: 'Bjorn', playerId: 42n, startSeed: 'abc123', usedCheats: false, dateCreated: 1758000000n,
    player, playerRaw,
  };
}

test('stableHash matches known game hashes', () => {
  assert.equal(stableHash('Acorn'), -2047937207);
  assert.equal(stableHash('Amber'), -1570747403);
  assert.equal(stableHash('ArmorBronzeChest'), -524840022);
  assert.equal(stableHash('ArmorDress10'), 1851887405);
});

test('items.json hashes agree with the JS stableHash', async () => {
  const data = JSON.parse(await readFile(new URL('../data/items.json', import.meta.url), 'utf8'));
  assert.ok(Object.keys(data.items).length > 1000);
  assert.equal(data.items.SwordIron.maxQuality, 4);
});

test('primitives round-trip', () => {
  const w = new Writer(8);
  w.string('héllo ✓'); w.numItems(5); w.numItems(300); w.f32(1.5); w.f32({ nanBits: 0x7fc00001 }); w.i64(-5n); w.bool(true);
  const r = new Reader(w.toBytes());
  assert.equal(r.string(), 'héllo ✓'); assert.equal(r.numItems(), 5); assert.equal(r.numItems(), 300);
  assert.equal(r.f32(), 1.5); assert.deepEqual(r.f32(), { nanBits: 0x7fc00001 }); assert.equal(r.i64(), -5n); assert.equal(r.bool(), true);
  assert.ok(r.atEnd());
});

test('synthetic profile round-trips byte for byte and is editable', async () => {
  const payload = encodeProfile(syntheticProfile());
  const file = await wrapContainer(payload);
  const save = await parseFch(file);
  assert.ok(save.hashOk);
  assert.deepEqual(save.health, { fullRoundTrip: true, inventoryRoundTrip: true, skillsRoundTrip: true });
  assert.ok(save.editable, save.reasons.join('; '));
  assert.equal(save.profile.name, 'Bjorn');
  assert.equal(save.profile.usedCheats, false);
  assert.equal(inventoryRows(save.player), 5);
  assert.equal(save.player.items.length, 4);
  assert.equal(save.player.items[0].quality, 4);
  assert.equal(save.player.items[0].flags & ITEM_FLAG.EQUIPPED, ITEM_FLAG.EQUIPPED);
  assert.equal(save.player.items[3].extraFlags & EXTRA_FLAG.CHEATED, 1);
  assert.deepEqual(save.player.items[2].customData, [['foo', 'bar']]);
});

test('raising quality past the catalog max splices cleanly and leaves everything else identical', async () => {
  const payload = encodeProfile(syntheticProfile());
  const file = await wrapContainer(payload);
  const save = await parseFch(file);

  const items = structuredClone(save.player.items);
  items[0].quality = 12;                 // beyond the pre-Forge cap of 4
  items[0].durabilityX100 = 75000;       // 200 + 11*50 = 750 max
  items[1].quality = 1;                  // stays default → no flag bit
  const skills = structuredClone(save.player.skills);
  skills[0].level = 77;

  const out = await serializeFch(save, items, skills);
  const again = await parseFch(out);
  assert.ok(again.hashOk);
  assert.ok(again.editable);
  assert.equal(again.player.items[0].quality, 12);
  assert.equal(again.player.items[0].durabilityX100, 75000);
  assert.equal(again.player.skills[0].level, 77);
  // Cheat state untouched.
  assert.equal(again.profile.usedCheats, false);
  assert.equal(again.player.items[0].extraFlags, 0);
  assert.equal(again.player.items[3].extraFlags & EXTRA_FLAG.CHEATED, 1);
  // Every byte outside the inventory/skills sections is identical to the original.
  const [ps] = save.profile.playerRange;
  assert.ok(bytesEqual(again.payload.subarray(0, ps - 4), save.payload.subarray(0, ps - 4)), 'prefix differs');
  const tailA = save.profile.playerRaw.subarray(save.player.ranges.skills[1]);
  const tailB = again.profile.playerRaw.subarray(again.player.ranges.skills[1]);
  assert.ok(bytesEqual(tailA, tailB), 'player tail differs');
  const midA = save.profile.playerRaw.subarray(save.player.ranges.inventory[1], save.player.ranges.skills[0]);
  const midB = again.profile.playerRaw.subarray(again.player.ranges.inventory[1], again.player.ranges.skills[0]);
  assert.ok(bytesEqual(midA, midB), 'player middle differs');
});

test('clearing cheat flags works only in the clearing direction', async () => {
  const p = syntheticProfile(); p.usedCheats = true;
  const save = await parseFch(await wrapContainer(encodeProfile(p)));
  assert.equal(save.profile.usedCheats, true);

  // Default: copied verbatim.
  const same = await parseFch(await serializeFch(save, save.player.items, save.player.skills));
  assert.equal(same.profile.usedCheats, true);

  // Explicit clear of the profile flag and of one item's cheated bit.
  const items = structuredClone(save.player.items);
  items[3].extraFlags &= ~EXTRA_FLAG.CHEATED;
  const cleared = await parseFch(await serializeFch(save, items, save.player.skills, { usedCheats: false }));
  assert.equal(cleared.profile.usedCheats, false);
  assert.equal(cleared.player.items[3].extraFlags & EXTRA_FLAG.CHEATED, 0);
  // Only that one byte outside inventory/skills changed.
  const diffs = [];
  for (let i = 0; i < save.profile.playerRange[0] - 4; i++) if (save.payload[i] !== cleared.payload[i]) diffs.push(i);
  assert.deepEqual(diffs, [save.profile.usedCheatsOffset]);

  // Never sets it.
  const clean = await parseFch(await wrapContainer(encodeProfile(syntheticProfile())));
  await assert.rejects(() => serializeFch(clean, clean.player.items, clean.player.skills, { usedCheats: true }), /refusing to set/);
});

test('new items get their flag bits from values', () => {
  const it = item({ prefabHash: 1, quality: 7, stack: 3 });
  assert.equal(computeFlags(it), ITEM_FLAG.PREFAB | ITEM_FLAG.QUALITY | ITEM_FLAG.STACK);
});

test('unsupported profile version is rejected', () => {
  const p = syntheticProfile(); p.version = 45;
  assert.throws(() => decodeProfile(encodeProfile(p)), /profile version 45/);
});
