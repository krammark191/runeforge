// Little-endian primitives matching Valheim's ZPackage / .NET BinaryWriter encoding.
// Every read is bounds-checked and strict: anything that could not be re-encoded to
// the same bytes (non-canonical varints, bools other than 0/1, bad UTF-8) is an error.

export class FormatError extends Error {
  constructor(message, offset, path) {
    super(`${message} at 0x${offset.toString(16)}${path ? ` (${path})` : ''}`);
    this.name = 'FormatError';
    this.offset = offset;
    this.path = path;
  }
}

export function encode7bit(n) {
  const out = [];
  while (n >= 0x80) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
  return out;
}

const utf8Decode = new TextDecoder('utf-8', { fatal: true });
const utf8Encode = new TextEncoder();

export class Reader {
  constructor(bytes, base = 0) {
    this.b = bytes;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = 0;
    this.base = base;
    this.path = [];
  }
  get offset() { return this.base + this.pos; }
  get remaining() { return this.b.length - this.pos; }
  atEnd() { return this.pos === this.b.length; }
  scope(name, fn) {
    this.path.push(name);
    try { return fn(); } finally { this.path.pop(); }
  }
  error(message, at = this.offset) { return new FormatError(message, at, this.path.join('.')); }
  need(n) { if (n < 0 || n > this.remaining) throw this.error(`need ${n} bytes, ${this.remaining} left`); }
  raw(n) { this.need(n); const out = this.b.slice(this.pos, this.pos + n); this.pos += n; return out; }
  u8() { this.need(1); return this.b[this.pos++]; }
  bool() {
    const at = this.offset; const v = this.u8();
    if (v > 1) throw this.error(`bool byte must be 0 or 1, got ${v}`, at);
    return v === 1;
  }
  u16() { this.need(2); const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  i32() { this.need(4); const v = this.dv.getInt32(this.pos, true); this.pos += 4; return v; }
  i64() { this.need(8); const v = this.dv.getBigInt64(this.pos, true); this.pos += 8; return v; }
  // NaN payloads cannot survive a JS number, so they come back as { nanBits } and are re-emitted verbatim.
  f32() {
    this.need(4);
    const v = this.dv.getFloat32(this.pos, true);
    const bits = this.dv.getUint32(this.pos, true);
    this.pos += 4;
    return Number.isNaN(v) ? { nanBits: bits } : v;
  }
  vec3() { return [this.f32(), this.f32(), this.f32()]; }
  count(minItemSize = 1) {
    const at = this.offset; const n = this.i32();
    if (n < 0 || n * Math.max(minItemSize, 1) > this.remaining) throw this.error(`implausible count ${n}`, at);
    return n;
  }
  bytes() { return this.raw(this.count()); }
  string() {
    const at = this.offset;
    let n = 0, shift = 0, len = 0, done = false;
    for (let i = 0; i < 5; i++) {
      const b = this.u8(); len++;
      n |= (b & 0x7f) << shift; shift += 7;
      if (b < 0x80) { done = true; break; }
    }
    if (!done) throw this.error('string length varint longer than 5 bytes', at);
    if (len !== encode7bit(n).length) throw this.error('non-canonical string length', at);
    try { return utf8Decode.decode(this.raw(n)); } catch { throw this.error('invalid UTF-8 in string', at); }
  }
  // Inventory custom-data count: 1 byte if < 128, else 2 bytes with the high bit set.
  numItems() {
    const b = this.u8();
    if (b & 0x80) return ((b & 0x7f) << 8) | this.u8();
    return b;
  }
  strings() { const n = this.count(1); const out = []; for (let i = 0; i < n; i++) out.push(this.string()); return out; }
  stringPairs() { const n = this.count(2); const out = []; for (let i = 0; i < n; i++) out.push([this.string(), this.string()]); return out; }
  stringFloats() { const n = this.count(5); const out = []; for (let i = 0; i < n; i++) out.push([this.string(), this.f32()]); return out; }
}

export class Writer {
  constructor(initial = 1024) {
    this.b = new Uint8Array(initial);
    this.dv = new DataView(this.b.buffer);
    this.pos = 0;
  }
  ensure(n) {
    if (this.pos + n <= this.b.length) return;
    let size = this.b.length * 2;
    while (size < this.pos + n) size *= 2;
    const nb = new Uint8Array(size); nb.set(this.b);
    this.b = nb; this.dv = new DataView(nb.buffer);
  }
  raw(bytes) { this.ensure(bytes.length); this.b.set(bytes, this.pos); this.pos += bytes.length; }
  u8(v) { this.ensure(1); this.b[this.pos++] = v & 0xff; }
  bool(v) { this.u8(v ? 1 : 0); }
  u16(v) { this.ensure(2); this.dv.setUint16(this.pos, v, true); this.pos += 2; }
  i32(v) { this.ensure(4); this.dv.setInt32(this.pos, v, true); this.pos += 4; }
  i64(v) { this.ensure(8); this.dv.setBigInt64(this.pos, BigInt(v), true); this.pos += 8; }
  f32(v) {
    this.ensure(4);
    if (v !== null && typeof v === 'object' && 'nanBits' in v) this.dv.setUint32(this.pos, v.nanBits, true);
    else this.dv.setFloat32(this.pos, v, true);
    this.pos += 4;
  }
  vec3(v) { this.f32(v[0]); this.f32(v[1]); this.f32(v[2]); }
  bytes(bytes) { this.i32(bytes.length); this.raw(bytes); }
  string(s) {
    const enc = utf8Encode.encode(s);
    for (const b of encode7bit(enc.length)) this.u8(b);
    this.raw(enc);
  }
  numItems(n) {
    if (n > 32767) throw new Error(`too many entries: ${n}`);
    if (n < 128) this.u8(n);
    else { this.u8((n >> 8) | 0x80); this.u8(n & 0xff); }
  }
  strings(list) { this.i32(list.length); for (const s of list) this.string(s); }
  stringPairs(list) { this.i32(list.length); for (const [k, v] of list) { this.string(k); this.string(v); } }
  stringFloats(list) { this.i32(list.length); for (const [k, v] of list) { this.string(k); this.f32(v); } }
  toBytes() { return this.b.slice(0, this.pos); }
}

export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function concat(...parts) {
  let n = 0; for (const p of parts) n += p.length;
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
