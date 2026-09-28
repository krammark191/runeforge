#!/usr/bin/env python3
"""Build data/items.json from the reference item tables.

Sources (both MIT licensed):
  Domphill/Valheim-Save-Editor        vse/itemdata.py     display name, type, stack, durability, max quality
  ValterKane/ValhaimCheaterRemover    valheim_items.py    prefab -> GetStableHashCode table (used only to verify)

Usage: python3 tools/build_items.py <ref_dir>
"""
import json, sys, os

ref = sys.argv[1]
sys.path.insert(0, os.path.join(ref, 'Valheim-Save-Editor'))
sys.path.insert(0, os.path.join(ref, 'ValhaimCheaterRemover'))
from vse.itemdata import ITEM_DATA, TYPE_NAMES  # noqa
from valheim_items import ITEM_NAME_TO_HASH     # noqa


def stable_hash(s: str) -> int:
    """Port of Valheim's GetStableHashCode (int32 wrap-around)."""
    def i32(x):
        x &= 0xFFFFFFFF
        return x - 0x100000000 if x & 0x80000000 else x
    a = b = 5381
    n = len(s)
    i = 0
    while i < n and s[i] != '\0':
        a = i32(((a << 5) + a) ^ ord(s[i]))
        if i == n - 1 or s[i + 1] == '\0':
            break
        b = i32(((b << 5) + b) ^ ord(s[i + 1]))
        i += 2
    return i32(a + b * 1566083941)


bad = [k for k, v in ITEM_NAME_TO_HASH.items() if stable_hash(k) != v]
assert not bad, f'stable hash mismatch for {bad[:5]}'

items = {}
for prefab, (name, typ, stack, dur, dur_per, maxq, uses_dur) in ITEM_DATA.items():
    items[prefab] = {
        'name': name, 'type': typ, 'typeName': TYPE_NAMES.get(typ, str(typ)),
        'maxStack': stack, 'maxDurability': dur, 'durabilityPerLevel': dur_per,
        'maxQuality': maxq, 'usesDurability': bool(uses_dur),
    }
# Prefabs only known by hash: keep them so the editor can still name and preserve them.
for prefab in ITEM_NAME_TO_HASH:
    if prefab not in items:
        items[prefab] = {'name': prefab, 'type': 0, 'typeName': 'unknown', 'maxStack': 1,
                         'maxDurability': 100.0, 'durabilityPerLevel': 50.0, 'maxQuality': 1,
                         'usesDurability': False, 'hashOnly': True}

out = {'generated': '2026-09-28', 'game': '1.0.7', 'items': dict(sorted(items.items()))}
with open(os.path.join(os.path.dirname(__file__), '..', 'data', 'items.json'), 'w') as f:
    json.dump(out, f, separators=(',', ':'))
print(len(items), 'items written; hash table verified for', len(ITEM_NAME_TO_HASH), 'prefabs')
