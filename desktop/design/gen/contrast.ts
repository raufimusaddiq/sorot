// bun desktop/design/gen/contrast.ts : WCAG 2.1 contrast of every text/background and boundary pair the screens use.
import { COLORS, ONBEAM } from "./fc";
const lum = (h: string) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const cr = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const col = (n: string, m: number) => (n.startsWith("#") ? n : COLORS[n][m]);
// [foreground, background, minimum, what]
const PAIRS: [string, string, number, string][] = [];
for (const fg of ["text", "muted", "beamText", "steel", "pass", "skip", "review"]) for (const bg of ["bg", "surface", "raised"]) PAIRS.push([fg, bg, 4.5, "text"]);
PAIRS.push([ONBEAM, "beam", 4.5, "label on beam fill"], ["edge", "raised", 3, "control boundary"], ["edge", "surface", 3, "control boundary"], ["beamText", "bg", 3, "focus ring, selected-control edge"],
  ["#ECE8E1", "#0E0F11", 4.5, "text on video"], ["#A39E95", "#0E0F11", 4.5, "muted on video"], ["#E07A68", "#0E0F11", 4.5, "error on video"]);
let fails = 0;
const out: string[] = ["| Pair | Dark | Light | Need |", "|---|---|---|---|"];
for (const [f, b, min, what] of PAIRS) {
  const r = [0, 1].map((m) => (f.startsWith("#") && m === 1 ? NaN : cr(col(f, m), col(b, m))));
  const bad = r.some((v) => !Number.isNaN(v) && v < min);
  if (bad) fails++;
  out.push(`| ${f} on ${b} (${what}) | ${r[0].toFixed(2)} | ${Number.isNaN(r[1]) ? "same (video stays dark)" : r[1].toFixed(2)} | ${min}${bad ? " FAIL" : ""} |`);
}
console.log(out.join("\n"));
console.log(fails ? `\n${fails} pairs below minimum` : "\nall pairs meet their minimum");
process.exitCode = fails ? 1 : 0;
