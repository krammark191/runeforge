// Item catalog: prefab name → display data, plus hash → prefab lookup.
import { stableHash } from './fch.js';

let catalog = null;      // prefab → entry
let byHash = null;       // int32 hash → prefab
let searchIndex = null;  // [{prefab, name, lower}]

export async function loadCatalog(url = new URL('../data/items.json', import.meta.url)) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not load item catalog (${res.status})`);
  const data = await res.json();
  setCatalog(data.items);
  return data;
}

export function setCatalog(items) {
  catalog = items;
  byHash = new Map();
  searchIndex = [];
  for (const [prefab, e] of Object.entries(items)) {
    e.prefab = prefab;
    e.hash = stableHash(prefab);
    byHash.set(e.hash, prefab);
    searchIndex.push({ prefab, name: e.name, lower: `${e.name} ${prefab}`.toLowerCase(), e });
  }
  searchIndex.sort((a, b) => a.name.localeCompare(b.name));
}

export function lookupHash(hash) {
  const prefab = byHash?.get(hash);
  return prefab ? catalog[prefab] : null;
}

export function lookupPrefab(prefab) { return catalog?.[prefab] ?? null; }

export function search(query, limit = 40) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const starts = [], contains = [];
  for (const s of searchIndex) {
    if (s.e.hashOnly) continue;
    if (s.name.toLowerCase().startsWith(q) || s.prefab.toLowerCase().startsWith(q)) starts.push(s.e);
    else if (s.lower.includes(q)) contains.push(s.e);
    if (starts.length >= limit) break;
  }
  return starts.concat(contains).slice(0, limit);
}

export function maxDurabilityFor(entry, quality) {
  if (!entry) return null;
  return entry.maxDurability + Math.max(0, quality - 1) * entry.durabilityPerLevel;
}

export function typeLabel(entry) {
  return entry ? entry.typeName : 'unknown';
}

// Only these item types have quality levels in the game (weapons, armor, tools, shields).
export function hasQuality(entry) {
  return !!entry && entry.maxQuality > 1;
}
