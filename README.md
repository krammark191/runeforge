# Runeforge — Valheim Character Editor

A browser-only editor for Valheim 1.0 character files (`.fch`). Its headline feature is raising an item's
quality past the level its crafting station allows, into the range the **Forge of Potential** reaches, without
ever touching the game's cheat flags.

Everything runs client-side. No build step, no framework, no upload. Serve the folder from any static host
(GitHub Pages works) or open it through a local static server.

```bash
python3 -m http.server 8765
```

Then open <http://localhost:8765>. The **Try a demo character** button loads a synthetic save so you can poke
at the UI without a real file.

## What it does

- **Inventory**: 8×N grid (height read from the save), drag to move/swap/merge stacks, search 1,000+ items by
  name or prefab, add/duplicate/remove, edit stack, durability, variant, equipped.
- **Quality**: no artificial cap. The number is stored as a u16 in the save, and the editor lets you set anything
  from 1 to 65535. Values above the station max are highlighted in blue as "Forge of Potential range".
  When quality changes the durability is (optionally) set to the new maximum, `maxDurability + (q-1) * durabilityPerLevel`,
  which is the formula the game uses.
- **Skills**: edit any skill 0–100, set all at once, add missing skills.
- **Character / Integrity**: read-only summary of the profile, and a dedicated view of the cheat state.
- **Undo / redo**, `Ctrl+Z` / `Ctrl+Shift+Z`, `Ctrl+S` to save.
- **Saving**: download the edited file, or (Chrome/Edge) open the characters folder and save in place with a
  timestamped `.bak` written first.

## How it stays out of the cheat system

Valheim 1.0 blocks achievements when any of these is true: the character's `usedCheats` flag, a world with
cheated modifiers, a *cheated* item in the inventory, or a modded game.

This editor:

1. **Never sets `usedCheats`.** Saving is done by splicing: only the inventory and skills byte ranges are
   re-encoded and the rest of the file, including that flag, is copied byte for byte from the original.
   The Integrity tab offers a *Clear flag* button for characters that already carry it; that patches exactly
   one byte, and the serializer refuses to move the flag in the other direction.
2. **Never sets an item's `cheated` bit** (inventory v109 `extraFlags` bit 0). Existing bits are preserved
   unless you clear them (per item, or all at once); new items are written with the bit clear and stamped
   with your character as the crafter, which is how a normally crafted item looks.
   Note that the `Cheats` stat counter and the console-command history in the stats block are left alone; they
   are records, not the flags the achievement check reads.
3. **Is not a mod.** The game is not running and nothing is injected, so the "modded" detection does not apply.
4. **Recomputes the SHA-512** over the payload. The game does not actually verify it on load, but a correct
   hash means nothing else that reads the file can tell the difference.
5. **Reads its own output back** before handing it to you and refuses to save if anything differs from what
   you edited.

### Why quality above the station max is safe to store

- Quality is a plain `u16` in the item record (spec §6). `GetDamage`, `GetArmor`, `GetBaseBlockPower` and
  `GetMaxDurability` all scale linearly with `quality - 1` and none of them clamp to `m_maxQuality`.
- The Forge of Potential produces exactly this data: the same record, a bigger number, no extra marker. The
  game therefore cannot treat "quality > station max" as evidence of cheating without also flagging every
  legitimately refined item.
- The stable-hash item identity, flags and record layout were verified against the community format spec that
  was derived from a decompile of 1.0.7 and cross-checked against the hash table used by other editors.

**Caveat:** this has been verified against the file format and against a synthetic save. It has not yet been
loaded into the game with a real character. First real-file test: open your `.fch`, confirm the Integrity tab
shows all three round-trips as *byte-identical*, raise one item by one level, save, and load it in Valheim.

## File format

Supported: profile **46**, player data **33**, inventory **109**, skills **2** (Valheim 1.0.x). Other versions
are refused rather than half-parsed. See `js/fch.js` for the codec; it follows the layout documented in
[Lorcelmao/ValheimEditor `docs/fch-format-spec.md`](https://github.com/Lorcelmao/ValheimEditor).

Container: `i32 len, payload[len], i32 64, sha512(payload)`.

Item record (v109): `i32 durability×100, u8 x, u8 y, u8 worldLevel, u8 flags, [u16 quality], [u16 stack],
[i32 variant], [i64 crafterId, string crafterName], [i32 prefabHash], [customData], u8 extraFlags`.
Flag bits: `0x01` pickedUp · `0x02` equipped · `0x04` quality · `0x08` stack · `0x10` variant · `0x20` crafter ·
`0x40` prefab · `0x80` customData. `extraFlags` bit 0 = cheated.

## Layout

```
index.html          page shell
css/style.css       theme (warm dark, gold + frost accents, Cinzel / Geist)
js/binary.js        LE reader/writer matching ZPackage / BinaryWriter
js/fch.js           codec, splice-based serializer, stable hash, self-check
js/items.js         item catalog (search, hash lookup, durability formula)
js/demo.js          synthetic demo character
js/app.js           UI
data/items.json     generated catalog (1,146 prefabs)
tools/build_items.py regenerates data/items.json from the reference tables
test/               node --test test/
```

## Tests

```bash
node --test test/
```

Covers primitives, stable hash against known game values, byte-identical round-trip of a synthetic v46 save,
and the splice path (raise quality to 12, confirm every byte outside inventory/skills is unchanged and the
cheat state is untouched).

## Credits

Item names, stack sizes, durability and quality caps come from
[Domphill/Valheim-Save-Editor](https://github.com/Domphill/Valheim-Save-Editor) (MIT); the prefab hash table
used to verify the hash port is from
[ValterKane/ValhaimCheaterRemover](https://github.com/ValterKane/ValhaimCheaterRemover) (MIT). Format notes from
[Lorcelmao/ValheimEditor](https://github.com/Lorcelmao/ValheimEditor). Visual direction inspired by
[vikingeditor.com](https://vikingeditor.com).

Unofficial fan tool. Not affiliated with Iron Gate or Coffee Stain.
