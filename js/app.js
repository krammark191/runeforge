import { parseFch, serializeFch, inventoryRows, ITEM_FLAG, EXTRA_FLAG, SKILL_NAMES, STAT_CHEATS, VERSIONS, stableHash } from './fch.js';
import { loadCatalog, lookupHash, search, maxDurabilityFor, hasQuality, iconFor } from './items.js';
import { demoFile } from './demo.js';

const $ = (id) => document.getElementById(id);
const GRID_W = 8;

// ------------------------------------------------------------------ state
const state = {
  save: null,          // result of parseFch
  fileName: '',
  fileHandle: null,    // FileSystemFileHandle when opened via folder/file picker with write access
  dirHandle: null,
  items: [],           // working copy
  skills: [],
  usedCheats: false,   // working copy of the profile flag; can only ever go true → false
  rows: 4,
  selected: null,      // {x,y}
  undo: [], redo: [],
  dirty: false,
  catalogReady: false,
};

function snapshot() { return structuredClone({ items: state.items, skills: state.skills, usedCheats: state.usedCheats }); }
function commit(label) {
  state.undo.push(state._before);
  if (state.undo.length > 200) state.undo.shift();
  state.redo = [];
  state.dirty = true;
  renderAll();
  if (label) toast(label);
}
function begin() { state._before = snapshot(); }
function mutate(label, fn) { begin(); fn(); commit(label); }
function undo() {
  const prev = state.undo.pop(); if (!prev) return;
  state.redo.push(snapshot()); Object.assign(state, prev); state.dirty = true; renderAll();
}
function redo() {
  const next = state.redo.pop(); if (!next) return;
  state.undo.push(snapshot()); Object.assign(state, next); state.dirty = true; renderAll();
}

// ------------------------------------------------------------------ helpers
let toastTimer;
function toast(msg, kind = '') {
  const t = $('toast'); t.textContent = msg; t.className = `toast ${kind}`; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'error' ? 6000 : 2600);
}
function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
function itemAt(x, y) { return state.items.find((i) => i.x === x && i.y === y) ?? null; }
function entryOf(item) { return lookupHash(item.prefabHash); }
function nameOf(item) { const e = entryOf(item); return e ? e.name : `#${item.prefabHash}`; }
function glyphOf(item) {
  const e = entryOf(item); const t = e?.type ?? 0;
  const map = { 3: '⚔', 14: '⚔', 22: '⚔', 4: '➶', 5: '⛨', 6: '⛑', 7: '🛡', 11: '👖', 12: '🧤', 17: '🧥', 19: '⚒', 15: '🔥', 13: '🏆', 2: '🍖', 9: '➹', 23: '➹', 21: '🐟', 24: '💍', 18: '✦', 1: '▪', 16: '◆', 10: '✂', 20: '✚' };
  return map[t] ?? '◆';
}
// Icon <img> with a glyph fallback if the file is missing or fails to load.
function iconEl(entry, item, cls = 'icon') {
  const src = entry ? iconFor(entry.prefab) : null;
  if (!src) return el('span', { class: 'glyph' }, item ? glyphOf(item) : '◆');
  const img = el('img', { class: cls, src, alt: '', loading: 'lazy', draggable: false });
  img.addEventListener('error', () => img.replaceWith(el('span', { class: 'glyph' }, item ? glyphOf(item) : '◆')), { once: true });
  return img;
}
function starsText(q, max) {
  // The game draws one small star per level; past 5 that stops being readable, so show a count instead.
  return q <= 5 ? '★'.repeat(q) : `${q}★`;
}
function fmtDate(unixSeconds) { try { return new Date(Number(unixSeconds) * 1000).toLocaleDateString(); } catch { return String(unixSeconds); } }
function fmtDur(s) { s = Math.round(Number(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m`; }
function num(v) { return typeof v === 'number' ? v : NaN; }

// ------------------------------------------------------------------ open / close
async function openBytes(bytes, fileName, fileHandle = null) {
  let save;
  try { save = await parseFch(bytes); }
  catch (e) { toast(`Could not open ${fileName}: ${e.message}`, 'error'); console.error(e); return; }
  state.save = save; state.fileName = fileName; state.fileHandle = fileHandle;
  state.items = structuredClone(save.player?.items ?? []);
  state.skills = structuredClone(save.player?.skills ?? []);
  state.usedCheats = save.profile.usedCheats;
  state.rows = save.player ? inventoryRows(save.player) : 4;
  state.selected = null; state.undo = []; state.redo = []; state.dirty = false;
  $('landing').hidden = true; $('editor').hidden = false; $('file-info').hidden = false; $('editor-actions').hidden = false;
  $('btn-save').hidden = !fileHandle;
  $('file-name').textContent = fileName;
  $('badge-char').textContent = `${save.profile.name} · v${save.profile.version}`;
  renderNotices();
  renderAll();
  selectTab('inventory');
}

function closeFile() {
  if (state.dirty && !confirm('Discard unsaved changes?')) return;
  state.save = null; state.dirty = false; state.fileHandle = null;
  $('landing').hidden = false; $('editor').hidden = true; $('file-info').hidden = true; $('editor-actions').hidden = true;
}

function renderNotices() {
  const box = $('editor-notices'); box.innerHTML = '';
  const s = state.save;
  if (!s.editable) {
    box.append(el('div', { class: 'notice danger' }, el('strong', {}, 'Opened read-only. '), `This file cannot be written safely: ${s.reasons.join('; ')}.`));
  } else if (!s.health.fullRoundTrip) {
    box.append(el('div', { class: 'notice warn' }, el('strong', {}, 'Heads up. '), 'The inventory and skills sections re-encode exactly, so saving is safe, but another part of the file did not round-trip through the parser. Please report this file layout so the parser can be checked.'));
  }
  if (!s.hashOk) box.append(el('div', { class: 'notice warn' }, 'The SHA-512 checksum in this file did not match its contents. Valheim does not verify it on load, and it will be recomputed on save.'));
}

// ------------------------------------------------------------------ rendering
function renderAll() {
  $('btn-undo').disabled = state.undo.length === 0;
  $('btn-redo').disabled = state.redo.length === 0;
  $('badge-dirty').hidden = !state.dirty;
  const disabled = !state.save?.editable;
  $('btn-download').disabled = disabled; $('btn-save').disabled = disabled;
  renderCheatBadge(); renderGrid(); renderDetail(); renderSkills(); renderCharacter(); renderIntegrity();
}

function renderCheatBadge() {
  const b = $('badge-cheats');
  const cheatedItems = state.items.filter((i) => i.extraFlags & EXTRA_FLAG.CHEATED).length;
  if (state.usedCheats) { b.className = 'badge danger'; b.textContent = 'cheats flag set'; }
  else if (cheatedItems) { b.className = 'badge warn'; b.textContent = `${cheatedItems} cheated item${cheatedItems > 1 ? 's' : ''}`; }
  else { b.className = 'badge ok'; b.textContent = 'no cheat flags'; }
}

function renderGrid() {
  const g = $('inv-grid'); g.innerHTML = '';
  $('inv-meta').textContent = `${state.items.length} items · ${GRID_W}×${state.rows}`;
  for (let y = 0; y < state.rows; y++) for (let x = 0; x < GRID_W; x++) {
    const it = itemAt(x, y);
    const slot = el('div', { class: `slot ${it ? '' : 'empty'} ${state.selected && state.selected.x === x && state.selected.y === y ? 'selected' : ''}`, 'data-x': x, 'data-y': y, draggable: !!it, title: it ? nameOf(it) : `Empty slot ${x + 1},${y + 1}` });
    if (it) {
      const e = entryOf(it);
      const icon = iconEl(e, it);
      slot.append(icon);
      if (icon.tagName !== 'IMG') slot.append(el('span', { class: 'name' }, nameOf(it)));
      if (it.stack > 1) slot.append(el('span', { class: 'stack' }, it.stack));
      if (it.quality > 1 || hasQuality(e)) {
        const forge = e && it.quality > e.maxQuality;
        slot.append(el('span', { class: `quality ${forge ? 'forge' : ''}`, title: `quality ${it.quality}` }, starsText(it.quality)));
      }
      if (it.flags & ITEM_FLAG.EQUIPPED) slot.append(el('span', { class: 'equipped', title: 'equipped' }));
      if (it.extraFlags & EXTRA_FLAG.CHEATED) slot.append(el('span', { class: 'cheated', title: 'marked as cheated by the game' }));
      if (e?.usesDurability) {
        const max = maxDurabilityFor(e, it.quality); const pct = Math.max(0, Math.min(100, (it.durabilityX100 / 100) / max * 100));
        slot.append(el('span', { class: `dura ${pct < 25 ? 'low' : ''}` }, el('i', { style: `width:${pct}%` })));
      }
    }
    slot.addEventListener('click', () => { state.selected = { x, y }; renderGrid(); renderDetail(); $('add-target').textContent = it ? '' : `New items go to slot ${x + 1},${y + 1}`; });
    slot.addEventListener('dragstart', (ev) => { ev.dataTransfer.setData('text/plain', `${x},${y}`); ev.dataTransfer.effectAllowed = 'move'; });
    slot.addEventListener('dragover', (ev) => { ev.preventDefault(); slot.classList.add('over'); });
    slot.addEventListener('dragleave', () => slot.classList.remove('over'));
    slot.addEventListener('drop', (ev) => {
      ev.preventDefault(); slot.classList.remove('over');
      const [sx, sy] = ev.dataTransfer.getData('text/plain').split(',').map(Number);
      if (sx === x && sy === y) return;
      moveItem(sx, sy, x, y);
    });
    g.append(slot);
  }
}

function moveItem(sx, sy, tx, ty) {
  const a = itemAt(sx, sy); if (!a) return;
  const b = itemAt(tx, ty);
  mutate(null, () => {
    if (b && b.prefabHash === a.prefabHash && b.quality === a.quality && b.variant === a.variant) {
      // stack merge up to catalog max
      const e = entryOf(a); const max = e?.maxStack ?? 1;
      const room = max - b.stack;
      if (room > 0) { const n = Math.min(room, a.stack); b.stack += n; a.stack -= n; if (a.stack === 0) state.items.splice(state.items.indexOf(a), 1); }
      else { b.x = sx; b.y = sy; a.x = tx; a.y = ty; }
    } else {
      if (b) { b.x = sx; b.y = sy; }
      a.x = tx; a.y = ty;
    }
  });
  state.selected = { x: tx, y: ty }; renderGrid(); renderDetail();
}

function stars(q, max) {
  const parts = [];
  for (let i = 1; i <= Math.min(q, 12); i++) parts.push(el('span', { class: max && i > max ? 'forge' : '' }, '★'));
  if (q > 12) parts.push(el('span', { class: 'forge' }, ` +${q - 12}`));
  return el('span', { class: 'stars' }, ...parts);
}

function renderDetail() {
  const box = $('item-detail'); box.innerHTML = '';
  const sel = state.selected; const it = sel ? itemAt(sel.x, sel.y) : null;
  if (!sel) { box.append(el('p', { class: 'muted' }, 'Select a slot to edit it.')); return; }
  if (!it) { box.append(el('h3', {}, `Empty slot ${sel.x + 1},${sel.y + 1}`), el('p', { class: 'muted' }, 'Use the search below the grid to place a new item here.')); return; }
  const e = entryOf(it);
  const editable = state.save.editable;
  const field = (label, ...value) => el('div', { class: 'field' }, el('label', {}, label), el('div', { class: 'value' }, ...value));
  const numInput = (value, opts, onchange) => el('input', { type: 'number', value, disabled: !editable, ...opts, onchange: (ev) => onchange(ev.target.valueAsNumber) });

  box.append(el('div', { class: 'panel-head' },
    el('div', { class: 'item-title' }, el('span', { class: 'thumb' }, iconEl(e, it, '')), el('h2', {}, nameOf(it))),
    el('span', { class: 'badge' }, e ? e.typeName : 'unknown prefab')));
  box.append(el('p', { class: 'hint mono' }, e ? e.prefab : `hash ${it.prefabHash}`));

  // ---- quality box
  if (hasQuality(e) || it.quality > 1) {
    const max = e?.maxQuality ?? 4;
    const forge = it.quality > max;
    const setQ = (q, repair) => {
      q = Math.max(1, Math.min(65535, Math.round(q))); if (!Number.isFinite(q)) return;
      mutate(null, () => { it.quality = q; if (repair && e?.usesDurability) it.durabilityX100 = Math.round(maxDurabilityFor(e, q) * 100); });
    };
    const repairChk = el('input', { type: 'checkbox', id: 'q-repair', checked: true, disabled: !editable });
    const qInput = el('input', { type: 'number', min: 1, max: 65535, step: 1, value: it.quality, disabled: !editable, onchange: (ev) => setQ(ev.target.valueAsNumber, repairChk.checked) });
    const qb = el('div', { class: `qualitybox ${forge ? 'forge' : ''}` },
      el('div', { class: 'row' },
        el('span', { class: 'big' }, it.quality),
        el('div', { class: 'stepper' },
          el('button', { disabled: !editable, onclick: () => setQ(it.quality - 1, repairChk.checked) }, '−'),
          qInput,
          el('button', { disabled: !editable, onclick: () => setQ(it.quality + 1, repairChk.checked) }, '+')),
        el('button', { class: 'btn small', disabled: !editable, onclick: () => setQ(max, repairChk.checked) }, `Station max (${max})`),
      ),
      el('div', { style: 'margin-top:8px' }, stars(it.quality, max)),
      el('p', { class: 'hint', style: 'margin-top:8px' },
        forge ? `Quality ${it.quality} is ${it.quality - max} level${it.quality - max > 1 ? 's' : ''} above the ${max} this item's crafting station allows. In Valheim 1.0 that is the range the Forge of Potential reaches; the game stores quality as a plain 16-bit number and scales damage, armor, block and durability per level with no upper clamp.`
              : `Regular crafting stations upgrade this item to quality ${max}. Anything higher is Forge of Potential territory.`),
      el('label', { class: 'hint', style: 'display:flex;gap:8px;align-items:center;margin-top:6px' }, repairChk, 'Set durability to the new maximum when quality changes'),
    );
    box.append(qb);
  }

  // ---- durability
  if (e?.usesDurability || it.durabilityX100 !== 10000) {
    const max = e ? maxDurabilityFor(e, it.quality) : null;
    box.append(field('Durability',
      numInput((it.durabilityX100 / 100).toFixed(2), { min: 0, step: 1 }, (v) => { if (Number.isFinite(v)) mutate(null, () => { it.durabilityX100 = Math.round(v * 100); }); }),
      max !== null ? el('span', { class: 'hint' }, `/ ${max}`) : null,
      max !== null ? el('button', { class: 'btn small ghost', disabled: !editable, onclick: () => mutate('Repaired', () => { it.durabilityX100 = Math.round(max * 100); }) }, 'Repair') : null));
  }
  // ---- stack
  box.append(field('Stack',
    numInput(it.stack, { min: 1, max: 65535, step: 1 }, (v) => { if (Number.isFinite(v)) mutate(null, () => { it.stack = Math.max(1, Math.min(65535, Math.round(v))); }); }),
    e ? el('span', { class: 'hint' }, `max ${e.maxStack}`) : null,
    e && e.maxStack > 1 ? el('button', { class: 'btn small ghost', disabled: !editable, onclick: () => mutate(null, () => { it.stack = e.maxStack; }) }, 'Fill') : null));
  // ---- variant
  box.append(field('Variant', numInput(it.variant, { min: 0, step: 1 }, (v) => { if (Number.isFinite(v)) mutate(null, () => { it.variant = Math.round(v); }); }), el('span', { class: 'hint' }, 'style index for capes, shields, etc.')));
  // ---- equipped
  const eq = el('input', { type: 'checkbox', checked: !!(it.flags & ITEM_FLAG.EQUIPPED), disabled: !editable, onchange: (ev) => mutate(null, () => { it.flags = ev.target.checked ? it.flags | ITEM_FLAG.EQUIPPED : it.flags & ~ITEM_FLAG.EQUIPPED; }) });
  box.append(field('Equipped', eq));
  // ---- crafter
  box.append(field('Crafted by', el('span', {}, it.crafterName || el('span', { class: 'faint' }, 'not recorded')), it.crafterId ? el('span', { class: 'hint mono' }, String(it.crafterId)) : null,
    BigInt(it.crafterId) !== BigInt(state.save.profile.playerId) ? el('button', { class: 'btn small ghost', disabled: !editable, title: 'Stamp this item as crafted by this character', onclick: () => mutate(null, () => { it.crafterId = BigInt(state.save.profile.playerId); it.crafterName = state.save.profile.name; }) }, 'Set to me') : null));
  box.append(field('World level', el('span', { class: 'mono' }, it.worldLevel)));
  box.append(field('Picked up', el('span', {}, it.flags & ITEM_FLAG.PICKED_UP ? 'yes' : 'no')));
  // ---- cheat mark: shown always, clearable on request, never settable
  const cheated = !!(it.extraFlags & EXTRA_FLAG.CHEATED);
  box.append(field('Cheat mark', el('span', { class: `badge ${cheated ? 'danger' : 'ok'}` }, cheated ? 'marked as cheated' : 'clean'),
    cheated ? el('button', { class: 'btn small', disabled: !editable, onclick: () => clearItemMarks([it]) }, 'Clear mark') : el('span', { class: 'hint' }, 'as in the original file')));
  if (it.customData.length) {
    box.append(el('h3', { style: 'margin-top:14px' }, 'Custom data'));
    const t = el('table', {}, el('tbody', {}, ...it.customData.map(([k, v]) => el('tr', {}, el('td', { class: 'mono' }, k), el('td', { class: 'mono' }, v)))));
    box.append(t);
  }
  box.append(el('div', { style: 'display:flex;gap:8px;margin-top:16px' },
    el('button', { class: 'btn small', disabled: !editable, onclick: () => duplicateItem(it) }, 'Duplicate'),
    el('button', { class: 'btn small danger', disabled: !editable, onclick: () => mutate('Removed', () => { state.items.splice(state.items.indexOf(it), 1); }) }, 'Remove')));
}

function clearItemMarks(items) {
  const marked = items.filter((i) => i.extraFlags & EXTRA_FLAG.CHEATED);
  if (!marked.length) return;
  mutate(`Cleared cheat mark on ${marked.length} item${marked.length > 1 ? 's' : ''}`, () => { for (const i of marked) i.extraFlags &= ~EXTRA_FLAG.CHEATED; });
}

function clearUsedCheats() {
  if (!state.usedCheats) return;
  mutate('usedCheats flag will be cleared on save', () => { state.usedCheats = false; });
}

function firstFreeSlot(prefer) {
  if (prefer && !itemAt(prefer.x, prefer.y)) return prefer;
  for (let y = 0; y < state.rows; y++) for (let x = 0; x < GRID_W; x++) if (!itemAt(x, y)) return { x, y };
  return null;
}

function duplicateItem(it) {
  const slot = firstFreeSlot(null); if (!slot) return toast('No free slot', 'error');
  mutate('Duplicated', () => { const c = structuredClone(it); c.x = slot.x; c.y = slot.y; c.flags &= ~ITEM_FLAG.EQUIPPED; state.items.push(c); });
  state.selected = slot; renderGrid(); renderDetail();
}

function addItem(entry) {
  const slot = firstFreeSlot(state.selected && !itemAt(state.selected.x, state.selected.y) ? state.selected : null);
  if (!slot) return toast('Inventory is full', 'error');
  const p = state.save.profile;
  const q = 1;
  const item = {
    durabilityX100: Math.round(maxDurabilityFor(entry, q) * 100), x: slot.x, y: slot.y, worldLevel: 0, flags: ITEM_FLAG.PICKED_UP,
    quality: q, stack: 1, variant: 0,
    // Stamped like a crafted item so it reads "crafted by <you>" in game; the cheated bit stays clear.
    crafterId: hasQuality(entry) || entry.usesDurability ? BigInt(p.playerId) : 0n,
    crafterName: hasQuality(entry) || entry.usesDurability ? p.name : '',
    prefabHash: entry.hash, customData: [], extraFlags: 0,
  };
  mutate(`Added ${entry.name}`, () => state.items.push(item));
  state.selected = slot; renderGrid(); renderDetail();
  $('item-results').hidden = true; $('item-search').value = '';
}

function renderSearch() {
  const q = $('item-search').value; const box = $('item-results'); box.innerHTML = '';
  const res = search(q, 40);
  box.hidden = res.length === 0;
  for (const e of res) {
    box.append(el('div', { class: 'result', onclick: () => addItem(e) },
      el('span', { class: 'thumb' }, iconEl(e, null, '')),
      el('div', { class: 'grow' }, el('div', {}, e.name), el('div', { class: 'prefab' }, e.prefab)),
      el('div', { class: 'type' }, e.maxQuality > 1 ? `${e.typeName} · ★${e.maxQuality}` : e.typeName)));
  }
}

// ------------------------------------------------------------------ skills
function renderSkills() {
  const list = $('skills-list'); list.innerHTML = '';
  const editable = state.save.editable;
  const sorted = [...state.skills].sort((a, b) => (SKILL_NAMES[a.type] ?? `z${a.type}`).localeCompare(SKILL_NAMES[b.type] ?? `z${b.type}`));
  for (const s of sorted) {
    const lvl = num(s.level);
    list.append(el('div', { class: 'skill' },
      el('span', { class: 'name' }, SKILL_NAMES[s.type] ?? `Skill ${s.type}`),
      el('input', { type: 'number', min: 0, max: 100, step: 1, value: Number.isFinite(lvl) ? Math.round(lvl * 10) / 10 : 0, disabled: !editable, onchange: (ev) => { const v = ev.target.valueAsNumber; if (Number.isFinite(v)) mutate(null, () => { s.level = Math.max(0, v); s.accumulator = 0; }); } }),
      el('span', { class: 'lvl' }, Number.isFinite(lvl) ? lvl.toFixed(1) : '?'),
      el('div', { class: 'bar' }, el('i', { style: `width:${Math.min(100, Math.max(0, lvl))}%` }))));
  }
  const sel = $('skill-add-select'); sel.innerHTML = '';
  const have = new Set(state.skills.map((s) => s.type));
  for (const [t, n] of Object.entries(SKILL_NAMES)) if (!have.has(Number(t))) sel.append(el('option', { value: t }, n));
  $('btn-skill-add').disabled = !editable || sel.options.length === 0;
  $('btn-skills-all').disabled = !editable;
}

// ------------------------------------------------------------------ character
function renderCharacter() {
  const p = state.save.profile; const pl = state.save.player;
  const kv = $('char-kv'); kv.innerHTML = '';
  const row = (k, v) => kv.append(el('dt', {}, k), el('dd', {}, v));
  row('Name', p.name); row('Player ID', el('span', { class: 'mono' }, String(p.playerId))); row('Start seed', el('span', { class: 'mono' }, p.startSeed));
  row('Created', fmtDate(p.dateCreated));
  if (pl) {
    row('Health', `${num(pl.health).toFixed(0)} / ${num(pl.maxHealth).toFixed(0)}`); row('Stamina', `${num(pl.stamina).toFixed(0)} / ${num(pl.maxStamina).toFixed(0)}`);
    row('Eitr', `${num(pl.eitr).toFixed(0)} / ${num(pl.maxEitr).toFixed(0)}`);
    row('Guardian power', pl.guardianPower || el('span', { class: 'faint' }, 'none'));
    row('Appearance', `${pl.hair}, ${pl.beard}, model ${pl.modelIndex}`);
    row('Known biomes', pl.knownBiomes.join(', ') || '—'); row('Trophies', pl.trophies.length); row('Known recipes', pl.knownRecipes.length);
    row('Stations', pl.knownStations.map(([n, l]) => `${n} (lv ${l})`).join(', ') || '—');
  }
  const b0 = p.statBlocks[0];
  if (b0) { row('Deaths', b0.stats[0]); row('Enemy kills', b0.stats[6]); row('Crafts', b0.stats[13]); row('Builds', b0.stats[2]); }
  const w = $('char-worlds'); w.innerHTML = '';
  if (!p.worlds.length) w.append(el('p', { class: 'muted' }, 'No world data.'));
  const played = new Map(b0?.knownWorlds ?? []);
  const t = el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'World UID'), el('th', {}, 'Logout'), el('th', {}, 'Death'), el('th', {}, 'Map'))));
  const tb = el('tbody');
  for (const wd of p.worlds) tb.append(el('tr', {}, el('td', { class: 'mono' }, String(wd.uid)), el('td', {}, wd.haveLogout ? wd.logout.map((v) => num(v).toFixed(0)).join(', ') : '—'), el('td', {}, wd.haveDeath ? wd.death.map((v) => num(v).toFixed(0)).join(', ') : '—'), el('td', {}, wd.mapData ? `${(wd.mapData.length / 1024).toFixed(0)} KB` : '—')));
  t.append(tb); w.append(t);
  if (played.size) w.append(el('p', { class: 'hint' }, 'Time played: ' + [...played].map(([n, s]) => `${n} ${fmtDur(s)}`).join(' · ')));
}

// ------------------------------------------------------------------ integrity
function renderIntegrity() {
  const s = state.save; const p = s.profile; const b = $('integrity-body'); b.innerHTML = '';
  const cheatStat = p.statBlocks[0]?.stats[STAT_CHEATS] ?? 0;
  const cmds = p.statBlocks[0]?.knownCommands ?? [];
  const badge = (ok, okText, badText, cls = 'danger') => el('span', { class: `badge ${ok ? 'ok' : cls}` }, ok ? okText : badText);
  const kv = el('dl', { class: 'kv' });
  const row = (k, v) => kv.append(el('dt', {}, k), el('dd', {}, v));
  const editable = s.editable;
  const flagCell = el('span', { class: 'value' });
  if (state.usedCheats) flagCell.append(badge(false, '', 'SET — achievements disabled for this character'), el('button', { class: 'btn small', disabled: !editable, onclick: clearUsedCheats }, 'Clear flag'));
  else if (p.usedCheats) flagCell.append(el('span', { class: 'badge frost' }, 'will be cleared on save'), el('button', { class: 'btn small ghost', disabled: !editable, onclick: () => mutate('Kept original flag', () => { state.usedCheats = true; }) }, 'Keep original'));
  else flagCell.append(badge(true, 'not set', ''));
  row('usedCheats flag', flagCell);
  row('Cheats stat', el('span', { class: 'mono' }, String(cheatStat)), );
  row('Console commands seen', cmds.length ? el('span', { class: 'mono' }, cmds.map(([c]) => c).join(', ')) : el('span', { class: 'faint' }, 'none recorded'));
  const nCheated = state.items.filter((i) => i.extraFlags & EXTRA_FLAG.CHEATED).length;
  row('Cheated items', el('span', { class: 'value' }, badge(nCheated === 0, 'none', `${nCheated} in inventory`, 'warn'),
    nCheated ? el('button', { class: 'btn small', disabled: !editable, onclick: () => clearItemMarks(state.items) }, 'Clear all marks') : null));
  row('Versions', el('span', { class: 'mono' }, `profile ${p.version} · player ${s.player?.version ?? '?'} · inventory ${s.player?.inventoryVersion ?? '?'} · skills ${s.player?.skillsVersion ?? '?'}`));
  row('Checksum on open', badge(s.hashOk, 'SHA-512 matches', 'mismatch (recomputed on save)', 'warn'));
  row('Inventory round-trip', badge(s.health.inventoryRoundTrip, 'byte-identical', 'differs'));
  row('Skills round-trip', badge(s.health.skillsRoundTrip, 'byte-identical', 'differs'));
  row('Full-file round-trip', badge(s.health.fullRoundTrip, 'byte-identical', 'differs (diagnostic only)', 'warn'));
  row('Save mode', 'splice: only inventory + skills bytes are replaced');
  b.append(kv);
  const ib = $('integrity-items'); ib.innerHTML = '';
  const cheated = state.items.filter((i) => i.extraFlags & EXTRA_FLAG.CHEATED);
  if (!cheated.length) ib.append(el('p', { class: 'muted' }, 'No items in this inventory carry the game\'s cheated mark.'));
  else {
    ib.append(el('p', { class: 'hint' }, 'The game sets this mark on items created with console commands. Carrying one puts the character in a temporary cheat state; dropping them (or clearing the mark here) restores achievement eligibility. The Cheats stat and command history above are kept as they are.'));
    ib.append(el('table', {}, el('tbody', {}, ...cheated.map((i) => el('tr', {}, el('td', {}, nameOf(i)), el('td', { class: 'mono' }, `slot ${i.x + 1},${i.y + 1}`), el('td', { class: 'mono' }, `×${i.stack}`),
      el('td', {}, el('button', { class: 'btn small ghost', disabled: !s.editable, onclick: () => clearItemMarks([i]) }, 'Clear')))))));
  }
}

// ------------------------------------------------------------------ save
async function buildOutput() {
  if (!state.save.editable) throw new Error('file is read-only');
  return serializeFch(state.save, state.items, state.skills, { usedCheats: state.usedCheats });
}

async function download() {
  try {
    const out = await buildOutput();
    const blob = new Blob([out], { type: 'application/octet-stream' });
    const a = el('a', { href: URL.createObjectURL(blob), download: state.fileName || 'character.fch' });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    state.dirty = false; renderAll(); toast('Edited file downloaded. Replace the original with it while Valheim is closed.', 'ok');
  } catch (e) { console.error(e); toast(`Save failed: ${e.message}`, 'error'); }
}

async function saveInPlace() {
  const h = state.fileHandle; if (!h) return download();
  try {
    const out = await buildOutput();
    if (state.dirHandle) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const bak = await state.dirHandle.getFileHandle(`${state.fileName}.${stamp}.bak`, { create: true });
      const bw = await bak.createWritable(); await bw.write(state.save.fileBytes); await bw.close();
    }
    const w = await h.createWritable(); await w.write(out); await w.close();
    // Re-open from disk so the working state reflects what is now on disk.
    const file = await h.getFile();
    await openBytes(new Uint8Array(await file.arrayBuffer()), state.fileName, h);
    toast(state.dirHandle ? 'Saved. A timestamped .bak copy of the original was written next to it.' : 'Saved.', 'ok');
  } catch (e) { console.error(e); toast(`Save failed: ${e.message}`, 'error'); }
}

// ------------------------------------------------------------------ opening files
async function openFileObject(file, handle = null) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  await openBytes(bytes, file.name, handle);
}

async function chooseFile() {
  if (window.showOpenFilePicker) {
    try {
      const [h] = await window.showOpenFilePicker({ types: [{ description: 'Valheim character', accept: { 'application/octet-stream': ['.fch'] } }] });
      state.dirHandle = null;
      return openFileObject(await h.getFile(), h);
    } catch (e) { if (e.name === 'AbortError') return; console.warn(e); }
  }
  $('file-input').click();
}

async function openFolder() {
  if (!window.showDirectoryPicker) return toast('Folder mode needs Chrome or Edge on desktop. Use “Choose file” instead.', 'error');
  try {
    const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
    state.dirHandle = dir;
    const list = $('folder-files'); list.innerHTML = '';
    const entries = [];
    for await (const [name, h] of dir.entries()) if (h.kind === 'file' && /\.fch$/i.test(name)) entries.push([name, h]);
    entries.sort((a, b) => a[0].localeCompare(b[0]));
    if (!entries.length) list.append(el('p', { class: 'muted' }, 'No .fch files in this folder.'));
    for (const [name, h] of entries) {
      const f = await h.getFile();
      list.append(el('div', { class: 'result', onclick: () => openFileObject(f, h) }, el('div', { class: 'mono' }, name), el('div', { class: 'type' }, `${(f.size / 1024).toFixed(0)} KB · ${new Date(f.lastModified).toLocaleString()}`)));
    }
    $('folder-list').hidden = false;
  } catch (e) { if (e.name !== 'AbortError') { console.error(e); toast(e.message, 'error'); } }
}

// ------------------------------------------------------------------ tabs & wiring
function selectTab(name) {
  document.querySelectorAll('.tabs [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== name; });
}

function wire() {
  document.querySelectorAll('.tabs [role=tab]').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));
  $('btn-choose').addEventListener('click', chooseFile);
  $('file-input').addEventListener('change', (ev) => { const f = ev.target.files[0]; if (f) { state.dirHandle = null; openFileObject(f); } ev.target.value = ''; });
  $('btn-folder').addEventListener('click', openFolder);
  $('btn-folder-close').addEventListener('click', () => { $('folder-list').hidden = true; state.dirHandle = null; });
  $('btn-demo').addEventListener('click', async () => { state.dirHandle = null; await openBytes(await demoFile(), 'Sigrun.fch'); toast('Demo character loaded. Nothing here is a real save.'); });
  $('btn-close').addEventListener('click', closeFile);
  $('brand').addEventListener('click', (ev) => { ev.preventDefault(); if (state.save) closeFile(); });
  $('btn-download').addEventListener('click', download);
  $('btn-save').addEventListener('click', saveInPlace);
  $('btn-undo').addEventListener('click', undo);
  $('btn-redo').addEventListener('click', redo);
  $('item-search').addEventListener('input', renderSearch);
  $('item-search').addEventListener('focus', renderSearch);
  $('btn-skills-all').addEventListener('click', () => { const v = $('skills-all').valueAsNumber; if (!Number.isFinite(v)) return; mutate('All skills set', () => { for (const s of state.skills) { s.level = Math.max(0, v); s.accumulator = 0; } }); });
  $('btn-skill-add').addEventListener('click', () => { const t = Number($('skill-add-select').value); if (!t) return; mutate(`Added ${SKILL_NAMES[t]}`, () => state.skills.push({ type: t, level: 1, accumulator: 0 })); });

  const dz = $('dropzone');
  for (const evn of ['dragenter', 'dragover']) dz.addEventListener(evn, (e) => { e.preventDefault(); dz.classList.add('over'); });
  for (const evn of ['dragleave', 'drop']) dz.addEventListener(evn, (e) => { e.preventDefault(); dz.classList.remove('over'); });
  dz.addEventListener('drop', async (e) => {
    const item = e.dataTransfer.items?.[0];
    if (item?.getAsFileSystemHandle) { try { const h = await item.getAsFileSystemHandle(); if (h?.kind === 'file') { state.dirHandle = null; return openFileObject(await h.getFile(), h); } } catch { /* fall through */ } }
    const f = e.dataTransfer.files[0]; if (f) { state.dirHandle = null; openFileObject(f); }
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());

  document.addEventListener('keydown', (e) => {
    if (!state.save) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); state.fileHandle ? saveInPlace() : download(); }
  });
  window.addEventListener('beforeunload', (e) => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });
  if (!window.showDirectoryPicker) $('folder-hint').textContent = 'Folder mode (save in place with automatic backup) needs Chrome or Edge on desktop. In this browser you download the edited file instead.';
}

(async function main() {
  wire();
  try { await loadCatalog(); state.catalogReady = true; }
  catch (e) { console.error(e); toast(`Item catalog failed to load: ${e.message}. Items will show as hashes.`, 'error'); }
  // Make the parser reachable from the console for poking at files.
  window.runeforge = { state, parseFch, stableHash, VERSIONS };
})();
