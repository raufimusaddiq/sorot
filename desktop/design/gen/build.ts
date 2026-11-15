// bun desktop/design/gen/build.ts [stage]   -> script.json -> figcraft-cli run -> ../sorot-desktop.figcraft
import { Doc, write, COLORS, SPACE, RADIUS } from "./fc";
import { writeFileSync, mkdirSync } from "node:fs";
import { variables, foundations } from "./foundations";
import { brand } from "./brand";
import { componentsPage } from "./components";
import { screensPage } from "./screens";
import { statesPage, motionPage } from "./extra";
import { mode } from "./fc";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const here = import.meta.dir;
const ROOT = resolve(here, "../../..");
const CLI = process.env.FIGCRAFT_CLI ?? "D:/VibeCoding/figcraft/target/release/figcraft-cli.exe";
export const OUT = resolve(here, "../sorot-desktop.figcraft");

const d = new Doc();
d.cmd("text.loadFont", { path: resolve(here, "../fonts/InstrumentSans.ttf").replaceAll("\\", "/") });
// T001: pages
d.cmd("page.rename", { id: 1, name: "Foundations" });
for (const p of ["Brand", "Components", "Screens: dark", "Screens: light", "Motion notes"]) d.cmd("page.add", { name: p });
d.cmd("page.select", { index: 0 });
variables(d);
foundations(d, "Foundations");
d.cmd("page.select", { index: 1 });
const brandOut = brand(d);

d.cmd("page.select", { index: 2 });
componentsPage(d);
d.cmd("page.select", { index: 3 });
d.cmd("page.setBackground", { color: "#08090A" });
const dark = screensPage(d, false);
d.cmd("page.select", { index: 4 });
d.cmd("page.setBackground", { color: "#8D877B" });
mode.light = true;
const light = screensPage(d, true);
mode.light = false;
const stL = (mode.light = true, statesPage(d, true)); mode.light = false;
d.set(stL.ref, { x: 0, y: (light as any).bottom + 200 }); light.push(stL);
d.cmd("page.select", { index: 3 });
const stD = statesPage(d, false); d.set(stD.ref, { x: 0, y: (dark as any).bottom + 200 }); dark.push(stD);
d.cmd("page.select", { index: 5 });
const mo = motionPage(d);
const doExport = process.argv.includes("--export");
// preview exports (scratch, not committed)
const PREV = resolve(ROOT, ".scratch");
const preview = (ref: string, name: string, scale = 0.5) => d.cmd("file.export", { ids: [d.ref(ref)], format: "png", scale, path: PREV + "/" + name + ".png" });
d.cmd("select.none");
for (const s of [...dark, ...light]) preview(s.ref, s.name, 0.5);
preview(mo, "motion", 0.5);
preview(brandOut.root, "brand", 0.5);

if (doExport) {
  const F = resolve(here, "../frames"), A = resolve(ROOT, "desktop/assets"), I = A + "/icon";
  for (const s of [...dark, ...light]) d.cmd("file.export", { ids: [d.ref(s.ref)], format: "png", scale: 1, path: F + "/" + s.name + ".png" });
  d.cmd("variable.export", { format: "json", path: resolve(here, "../tokens.figma.json") });
  const dtcg: any = { color: { dark: {}, light: {} }, space: {}, radius: {}, font: { family: { $type: "fontFamily", $value: "Instrument Sans" } } };
  for (const [k, [dk, lt]] of Object.entries(COLORS)) { dtcg.color.dark[k] = { $type: "color", $value: dk }; dtcg.color.light[k] = { $type: "color", $value: lt }; }
  for (const v of SPACE) dtcg.space[v] = { $type: "dimension", $value: v + "px" };
  for (const v of RADIUS) dtcg.radius[v] = { $type: "dimension", $value: v + "px" };
  writeFileSync(resolve(here, "../tokens.json"), JSON.stringify(dtcg, null, 2) + "\n");
  const ex = (ref: string, size: number, path: string) => d.cmd("file.export", { ids: [d.ref(ref)], format: "png", size: size + "w", path });
  const bi = brandOut.ids;
  ex(bi.mac, 1024, I + "/icon-1024.png");
  for (const n of [16, 32, 64, 128, 256, 512, 1024]) ex(bi.mac, n, I + "/icns/icon-" + n + ".png");
  for (const n of [16, 24, 32, 48, 256]) ex(bi.win, n, I + "/ico/icon-" + n + ".png");
  ex(bi.linux, 512, I + "/icon-512.png");
  d.cmd("file.export", { ids: [d.ref(bi.tray)], format: "svg", path: I + "/tray-template.svg" });
  d.cmd("file.export", { ids: [d.ref(bi.wmInner)], format: "svg", path: A + "/wordmark.svg" });
  d.cmd("file.export", { ids: [d.ref(bi.wmInnerLight)], format: "svg", path: F + "/wordmark-light.svg" });
}

const stage = resolve(ROOT, ".scratch/script.json");
mkdirSync(resolve(ROOT, ".scratch"), { recursive: true });
write(d, stage);
const r = spawnSync(CLI, ["--no-system-fonts", "run", stage, "--automation-write-root", ROOT, "--out", OUT], { encoding: "utf8", maxBuffer: 1 << 28 });
const lines = (r.stdout ?? "").trim().split("\n");
const bad = lines.filter((l) => l.includes('"ok":false'));
console.log(lines.length, "steps;", bad.length, "failed;", (r.stderr ?? "").slice(0, 500));
for (const b of bad.slice(0, 5)) console.log(b.slice(0, 400));
