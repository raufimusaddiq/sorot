// bun desktop/design/gen/verify.ts : tokens.json == design.md table == figcraft variables export
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const here = import.meta.dir;
const md = readFileSync(resolve(here, "../../../specs/003-native-desktop-app/design.md"), "utf8");
const tok = JSON.parse(readFileSync(resolve(here, "../tokens.json"), "utf8"));
const fig = JSON.parse(readFileSync(resolve(here, "../tokens.figma.json"), "utf8"));
let fail = 0;
const bad = (m: string) => { fail++; console.log("FAIL", m); };

// 1. design.md table: first dark/light hex per row (token cell is `name`)
const want: Record<string, [string, string]> = {};
for (const line of md.split("\n")) {
  const m = line.match(/^\| `(\w+)`(?: \([^)]*\))? \| (.+?) \| (.+?) \| /);
  if (!m || !["bg", "surface", "raised", "divider", "edge", "text", "muted", "beam", "steel", "pass", "skip"].includes(m[1])) continue;
  const hx = (s: string) => [...s.matchAll(/`(#[0-9A-Fa-f]{6})`/g)].map((x) => x[1].toUpperCase());
  want[m[1]] = [hx(m[2])[0], m[1] === "beam" ? hx(m[3])[0] : hx(m[3])[0]];
}
want.beamText = ["#F0B44C", (md.match(/beam text `(#[0-9A-Fa-f]{6})`/) ?? [])[1]?.toUpperCase() ?? ""];
want.review = want.steel;
for (const [k, [dk, lt]] of Object.entries(want)) {
  if (tok.color.dark[k]?.$value.toUpperCase() !== dk) bad(`dark ${k}: tokens ${tok.color.dark[k]?.$value} vs design.md ${dk}`);
  if (tok.color.light[k]?.$value.toUpperCase() !== lt) bad(`light ${k}: tokens ${tok.color.light[k]?.$value} vs design.md ${lt}`);
}
if (Object.keys(want).length !== 13) bad("expected 13 design.md colour tokens, got " + Object.keys(want).length);

// 2. figcraft export (floats) -> hex, must equal tokens.json
const hex = (c: any) => "#" + [c.r, c.g, c.b].map((v: number) => Math.round(v * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
const modes: Record<string, string> = {};
for (const c of Object.values<any>(fig.meta.variableCollections)) if (c.name === "color") for (const m of c.modes) modes[m.modeId] = m.name;
let n = 0;
for (const v of Object.values<any>(fig.meta.variables)) {
  if (v.resolvedType !== "COLOR") continue;
  for (const [mid, val] of Object.entries<any>(v.valuesByMode)) {
    n++;
    if (hex(val) !== tok.color[modes[mid]][v.name].$value.toUpperCase()) bad(`figcraft ${v.name}/${modes[mid]}: ${hex(val)} vs tokens`);
  }
}
if (n !== 26) bad("expected 26 colour values in the figcraft export, got " + n);
console.log(fail ? `${fail} FAIL` : `PASS: ${Object.keys(want).length} tokens x 2 modes equal design.md and the figcraft export; space/radius present`);
for (const [c, vals] of [["space", [4, 8, 12, 16, 24, 40, 64]], ["radius", [2, 6, 10]]] as [string, number[]][]) for (const v of vals) if (tok[c][v]?.$value !== v + "px") { console.log("FAIL", c, v); process.exitCode = 1; }
process.exitCode = fail ? 1 : process.exitCode;
