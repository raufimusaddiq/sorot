// Tiny declarative compiler: calls -> one figcraft `run` script (JSON array of commands).
// Colours are token names ("bg", "beam", ...) bound to the `color` variable collection, or "#hex".
import { writeFileSync } from "node:fs";

export const COLORS: Record<string, [string, string]> = {
  // design.md palette, hex verbatim: name -> [dark, light]
  bg: ["#0E0F11", "#F4F1EA"],
  surface: ["#16181B", "#FBF9F4"],
  raised: ["#1E2125", "#FFFFFF"],
  divider: ["#2A2E33", "#DAD4C8"],
  edge: ["#7A818A", "#857E71"],
  text: ["#ECE8E1", "#17191C"],
  muted: ["#A39E95", "#5C5850"],
  beam: ["#F0B44C", "#F0B44C"],
  beamText: ["#F0B44C", "#8A5600"],
  steel: ["#7FA3B8", "#3F6478"],
  pass: ["#6FBF8E", "#2E7A4E"],
  review: ["#7FA3B8", "#3F6478"],
  skip: ["#E07A68", "#B2412F"],
};
export const SPACE = [4, 8, 12, 16, 24, 40, 64];
export const RADIUS = [2, 6, 10];
export const SIZES = [12, 13, 15, 19, 26, 40];
export const WEIGHTS: Record<number, string> = { 400: "regular", 500: "medium", 600: "semibold" };
export const FONT = "Instrument Sans";
export const ONBEAM = "#17191C"; // label on a beam fill: 9.51:1 on #F0B44C in both modes
export const GLOW = [{ type: "dropShadow", color: "#F0B44C99", offset: [0, 0], radius: 10 }];

type P = Record<string, any>;
export const mode = { light: false }; // set by the page builder: literals that cannot bind a variable follow it

export function paint(v: any): any {
  if (v === null || v === undefined || v === "none") return "none";
  if (typeof v === "string" && v.startsWith("#")) return v;
  if (typeof v === "object") return v;
  return { $var: v };
}

export function styleName(size: number, wt: number, num: boolean) {
  return num ? `numeric/${size} tabular` : `text/${size} ${WEIGHTS[wt]}`;
}

const ALIAS: Record<string, string> = {
  radius: "cornerRadius", pad: "padding", sh: "sizingH", sv: "sizingV", main: "mainAlign", cross: "crossAlign",
  sw: "strokeWeight",
};

export class Doc {
  cmds: P[] = [];
  n = 0;
  styles = new Set<string>();

  cmd(command: string, params: P = {}, as?: string) {
    const c: P = { command, params };
    if (as) c.as = as;
    this.cmds.push(c);
    return as;
  }
  ref = (r: string) => ({ $ref: r });
  fresh = () => `n${++this.n}`;

  mapProps(props: P) {
    const pr: P = {};
    for (const [k0, v] of Object.entries(props)) {
      if (v === undefined || v === null || k0 === "comp") continue;
      const k = ALIAS[k0] ?? k0;
      pr[k] = k === "fill" || k === "stroke" ? paint(v) : v;
    }
    return pr;
  }

  node(type: string, parent: string | null, name: string | null, o: P = {}) {
    const { x, y, w, h, text, path, closed, ...props } = o;
    const r = this.fresh();
    const p: P = { type };
    if (parent) p.parent = this.ref(parent);
    if (name) p.name = name;
    if (x !== undefined) p.x = x;
    if (y !== undefined) p.y = y;
    if (w !== undefined) p.width = w;
    if (h !== undefined) p.height = h;
    if (text !== undefined) p.text = text;
    if (path !== undefined) p.path = path;
    if (closed !== undefined) p.closed = closed;
    const pr = this.mapProps(props);
    if (Object.keys(pr).length) p.props = pr;
    this.cmd("node.create", p, r);
    return r;
  }

  set(r: string, props: P) {
    this.cmd("node.set", { ids: [this.ref(r)], ...this.mapProps(props) });
  }

  frame(parent: string | null, name: string | null, o: P = {}) {
    const q = { ...o };
    q.fill = q.fill ?? "none";
    if (q.stroke && q.sw === undefined) q.sw = 1;
    if (q.layout) {
      if (q.w === undefined && q.sh === undefined) q.sh = "hug";
      if (q.h === undefined && q.sv === undefined) q.sv = "hug";
    }
    return this.node("frame", parent, name, q);
  }
  row = (parent: string | null, name: string | null, o: P = {}) => this.frame(parent, name, { layout: "horizontal", ...o });
  col = (parent: string | null, name: string | null, o: P = {}) => this.frame(parent, name, { layout: "vertical", ...o });
  rect = (parent: string | null, name: string | null, o: P = {}) => this.node("rectangle", parent, name, o);

  text(parent: string | null, t: string, o: P = {}) {
    const { size = 13, wt = 400, color = "text", num = false, name, align, lh, fillW = false, ...rest } = o;
    const r = this.node("text", parent, name ?? t.slice(0, 24), {
      text: t, fontFamily: FONT, fontSize: size, fontVariations: { wght: wt }, fill: color, textAlign: align,
      lineHeight: lh, features: num ? { tnum: true } : undefined, sh: fillW ? "fill" : undefined, ...rest,
    });
    const key = styleName(size, wt, num);
    if (this.styles.has(key)) this.cmd("style.apply", { ids: [this.ref(r)], style: key });
    return r;
  }
}

export function write(doc: Doc, path: string) {
  writeFileSync(path, JSON.stringify(doc.cmds));
}
