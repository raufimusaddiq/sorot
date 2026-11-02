import { deflateRawSync, inflateRawSync } from "node:zlib";

// The smallest zip reader and writer a kit part needs (FR-039: parts are shared as .zip files). Stored
// and deflated entries only, no zip64, no encryption: a part is a few small text files and maybe a
// pinned library. A path that would leave the part's folder is refused here, before anything is written.

export interface ZipEntry { path: string; data: Uint8Array }

export class ZipError extends Error {}

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
/** A part is small; a bigger archive is refused before it is unpacked. */
export const MAX_UNPACKED_BYTES = 50 * 1024 * 1024;

/** A relative path inside the archive's folder: no absolute paths, drive letters, `..` or backslashes. */
export function safeEntryPath(path: string): boolean {
  if (!path || path.includes("\\") || path.startsWith("/") || /^[a-zA-Z]:/.test(path) || path.includes("\0")) return false;
  return path.split("/").every((part) => part !== ".." && part !== ".");
}

/** The files in `bytes` (folders skipped). */
export function readZip(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === END) { end = i; break; }
  }
  if (end < 0) throw new ZipError("This isn't a zip file");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const entries: ZipEntry[] = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== CENTRAL) throw new ZipError("The zip file's directory is damaged");
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const path = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    if (path.endsWith("/")) continue;
    if (!safeEntryPath(path)) throw new ZipError(`The zip file holds a path outside its folder: ${path}`);
    if (flags & 1) throw new ZipError(`${path} is encrypted`);
    total += size;
    if (total > MAX_UNPACKED_BYTES) throw new ZipError(`The zip file unpacks to more than ${MAX_UNPACKED_BYTES / 1024 / 1024} MB`);
    if (view.getUint32(local, true) !== LOCAL) throw new ZipError(`The zip file's entry for ${path} is damaged`);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + compressed);
    let data: Uint8Array;
    if (method === 0) data = raw.slice();
    else if (method === 8) data = new Uint8Array(inflateRawSync(raw));
    else throw new ZipError(`${path} uses a compression this reader doesn't know (method ${method})`);
    if (data.length !== size) throw new ZipError(`${path} didn't unpack to its recorded size`);
    entries.push({ path, data });
  }
  return entries;
}

/** A zip of `entries`, deflated, with a fixed timestamp so the same files give the same bytes. */
export function writeZip(entries: ZipEntry[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    if (!safeEntryPath(e.path)) throw new ZipError(`Not a path inside the folder: ${e.path}`);
    const name = new TextEncoder().encode(e.path);
    const packed = new Uint8Array(deflateRawSync(e.data));
    const crc = Bun.hash.crc32(e.data);
    const head = new Uint8Array(30 + name.length);
    const h = new DataView(head.buffer);
    h.setUint32(0, LOCAL, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 8, true);
    h.setUint16(10, 0, true); h.setUint16(12, 0x21, true); // 1980-01-01 00:00
    h.setUint32(14, crc, true); h.setUint32(18, packed.length, true); h.setUint32(22, e.data.length, true);
    h.setUint16(26, name.length, true); head.set(name, 30);
    const dir = new Uint8Array(46 + name.length);
    const d = new DataView(dir.buffer);
    d.setUint32(0, CENTRAL, true); d.setUint16(4, 20, true); d.setUint16(6, 20, true); d.setUint16(8, 0x0800, true); d.setUint16(10, 8, true);
    d.setUint16(12, 0, true); d.setUint16(14, 0x21, true);
    d.setUint32(16, crc, true); d.setUint32(20, packed.length, true); d.setUint32(24, e.data.length, true);
    d.setUint16(28, name.length, true); d.setUint32(42, offset, true); dir.set(name, 46);
    locals.push(head, packed);
    centrals.push(dir);
    offset += head.length + packed.length;
  }
  const dirSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const v = new DataView(end.buffer);
  v.setUint32(0, END, true); v.setUint16(8, entries.length, true); v.setUint16(10, entries.length, true);
  v.setUint32(12, dirSize, true); v.setUint32(16, offset, true);
  const out = new Uint8Array(offset + dirSize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) { out.set(part, at); at += part.length; }
  return out;
}
