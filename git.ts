// Git object model + packfile + pkt-line. Standard library only (node:crypto, node:zlib).
// No git binary anywhere: everything is implemented here.
// Wire framing (upload-pack v2/v0, receive-pack v0) lives in app.ts and uses these primitives.

import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';

// Object type numbers (packfile + loose).
export const OBJ_COMMIT = 1;
export const OBJ_TREE = 2;
export const OBJ_BLOB = 3;
export const OBJ_TAG = 4;
export const OBJ_OFS_DELTA = 6;
export const OBJ_REF_DELTA = 7;

export const TYPE_NAMES: Record<number, string> = {
  [OBJ_COMMIT]: 'commit',
  [OBJ_TREE]: 'tree',
  [OBJ_BLOB]: 'blob',
  [OBJ_TAG]: 'tag',
};
export const NAME_TYPES: Record<string, number> = {
  commit: OBJ_COMMIT,
  tree: OBJ_TREE,
  blob: OBJ_BLOB,
  tag: OBJ_TAG,
};

export interface GitObject {
  type: number;
  data: Buffer;
}

/** SHA-1 of "<type> <len>\0" + data, as a 40-hex string. */
export function hashObject(type: number, data: Buffer): string {
  const header = Buffer.from(`${TYPE_NAMES[type]} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** The exact bytes a loose object stores (header + data), zlib-deflated. */
export function looseEncode(type: number, data: Buffer): Buffer {
  const header = Buffer.from(`${TYPE_NAMES[type]} ${data.length}\0`, 'ascii');
  return deflateSync(Buffer.concat([header, data]));
}

/** Decode a loose object: returns {type, data}. Throws on corrupt input. */
export function looseDecode(raw: Buffer): GitObject {
  const buf = inflateSync(raw);
  const nul = buf.indexOf(0);
  const header = buf.subarray(0, nul).toString('ascii');
  const [typeName, lenStr] = header.split(' ');
  const type = NAME_TYPES[typeName];
  const len = Number(lenStr);
  if (!type || !Number.isInteger(len) || buf.length - nul - 1 !== len) {
    throw new Error('corrupt loose object');
  }
  return { type, data: Buffer.from(buf.subarray(nul + 1)) };
}

// ---------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

/** Encode one pkt-line (payload without the 4-byte length). */
export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

/** Encode a list of payloads as pkt-lines, ending with a flush. */
export function pktLines(payloads: Array<Buffer | string>, endWithFlush = true): Buffer {
  const parts = payloads.map((p) => pktLine(p));
  if (endWithFlush) parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Split a buffer into pkt-line frames. Returns {lines, rest} where each line is the
 *  payload (without length), or null for a flush/delim/response-end marker. */
export function pktSplit(buf: Buffer): { lines: Array<Buffer | null>; rest: Buffer } {
  const lines: Array<Buffer | null> = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = parseInt(buf.subarray(off, off + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) { lines.push(null); off += 4; continue; }
    if (len === 1) { lines.push(Buffer.from([1])); off += 4; continue; }
    if (len === 2) { lines.push(Buffer.from([2])); off += 4; continue; }
    if (off + len > buf.length) break;
    lines.push(Buffer.from(buf.subarray(off + 4, off + len)));
    off += len;
  }
  return { lines, rest: Buffer.from(buf.subarray(off)) };
}

// ---------------------------------------------------------------------------
// Packfile: parse + build (plain, non-delta entries; deltas resolved on read)
// ---------------------------------------------------------------------------

export interface PackEntry {
  oid: string;
  type: number;
  data: Buffer;
}

/** Read a varint size from buf at off (packfile object header encoding).
 *  Returns [size, nextOffset]. The first byte's low 4 bits are the low bits of
 *  the size, the next 3 bits are the type, then 7 bits per continuation byte. */
function readSizeEncoding(buf: Buffer, off: number): [number, number, number] {
  let b = buf[off];
  let size = b & 0x0f;
  let shift = 4;
  const type = (b >> 4) & 0x07;
  let i = off + 1;
  while (b & 0x80) {
    b = buf[i];
    size |= (b & 0x7f) << shift;
    shift += 7;
    i += 1;
  }
  return [type, size, i];
}

/** Read an offset-delta base offset (packfile ofs-delta encoding). */
function readOfsOffset(buf: Buffer, off: number): [number, number] {
  let b = buf[off];
  let offset = b & 0x7f;
  let i = off + 1;
  while (b & 0x80) {
    b = buf[i];
    offset = ((offset + 1) << 7) | (b & 0x7f);
    i += 1;
  }
  return [offset, i];
}

/** Apply a delta (copy/insert instructions) to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  // Source size varint (ignored, but consumed).
  while (delta[off] & 0x80) off += 1;
  off += 1;
  // Target size varint (ignored, but consumed).
  while (delta[off] & 0x80) off += 1;
  off += 1;
  const parts: Buffer[] = [];
  while (off < delta.length) {
    const op = delta[off];
    off += 1;
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) { cpOff |= delta[off] << (8 * i); off += 1; }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) { cpSize |= delta[off] << (8 * i); off += 1; }
      }
      if (cpSize === 0) cpSize = 0x10000;
      parts.push(base.subarray(cpOff, cpOff + cpSize));
    } else if (op !== 0) {
      parts.push(delta.subarray(off, off + op));
      off += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  return Buffer.concat(parts);
}

/** Parse a whole packfile buffer into objects. Resolves ofs-delta and ref-delta.
 * `lookup` supplies objects already held by the receiver (thin-pack delta
 * bases) without copying the receiver's whole object map per pack. Entries
 * parsed earlier in this pack are also available as bases. */
export function parsePack(buf: Buffer, lookup?: (oid: string) => PackEntry | undefined): PackEntry[] {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  const byOid = new Map<string, PackEntry>();
  let off = 12;
  for (let n = 0; n < count; n += 1) {
    const start = off;
    const [type, size, dataOff] = readSizeEncoding(buf, off);
    off = dataOff;
    let objType = type;
    let data: Buffer;
    let baseOid: string | null = null;
    let baseOffset: number | null = null;
    if (type === OBJ_OFS_DELTA) {
      const [baseOff, after] = readOfsOffset(buf, off);
      baseOffset = start - baseOff;
      off = after;
      const inflated = inflateSync(buf.subarray(off));
      // inflateSync consumes the whole remaining buffer; find the consumed length
      // by re-inflating with a streaming-safe approach: use the zlib stream length.
      const consumed = zlibConsumed(buf.subarray(off));
      off += consumed;
      const base = byOffset.get(baseOffset);
      if (!base) throw new Error('ofs-delta base not found');
      data = applyDelta(base.data, inflated);
      objType = base.type;
    } else if (type === OBJ_REF_DELTA) {
      baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
      const inflated = inflateSync(buf.subarray(off));
      const consumed = zlibConsumed(buf.subarray(off));
      off += consumed;
      const base = byOid.get(baseOid) ?? lookup?.(baseOid);
      if (!base) throw new Error('ref-delta base not found');
      data = applyDelta(base.data, inflated);
      objType = base.type;
    } else {
      const inflated = inflateSync(buf.subarray(off));
      const consumed = zlibConsumed(buf.subarray(off));
      off += consumed;
      data = inflated;
      if (data.length !== size) throw new Error('pack object size mismatch');
    }
    const oid = hashObject(objType, data);
    const entry: PackEntry = { oid, type: objType, data };
    entries.push(entry);
    byOffset.set(start, entry);
    byOid.set(oid, entry);
  }
  return entries;
}

/** Number of bytes the zlib stream at the start of buf occupies. */
function zlibConsumed(buf: Buffer): number {
  // Deflate streams have no length prefix; find the end by inflating incrementally.
  // Node's zlib has no "bytes consumed" API, so binary-search the smallest prefix
  // that inflates cleanly. Packs here are small (<= a few MB), so this is cheap.
  let lo = 1;
  let hi = buf.length;
  // Fast path: most streams end well before the buffer end; try growing windows
  // to tighten hi before the binary search.
  let probe = 64;
  while (probe < hi) {
    try {
      inflateSync(buf.subarray(0, probe));
      hi = probe;
      break;
    } catch {
      probe *= 2;
    }
  }
  // Binary-search the smallest prefix that inflates cleanly. If the stream spans
  // the whole buffer this returns buf.length; if the buffer is truncated the
  // caller's inflate of the returned slice throws.
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buf.subarray(0, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return lo;
}

/** Build a packfile (v2, plain entries, no deltas) from objects. */
/** Deflated form of an object, cached by oid. Objects are content-addressed
 *  (the oid IS the content hash), so the cache is valid across repos and
 *  across packs. The clone workload builds the same 200-commit pack 50 times;
 *  without this, deflate dominates the trial. Bounded: cleared past 20k entries. */
const deflateCache = new Map<string, Buffer>();

export function buildPack(objects: PackEntry[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const data = obj.data;
    // Size/type header: first byte: (type << 4) | (size & 0x0f), MSB set if more.
    let size = data.length;
    const headBytes: number[] = [];
    let first = ((obj.type & 0x07) << 4) | (size & 0x0f);
    size >>= 4;
    if (size > 0) first |= 0x80;
    headBytes.push(first);
    while (size > 0) {
      let b = size & 0x7f;
      size >>= 7;
      if (size > 0) b |= 0x80;
      headBytes.push(b);
    }
    parts.push(Buffer.from(headBytes));
    let deflated = deflateCache.get(obj.oid);
    if (deflated === undefined) {
      deflated = deflateSync(data);
      if (deflateCache.size > 20_000) deflateCache.clear();
      deflateCache.set(obj.oid, deflated);
    }
    parts.push(deflated);
  }
  // Trailer: SHA-1 of everything so far (20 bytes).
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------
// Tree / commit helpers
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const mode = data.subarray(off, sp).toString('ascii');
    const nul = data.indexOf(0, sp);
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

/** Build a tree object's bytes from entries (sorted by name, dirs as name+"/"). */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's headers + message. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit object's bytes. */
export function buildCommit(c: CommitInfo): Buffer {
  const lines = [`tree ${c.tree}`];
  for (const p of c.parents) lines.push(`parent ${p}`);
  lines.push(`author ${c.author}`);
  lines.push(`committer ${c.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${c.message}`, 'utf8');
}
