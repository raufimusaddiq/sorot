import { Doc, GLOW } from "./fc";

// T009: the beam as an icon. One solid wedge from the head at the upper left, no letters.
// Reason: the icon is the identity motif itself, so icon and app say the same thing (design.md, Assets).
const BEAM = "#F0B44C";
const BG = "#0E0F11";

export interface IconOpts {
  round: boolean; // own 22% corner radius (Windows, Linux); macOS is full-bleed, the OS adds the mask
  mono?: boolean; // one-colour tray / template version
  name: string;
  x?: number;
  y?: number;
}

export function icon(d: Doc, parent: string | null, size: number, o: IconOpts) {
  const k = size / 1024;
  const f = d.frame(parent, o.name, {
    w: size, h: size, x: o.x, y: o.y, clip: true,
    fill: o.mono ? "none" : BG, radius: o.round ? Math.round(size * 0.22) : 0,
  });
  const wedge = d.node("vector", f, "beam cone", {
    x: 200 * k, y: 200 * k, w: 790 * k, h: 790 * k, path: "M0 0 L790 300 L300 790 Z", closed: true,
    fill: o.mono ? "#000000" : "none",
  });
  if (!o.mono) {
    d.set(wedge, {
      fills: [{
        type: "linearGradient", from: [0, 0], to: [1, 1],
        stops: [{ position: 0, color: BEAM }, { position: 0.55, color: "#F0B44C99" }, { position: 1, color: "#F0B44C00" }],
      }],
    });
  }
  const head = d.node("ellipse", f, "beam head", {
    x: (200 - 76) * k, y: (200 - 76) * k, w: 152 * k, h: 152 * k, fill: o.mono ? "#000000" : BEAM,
  });
  if (!o.mono && size >= 128) d.set(head, { effects: [{ type: "dropShadow", color: "#F0B44CB3", offset: [0, 0], radius: 40 * k }] });
  return f;
}

export function wordmark(d: Doc, parent: string | null, name: string, color: string, size = 96, o: Record<string, any> = {}) {
  const r = d.row(parent, name, { gap: 0, cross: "min", ...o });
  // hand-adjusted S: +40 weight and -1.5% tracking so the first letter holds the word at the same colour density
  d.text(r, "S", { size, wt: 640, color, letterSpacing: -size * 0.015, name: "S (adjusted)" });
  d.text(r, "orot", { size, wt: 600, color, letterSpacing: -size * 0.01, name: "orot" });
  return r;
}

export function brand(d: Doc) {
  const root = d.frame(null, "Brand", { w: 2100, h: 1500, fill: "bg" });
  d.cmd("variable.setMode", { ids: [d.ref(root)], collection: "color", mode: "light" });
  d.text(root, "Sorot: ikon dan wordmark", { size: 26, wt: 600, x: 40, y: 32 });
  d.text(root, "Ikon = sorotnya: satu kerucut cahaya tungsten melintasi persegi grafit, kepala di kiri atas seperti lampu panggung, tanpa huruf.", { size: 13, color: "muted", x: 40, y: 76 });
  const ids: Record<string, string> = {};
  const cap = (t: string, x: number, y: number, w = 460) => d.text(root, t, { size: 12, color: "muted", x, y, w });

  ids.mac = icon(d, root, 1024, { round: false, name: "Icon macOS 1024", x: 40, y: 130 });
  cap("macOS: persegi penuh 1024. Sistem memasang topeng 22%. Alasan: topeng macOS memotong sudut, jadi gambar tidak boleh membawa sudutnya sendiri.", 40, 1170, 900);

  ids.win = icon(d, root, 256, { round: true, name: "Icon Windows 256", x: 1120, y: 130 });
  cap("Windows: sudut transparan, radius 22%. Diekspor 16, 24, 32, 48, 256.", 1120, 400, 300);
  ids.linux = icon(d, root, 512, { round: true, name: "Icon Linux 512", x: 1480, y: 130 });
  cap("Linux: 512, sudut transparan. Alasan: tema ikon Linux tidak memasang topeng.", 1480, 660, 400);

  ids.tray = icon(d, root, 128, { round: false, mono: true, name: "Icon tray template 128", x: 1120, y: 470 });
  cap("Satu warna untuk tray Linux dan template macOS. Alasan: sistem mewarnainya sendiri, jadi hanya bentuk yang dibawa.", 1120, 610, 400);

  const proof = d.row(root, "Uji ukuran kecil", { x: 1120, y: 740, gap: 24, cross: "max" });
  for (const s of [16, 24, 32, 48]) icon(d, proof, s, { round: true, name: "Icon " + s });
  const proof2 = d.row(root, "Uji ukuran kecil 4x", { x: 1120, y: 810, gap: 24, cross: "max" });
  for (const s of [16, 24, 32, 48]) icon(d, proof2, s * 4, { round: true, name: "Icon " + s + " x4" });
  cap("Satu baji utuh tanpa sinar tipis, jadi tetap terbaca di 16 px. Baris bawah: 4x.", 1120, 1070, 460);

  const wm = d.frame(root, "Wordmark dark", { x: 1120, y: 1130, w: 460, h: 160, fill: "#0E0F11", stroke: "#2A2E33", radius: 10, layout: "horizontal", main: "center", cross: "center", sh: "fixed", sv: "fixed" });
  const wmIn = wordmark(d, wm, "Wordmark", "#ECE8E1", 96);
  const wl = d.frame(root, "Wordmark light", { x: 1600, y: 1130, w: 420, h: 160, fill: "#F4F1EA", stroke: "#DAD4C8", radius: 10, layout: "horizontal", main: "center", cross: "center", sh: "fixed", sv: "fixed" });
  const wlIn = wordmark(d, wl, "Wordmark", "#17191C", 96);
  d.text(root, "Wordmark: Sorot, Instrument Sans 600. S disesuaikan: bobot +40 dan jarak -1,5% supaya huruf pertama memegang kata dengan kepadatan yang sama.", { size: 12, color: "muted", x: 1120, y: 1300, w: 900 });
  ids.wm = wm;
  ids.wml = wl;
  ids.wmInner = wmIn;
  ids.wmInnerLight = wlIn;
  return { root, ids };
}
