import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shotId, shotStarts } from "./composer";
import type { Plan } from "./planSchema";

// The scene probe (check step): what HyperFrames' own lint and check can't see, read from the page
// itself before anything renders. While `check` runs, the root loads one Sorot script that waits for
// the page, reads every GSAP tween on the film's clock (tagging the ones a kit part made while it
// mounted), seeks a few moments of each shot, reads the boxes of the text and the drawn objects, puts
// the clock back, and prints it all as one console warning. HyperFrames reports the warning like any
// other; the step takes it out of the list and turns it into findings here, in code, so the director
// gets them as repairs. Probed on HyperFrames 0.8.223 (spike, 2026-11-02): its check page has
// `__player.renderSeek`, and a scene's shot timelines sit inside `__timelines.main`.

/** The script's file inside the project, present only while `check` runs. */
export const PROBE_FILE = "assets/sorot-probe.js";
/** How its one console line starts. */
export const PROBE_PREFIX = "SOROT_PROBE:";

export interface ProbeSettings {
  /** A swap: a show or hide this quick (s)... a cross-fade under 0.3 s reads as a jump (the motion check measured 147× on a real film). */
  swapSec: number;
  /** ...of an element covering at least this share of the frame (a whole scene layer, not a word or a card)... */
  swapShare: number;
  /** ...while another does the opposite within this many seconds (three frames at 30 fps read as one moment). */
  swapGapSec: number;
  /** Both covering this much of the frame is a must-fix: the whole picture changes at once. */
  swapFullShare: number;
  /** Two tweens overlapping less than this (s) are a hand-off, not a fight (one frame at 30 fps, plus rounding). */
  fightSec: number;
  /** Text sits on an object when this share of its box is over the object (a touching edge or a descender doesn't count). */
  coverShare: number;
  /** ...in at least this share of the moments it is shown ("most of the time")... */
  coverTime: number;
  /** ...and in at least this many sampled moments (one moment can be an object passing by). */
  coverMoments: number;
  /** An object this big is a backdrop: text has to sit somewhere on it. */
  backdropShare: number;
  /** A CSS-drawn box this big is a panel or card the words sit on, not a drawing: it is left out (an svg or picture this big is a backdrop at `backdropShare`). */
  panelShare: number;
  /** A text this much inside a drawing at least `labelSize` times its own area is a label sitting on it (a card, a panel), not a collision. */
  labelShare: number;
  labelSize: number;
  /** On a first frame, text showing more than this share of itself (and less than `wholeShare`) is cut off. */
  slicedShare: number;
  /** A box showing this much is whole (an edge kissing the mask isn't a cut). */
  wholeShare: number;
  /** Moments sampled inside each shot for text over objects. */
  moments: number;
}

export const PROBE_DEFAULTS: ProbeSettings = {
  swapSec: 0.3, swapShare: 0.4, swapGapSec: 0.1, swapFullShare: 0.8, fightSec: 0.05,
  coverShare: 0.3, coverTime: 0.5, coverMoments: 2, backdropShare: 0.5, panelShare: 0.2, labelShare: 0.95, labelSize: 5, slicedShare: 0.05, wholeShare: 0.95, moments: 4,
};

/** Shown means at least this opaque; hidden means at most `HIDDEN` (a fade's two ends). */
const SHOWN = 0.9;
const HIDDEN = 0.1;
/** Text this faint or this hidden isn't being read at that moment. */
const READABLE = 0.5;
/** Seam frames left out of every shot's samples, like the motion check (motion.ts: SEAM_FRAMES at 30 fps). */
const EDGE_SEC = 0.1;

/** How long a transition reaches into the shots on either side (the same rule as motion.ts). */
const seamReach = (transition: string | undefined, before: number, after: number) => (!transition || transition === "cut" ? 0 : Math.min(0.4, 0.2 * Math.min(before, after)));
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface ProbeMoment { t: number; c: string; first?: boolean }
export interface ProbeConfig { fps: number; fadeMaxSec: number; frames: ProbeMoment[] }

/** What the page is asked to look at: the first frame of the film and of each shot after a cut, and a few moments inside every shot clear of its seams. */
export function probeConfig(plan: Plan, fps: number, settings: Partial<ProbeSettings> = {}): ProbeConfig {
  const s = { ...PROBE_DEFAULTS, ...settings };
  const starts = shotStarts(plan);
  const frames: ProbeMoment[] = [];
  plan.shots.forEach((shot, k) => {
    const c = shotId(k);
    if (k === 0 || shot.transition === "cut") frames.push({ t: starts[k]!, c, first: true });
    const from = starts[k]! + (k > 0 ? seamReach(shot.transition, plan.shots[k - 1]!.durationSec, shot.durationSec) : 0) + EDGE_SEC;
    const next = plan.shots[k + 1];
    const to = starts[k]! + shot.durationSec - (next ? seamReach(next.transition, shot.durationSec, next.durationSec) : 0) - EDGE_SEC;
    for (let i = 1; i <= s.moments && to > from; i++) frames.push({ t: Math.round((from + ((to - from) * i) / (s.moments + 1)) * 1000) / 1000, c });
  });
  return { fps, fadeMaxSec: s.swapSec, frames };
}

/** The script as the root loads it: its settings, then the probe. */
export const probeScript = (config: ProbeConfig): string => `window.__sorotProbe = ${JSON.stringify(config)};\n${PROBE_JS}`;

/**
 * Runs `fn` (HyperFrames' check) with the probe loaded by the root, after GSAP and the kit (it wraps the
 * kit's mount), then puts the root back as it was. A root without a head is checked without it.
 */
export async function withProbe<T>(dir: string, config: ProbeConfig, fn: () => Promise<T>): Promise<T> {
  const root = join(dir, "index.html");
  const html = existsSync(root) ? readFileSync(root, "utf-8") : "";
  if (!html.includes("</head>")) return fn();
  writeFileSync(join(dir, PROBE_FILE), probeScript(config));
  writeFileSync(root, html.replace("</head>", `  <script src="${PROBE_FILE}"></script>\n  </head>`));
  try {
    return await fn();
  } finally {
    writeFileSync(root, html);
    rmSync(join(dir, PROBE_FILE), { force: true });
  }
}

export interface ProbeTween { el: string; p: string[]; s: number; e: number; kit: string | null; auto: boolean }
export interface ProbeFade { el: string; s: number; e: number; before?: { o: number; a: number }; after?: { o: number; a: number } }
export interface ProbeBox { el: string; r: [number, number, number, number]; o: number; /** A plain box or shape drawn with CSS (a colour, a gradient or a clip-path), not an svg, picture or canvas. */ box?: 1 }
export interface ProbeText extends ProbeBox { /** Share of the box a viewer can see (-1: a clip shape that can't be read). */ v: number; overlap?: boolean }
export interface ProbeFrame { t: number; c: string; first?: boolean; texts: ProbeText[]; objects: ProbeBox[] }
export interface ProbeData {
  size: [number, number];
  labels: Record<string, { l: string; c: string; x?: string }>;
  tweens: ProbeTween[];
  fades: ProbeFade[];
  frames: ProbeFrame[];
}

/** The probe's line among the console messages, or null (not loaded, or the page never got ready). */
export function readProbe(messages: string[]): ProbeData | null {
  for (const m of messages) {
    if (!m.startsWith(PROBE_PREFIX)) continue;
    try {
      const d = JSON.parse(m.slice(PROBE_PREFIX.length)) as Partial<ProbeData> & { error?: string };
      if (!d.error && Array.isArray(d.tweens) && Array.isArray(d.frames) && Array.isArray(d.fades) && d.labels && d.size) return d as ProbeData;
    } catch { /* a cut line is no probe */ }
  }
  return null;
}

export interface ProbeFinding { shot: number; code: string; severity: "error" | "warning"; message: string; hint: string; time: number }

const shotOf = (c: string | undefined, shots: number): number | null => {
  const m = /^shot-(\d+)$/.exec(c ?? "");
  const i = m ? Number(m[1]) - 1 : -1;
  return i >= 0 && i < shots ? i : null;
};
const area = (r: [number, number, number, number]) => Math.max(0, r[2]) * Math.max(0, r[3]);
const overlap = (a: [number, number, number, number], b: [number, number, number, number]) =>
  Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));

/** Findings from what the page reported: hard swaps, fighting moves, text over drawings, and titles cut off on a first frame. */
export function probeFindings(data: ProbeData, plan: Plan, settings: Partial<ProbeSettings> = {}): ProbeFinding[] {
  const s = { ...PROBE_DEFAULTS, ...settings };
  const starts = shotStarts(plan);
  const n = plan.shots.length;
  const name = (el: string) => data.labels[el]?.l ?? el;
  const text = (el: string) => (data.labels[el]?.x ? `"${data.labels[el]!.x}"` : name(el));
  const found: ProbeFinding[] = [];

  // 1. hard swaps: one large layer shown and another hidden at the same moment, too quickly to read as a move
  const edges = plan.shots.map((shot, k) => {
    const next = plan.shots[k + 1];
    return {
      from: starts[k]! + (k > 0 ? seamReach(shot.transition, plan.shots[k - 1]!.durationSec, shot.durationSec) : 0) + EDGE_SEC,
      to: starts[k]! + shot.durationSec - (next ? seamReach(next.transition, shot.durationSec, next.durationSec) : 0) - EDGE_SEC,
    };
  });
  const fades = data.fades.flatMap((f) => {
    const k = shotOf(data.labels[f.el]?.c, n);
    if (k === null || !f.before || !f.after || f.e - f.s > s.swapSec || f.s < edges[k]!.from || f.e > edges[k]!.to) return [];
    const way = f.before.o <= HIDDEN && f.after.o >= SHOWN ? "in" : f.before.o >= SHOWN && f.after.o <= HIDDEN ? "out" : null;
    const share = Math.max(f.before.a, f.after.a);
    return way && share >= s.swapShare ? [{ ...f, k, way, share }] : [];
  });
  const paired = new Set<string>();
  for (const a of fades.filter((f) => f.way === "out")) {
    const b = fades.find((f) => f.way === "in" && f.k === a.k && f.el !== a.el && Math.abs(f.s - a.s) <= s.swapGapSec);
    const moment = `${a.k}:${round2(a.s)}`;
    if (!b || paired.has(moment)) continue;
    paired.add(moment);
    found.push({
      shot: a.k, code: "hard_swap", severity: a.share >= s.swapFullShare && b.share >= s.swapFullShare ? "error" : "warning", time: round2(a.s),
      message: `At ${round2(a.s)} s ${name(a.el)} disappears and ${name(b.el)} appears in ${round2(Math.max(a.e, b.e) - Math.min(a.s, b.s))} s (they cover ${Math.round(a.share * 100)}% and ${Math.round(b.share * 100)}% of the frame): one picture swapped for another inside a shot reads as a jump.`,
      hint: "Build one into the other (move, grow or wipe the new layer in over at least half a second while the old one moves away), or end the shot there and let the seam make the change.",
    });
  }

  // 2. fighting moves: a kit part's tween and another tween on the same property of the same element at once
  // (two of the scene's own are HyperFrames' overlapping_gsap_tweens already)
  const fights = new Set<string>();
  data.tweens.forEach((a, i) => {
    for (const b of data.tweens.slice(i + 1)) {
      if (a.el !== b.el || (!a.kit && !b.kit) || a.kit === b.kit || a.auto || b.auto) continue;
      const shared = a.p.filter((p) => b.p.includes(p));
      const from = Math.max(a.s, b.s);
      const to = Math.min(a.e, b.e);
      const k = shotOf(data.labels[a.el]?.c, n);
      if (!shared.length || to - from < s.fightSec || k === null || fights.has(`${a.el}:${shared.join()}`)) continue;
      fights.add(`${a.el}:${shared.join()}`);
      const who = (t: ProbeTween) => (t.kit ? `the ${t.kit.split("#")[0]} part's move` : "the scene's own tween");
      found.push({
        shot: k, code: "fighting_tweens", severity: "warning", time: round2(from),
        message: `${name(a.el)} gets two moves on ${shared.join(", ")} at once (${round2(from)} to ${round2(to)} s): ${who(a)} and ${who(b)}. Each frame one overwrites the other, so the motion jerks.`,
        hint: "Let one of them move it: drop the scene's tween on that element (or put it on a wrapper inside), or give the part another target.",
      });
    }
  });

  // 3. text over a drawn object for most of the time the text is shown
  const frame = data.size[0] * data.size[1];
  const byText = new Map<string, { k: number; shown: number; over: Map<string, number>; at: number }>();
  for (const f of data.frames) {
    const k = shotOf(f.c, n);
    if (k === null || f.first) continue;
    const objects = f.objects.filter((o) => o.o >= READABLE && area(o.r) < (o.box ? s.panelShare : s.backdropShare) * frame);
    for (const t of f.texts) {
      if (t.o < READABLE || (t.v >= 0 && t.v < READABLE) || t.overlap || area(t.r) <= 0) continue;
      const entry = byText.get(t.el) ?? { k, shown: 0, over: new Map(), at: f.t };
      entry.shown++;
      // a text lying wholly inside a drawing much bigger than itself is a label on a card or panel; one only partly over it is a collision
      const hit = objects.find((o) => { const share = overlap(t.r, o.r) / area(t.r); return share >= s.coverShare && !(share >= s.labelShare && area(o.r) >= s.labelSize * area(t.r)); });
      if (hit) {
        if (!entry.over.size) entry.at = f.t;
        entry.over.set(hit.el, (entry.over.get(hit.el) ?? 0) + 1);
      }
      byText.set(t.el, entry);
    }
  }
  for (const [el, e] of byText) {
    const [obj, times] = [...e.over].sort((x, y) => y[1] - x[1])[0] ?? ["", 0];
    const total = [...e.over.values()].reduce((a, b) => a + b, 0);
    if (total < s.coverMoments || total < s.coverTime * e.shown) continue;
    found.push({
      shot: e.k, code: "text_over_object", severity: "warning", time: round2(e.at),
      message: `${text(el)} sits on top of ${name(obj)} in ${total} of the ${e.shown} moments it is shown${times < total ? " (and on other drawings in the rest)" : ""}: the words cover the drawing and the drawing muddies the words.`,
      hint: "Move the text off the drawing (above, below or beside it) or move the drawing; if it is a label meant to sit on it, keep it with a reason.",
    });
  }

  // 4. a first frame (the film's, and each shot's after a cut) showing text cut part-way by its mask, a clip or the frame edge
  for (const f of data.frames) {
    const k = shotOf(f.c, n);
    const cut = f.texts.filter((t) => t.o > HIDDEN && t.v > s.slicedShare && t.v < s.wholeShare);
    if (k === null || !f.first || !cut.length) continue;
    found.push({
      shot: k, code: "first_frame_partial_text", severity: "warning", time: round2(f.t),
      message: `On the ${k === 0 ? "film's" : "shot's"} first frame ${cut.slice(0, 3).map((t) => `${text(t.el)} shows ${Math.round(t.v * 100)}% of itself`).join(", ")}${cut.length > 3 ? ` (and ${cut.length - 3} more)` : ""}: text cut part-way by its mask, a clip or the frame edge reads as a mistake, not a reveal.`,
      hint: "Start the reveal fully hidden (wholly outside its mask, or clipped to nothing) or show the text whole on the first frame.",
    });
  }
  // 5. the film's first frame shows none of the opening shot's planned words: a viewer scrolling past
  // sees an empty card (a real film opened on a bare glow and its title arrived later, 2026-11-02)
  const opening = data.frames.find((f) => f.first && shotOf(f.c, n) === 0);
  if (opening && plan.shots[0]?.text?.length && !opening.texts.some((t) => t.o > HIDDEN && t.v >= s.wholeShare)) {
    found.push({
      shot: 0, code: "first_frame_no_text", severity: "warning", time: round2(opening.t),
      message: `The film's first frame shows none of the opening shot's words (${plan.shots[0].text.map((t) => `"${t.value}"`).join(", ")}): a viewer deciding whether to stop sees an empty frame.`,
      hint: "Show the opening line (or the title) whole on the first frame, and move from there; reveal later lines after it.",
    });
  }
  return found;
}

/** The page side: plain ES5 in the browser, no clock or randomness of its own; it only reads, and puts the film's clock back where it found it. */
const PROBE_JS = String.raw`(function () {
  "use strict";
  var C = window.__sorotProbe || { frames: [], fadeMaxSec: 0.3 };
  var PREFIX = "SOROT_PROBE:";
  var LIMIT = { texts: 60, objects: 60, tweens: 600 };
  var NOT_PROPS = { duration: 1, delay: 1, ease: 1, repeat: 1, repeatDelay: 1, yoyo: 1, yoyoEase: 1, stagger: 1, overwrite: 1, immediateRender: 1, lazy: 1, id: 1, paused: 1, reversed: 1, data: 1, inherit: 1, callbackScope: 1, runBackwards: 1, startAt: 1, keyframes: 1, onStart: 1, onUpdate: 1, onComplete: 1, onRepeat: 1, onReverseComplete: 1, onInterrupt: 1, onStartParams: 1, onUpdateParams: 1, onCompleteParams: 1, transformOrigin: 1, force3D: 1, autoRound: 1, css: 1, defaults: 1, parent: 1 };
  var ALIAS = { translateX: ["x"], translateY: ["y"], translateZ: ["z"], rotate: ["rotation"], rotationZ: ["rotation"], rotateZ: ["rotation"], scale: ["scaleX", "scaleY"], autoAlpha: ["opacity", "visibility"], xPercent: ["xPercent"], yPercent: ["yPercent"] };
  var FADE = { opacity: 1, visibility: 1, display: 1 };
  var kitOf = new WeakMap();
  var keys = new WeakMap();
  var labels = {};
  var n = 0;
  var mounts = 0;

  // tweens a kit part adds while it mounts are tagged with the part's name
  var rt = window.SorotKitRuntime;
  if (rt && typeof rt.mount === "function") {
    var mount = rt.mount;
    rt.mount = function (name, host, settings, opts) {
      var tl = opts && opts.tl;
      var before = tl && tl.getChildren ? new Set(tl.getChildren(true, true, true)) : new Set();
      var out = mount.apply(this, arguments);
      if (tl && tl.getChildren) tl.getChildren(true, true, true).forEach(function (c) { if (!before.has(c)) kitOf.set(c, name + "#" + mounts); });
      mounts++;
      return out;
    };
  }

  function comp(el) {
    var c = el.closest("[data-composition-id]");
    return c ? c.getAttribute("data-composition-id") : "";
  }
  function label(el) {
    if (el.id) return el.tagName.toLowerCase() + "#" + el.id;
    var cls = (el.getAttribute("class") || "").split(/\s+/).filter(Boolean).slice(0, 2);
    if (cls.length) return el.tagName.toLowerCase() + "." + cls.join(".");
    var kit = el.getAttribute("data-kit");
    return el.tagName.toLowerCase() + (kit ? '[data-kit="' + kit + '"]' : "");
  }
  function key(el, text) {
    var k = keys.get(el);
    if (k) {
      if (text && !labels[k].x) labels[k].x = text.slice(0, 60);
      return k;
    }
    k = "e" + ++n;
    keys.set(el, k);
    labels[k] = { l: label(el), c: comp(el) };
    if (text) labels[k].x = text.slice(0, 60);
    return k;
  }
  function props(vars) {
    var out = [];
    Object.keys(vars || {}).forEach(function (p) {
      if (NOT_PROPS[p] || typeof vars[p] === "function" || (vars[p] && typeof vars[p] === "object" && !Array.isArray(vars[p]))) return;
      (ALIAS[p] || [p]).forEach(function (q) { if (out.indexOf(q) < 0) out.push(q); });
    });
    return out;
  }
  function frame() { return { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }; }
  function rectOf(r) { return { x: r.left, y: r.top, w: r.width, h: r.height }; }
  function cut(a, b) {
    var x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
    var w = Math.min(a.x + a.w, b.x + b.w) - x, h = Math.min(a.y + a.h, b.y + b.h) - y;
    return { x: x, y: y, w: Math.max(0, w), h: Math.max(0, h) };
  }
  function union(rects) {
    var u = null;
    rects.forEach(function (r) {
      if (!r.width && !r.height) return;
      if (!u) { u = { x: r.left, y: r.top, r: r.right, b: r.bottom }; return; }
      u.x = Math.min(u.x, r.left); u.y = Math.min(u.y, r.top); u.r = Math.max(u.r, r.right); u.b = Math.max(u.b, r.bottom);
    });
    return u ? { x: u.x, y: u.y, w: u.r - u.x, h: u.b - u.y } : null;
  }
  function opacity(el) {
    var o = 1;
    for (var a = el; a && a.nodeType === 1; a = a.parentElement) {
      var s = getComputedStyle(a);
      if (s.display === "none") return 0;
      o *= parseFloat(s.opacity);
    }
    return getComputedStyle(el).visibility === "hidden" ? 0 : o;
  }
  // inset() and polygon() clip paths as the box they leave; null when the shape can't be read
  function clipBox(value, box) {
    var m = /^inset\(([^)]*)\)/.exec(value);
    var len = function (v, size) { return /%$/.test(v) ? (parseFloat(v) / 100) * size : parseFloat(v) || 0; };
    if (m) {
      var p = m[1].split(/\s+round\s+/)[0].trim().split(/\s+/);
      var t = p[0], r = p[1] || t, b = p[2] || t, l = p[3] || r;
      var x = box.x + len(l, box.w), y = box.y + len(t, box.h);
      return { x: x, y: y, w: Math.max(0, box.w - len(l, box.w) - len(r, box.w)), h: Math.max(0, box.h - len(t, box.h) - len(b, box.h)) };
    }
    m = /^polygon\(([^)]*)\)/.exec(value);
    if (m) {
      var xs = [], ys = [];
      m[1].replace(/^\s*(nonzero|evenodd)\s*,/, "").split(",").forEach(function (pt) {
        var q = pt.trim().split(/\s+/);
        xs.push(box.x + len(q[0], box.w)); ys.push(box.y + len(q[1], box.h));
      });
      var x0 = Math.max(box.x, Math.min.apply(null, xs)), y0 = Math.max(box.y, Math.min.apply(null, ys));
      return { x: x0, y: y0, w: Math.max(0, Math.min(box.x + box.w, Math.max.apply(null, xs)) - x0), h: Math.max(0, Math.min(box.y + box.h, Math.max.apply(null, ys)) - y0) };
    }
    return null;
  }
  // the part of r a viewer can see: inside the frame and every clipping ancestor (-1 when a clip can't be read)
  function visible(el, r) {
    var v = cut(r, frame());
    for (var a = el; a && a.nodeType === 1; a = a.parentElement) {
      var s = getComputedStyle(a);
      var box = rectOf(a.getBoundingClientRect());
      if (s.clipPath && s.clipPath !== "none") {
        var c = clipBox(s.clipPath, box);
        if (!c) return -1;
        v = cut(v, c);
      }
      if (a !== el && (s.overflowX !== "visible" || s.overflowY !== "visible")) v = cut(v, box);
      if (a.hasAttribute("data-composition-id") && a.getAttribute("data-composition-id") === "main") break;
    }
    return r.w * r.h > 0 ? (v.w * v.h) / (r.w * r.h) : 0;
  }
  var r1 = function (x) { return Math.round(x * 10) / 10; };
  var r3 = function (x) { return Math.round(x * 1000) / 1000; };

  // what is text and what is drawn, once
  var texts = [], objects = [], boxes = [];
  function classify() {
    document.querySelectorAll("body *").forEach(function (el) {
      if (el.closest("script, style, noscript, template, svg *, [data-layout-ignore], [data-layout-check='ignore']")) return;
      var tag = el.tagName.toLowerCase();
      if (tag === "svg" || tag === "img" || tag === "canvas" || tag === "video" || (el.hasAttribute("data-kit") && el.getAttribute("data-kit") !== "shadow")) {
        if (!el.parentElement || !el.parentElement.closest("[data-kit]") || el.hasAttribute("data-kit")) objects.push(el);
        if (tag !== "svg") return;
      }
      var own = [];
      el.childNodes.forEach(function (c) { if (c.nodeType === 3 && /\S/.test(c.textContent)) own.push(c); });
      // a plain box or shape drawn with a colour, a gradient or a clip-path is a drawing too (a hull made of divs)
      if (!own.length && tag !== "svg" && tag !== "img" && tag !== "canvas" && tag !== "video" && !el.hasAttribute("data-kit")) {
        var cs = getComputedStyle(el), bg = cs.backgroundColor || "", alpha = /rgba\(.*,\s*([\d.]+)\)$/.exec(bg);
        if ((bg && bg !== "transparent" && !(alpha && Number(alpha[1]) < 0.05)) || (cs.backgroundImage && cs.backgroundImage !== "none") || (cs.clipPath && cs.clipPath !== "none")) { boxes.push(el); objects.push(el); }
      }
      if (own.length) texts.push({
        el: el, nodes: own, text: own.map(function (c) { return c.textContent; }).join(" ").replace(/\s+/g, " ").trim(),
        overlap: !!el.closest("[data-layout-allow-overlap]"), bleed: !!el.closest("[data-layout-allow-overflow], [data-layout-bleed]"),
      });
    });
    // a drawn object holds no text: a box with words in it is a card, not a drawing
    objects = objects.filter(function (ob) { return !texts.some(function (tx) { return ob !== tx.el && (ob.contains(tx.el) || tx.el.contains(ob)); }); });
  }
  function textRect(t) {
    var rects = [];
    t.nodes.forEach(function (node) {
      var range = document.createRange();
      range.selectNodeContents(node);
      for (var i = 0, list = range.getClientRects(); i < list.length; i++) rects.push(list[i]);
    });
    return union(rects);
  }
  function objectRect(el) {
    if (el.tagName.toLowerCase() === "svg") {
      var parts = [];
      el.querySelectorAll("path, rect, circle, ellipse, polygon, polyline, line, image, use, text").forEach(function (s) { if (!s.closest("defs, clipPath, mask, symbol, pattern")) parts.push(s.getBoundingClientRect()); });
      var u = union(parts);
      if (u) return u;
    }
    return rectOf(el.getBoundingClientRect());
  }

  function seek(player, t) {
    player.renderSeek(t);
    if (window.gsap && gsap.ticker) gsap.ticker.tick();
  }

  function run(player) {
    var main = (window.__timelines || {}).main || (player.getMainTimeline && player.getMainTimeline());
    var hosts = {};
    document.querySelectorAll("[data-composition-id][data-start]").forEach(function (h) { hosts[h.getAttribute("data-composition-id")] = parseFloat(h.getAttribute("data-start")) || 0; });
    var tlKey = new Map();
    Object.keys(window.__timelines || {}).forEach(function (k) { tlKey.set(window.__timelines[k], k); });
    // a time on anim's own clock as a time on the film's clock
    function onFilm(anim, t) {
      for (var a = anim; a; a = a.parent) {
        if (a === main) return t;
        if (!a.parent || a.parent === gsap.globalTimeline) return tlKey.has(a) ? t + (hosts[tlKey.get(a)] || 0) : null;
        t = a.startTime() + t / (a.timeScale() || 1);
      }
      return null;
    }
    var seen = new Set(), tweens = [], fades = [];
    Object.keys(window.__timelines || {}).forEach(function (k) {
      window.__timelines[k].getChildren(true, true, false).forEach(function (tw) {
        if (seen.has(tw) || tweens.length >= LIMIT.tweens) return;
        seen.add(tw);
        var s = onFilm(tw.parent, tw.startTime());
        if (s === null) return;
        var e = s + tw.duration();
        var ps = props(tw.vars);
        var kit = null;
        for (var a = tw; a && !kit; a = a.parent) kit = kitOf.get(a) || null;
        var auto = tw.vars && tw.vars.overwrite === "auto";
        (tw.targets ? tw.targets() : []).forEach(function (el) {
          if (!el || el.nodeType !== 1) return;
          var k = key(el);
          tweens.push({ el: k, p: ps, s: r3(s), e: r3(e), kit: kit, auto: auto });
          if (tw.duration() <= C.fadeMaxSec && ps.some(function (p) { return FADE[p]; })) fades.push({ el: k, node: el, s: s, e: e });
        });
      });
    });
    var times = {};
    var at = function (t, what) { var k = r3(Math.max(0, t)); (times[k] = times[k] || []).push(what); };
    fades.forEach(function (f, i) { at(f.s - 0.001, { fade: i, side: "before" }); at(f.e + 1 / (C.fps || 30) + 0.001, { fade: i, side: "after" }); });
    (C.frames || []).forEach(function (f, i) { at(f.t, { frame: i }); });
    classify();
    var before = player.getTime ? player.getTime() : 0;
    var outFades = fades.map(function (f) { return { el: f.el, s: r3(f.s), e: r3(f.e) }; });
    var outFrames = (C.frames || []).map(function (f) { return { t: f.t, c: f.c, first: !!f.first, texts: [], objects: [] }; });
    var area = frame().w * frame().h;
    Object.keys(times).map(Number).sort(function (a, b) { return a - b; }).forEach(function (t) {
      seek(player, t);
      (times[String(t)] || []).forEach(function (w) {
        if (w.fade !== undefined) {
          var f = fades[w.fade];
          var b = cut(rectOf(f.node.getBoundingClientRect()), frame());
          outFades[w.fade][w.side] = { o: r3(opacity(f.node)), a: r3((b.w * b.h) / area) };
          return;
        }
        var out = outFrames[w.frame];
        texts.forEach(function (tx) {
          if (out.texts.length >= LIMIT.texts || comp(tx.el) !== out.c) return;
          var o = opacity(tx.el);
          if (o <= 0.01) return;
          var r = textRect(tx);
          if (!r || r.w * r.h <= 0) return;
          // what a clip cuts is measured on the glyph run inside the element's own box: a font's content area is
          // taller than a tight line box, and a word at rest in its mask would read as cut
          var core = cut(r, rectOf(tx.el.getBoundingClientRect()));
          var entry = { el: key(tx.el, tx.text), r: [r1(r.x), r1(r.y), r1(r.w), r1(r.h)], o: r3(o), v: tx.bleed ? 1 : r3(visible(tx.el, core.w * core.h > 0 ? core : r)) };
          if (tx.overlap) entry.overlap = true;
          out.texts.push(entry);
        });
        objects.forEach(function (ob) {
          if (out.objects.length >= LIMIT.objects || comp(ob) !== out.c) return;
          var o = opacity(ob);
          if (o <= 0.01) return;
          var r = objectRect(ob);
          if (r.w * r.h <= 0) return;
          var drawn = { el: key(ob), r: [r1(r.x), r1(r.y), r1(r.w), r1(r.h)], o: r3(o) };
          if (boxes.indexOf(ob) >= 0) drawn.box = 1;
          out.objects.push(drawn);
        });
      });
    });
    seek(player, before);
    return { v: 1, size: [frame().w, frame().h], labels: labels, tweens: tweens, fades: outFades, frames: outFrames };
  }

  var tries = 0;
  function wait() {
    var player = window.__player;
    if (window.__renderReady && player && typeof player.renderSeek === "function") {
      var out;
      try { out = run(player); } catch (e) { out = { v: 1, error: String(e && e.message || e) }; }
      console.warn(PREFIX + JSON.stringify(out));
      return;
    }
    if (++tries < 200) setTimeout(wait, 50);
    else console.warn(PREFIX + JSON.stringify({ v: 1, error: "the page never became ready" }));
  }
  window.addEventListener("load", wait);
})();
`;
