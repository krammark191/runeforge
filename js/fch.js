// Valheim .fch (player profile) codec for game 1.0.x:
//   profile v46 · player data v33 · inventory v109 · skills v2
//
// Saving is done by SPLICING: only the inventory and skills sections are re-encoded and
// written back into the original bytes; every other byte of the file is kept exactly as
// the game wrote it. The whole file is still fully decoded so the UI can show it, and the
// full decode is round-trip checked as a health signal for the codec.
//
// Cheat state: the profile's `usedCheats` bool and each item's `extraFlags` bit 0 (cheated)
// are copied verbatim by default. The only way either changes is an explicit request:
// `serializeFch(..., { usedCheats: false })` patches that single byte, and clearing an item's
// bit is an ordinary item edit made by the UI. Nothing here ever SETS a cheat flag.

import { Reader, Writer, FormatError, bytesEqual, concat } from './binary.js';

export const VERSIONS = { profile: 46, player: 33, inventory: 109, skills: 2 };

export const ITEM_FLAG = {
  PICKED_UP: 0x01, EQUIPPED: 0x02, QUALITY: 0x04, STACK: 0x08,
  VARIANT: 0x10, CRAFTER: 0x20, PREFAB: 0x40, CUSTOM_DATA: 0x80,
};
export const EXTRA_FLAG = { CHEATED: 0x01 };

export const SKILL_NAMES = {
  1: 'Swords', 2: 'Knives', 3: 'Clubs', 4: 'Polearms', 5: 'Spears', 6: 'Blocking', 7: 'Axes', 8: 'Bows',
  9: 'Elemental Magic', 10: 'Blood Magic', 11: 'Unarmed', 12: 'Pickaxes', 13: 'Wood Cutting', 14: 'Crossbows',
  100: 'Jump', 101: 'Sneak', 102: 'Run', 103: 'Swim', 104: 'Fishing', 105: 'Cooking', 106: 'Farming',
  107: 'Crafting', 108: 'Dodge', 110: 'Ride',
};

export const STAT_CHEATS = 4; // PlayerStatType.Cheats

export class UnsupportedVersion extends Error {
  constructor(message) { super(message); this.name = 'UnsupportedVersion'; }
}

// ---------------------------------------------------------------- hashing

export async function sha512(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-512', bytes));
}

// Valheim's GetStableHashCode over UTF-16 code units, int32 wrap-around.
export function stableHash(s) {
  let a = 5381, b = 5381;
  const n = s.length;
  for (let i = 0; i < n && s.charCodeAt(i) !== 0; i += 2) {
    a = (((a << 5) + a) ^ s.charCodeAt(i)) | 0;
    if (i === n - 1 || s.charCodeAt(i + 1) === 0) break;
    b = (((b << 5) + b) ^ s.charCodeAt(i + 1)) | 0;
  }
  return (a + Math.imul(b, 1566083941)) | 0;
}

// ---------------------------------------------------------------- container

export function splitContainer(fileBytes) {
  const r = new Reader(fileBytes);
  const payloadLength = r.count(1);
  const payloadStart = r.pos;
  const payload = r.raw(payloadLength);
  const hashLength = r.count(1);
  const hash = r.raw(hashLength);
  if (!r.atEnd()) throw r.error(`${r.remaining} unexpected bytes after hash`);
  return { payload, payloadStart, hash };
}

export async function wrapContainer(payload) {
  const w = new Writer(payload.length + 80);
  w.bytes(payload);
  w.bytes(await sha512(payload));
  return w.toBytes();
}

// ---------------------------------------------------------------- inventory

export function decodeItem(r) {
  const item = {
    durabilityX100: r.i32(), x: r.u8(), y: r.u8(), worldLevel: r.u8(), flags: r.u8(),
    quality: 1, stack: 1, variant: 0, crafterId: 0n, crafterName: '', prefabHash: 0, customData: [], extraFlags: 0,
  };
  const f = item.flags;
  if (f & ITEM_FLAG.QUALITY) item.quality = r.u16();
  if (f & ITEM_FLAG.STACK) item.stack = r.u16();
  if (f & ITEM_FLAG.VARIANT) item.variant = r.i32();
  if (f & ITEM_FLAG.CRAFTER) { item.crafterId = r.i64(); item.crafterName = r.string(); }
  if (f & ITEM_FLAG.PREFAB) item.prefabHash = r.i32();
  if (f & ITEM_FLAG.CUSTOM_DATA) {
    const at = r.offset; const n = r.numItems();
    if (n * 2 > r.remaining) throw r.error(`implausible custom data count ${n}`, at);
    for (let i = 0; i < n; i++) item.customData.push([r.string(), r.string()]);
  }
  item.extraFlags = r.u8();
  return item;
}

// Flags are derived from values exactly the way the game does it, so an edit that turns a
// default value into a non-default one (quality 1 → 5) gets its flag bit automatically.
export function computeFlags(item) {
  let f = item.flags & (ITEM_FLAG.PICKED_UP | ITEM_FLAG.EQUIPPED);
  if (item.quality !== 1) f |= ITEM_FLAG.QUALITY;
  if (item.stack !== 1) f |= ITEM_FLAG.STACK;
  if (item.variant !== 0) f |= ITEM_FLAG.VARIANT;
  if (BigInt(item.crafterId) !== 0n) f |= ITEM_FLAG.CRAFTER;
  if (item.prefabHash !== 0) f |= ITEM_FLAG.PREFAB;
  if (item.customData.length > 0) f |= ITEM_FLAG.CUSTOM_DATA;
  return f;
}

export function encodeItem(w, item) {
  const f = computeFlags(item);
  if (item.quality < 0 || item.quality > 0xffff) throw new RangeError(`quality ${item.quality} out of u16 range`);
  if (item.stack < 0 || item.stack > 0xffff) throw new RangeError(`stack ${item.stack} out of u16 range`);
  w.i32(item.durabilityX100);
  w.u8(item.x); w.u8(item.y); w.u8(item.worldLevel); w.u8(f);
  if (f & ITEM_FLAG.QUALITY) w.u16(item.quality);
  if (f & ITEM_FLAG.STACK) w.u16(item.stack);
  if (f & ITEM_FLAG.VARIANT) w.i32(item.variant);
  if (f & ITEM_FLAG.CRAFTER) { w.i64(item.crafterId); w.string(item.crafterName); }
  if (f & ITEM_FLAG.PREFAB) w.i32(item.prefabHash);
  if (f & ITEM_FLAG.CUSTOM_DATA) {
    w.numItems(item.customData.length);
    for (const [k, v] of item.customData) { w.string(k); w.string(v); }
  }
  w.u8(item.extraFlags);
}

export function decodeInventory(r) {
  const at = r.offset;
  const version = r.i32();
  if (version !== VERSIONS.inventory) throw new UnsupportedVersion(`inventory version ${version} at 0x${at.toString(16)}, supported ${VERSIONS.inventory}`);
  const countAt = r.offset;
  const n = r.u16();
  if (n * 9 > r.remaining) throw r.error(`implausible item count ${n}`, countAt);
  const items = [];
  for (let i = 0; i < n; i++) items.push(r.scope(`items[${i}]`, () => decodeItem(r)));
  return { version, items };
}

export function encodeInventory(version, items) {
  const w = new Writer();
  w.i32(version);
  if (items.length > 0xffff) throw new RangeError('too many items');
  w.u16(items.length);
  for (const it of items) encodeItem(w, it);
  return w.toBytes();
}

// ---------------------------------------------------------------- skills

export function decodeSkills(r) {
  const at = r.offset;
  const version = r.i32();
  if (version !== VERSIONS.skills) throw new UnsupportedVersion(`skills version ${version} at 0x${at.toString(16)}, supported ${VERSIONS.skills}`);
  const n = r.count(12);
  const skills = [];
  for (let i = 0; i < n; i++) skills.push({ type: r.i32(), level: r.f32(), accumulator: r.f32() });
  return { version, skills };
}

export function encodeSkills(version, skills) {
  const w = new Writer();
  w.i32(version);
  w.i32(skills.length);
  for (const s of skills) { w.i32(s.type); w.f32(s.level); w.f32(s.accumulator); }
  return w.toBytes();
}

// ---------------------------------------------------------------- player blob (v33)

export function decodePlayer(bytes, base = 0) {
  const r = new Reader(bytes, base);
  return r.scope('player', () => {
    const p = {};
    p.version = r.i32();
    if (p.version !== VERSIONS.player) throw new UnsupportedVersion(`player data version ${p.version}, supported ${VERSIONS.player}`);
    p.maxHealth = r.f32(); p.health = r.f32(); p.maxStamina = r.f32(); p.timeSinceDeath = r.f32();
    p.guardianPower = r.string(); p.guardianPowerCooldown = r.f32();
    const invStart = r.pos;
    const inv = r.scope('inventory', () => decodeInventory(r));
    p.inventoryVersion = inv.version; p.items = inv.items;
    const invEnd = r.pos;
    p.knownRecipes = r.strings();
    p.knownStations = r.scope('knownStations', () => { const n = r.count(5); const o = []; for (let i = 0; i < n; i++) o.push([r.string(), r.i32()]); return o; });
    p.knownMaterials = r.strings(); p.shownTutorials = r.strings(); p.uniques = r.strings();
    p.trophies = r.strings(); p.knownBiomes = r.strings(); p.knownTexts = r.stringPairs();
    p.beard = r.string(); p.hair = r.string(); p.skinColor = r.vec3(); p.hairColor = r.vec3(); p.modelIndex = r.i32();
    p.foods = r.scope('foods', () => { const n = r.count(5); const o = []; for (let i = 0; i < n; i++) o.push({ name: r.string(), time: r.f32() }); return o; });
    const skStart = r.pos;
    const sk = r.scope('skills', () => decodeSkills(r));
    p.skillsVersion = sk.version; p.skills = sk.skills;
    const skEnd = r.pos;
    p.customData = r.stringPairs();
    p.stamina = r.f32(); p.maxEitr = r.f32(); p.eitr = r.f32();
    p.buildUiState = r.bytes();
    if (!r.atEnd()) throw r.error(`${r.remaining} unexpected bytes after player data`);
    p.ranges = { inventory: [invStart, invEnd], skills: [skStart, skEnd] };
    return p;
  });
}

export function encodePlayer(p) {
  const w = new Writer(4096);
  w.i32(p.version);
  for (const v of [p.maxHealth, p.health, p.maxStamina, p.timeSinceDeath]) w.f32(v);
  w.string(p.guardianPower); w.f32(p.guardianPowerCooldown);
  w.raw(encodeInventory(p.inventoryVersion, p.items));
  w.strings(p.knownRecipes);
  w.i32(p.knownStations.length); for (const [n, l] of p.knownStations) { w.string(n); w.i32(l); }
  for (const l of [p.knownMaterials, p.shownTutorials, p.uniques, p.trophies, p.knownBiomes]) w.strings(l);
  w.stringPairs(p.knownTexts);
  w.string(p.beard); w.string(p.hair); w.vec3(p.skinColor); w.vec3(p.hairColor); w.i32(p.modelIndex);
  w.i32(p.foods.length); for (const f of p.foods) { w.string(f.name); w.f32(f.time); }
  w.raw(encodeSkills(p.skillsVersion, p.skills));
  w.stringPairs(p.customData);
  for (const v of [p.stamina, p.maxEitr, p.eitr]) w.f32(v);
  w.bytes(p.buildUiState);
  return w.toBytes();
}

// ---------------------------------------------------------------- profile (v46)

function decodeStatBlock(r, statCount) {
  const b = {};
  b.stats = []; for (let i = 0; i < statCount; i++) b.stats.push(r.f32());
  b.knownWorlds = r.stringFloats(); b.knownWorldKeys = r.stringFloats(); b.knownCommands = r.stringFloats();
  const n = r.count(4); b.enemyStats = []; for (let i = 0; i < n; i++) b.enemyStats.push(r.stringFloats());
  b.itemPickup = r.stringFloats(); b.itemCraft = r.stringFloats(); b.pickable = r.stringFloats();
  b.foodEaten = r.stringFloats(); b.piecesPlaced = r.stringFloats();
  return b;
}

function encodeStatBlock(w, b) {
  for (const v of b.stats) w.f32(v);
  w.stringFloats(b.knownWorlds); w.stringFloats(b.knownWorldKeys); w.stringFloats(b.knownCommands);
  w.i32(b.enemyStats.length); for (const d of b.enemyStats) w.stringFloats(d);
  for (const d of [b.itemPickup, b.itemCraft, b.pickable, b.foodEaten, b.piecesPlaced]) w.stringFloats(d);
}

function decodeWorld(r) {
  const wd = { uid: r.i64() };
  wd.haveCustomSpawn = r.bool(); wd.spawn = r.vec3();
  wd.haveLogout = r.bool(); wd.logout = r.vec3();
  wd.haveDeath = r.bool(); wd.death = r.vec3();
  wd.home = r.vec3();
  wd.mapData = r.bool() ? r.bytes() : null;
  return wd;
}

function encodeWorld(w, wd) {
  w.i64(wd.uid);
  w.bool(wd.haveCustomSpawn); w.vec3(wd.spawn);
  w.bool(wd.haveLogout); w.vec3(wd.logout);
  w.bool(wd.haveDeath); w.vec3(wd.death);
  w.vec3(wd.home);
  w.bool(wd.mapData !== null); if (wd.mapData !== null) w.bytes(wd.mapData);
}

export function decodeProfile(payload, base = 4) {
  const r = new Reader(payload, base);
  const p = {};
  p.version = r.i32();
  if (p.version !== VERSIONS.profile) throw new UnsupportedVersion(`profile version ${p.version}, supported ${VERSIONS.profile}`);
  p.statCount = r.count(4);
  const nb = r.count(1);
  p.statBlocks = []; for (let i = 0; i < nb; i++) p.statBlocks.push(r.scope(`statBlocks[${i}]`, () => decodeStatBlock(r, p.statCount)));
  p.firstSpawn = r.bool();
  const nw = r.count(46);
  p.worlds = []; for (let i = 0; i < nw; i++) p.worlds.push(r.scope(`worlds[${i}]`, () => decodeWorld(r)));
  p.name = r.string(); p.playerId = r.i64(); p.startSeed = r.string();
  p.usedCheatsOffset = r.pos; // relative to payload; the one byte outside inventory/skills the splicer may patch
  p.usedCheats = r.bool(); p.dateCreated = r.i64();
  p.playerRaw = null; p.playerRange = null; p.player = null; p.playerError = null;
  if (r.bool()) {
    const len = r.count(1);
    const start = r.pos;
    p.playerRaw = r.raw(len);
    p.playerRange = [start, start + len]; // relative to payload
  }
  if (!r.atEnd()) throw r.error(`${r.remaining} unexpected bytes after profile`);
  if (p.playerRaw) {
    try { p.player = decodePlayer(p.playerRaw, base + p.playerRange[0]); }
    catch (e) { if (e instanceof FormatError || e instanceof UnsupportedVersion) p.playerError = e.message; else throw e; }
  }
  return p;
}

export function encodeProfile(p) {
  const w = new Writer(65536);
  w.i32(p.version); w.i32(p.statCount); w.i32(p.statBlocks.length);
  for (const b of p.statBlocks) encodeStatBlock(w, b);
  w.bool(p.firstSpawn);
  w.i32(p.worlds.length); for (const wd of p.worlds) encodeWorld(w, wd);
  w.string(p.name); w.i64(p.playerId); w.string(p.startSeed);
  w.bool(p.usedCheats); w.i64(p.dateCreated);
  const player = p.player ? encodePlayer(p.player) : p.playerRaw;
  w.bool(player !== null);
  if (player !== null) w.bytes(player);
  return w.toBytes();
}

// ---------------------------------------------------------------- high level

export function inventoryRows(player) {
  for (const u of player.uniques) {
    const m = /^invrows (\d+)$/.exec(u);
    if (m) return Math.min(9, Math.max(0, parseInt(m[1], 10)));
  }
  return 4;
}

/**
 * Parse a whole .fch file. Returns a Save object:
 *   { fileBytes, payload, hash, hashOk, profile, player, health: { fullRoundTrip, inventoryRoundTrip, skillsRoundTrip }, editable, reasons[] }
 */
export async function parseFch(fileBytes) {
  const { payload, hash } = splitContainer(fileBytes);
  const expected = await sha512(payload);
  const hashOk = bytesEqual(expected, hash);
  const profile = decodeProfile(payload);
  const player = profile.player;
  const reasons = [];
  const health = { fullRoundTrip: false, inventoryRoundTrip: false, skillsRoundTrip: false };

  if (!player) {
    reasons.push(profile.playerError ? `player data could not be decoded: ${profile.playerError}` : 'file has no player data');
  } else {
    const raw = profile.playerRaw;
    const [is, ie] = player.ranges.inventory;
    const [ss, se] = player.ranges.skills;
    health.inventoryRoundTrip = bytesEqual(encodeInventory(player.inventoryVersion, player.items), raw.subarray(is, ie));
    health.skillsRoundTrip = bytesEqual(encodeSkills(player.skillsVersion, player.skills), raw.subarray(ss, se));
    if (!health.inventoryRoundTrip) reasons.push('inventory section does not re-encode byte-for-byte');
    if (!health.skillsRoundTrip) reasons.push('skills section does not re-encode byte-for-byte');
  }
  try { health.fullRoundTrip = bytesEqual(encodeProfile(profile), payload); } catch { health.fullRoundTrip = false; }

  return { fileBytes, payload, hash, hashOk, profile, player, health, editable: reasons.length === 0, reasons };
}

/**
 * Produce a new .fch by splicing freshly encoded inventory + skills into the ORIGINAL bytes.
 * Everything outside those two sections is copied verbatim, except that `opts.usedCheats`,
 * when given, overwrites the profile's usedCheats byte (used only to CLEAR the flag).
 */
export async function serializeFch(save, items, skills, opts = {}) {
  const { payload, profile, player } = save;
  if (!player) throw new Error('nothing to save: no player data');
  const wantCheats = opts.usedCheats === undefined ? profile.usedCheats : !!opts.usedCheats;
  if (wantCheats && !profile.usedCheats) throw new Error('refusing to set the usedCheats flag');
  const raw = profile.playerRaw;
  const [is, ie] = player.ranges.inventory;
  const [ss, se] = player.ranges.skills;
  const newPlayer = concat(
    raw.subarray(0, is),
    encodeInventory(player.inventoryVersion, items),
    raw.subarray(ie, ss),
    encodeSkills(player.skillsVersion, skills),
    raw.subarray(se),
  );
  const [ps, pe] = profile.playerRange;
  const lenW = new Writer(4); lenW.i32(newPlayer.length);
  const newPayload = concat(payload.subarray(0, ps - 4), lenW.toBytes(), newPlayer, payload.subarray(pe));
  if (wantCheats !== profile.usedCheats) newPayload[profile.usedCheatsOffset] = wantCheats ? 1 : 0;
  const out = await wrapContainer(newPayload);

  // Read the result back and make sure it says what we meant to write.
  const check = await parseFch(out);
  if (!check.player) throw new Error('self-check failed: output has no decodable player data');
  if (!check.hashOk) throw new Error('self-check failed: hash mismatch');
  if (check.profile.usedCheats !== wantCheats) throw new Error('self-check failed: usedCheats flag differs after re-read');
  const a = JSON.stringify(check.player.items, bigintReplacer), b = JSON.stringify(items.map(normalizeItem), bigintReplacer);
  if (a !== b) throw new Error('self-check failed: items differ after re-read');
  if (JSON.stringify(check.player.skills) !== JSON.stringify(skills)) throw new Error('self-check failed: skills differ after re-read');
  return out;
}

function normalizeItem(it) { return { ...it, flags: computeFlags(it), crafterId: BigInt(it.crafterId) }; }
export function bigintReplacer(_, v) { return typeof v === 'bigint' ? v.toString() + 'n' : v; }
