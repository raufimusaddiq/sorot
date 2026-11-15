// Builds icon.icns and icon.ico from the exported PNGs (icns/, ico/). Run: bun desktop/assets/icon/build-icons.ts
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const dir = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const png = (p: string) => new Uint8Array(readFileSync(join(dir, p)));

// icns: header, then type + length + PNG data per size (icp4..ic10 = 16..1024).
const ICNS: [string, string][] = [
  ["icp4", "icns/icon-16.png"], ["icp5", "icns/icon-32.png"], ["icp6", "icns/icon-64.png"],
  ["ic07", "icns/icon-128.png"], ["ic08", "icns/icon-256.png"], ["ic09", "icns/icon-512.png"],
  ["ic10", "icns/icon-1024.png"],
];
const chunks = ICNS.map(([t, p]) => {
  const d = png(p), b = new Uint8Array(8 + d.length), v = new DataView(b.buffer);
  b.set(new TextEncoder().encode(t)); v.setUint32(4, b.length); b.set(d, 8);
  return b;
});
const total = 8 + chunks.reduce((n, c) => n + c.length, 0);
const icns = new Uint8Array(total), iv = new DataView(icns.buffer);
icns.set(new TextEncoder().encode("icns")); iv.setUint32(4, total);
let o = 8; for (const c of chunks) { icns.set(c, o); o += c.length; }
writeFileSync(join(dir, "icon.icns"), icns);

// ico: ICONDIR + one ICONDIRENTRY per PNG (size 256 is stored as 0).
const SIZES = [16, 24, 32, 48, 256];
const imgs = SIZES.map((s) => png(`ico/icon-${s}.png`));
const head = 6 + 16 * imgs.length;
const ico = new Uint8Array(head + imgs.reduce((n, i) => n + i.length, 0)), dv = new DataView(ico.buffer);
dv.setUint16(2, 1, true); dv.setUint16(4, imgs.length, true);
let off = head;
imgs.forEach((img, i) => {
  const e = 6 + 16 * i, s = SIZES[i];
  ico[e] = s === 256 ? 0 : s; ico[e + 1] = ico[e];
  dv.setUint16(e + 4, 1, true); dv.setUint16(e + 6, 32, true);
  dv.setUint32(e + 8, img.length, true); dv.setUint32(e + 12, off, true);
  ico.set(img, off); off += img.length;
});
writeFileSync(join(dir, "icon.ico"), ico);
