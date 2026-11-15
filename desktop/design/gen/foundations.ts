import { Doc, COLORS, SPACE, RADIUS, SIZES, WEIGHTS, styleName } from "./fc";

// T002: variable collections. T003: text styles. Page content: swatches (both modes), type scale, space, radius.
export function variables(d: Doc) {
  d.cmd("variable.createCollection", { name: "color", modes: ["dark", "light"] });
  for (const [k, [dk, lt]] of Object.entries(COLORS)) {
    d.cmd("variable.create", { collection: "color", name: k, type: "color", values: { dark: dk, light: lt } });
  }
  d.cmd("variable.createCollection", { name: "space" });
  for (const v of SPACE) d.cmd("variable.create", { collection: "space", name: String(v), type: "number", value: v });
  d.cmd("variable.createCollection", { name: "radius" });
  for (const v of RADIUS) d.cmd("variable.create", { collection: "radius", name: String(v), type: "number", value: v });
}

export function foundations(d: Doc, page: string) {
  const root = d.frame(null, "Foundations", { w: 1700, h: 1500, layout: "vertical", gap: 40, pad: 40, fill: "bg" });
  d.text(root, "Sorot: fondasi desain", { size: 26, wt: 600 });
  d.text(root, "Warna, tipe, jarak, radius. Nilai dari desain.md, dua mode (dark, light).", { size: 13, color: "muted" });

  // type styles first (samples), so later text can apply them
  const typ = d.col(root, "Tipe", { gap: 12, sh: "fill", sv: "hug" });
  d.text(typ, "Tipe: Instrument Sans 12 / 13 / 15 / 19 / 26 / 40, bobot 400 / 500 / 600", { size: 15, wt: 600 });
  const sample = "Potong video ini  00:42  0123456789";
  for (const size of SIZES) {
    const r = d.row(typ, `type ${size}`, { gap: 24, cross: "center", sh: "fill", sv: "hug" });
    for (const wt of [400, 500, 600]) {
      const t = d.text(r, `${size} ${WEIGHTS[wt]}`, { size, wt, name: `sample ${size} ${WEIGHTS[wt]}` });
      const nm = styleName(size, wt, false);
      d.cmd("style.create", { type: "text", name: nm, from: d.ref(t) });
      d.styles.add(nm);
    }
    const t = d.text(r, "00:42 0123456789", { size, wt: 500, num: true, name: `sample numeric ${size}` });
    const nm = styleName(size, 500, true);
    d.cmd("style.create", { type: "text", name: nm, from: d.ref(t) });
    d.styles.add(nm);
  }
  d.text(typ, "Angka tabular di style numeric/*: skor, durasi, timecode sejajar di kolom. Tanpa huruf kapital berjarak lebar.", { size: 13, color: "muted" });

  // colour panels, one per mode
  const panels = d.row(root, "Warna", { gap: 40, sv: "hug", sh: "fill" });
  for (const mode of ["dark", "light"]) {
    const p = d.col(panels, `Warna ${mode}`, { gap: 8, pad: 24, fill: "bg", stroke: "divider", radius: 10, w: 780, sv: "hug" });
    d.text(p, `Warna: ${mode}`, { size: 15, wt: 600 });
    const grid = d.row(p, "swatches", { gap: 12, wrap: true, sh: "fill", sv: "hug" });
    for (const [k, [dk, lt]] of Object.entries(COLORS)) {
      const c = d.col(grid, `swatch ${k}`, { gap: 4, w: 112, sv: "hug" });
      d.rect(c, k, { w: 112, h: 48, fill: k, radius: 6, stroke: "divider", sw: 1 });
      d.text(c, k, { size: 12, wt: 600 });
      d.text(c, mode === "dark" ? dk : lt, { size: 12, color: "muted", num: false });
    }
    if (mode === "light") d.cmd("variable.setMode", { ids: [d.ref(p)], collection: "color", mode: "light" });
  }

  // space + radius
  const sr = d.row(root, "Jarak dan radius", { gap: 64, sh: "fill", sv: "hug" });
  const sp = d.col(sr, "Jarak", { gap: 8, sv: "hug" });
  d.text(sp, "Jarak: 4 / 8 / 12 / 16 / 24 / 40 / 64", { size: 15, wt: 600 });
  for (const v of SPACE) {
    const r = d.row(sp, `space ${v}`, { gap: 12, cross: "center", sv: "hug" });
    d.rect(r, `bar ${v}`, { w: v * 4, h: 12, fill: "beam", radius: 2 });
    d.text(r, `${v}`, { size: 13, num: true, wt: 500 });
  }
  d.text(sp, "Daftar bernapas di 12. Wilayah layar dipisah di 40.", { size: 13, color: "muted" });
  const rd = d.col(sr, "Radius", { gap: 8, sv: "hug" });
  d.text(rd, "Radius: 2 chip dan tanda verdict, 6 kontrol, 10 panel dan panggung klip", { size: 15, wt: 600 });
  const rr = d.row(rd, "radius row", { gap: 24, sv: "hug" });
  for (const v of RADIUS) {
    const c = d.col(rr, `radius ${v}`, { gap: 8, cross: "center", sv: "hug" });
    d.rect(c, `sq ${v}`, { w: 72, h: 72, fill: "raised", stroke: "edge", sw: 1, radius: v });
    d.text(c, `${v}`, { size: 13, num: true, wt: 500 });
  }
  d.text(rd, "Satu-satunya bentuk bulat penuh: jempol switch.", { size: 13, color: "muted" });
  return root;
}
