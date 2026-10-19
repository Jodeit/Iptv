// EBML (the binary format under Matroska/MKV): a streaming byte reader and helpers for
// parsing elements. Every element is: ID (variable-length int, marker kept), size
// (variable-length int, marker removed; all ones = unknown), then the payload.

export const UNKNOWN = -1;

export class ByteReader {
  // stream: a ReadableStream of Uint8Array; pos: file offset of its first byte.
  constructor(stream, pos = 0) {
    this.reader = stream.getReader();
    this.buf = new Uint8Array(0);
    this.off = 0;
    this.pos = pos;
    this.eof = false;
  }

  get available() { return this.buf.length - this.off; }

  // Makes at least n bytes available (fewer only at end of stream). Chunks are joined once,
  // so filling a large element doesn't copy the buffer over and over.
  async fill(n) {
    if (this.available >= n) return true;
    const parts = [this.buf.subarray(this.off)];
    let have = parts[0].length;
    while (have < n) {
      const { value, done } = await this.reader.read();
      if (done) { this.eof = true; break; }
      parts.push(value);
      have += value.length;
    }
    this.buf = parts.length === 1 ? parts[0] : concat(parts, have);
    this.off = 0;
    return have >= n;
  }

  async read(n) {
    if (!await this.fill(n)) throw new Error('unexpected end of file');
    const out = this.buf.subarray(this.off, this.off + n);
    this.off += n;
    this.pos += n;
    return out;
  }

  async skip(n) {
    while (n > 0) {
      if (!this.available && !await this.fill(1)) throw new Error('unexpected end of file');
      const k = Math.min(n, this.available);
      this.off += k;
      this.pos += k;
      n -= k;
    }
  }

  async peekByte() {
    return await this.fill(1) ? this.buf[this.off] : -1;
  }

  // Element header: { id, size, start } (start = file offset of the ID). null at end of file.
  async header() {
    if (!await this.fill(1)) return null;
    const start = this.pos;
    const id = await this.vint(true);
    const size = await this.vint(false);
    return { id, size, start };
  }

  // Next element ID without consuming it (for clusters of unknown size).
  async peekId() {
    if (!await this.fill(1)) return null;
    const len = vintLength(this.buf[this.off]);
    if (!await this.fill(len)) return null;
    let v = 0;
    for (let i = 0; i < len; i++) v = v * 256 + this.buf[this.off + i];
    return v;
  }

  async vint(keepMarker) {
    const first = await this.peekByte();
    if (first < 0) throw new Error('unexpected end of file');
    const len = vintLength(first);
    const b = await this.read(len);
    return decodeVint(b, 0, len, keepMarker).value;
  }

  cancel() {
    return this.reader.cancel().catch(() => {});
  }
}

export function vintLength(byte) {
  for (let i = 0; i < 8; i++) if (byte & (0x80 >> i)) return i + 1;
  throw new Error('invalid EBML variable-length integer');
}

// Decodes a variable-length integer at b[o]; size values that are all ones mean "unknown".
export function decodeVint(b, o, len = vintLength(b[o]), keepMarker = false) {
  let v = keepMarker ? b[o] : b[o] & (0xff >> len);
  let allOnes = v === (0xff >> len);
  for (let i = 1; i < len; i++) {
    v = v * 256 + b[o + i];
    if (b[o + i] !== 0xff) allOnes = false;
  }
  return { value: !keepMarker && allOnes ? UNKNOWN : v, length: len };
}

// Iterates the child elements of a fully buffered master element.
export function* children(b, from = 0, to = b.length) {
  let o = from;
  while (o < to) {
    const id = decodeVint(b, o, undefined, true);
    o += id.length;
    const size = decodeVint(b, o);
    o += size.length;
    const end = size.value === UNKNOWN ? to : Math.min(to, o + size.value);
    yield { id: id.value, data: b.subarray(o, end), start: o, end };
    o = end;
  }
}

export function uint(b) {
  let v = 0;
  for (const x of b) v = v * 256 + x;
  return v;
}

export function float(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return b.length === 4 ? dv.getFloat32(0) : b.length === 8 ? dv.getFloat64(0) : 0;
}

export function str(b) {
  let end = b.indexOf(0);
  if (end < 0) end = b.length;
  return new TextDecoder().decode(b.subarray(0, end));
}

export function concat(parts, total = parts.reduce((n, p) => n + p.length, 0)) {
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
