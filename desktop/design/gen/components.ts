import { Doc, ONBEAM, GLOW, mode } from "./fc";
import { icon } from "./brand";

// T004 beam, T005 components. Every colour is a bound token; literal hex only where a mode-independent value is the point.
export type St = "default" | "hover" | "pressed" | "focused" | "disabled" | "error";
export const STATES: St[] = ["default", "hover", "pressed", "focused", "disabled", "error"];

// ---- icons: 1.5 px stroke, square ends, 16 px grid. Only where a label alone is slower (design.md, Assets) ----
export const ICONS: Record<string, { path: string; why: string }> = {
  play: { path: "M4 2 L13 8 L4 14 Z", why: "preview transport: start" },
  pause: { path: "M4 2 L4 14 M12 2 L12 14", why: "preview transport: stop" },
  cancel: { path: "M3 3 L13 13 M13 3 L3 13", why: "cancel a running job" },
  reveal: { path: "M2 4 L6 4 L8 6 L14 6 L14 13 L2 13 Z", why: "show the file in its folder" },
  retry: { path: "M13 8 A5 5 0 1 1 11 4 M13 2 L13 5 L10 5", why: "run a failed step again" },
  chevron: { path: "M3 6 L8 11 L13 6", why: "opens a list" },
  check: { path: "M3 8 L7 12 L13 4", why: "checked" },
};

export function ic(d: Doc, parent: string | null, key: string, color = "text", size = 16) {
  const v = d.node("vector", parent, "ikon " + key, { w: size, h: size, path: ICONS[key].path, fill: "none", stroke: color, sw: 1.5, strokeCap: "square", strokeJoin: "miter" });
  return v;
}

// ---- generic state look for boxed controls ----
function look(st: St) {
  switch (st) {
    case "hover": return { stroke: "muted", sw: 1 };
    case "pressed": return { stroke: "text", sw: 1 };
    case "focused": return { stroke: "beamText", sw: 2 };
    case "error": return { stroke: "skip", sw: 2 };
    default: return { stroke: "edge", sw: 1 };
  }
}

export interface Placed { ref: string; w: number; h: number }

// Cursor that lays loose components in a grid on the page (position only matters before they become variants).
export class Grid {
  x = 40; y = 0; rowH = 0;
  constructor(public d: Doc, public parent: string | null, public maxW = 1700) {}
  at(w: number, h: number) {
    if (this.x + w > this.maxW) { this.x = 40; this.y += this.rowH + 24; this.rowH = 0; }
    const p = { x: this.x, y: this.y };
    this.x += w + 24;
    this.rowH = Math.max(this.rowH, h);
    return p;
  }
  nextRow(gap = 64) { this.x = 40; this.y += this.rowH + gap; this.rowH = 0; }
}

function label(d: Doc, page: string | null, t: string, x: number, y: number, note?: string) {
  d.text(page, t, { size: 19, wt: 600, x, y });
  if (note) d.text(page, note, { size: 12, color: "muted", x, y: y + 28, w: 900 });
}

function combine(d: Doc, ids: string[], name: string, desc: string, x: number, y: number) {
  const s = d.fresh();
  d.cmd("component.combineVariants", { ids: ids.map((i) => d.ref(i)) }, s);
  d.set(s, { name, description: desc, x, y });
  return s;
}

// ---------------------------------------------------------------- beam
// rune-fx signature moments (design.md): the beam head is a heat light (cool, warming, hot), grain only on the beam fill.
export type Heat = "cool" | "warming" | "hot";
export const HEAT: Record<Heat, { size: number; fill: string; glow: { radius: number; color: string } }> = {
  cool: { size: 10, fill: "#B98B3D", glow: { radius: 4, color: "#F0B44C55" } },
  warming: { size: 12, fill: "#F0B44C", glow: { radius: 10, color: "#F0B44C99" } },
  hot: { size: 14, fill: "#FFD98F", glow: { radius: 20, color: "#F0B44CCC" } },
};
export const heatOf = (pct: number): Heat => (pct >= 60 ? "hot" : pct >= 25 ? "warming" : "cool");
export const GRAIN = { type: "noise", size: 1, density: 0.55, color: "#0E0F1133" };
export function heatHead(d: Doc, parent: string, heat: Heat, cx: number, cy: number) {
  const h = HEAT[heat];
  return d.node("ellipse", parent, "beam head " + heat, { x: cx - h.size / 2, y: cy - h.size / 2, w: h.size, h: h.size, fill: h.fill, effects: [{ type: "dropShadow", color: h.glow.color, offset: [0, 0], radius: h.glow.radius }] });
}
// fluted glass (the 2 glass surfaces): glass with frost + a rib overlay. One-line reason: ribs keep the backdrop readable while the controls stay legible.
export const GLASS_TRANSPORT = { type: "glass", frost: 12, refraction: 0.35, depth: 8, dispersion: 0.08, lightIntensity: 0.4, splay: 0.3 };
export const GLASS_PALETTE = { type: "glass", frost: 20, refraction: 0.35, depth: 10, dispersion: 0.08, lightIntensity: 0.4, splay: 0.3 };
export function flutes(d: Doc, parent: string, w: number, h: number) {
  const f = d.frame(parent, "flutes", { absolute: true, x: 0, y: 0, w, h, clip: true });
  for (let x = 0; x < w; x += 8) d.rect(f, "rib", { x, y: 0, w: 1, h, fill: "#FFFFFF", opacity: 0.05 });
  return f;
}

export function beam(d: Doc, page: string | null, x: number, y: number) {
  label(d, page, "Beam", x, y, "Satu sorot per layar: tahap yang sedang jalan, klip terpilih, momen hook, aksi utama. Gradien ini satu-satunya di aplikasi: ia menggambar cahaya (kuat di kepala, memudar ke ekor). Kepala = lampu panas (dingin, menghangat, panas); butir hanya di badan beam.");
  const ids: string[] = [];
  const fall = (angle: "h" | "v", flip = false) => [{
    type: "linearGradient", from: angle === "h" ? (flip ? [1, 0.5] : [0, 0.5]) : [0.5, 0], to: angle === "h" ? (flip ? [0, 0.5] : [1, 0.5]) : [0.5, 1],
    stops: [{ position: 0, color: "#F0B44C" }, { position: 1, color: "#F0B44C00" }],
  }];
  // stage: track segment, head leading on the right with its heat, tail falling off to the left, grain on the fill
  (["cool", "warming", "hot"] as Heat[]).forEach((heat, i) => {
    const st = d.node("component", null, `variant=stage, heat=${heat}`, { x: x + i * 320, y: y + 80, w: 280, h: 28, fill: "none" });
    d.rect(st, "track", { x: 0, y: 12, w: 280, h: 2, fill: "divider" });
    d.node("rectangle", st, "falloff", { x: 20, y: 10, w: 250, h: 6, fills: fall("h", true), effects: [GRAIN] });
    heatHead(d, st, heat, 268, 13);
    ids.push(st);
  });
  // clip: hairline across the top of the selected row, strong at the left, falling off to the right
  const cl = d.node("component", null, "variant=clip, heat=none", { x: x + 960, y: y + 80, w: 280, h: 28, fill: "none" });
  d.rect(cl, "row edge", { x: 0, y: 11, w: 280, h: 1, fill: "divider" });
  d.node("rectangle", cl, "falloff", { x: 0, y: 10, w: 280, h: 3, fills: fall("h") });
  ids.push(cl);
  // hook: vertical marker on the timeline, head at the top
  const hk = d.node("component", null, "variant=hook, heat=none", { x: x + 1280, y: y + 80, w: 24, h: 72, fill: "none" });
  d.node("rectangle", hk, "falloff", { x: 11, y: 8, w: 2, h: 64, fills: fall("v") });
  heatHead(d, hk, "warming", 12, 6);
  ids.push(hk);
  // action: the primary action focus ring, the other place glow is allowed
  const ac = d.node("component", null, "variant=action, heat=none", { x: x + 1340, y: y + 80, w: 168, h: 52, fill: "none" });
  d.rect(ac, "ring", { x: 4, y: 4, w: 160, h: 44, fill: "none", radius: 8, stroke: "beamText", sw: 2, effects: GLOW });
  ids.push(ac);
  return combine(d, ids, "Beam", "Beam: light falloff from beam at 100% to 0%, with grain on the beam fill only. stage = the stage that is working now; its head is a heat light (cool = idle, warming = attack as PROGRESS arrives, hot = busy), rune-fx Fx::glow with GlowParams::heat; clip = the selected clip; hook = the hook moment on a timeline; action = the primary action waiting for the user. Reason: it is the one-focal-point-per-screen lever made literal (design.md, Identity). Glow only on the head and on the primary action ring (never more than 2 per screen).", x, y + 80);
}

// ---------------------------------------------------------------- buttons
export function buttons(d: Doc, g: Grid, y: number) {
  label(d, null, "Button", 40, y, "Utama, sekunder, senyap. Hover 120 ms, tekan 1 px. Cincin fokus utama memakai glow (satu dari dua tempat glow).");
  const ids: string[] = [];
  let by = y + 80;
  for (const v of ["primary", "secondary", "quiet"]) {
    let bx = 40;
    for (const st of ["default", "hover", "pressed", "focused", "disabled"] as St[]) {
      const fill = v === "primary" ? (st === "hover" ? "#F7C464" : st === "pressed" ? "#D9A040" : "beam") : v === "secondary" ? (st === "hover" || st === "pressed" ? (st === "pressed" ? "divider" : "surface") : "raised") : st === "hover" ? "raised" : st === "pressed" ? "divider" : "none";
      const c = d.node("component", null, `variant=${v}, state=${st}`, {
        x: bx, y: by, layout: "horizontal", sh: "hug", sv: "fixed", h: 36, w: 120, pad: [0, 16, st === "pressed" ? 0 : 0, 16], main: "center", cross: "center",
        fill, radius: 6, opacity: st === "disabled" ? 0.4 : 1,
        stroke: st === "focused" ? (v === "primary" ? "text" : "beamText") : v === "secondary" ? "edge" : "none", sw: st === "focused" ? 2 : 1,
        effects: st === "focused" && v === "primary" ? GLOW : undefined,
        paddingTop: st === "pressed" ? 1 : 0,
      });
      d.text(c, v === "primary" ? "Potong video ini" : v === "secondary" ? "Pilih berkas" : "Lewati", { size: 13, wt: 600, color: v === "primary" ? ONBEAM : "text" });
      ids.push(c);
      bx += 160;
    }
    by += 52;
  }
  combine(d, ids, "Button", "Button: radius 6, label 13/600, one specific verb per label. primary carries the beam fill (the action waiting for the user), secondary a 3:1 edge, quiet no boundary. States: default, hover (120 ms tint), pressed (1 px down), focused (2 px ring), disabled.", 40, y + 80);
  return y + 80 + 3 * 52 + 24;
}

// ---------------------------------------------------------------- inputs
function field(d: Doc, kind: "TextField" | "TextArea" | "Select", st: St, x: number, y: number) {
  const c = d.node("component", null, `state=${st}`, { x, y, layout: "vertical", gap: 6, w: 280, sh: "fixed", sv: "hug", fill: "none", opacity: st === "disabled" ? 0.4 : 1 });
  const lbl = kind === "TextField" ? "Tautan video" : kind === "TextArea" ? "Arahan untuk pemilihan klip" : "Bahasa subtitel";
  d.text(c, lbl, { size: 12, wt: 500, color: "muted" });
  const l = look(st);
  const box = d.row(c, "field", { sh: "fill", h: kind === "TextArea" ? 88 : 36, sv: "fixed", pad: [kind === "TextArea" ? 8 : 0, 12, 0, 12], cross: kind === "TextArea" ? "min" : "center", main: "min", fill: "raised", stroke: l.stroke, sw: l.sw, radius: 6, gap: 8 });
  const ph = kind === "TextField" ? "Tempel tautan YouTube" : kind === "TextArea" ? "Contoh: cari momen yang lucu, hindari iklan" : "Indonesia";
  d.text(box, st === "default" || st === "hover" || st === "error" ? ph : st === "focused" ? "https://youtu.be/" : ph, { size: 13, color: kind === "Select" ? "text" : "muted", fillW: true });
  if (kind === "Select") ic(d, box, "chevron", "muted");
  d.text(c, st === "error" ? (kind === "TextField" ? "Alamat tidak valid. Tempel tautan YouTube lengkap." : kind === "Select" ? "Bahasa belum dipilih. Pilih satu dari daftar." : "Arahan terlalu panjang. Batas 500 karakter.") : kind === "TextField" ? "Atau jatuhkan berkas video ke jendela ini." : "Opsional.", { size: 12, color: st === "error" ? "skip" : "muted" });
  return c;
}

export function inputs(d: Doc, y: number) {
  label(d, null, "TextField, TextArea, Select", 40, y, "Label tetap di atas, pesan galat menyebut sebabnya dan langkah berikut.");
  let yy = y + 80;
  for (const kind of ["TextField", "TextArea", "Select"] as const) {
    const ids: string[] = [];
    STATES.filter((s) => s !== "pressed").forEach((st, i) => ids.push(field(d, kind, st, 40 + i * 304, yy)));
    combine(d, ids, kind, `${kind}: label above, raised fill, 3:1 edge (WCAG 1.4.11), radius 6. Focus = 2 px beam ring, error = 2 px skip edge plus a message naming the cause and the next action.`, 40, yy);
    yy += kind === "TextArea" ? 190 : 150;
  }
  return yy;
}

// ---------------------------------------------------------------- switch, checkbox, radio
export function toggles(d: Doc, y: number) {
  label(d, null, "Switch, Checkbox, Radio", 40, y, "Jempol switch adalah satu-satunya bentuk bulat penuh. Radio memakai kotak radius 6 dengan titik persegi, bukan lingkaran.");
  const out: string[] = [];
  const kinds = ["Switch", "Checkbox", "Radio"];
  kinds.forEach((kind, ki) => {
    const ids: string[] = [];
    let n = 0;
    for (const on of [false, true]) for (const st of ["default", "hover", "focused", "disabled"] as St[]) {
      const x = 40 + n * 210, yy = y + 80 + ki * 70;
      const c = d.node("component", null, `checked=${on ? "on" : "off"}, state=${st}`, { x, y: yy, layout: "horizontal", gap: 12, cross: "center", sh: "hug", sv: "hug", fill: "none", opacity: st === "disabled" ? 0.4 : 1 });
      const l = look(st);
      if (kind === "Switch") {
        const tr = d.frame(c, "track", { w: 36, h: 20, sh: "fixed", sv: "fixed", fill: on ? "beam" : "raised", stroke: on ? "beamText" : l.stroke, sw: l.sw, radius: 6 });
        if (st === "focused") d.set(tr, { stroke: "beamText", strokeWeight: 2 });
        d.node("ellipse", tr, "thumb", { x: on ? 19 : 3, y: 3, w: 14, h: 14, fill: on ? ONBEAM : "edge" });
        d.cmd("node.set", { ids: [d.ref(tr)], layout: null });
      } else {
        const bx = d.frame(c, "box", { w: 20, h: 20, sh: "fixed", sv: "fixed", layout: "horizontal", main: "center", cross: "center", fill: on && kind === "Checkbox" ? "beam" : "raised", stroke: on && kind === "Checkbox" ? "beamText" : l.stroke, sw: l.sw, radius: kind === "Checkbox" ? 2 : 6 });
        if (st === "focused") d.set(bx, { stroke: "beamText", strokeWeight: 2 });
        if (on && kind === "Checkbox") ic(d, bx, "check", ONBEAM, 14);
        if (on && kind === "Radio") d.rect(bx, "dot", { w: 8, h: 8, fill: "beam", radius: 2 });
      }
      d.text(c, kind === "Switch" ? "Pakai musik latar" : kind === "Checkbox" ? "Tampilkan subtitel" : "Potong di sini", { size: 13 });
      ids.push(c); n++;
    }
    out.push(combine(d, ids, kind, `${kind}: on/off by default, hover, focused (2 px beam ring), disabled. The label is part of the target.`, 40, y + 80 + ki * 70));
  });
  return y + 80 + 3 * 70 + 24;
}

// ---------------------------------------------------------------- verdict, score
export const VERDICTS: [string, string][] = [["PASS", "pass"], ["REVIEW", "review"], ["SKIP", "skip"]];
export function verdictMark(d: Doc, parent: string | null, word: string, color: string, o: Record<string, any> = {}) {
  const m = d.row(parent, "verdict " + word, { pad: [3, 8, 3, 8], fill: "none", stroke: color, radius: 2, cross: "center", ...o });
  d.text(m, word, { size: 12, wt: 600, color });
  return m;
}
export function scoreBar(d: Doc, parent: string | null, pct: number, o: Record<string, any> = {}) {
  const r = d.row(parent, "score", { gap: 8, cross: "center", ...o });
  const tr = d.frame(r, "track", { w: 96, h: 6, sh: "fixed", sv: "fixed", fill: "divider", radius: 2, clip: true });
  d.cmd("node.set", { ids: [d.ref(tr)], layout: null });
  d.rect(tr, "fill", { x: 0, y: 0, w: Math.round(96 * pct), h: 6, fill: "steel" });
  d.text(r, pct.toFixed(2).replace(".", ","), { size: 13, wt: 500, num: true });
  return r;
}

export function marks(d: Doc, y: number) {
  label(d, null, "Verdict dan skor", 40, y, "Verdict selalu membawa kata (PASS, REVIEW, SKIP), tidak pernah warna saja. REVIEW memakai steel: perlu dilihat lebih dekat, bukan bahaya.");
  const ids: string[] = [];
  VERDICTS.forEach(([w, c], i) => {
    const m = d.node("component", null, `verdict=${w}`, { x: 40 + i * 120, y: y + 80, layout: "horizontal", sh: "hug", sv: "hug", pad: [3, 8, 3, 8], fill: "none", stroke: c, sw: 1, radius: 2 });
    d.text(m, w, { size: 12, wt: 600, color: c });
    ids.push(m);
  });
  combine(d, ids, "Verdict mark", "Verdict mark: radius 2, outline in the verdict colour and the word in it (R-39: never colour alone). Contrast measured in design.md.", 40, y + 80);
  const sids: string[] = [];
  [0.35, 0.62, 0.88].forEach((p, i) => {
    const s = d.node("component", null, `level=${["low", "mid", "high"][i]}`, { x: 440 + i * 200, y: y + 80, layout: "horizontal", sh: "hug", sv: "hug", gap: 8, cross: "center", fill: "none" });
    const tr = d.frame(s, "track", { w: 96, h: 6, sh: "fixed", sv: "fixed", fill: "divider", radius: 2, clip: true });
    d.cmd("node.set", { ids: [d.ref(tr)], layout: null });
    d.rect(tr, "fill", { x: 0, y: 0, w: Math.round(96 * p), h: 6, fill: "steel" });
    d.text(s, p.toFixed(2).replace(".", ","), { size: 13, wt: 500, num: true });
    sids.push(s);
  });
  combine(d, sids, "Score bar", "Score bar: steel marks data (a bar and its tabular number). The number always sits beside the bar so it never depends on length alone.", 440, y + 80);
  return y + 80 + 40 + 24;
}

// ---------------------------------------------------------------- stage track
export const STAGES = ["Video", "Audio", "Transkrip", "Segmen", "Skor", "Render", "Subtitel"];
export function stageTrack(d: Doc, parent: string | null, active: number, o: Record<string, any> = {}, error = false, pct = 62, ripple = -1) {
  const W = 1100;
  const t = d.frame(parent, "Stage track", { w: W, h: 64, sh: "fixed", sv: "fixed", fill: "none", ...o });
  const colW = W / STAGES.length;
  d.rect(t, "track", { x: 0, y: 11, w: W, h: 2, fill: "divider" });
  if (active >= 0) {
    const head = colW * active + 12;
    const gradient = [{ type: "linearGradient", from: [1, 0.5], to: [0, 0.5], stops: [{ position: 0, color: error ? "#E07A68" : "#F0B44C" }, { position: 1, color: "#F0B44C00" }] }];
    d.node("rectangle", t, "beam falloff", { x: 0, y: 9, w: head, h: 6, fills: gradient, effects: error ? undefined : [GRAIN] });
    if (error) d.node("ellipse", t, "error head", { x: head - 6, y: 6, w: 12, h: 12, fill: "skip" });
    else heatHead(d, t, heatOf(pct), head, 12);
  }
  STAGES.forEach((s, i) => {
    const done = i < active, on = i === active;
    if (done) d.rect(t, "done " + s, { x: colW * i + 6, y: 6, w: 12, h: 12, fill: "beam", radius: 2 });
    if (i === ripple) d.node("ellipse", t, "stage-done pulse ripple (frame at 0.2 s of 0.6 s)", { x: colW * i + 12 - 15, y: 12 - 15, w: 30, h: 30, fill: "none", stroke: "#F0B44C", sw: 1.5, opacity: 0.5 });
    const color = on ? (error ? "skip" : "beamText") : done ? "text" : "muted";
    d.text(t, s, { size: 13, wt: on ? 600 : 500, color, x: colW * i, y: 28 });
    if (on) d.text(t, error ? "Gagal" : pct + "%", { size: 12, wt: 500, num: true, color: error ? "skip" : "beamText", x: colW * i, y: 46 });
  });
  return t;
}

export function stageTracks(d: Doc, y: number) {
  label(d, null, "Stage track", 40, y, "Beam berjalan di sepanjang lintasan hanya ketika engine melaporkan PROGRESS. Tahap selesai menjadi tanda tetap. Tanpa spinner.");
  const ids: string[] = [];
  const cases: [string, number, boolean][] = [["queued", -1, false], ["running", 4, false], ["error", 4, true], ["done", 7, false]];
  cases.forEach(([n, a, e], i) => {
    const c = d.node("component", null, `state=${n}`, { x: 40, y: y + 80 + i * 90, w: 1100, h: 64, fill: "none" });
    const inner = stageTrack(d, c, a, { x: 0, y: 0 }, e);
    ids.push(c);
  });
  combine(d, ids, "Stage track", "Stage track: one beam at the active stage (design.md, motion: job running). Finished stages settle to a steady mark; an error stage turns skip with the word Gagal.", 40, y + 80);
  return y + 80 + 4 * 90 + 24;
}

// ---------------------------------------------------------------- clip row, clip stage
export function clipRow(d: Doc, parent: string | null, o: { st: string; rank: number; title: string; meta: string; verdict: [string, string]; pct: number; x?: number; y?: number; w?: number; comp?: boolean }) {
  const W = o.w ?? 560;
  const fill = o.st === "selected" || o.st === "hover" ? "raised" : o.st === "pressed" ? "divider" : "none";
  const mk = o.comp ? (d.node("component", parent, `state=${o.st}`, { x: o.x, y: o.y, layout: "horizontal", w: W, h: 72, sh: "fixed", sv: "fixed", pad: [12, 12, 12, 12], gap: 12, cross: "center", fill, radius: 6, opacity: o.st === "skip" ? 0.6 : 1, stroke: o.st === "focused" ? "beamText" : "none", sw: 2 })) : d.row(parent, "Clip row " + o.rank, { w: W, h: 72, sh: "fixed", sv: "fixed", pad: [12, 12, 12, 12], gap: 12, cross: "center", fill, radius: 6, opacity: o.st === "skip" ? 0.6 : 1 });
  d.text(mk, String(o.rank), { size: 15, wt: 600, num: true, color: o.st === "selected" ? "beamText" : "muted", w: 20 });
  d.frame(mk, "thumb", { w: 27, h: 48, sh: "fixed", sv: "fixed", fill: "surface", stroke: "divider", radius: 2 });
  const tx = d.col(mk, "teks", { gap: 4, sh: "fill" });
  d.text(tx, o.title, { size: 13, wt: 600, fillW: true });
  d.text(tx, o.meta, { size: 12, color: "muted", num: true, fillW: true });
  verdictMark(d, mk, o.verdict[0], o.verdict[1]);
  scoreBar(d, mk, o.pct);
  if (o.st === "selected") d.node("rectangle", mk, "beam clip", { absolute: true, x: 0, y: 0, w: W, h: 3, fills: [{ type: "linearGradient", from: [0, 0.5], to: [1, 0.5], stops: [{ position: 0, color: "#F0B44C" }, { position: 1, color: "#F0B44C00" }] }] });
  return mk;
}

export function clipRows(d: Doc, y: number) {
  label(d, null, "Clip row", 40, y, "Baris klip: peringkat, miniatur 9:16, judul, durasi, verdict, skor. Terpilih = beam clip di tepi atas.");
  const ids: string[] = [];
  ["default", "hover", "selected", "pressed", "focused", "skip"].forEach((st, i) => {
    ids.push(clipRow(d, null, { st, rank: 1 + (i % 3), title: "Kenapa orang menunda mulai", meta: "00:42  ·  hook 0:03", verdict: st === "skip" ? ["SKIP", "skip"] : ["PASS", "pass"], pct: st === "skip" ? 0.31 : 0.84, x: 40 + (i % 3) * 590, y: y + 80 + Math.floor(i / 3) * 90, comp: true }));
  });
  combine(d, ids, "Clip row", "Clip row: states default, hover (raised), selected (raised + beam clip hairline), pressed, focused (2 px ring), skip (dimmed, verdict SKIP). Tabular numbers keep columns aligned.", 40, y + 80);
  return y + 80 + 2 * 90 + 24;
}

export function clipStage(d: Doc, parent: string | null, o: { w?: number; state?: string; x?: number; y?: number; comp?: boolean } = {}) {
  const W = o.w ?? 270, H = Math.round(W * 16 / 9);
  const c = o.comp ? d.node("component", parent, `state=${o.state}`, { x: o.x, y: o.y, w: W, h: H, fill: "surface", stroke: "divider", sw: 1, radius: 10, clip: true }) : d.frame(parent, "Clip stage", { w: W, h: H, sh: "fixed", sv: "fixed", fill: "surface", stroke: "divider", radius: 10, clip: true, x: o.x, y: o.y });
  d.rect(c, "frame video", { x: 0, y: 0, w: W, h: H, fill: "#0E0F11" });
  const st = o.state ?? "ready";
  if (st === "ready") {
    d.text(c, "Pratinjau 9:16", { size: 12, color: "#A39E95", x: 16, y: 16 });
    d.text(c, "Contoh teks subtitel", { size: 15, wt: 600, color: "#ECE8E1", x: 0, y: H * 0.72, w: W, align: "center" });
  } else if (st === "loading") {
    d.text(c, "Menyiapkan pratinjau", { size: 13, wt: 600, color: "#ECE8E1", x: 0, y: H * 0.45, w: W, align: "center" });
    d.text(c, "Berjalan 00:08", { size: 12, num: true, color: "#A39E95", x: 0, y: H * 0.45 + 22, w: W, align: "center" });
  } else {
    d.text(c, "Pratinjau gagal", { size: 13, wt: 600, color: "#E07A68", x: 0, y: H * 0.42, w: W, align: "center" });
    d.text(c, "Berkas klip tidak ditemukan. Render ulang klip ini.", { size: 12, color: "#A39E95", x: 24, y: H * 0.42 + 22, w: W - 48, align: "center" });
  }
  return c;
}

export function transport(d: Doc, parent: string | null, o: { x?: number; y?: number; w?: number; comp?: boolean; name?: string } = {}) {
  const W = o.w ?? 270;
  const t = o.comp ? d.node("component", parent, o.name ?? "Transport bar", { x: o.x, y: o.y, layout: "horizontal", w: W, h: 44, sh: "fixed", sv: "fixed", pad: [0, 12, 0, 12], gap: 12, cross: "center", fill: "#0E0F11AA", radius: 6, effects: [GLASS_TRANSPORT] })
    : d.row(parent, "Transport bar", { x: o.x, y: o.y, w: W, h: 44, sh: "fixed", sv: "fixed", pad: [0, 12, 0, 12], gap: 12, cross: "center", fill: "#0E0F11AA", radius: 6, effects: [GLASS_TRANSPORT] });
  flutes(d, t, W, 44);
  ic(d, t, "play", "#ECE8E1");
  d.text(t, "0:03 / 0:42", { size: 12, num: true, color: "#ECE8E1" });
  d.frame(t, "seek", { h: 4, sh: "fill", sv: "fixed", fill: "#2A2E33", radius: 2 });
  return t;
}

export function stages(d: Doc, y: number) {
  label(d, null, "Clip stage dan transport bar", 40, y, "Panggung klip 9:16 dengan bilah transport di atas video. Bilah memakai blur latar: satu dari dua permukaan kaca, supaya kontrol tidak menutupi gambar.");
  const ids: string[] = [];
  ["ready", "loading", "error"].forEach((st, i) => ids.push(clipStage(d, null, { state: st, x: 40 + i * 300, y: y + 100, comp: true })));
  combine(d, ids, "Clip stage", "Clip stage: 9:16 preview, radius 10. States ready, loading (names the wait, shows elapsed time, no spinner), error (names the cause and the next action).", 40, y + 100);
  transport(d, null, { x: 960, y: y + 100, comp: true, name: "Transport bar" });
  return y + 100 + 480 + 24;
}

// ---------------------------------------------------------------- shell parts
export const RAIL = ["Beranda", "Klip", "Temukan", "Generate", "Belajar", "Setelan"];
export function railItem(d: Doc, parent: string | null, label_: string, st: string, o: Record<string, any> = {}) {
  const mkr = o.comp ? (p: string | null, n: string, q: any) => d.node("component", p, n, q) : (p: string | null, n: string, q: any) => d.frame(p, n, q);
  const r = mkr(parent, o.comp ? `state=${st}` : "Rail " + label_, { layout: "horizontal", w: 56, h: 44, sh: "fixed", sv: "fixed", layout: "horizontal", main: "center", cross: "center", fill: st === "selected" ? "raised" : st === "hover" ? "surface" : "none", radius: 6, stroke: st === "focused" ? "beamText" : "none", sw: 2, opacity: st === "disabled" ? 0.4 : 1, ...o });
  d.text(r, label_, { size: 12, wt: st === "selected" ? 600 : 500, color: st === "selected" ? "beamText" : "text" });
  return r;
}
export function rail(d: Doc, parent: string | null, selected: string, o: Record<string, any> = {}) {
  const r = d.col(parent, "Rail", { w: 64, h: 768, sh: "fixed", sv: "fixed", pad: [12, 4, 12, 4], gap: 4, cross: "center", fill: "surface", ...o });
  icon(d, r, 32, { round: true, name: "ikon Sorot" });
  d.frame(r, "spacer", { w: 8, h: 12, sh: "fixed", sv: "fixed" });
  for (const it of RAIL) railItem(d, r, it, it === selected ? "selected" : "default");
  return r;
}
export function menuBar(d: Doc, parent: string | null, o: Record<string, any> = {}) {
  const w = o.w ?? 1280;
  const m = d.row(parent, "Menu bar", { w, h: 32, sh: "fixed", sv: "fixed", pad: [0, 16, 0, 16], gap: 20, cross: "center", fill: "surface", ...o });
  for (const t of ["Berkas", "Sunting", "Tampilan", "Jendela", "Bantuan"]) d.text(m, t, { size: 13, wt: 500 });
  d.frame(m, "spasi", { h: 1, sh: "fill", sv: "fixed" });
  d.text(m, "Pratinjau desain, data contoh", { size: 12, color: "muted" });
  return m;
}

export function shell(d: Doc, y: number) {
  label(d, null, "Menu bar, rail, command palette", 40, y, "Rail hanya memuat layar yang ada (R-24). Rail, menu bar, dan palet perintah memuat tujuan yang sama. Palet = permukaan kaca kedua.");
  menuBar(d, null, { x: 40, y: y + 80, w: 1000 });
  // rail item states
  const ids: string[] = [];
  ["default", "hover", "selected", "focused", "disabled"].forEach((st, i) => {
    ids.push(railItem(d, null, "Klip", st, { x: 40 + i * 72, y: y + 140, comp: true }));
  });
  combine(d, ids, "Rail item", "Rail item: sentence-case label, no icon (a label alone is fast enough). Selected = raised fill + beamText label; no edge stripe.", 40, y + 140);
  rail(d, null, "Klip", { x: 40, y: y + 220 });
  return y + 220 + 768 + 24;
}

export function palette(d: Doc, parent: string | null, o: { x?: number; y?: number; comp?: boolean } = {}) {
  const W = 560;
  const base = { x: o.x, y: o.y, w: W, sh: "fixed", sv: "hug", layout: "vertical", gap: 4, pad: 8, fill: mode.light ? "#FBF9F4E6" : "#16181BD9", stroke: "divider", sw: 1, radius: 10, effects: [GLASS_PALETTE, { type: "dropShadow", color: "#00000066", offset: [0, 12], radius: 32 }] };
  const p = o.comp ? d.node("component", parent, "Command palette", base) : d.frame(parent, "Command palette", base);
  flutes(d, p, W, 258);
  const inp = d.row(p, "input", { sh: "fill", h: 40, sv: "fixed", pad: [0, 12, 0, 12], cross: "center", fill: "raised", radius: 6, stroke: "beamText", sw: 2 });
  d.text(inp, "Ketik perintah atau nama klip", { size: 13, color: "muted" });
  const items: [string, string][] = [["Potong video baru", "Ctrl+O"], ["Tempel tautan dan potong", "Ctrl+Shift+V"], ["Ekspor klip terpilih", "Ctrl+E"], ["Tampilkan di folder", "Ctrl+Shift+R"], ["Buka Setelan", "Ctrl+,"]];
  items.forEach(([t, k], i) => {
    const r = d.row(p, "item " + t, { sh: "fill", h: 36, sv: "fixed", pad: [0, 12, 0, 12], cross: "center", fill: i === 0 ? "raised" : "none", radius: 6 });
    d.text(r, t, { size: 13, wt: i === 0 ? 600 : 500, fillW: true });
    d.text(r, k, { size: 12, color: "muted", num: true });
  });
  return p;
}

// ---------------------------------------------------------------- toast, dialog, state blocks
export function toast(d: Doc, parent: string | null, kind: "info" | "success" | "error", o: Record<string, any> = {}) {
  const spec = { info: ["Klip dirender ulang", "Pratinjau sudah diperbarui.", "Lihat klip", "steel"], success: ["Selesai", "Klip diekspor ke folder video ini.", "Tampilkan di folder", "pass"], error: ["Gagal", "Unggahan ke TikTok ditolak: akun belum terhubung. Hubungkan akun di Setelan.", "Buka Setelan", "skip"] }[kind];
  const t = o.comp ? d.node("component", parent, `kind=${kind}`, { layout: "vertical", w: 380, sh: "fixed", sv: "hug", gap: 4, pad: 16, fill: "raised", stroke: "divider", sw: 1, radius: 10, effects: [{ type: "dropShadow", color: "#00000066", offset: [0, 8], radius: 24 }], ...o }) : d.col(parent, "Toast", { w: 380, sh: "fixed", gap: 4, pad: 16, fill: "raised", stroke: "divider", radius: 10, effects: [{ type: "dropShadow", color: "#00000066", offset: [0, 8], radius: 24 }], ...o });
  d.text(t, spec[0], { size: 13, wt: 600, color: spec[3] as string });
  d.text(t, spec[1], { size: 13, fillW: true });
  d.text(t, spec[2], { size: 13, wt: 600, color: "beamText" });
  return t;
}

export function dialog(d: Doc, parent: string | null, o: Record<string, any> = {}) {
  const base = { layout: "vertical", w: 420, sh: "fixed", sv: "hug", gap: 12, pad: 24, fill: "surface", stroke: "divider", sw: 1, radius: 10, effects: [{ type: "dropShadow", color: "#00000080", offset: [0, 16], radius: 40 }], ...o };
  const dlg = o.comp ? d.node("component", parent, "Dialog", base) : d.frame(parent, "Dialog", base);
  d.text(dlg, "Batalkan proses ini?", { size: 19, wt: 600 });
  d.text(dlg, "Proses berhenti di langkah yang sedang berjalan. Hasil yang sudah jadi tetap tersimpan, dan Anda bisa melanjutkan nanti.", { size: 13, color: "muted", fillW: true });
  const act = d.row(dlg, "aksi", { gap: 8, main: "max", sh: "fill" });
  const b2 = d.row(act, "Lanjutkan", { h: 36, sv: "fixed", pad: [0, 16, 0, 16], cross: "center", fill: "raised", stroke: "edge", radius: 6 });
  d.text(b2, "Lanjutkan proses", { size: 13, wt: 600 });
  const b1 = d.row(act, "Batalkan", { h: 36, sv: "fixed", pad: [0, 16, 0, 16], cross: "center", fill: "beam", radius: 6 });
  d.text(b1, "Batalkan proses", { size: 13, wt: 600, color: ONBEAM });
  return dlg;
}

export function stateBlock(d: Doc, parent: string | null, kind: "empty" | "loading" | "error", o: Record<string, any> = {}) {
  const spec = {
    empty: ["Belum ada klip", "Jatuhkan video ke jendela ini atau tempel tautan untuk mulai.", "Potong video ini", "text"],
    loading: ["Menyiapkan transkrip", "Berjalan 02:14. Whisper bekerja di mesin ini. Jendela boleh ditutup, proses tetap lanjut.", "Lihat di Pekerjaan", "text"],
    error: ["Engine tidak menjawab", "Port 8080 tidak membalas dalam 10 detik. Mulai ulang engine, atau lihat log untuk sebabnya.", "Mulai ulang engine", "skip"],
  }[kind];
  const base = { layout: "vertical", w: 420, sh: "fixed", sv: "hug", gap: 8, pad: 24, fill: "surface", stroke: "divider", sw: 1, radius: 10, ...o };
  const b = o.comp ? d.node("component", parent, `kind=${kind}`, base) : d.frame(parent, "State " + kind, base);
  d.text(b, spec[0], { size: 15, wt: 600, color: kind === "error" ? "skip" : "text" });
  d.text(b, spec[1], { size: 13, color: "muted", fillW: true });
  const btn = d.row(b, "aksi", { h: 36, sv: "fixed", pad: [0, 16, 0, 16], cross: "center", fill: kind === "empty" ? "beam" : "raised", stroke: kind === "empty" ? "none" : "edge", radius: 6 });
  d.text(btn, spec[2], { size: 13, wt: 600, color: kind === "empty" ? ONBEAM : "text" });
  return b;
}

export function misc(d: Doc, y: number) {
  label(d, null, "Command palette, toast, dialog, state block", 40, y, "Bayangan hanya di lapisan melayang (palet, dialog, menu, toast) sebagai penanda ketinggian. Panel datar.");
  palette(d, null, { x: 40, y: y + 80, comp: true });
  const ti: string[] = [];
  (["info", "success", "error"] as const).forEach((k, i) => ti.push(toast(d, null, k, { x: 640 + i * 0, y: y + 80 + i * 0, comp: true })));
  ti.forEach((t, i) => d.set(t, { x: 640, y: y + 80 + i * 130 }));
  combine(d, ti, "Toast", "Toast: slides in from the edge, leaves after 6 s, pauses on hover. Names what happened and the next action.", 640, y + 80);
  dialog(d, null, { x: 1080, y: y + 80, comp: true });
  const si: string[] = [];
  (["empty", "loading", "error"] as const).forEach((k, i) => si.push(stateBlock(d, null, k, { x: 40 + i * 450, y: y + 540, comp: true })));
  combine(d, si, "State block", "State block: every data view designs empty, loading and error, and each names the cause and the next action (R-27).", 40, y + 540);
  // icons
  d.text(null, "Ikon (1,5 px, ujung persegi)", { size: 15, wt: 600, x: 1080, y: y + 360 });
  let ix = 1080;
  for (const k of Object.keys(ICONS)) {
    const c = d.node("component", null, "Ikon/" + k, { x: ix, y: y + 396, w: 16, h: 16, fill: "none", description: ICONS[k].why });
    ic(d, c, k);
    ix += 40;
  }
  return y + 540 + 260;
}

export function componentsPage(d: Doc) {
  d.cmd("page.setBackground", { color: "#0E0F11" });
  let y = 40;
  d.text(null, "Sorot: komponen", { size: 26, wt: 600, x: 40, y });
  y += 80;
  beam(d, null, 40, y); y += 220;
  y = buttons(d, new Grid(d, null), y) + 40;
  y = inputs(d, y) + 40;
  y = toggles(d, y) + 40;
  y = marks(d, y) + 40;
  y = stageTracks(d, y) + 40;
  y = clipRows(d, y) + 40;
  y = stages(d, y) + 40;
  y = shell(d, y) + 40;
  y = misc(d, y);
}
