import { Doc, ONBEAM, GLOW } from "./fc";
import { menuBar, rail, ic, verdictMark, scoreBar } from "./components";

type O = Record<string, any>;

export const fall = (flip = false) => [{
  type: "linearGradient", from: flip ? [1, 0.5] : [0, 0.5], to: flip ? [0, 0.5] : [1, 0.5],
  stops: [{ position: 0, color: "#F0B44C" }, { position: 1, color: "#F0B44C00" }],
}];

export function btn(d: Doc, p: string, t: string, kind: "primary" | "secondary" | "quiet" | "disabled" = "secondary", o: O = {}) {
  const prim = kind === "primary";
  const b = d.row(p, "Button " + t, {
    h: 36, sv: "fixed", pad: [0, 16, 0, 16], cross: "center", main: "center", radius: 6,
    fill: prim ? "beam" : kind === "secondary" || kind === "disabled" ? "raised" : "none",
    stroke: kind === "secondary" || kind === "disabled" ? "edge" : "none", opacity: kind === "disabled" ? 0.4 : 1, ...o,
  });
  d.text(b, t, { size: 13, wt: 600, color: prim ? ONBEAM : "text" });
  return b;
}

// the beam's primary-action ring (glow use 2 of 2): drawn around a button
export function actionRing(d: Doc, p: string, w: number, x = 0, y = 0) {
  return d.node("rectangle", p, "beam action ring", { absolute: true, x: x - 4, y: y - 4, w: w + 8, h: 44, fill: "none", radius: 8, stroke: "beamText", sw: 2, effects: GLOW });
}

export function link(d: Doc, p: string, t: string, o: O = {}) {
  return d.text(p, t, { size: 13, wt: 600, color: "beamText", ...o });
}

export function inputField(d: Doc, p: string, label: string, value: string, o: { ph?: boolean; w?: number; area?: boolean; error?: string; help?: string; fillW?: boolean; focus?: boolean; select?: boolean } = {}) {
  const c = d.col(p, "Field " + label, { gap: 6, ...(o.w ? { w: o.w, sh: "fixed" } : {}), ...(o.fillW ? { sh: "fill" } : {}) });
  d.text(c, label, { size: 12, wt: 500, color: "muted" });
  const box = d.row(c, "field", {
    sh: "fill", h: o.area ? 88 : 36, sv: "fixed", pad: [o.area ? 8 : 0, 12, 0, 12], cross: o.area ? "min" : "center", fill: "raised", radius: 6, gap: 8,
    stroke: o.error ? "skip" : o.focus ? "beamText" : "edge", sw: o.error || o.focus ? 2 : 1,
  });
  d.text(box, value, { size: 13, color: o.ph ? "muted" : "text", fillW: true });
  if (o.select) ic(d, box, "chevron", "muted");
  if (o.error) d.text(c, o.error, { size: 12, color: "skip", fillW: true });
  else if (o.help) d.text(c, o.help, { size: 12, color: "muted", fillW: true });
  return c;
}

export function switchRow(d: Doc, p: string, t: string, on: boolean, help?: string) {
  const r = d.row(p, "Switch " + t, { gap: 12, cross: "center", sh: "fill" });
  const tx = d.col(r, "teks", { sh: "fill", gap: 2 });
  d.text(tx, t, { size: 13, wt: 500, fillW: true });
  if (help) d.text(tx, help, { size: 12, color: "muted", fillW: true });
  const tr = d.frame(r, "track", { w: 36, h: 20, sh: "fixed", sv: "fixed", fill: on ? "beam" : "raised", stroke: on ? "beamText" : "edge", radius: 6 });
  d.node("ellipse", tr, "thumb", { x: on ? 19 : 3, y: 3, w: 14, h: 14, fill: on ? ONBEAM : "edge" });
  return r;
}

export function panel(d: Doc, p: string, name: string, o: O = {}) {
  return d.col(p, name, { gap: 12, pad: 24, fill: "surface", stroke: "divider", radius: 10, ...o });
}

export function head(d: Doc, p: string, title: string, sub?: string, o: O = {}) {
  const c = d.col(p, "Judul", { gap: 4, sh: "fill", ...o });
  d.text(c, title, { size: 26, wt: 600, fillW: true });
  if (sub) d.text(c, sub, { size: 13, color: "muted", fillW: true });
  return c;
}

export function h3(d: Doc, p: string, t: string, sub?: string) {
  const c = d.col(p, "Bagian " + t, { gap: 2, sh: "fill" });
  d.text(c, t, { size: 15, wt: 600, fillW: true });
  if (sub) d.text(c, sub, { size: 12, color: "muted", fillW: true });
  return c;
}

export function divider(d: Doc, p: string) {
  return d.frame(p, "pembatas", { h: 1, sh: "fill", sv: "fixed", fill: "divider" });
}

export function beamHair(d: Doc, p: string, w: number, o: O = {}) {
  return d.node("rectangle", p, "beam", { w, h: 3, fills: fall(), ...o });
}

export function kv(d: Doc, p: string, k: string, v: string, o: { num?: boolean; color?: string; w?: number } = {}) {
  const r = d.row(p, "kv " + k, { sh: "fill", gap: 12, cross: "center" });
  d.text(r, k, { size: 13, color: "muted", w: o.w ?? 140 });
  d.text(r, v, { size: 13, wt: 500, num: o.num, color: o.color ?? "text", fillW: true });
  return r;
}

export function pill(d: Doc, p: string, t: string, active = false) {
  const r = d.row(p, "Segmen " + t, { h: 32, sv: "fixed", pad: [0, 12, 0, 12], cross: "center", fill: active ? "raised" : "none", stroke: active ? "edge" : "none", radius: 6 });
  d.text(r, t, { size: 13, wt: active ? 600 : 500, color: active ? "text" : "muted" });
  return r;
}

export function status(d: Doc, p: string, word: string, ok: boolean) {
  const t = d.text(p, word, { size: 13, wt: 600, color: ok ? "pass" : "skip" });
  return t;
}

// a screen: frame (menu bar + optional rail + content). Returns the content column.
export function screen(d: Doc, name: string, w: number, h: number, selected: string | null, x: number, y: number, light: boolean) {
  const f = d.col(null, name, { x, y, w, h, sh: "fixed", sv: "fixed", fill: "bg", clip: true });
  if (light) d.cmd("variable.setMode", { ids: [d.ref(f)], collection: "color", mode: "light" });
  menuBar(d, f, { w, sh: "fill" });
  const body = d.row(f, "Badan", { sh: "fill", sv: "fill" });
  if (selected !== null) rail(d, body, selected, { h: h - 32, sv: "fill" });
  const content = d.col(body, "Isi", { sh: "fill", sv: "fill", pad: 40, gap: 24 });
  return { frame: f, content };
}

export { verdictMark, scoreBar, ic, GLOW };
