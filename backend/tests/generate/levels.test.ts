import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db";
import { capabilitiesFor } from "../../src/generate/capabilities";
import { checkScene } from "../../src/generate/composer";
import { Director } from "../../src/generate/director";
import { DirectorLog } from "../../src/generate/events";
import { readPart, type KitManifest } from "../../src/generate/kit";
import { validateKitShot, writeKitScene } from "../../src/generate/kitScene";
import { CALIBRATION_PLAN, calibrate, chooseLevel, provenLevel, recordAnswer, recordOf, type LevelChoice } from "../../src/generate/levels";
import { Store } from "../../src/store";
import { fakeLlm, sceneHtml } from "../helpers";

const KIT: KitManifest[] = ["camera", "particles", "shade", "text-reveal", "three"].map((n) => readPart(`../generator/kit/${n}`).manifest!);
const caps = (level: "kit" | "compose" | "free") => capabilitiesFor({ level, kit: KIT, config: { whisperDevice: "cpu", hyperframesVersion: "0.8.223" }, connected: () => false });
const json = (v: unknown) => JSON.stringify(v);
const r = (asked: number, firstPass: number, malformed = 0) => ({ asked, firstPass, malformed });

describe("model record", () => {
  test("each outcome adds to its own count; a malformed answer is a retry, not a new ask", () => {
    const store = new Store(openDatabase(":memory:"));
    for (const o of ["firstPass", "firstPass", "repaired", "failed", "malformed", "dropped"] as const) recordAnswer(store, "m", "compose", o, 100);
    recordAnswer(store, "", "compose", "firstPass");   // no model, nothing to keep
    expect(store.genModelRecords("m")).toMatchObject([{ model: "m", level: "compose", asked: 4, firstPass: 2, repaired: 1, dropped: 1, malformed: 1, ms: 500 }]);
  });

  test.each<[string, LevelChoice, string]>([
    // the director is never held back: a shot starts as high as the caps allow, whatever the record says
    ["a poor record still starts at the top", { record: { compose: r(10, 1, 5), free: r(10, 0, 9) } }, "free"],
    ["...under the recipe's cap", { record: {}, maxLevel: "compose" }, "compose"],
    ["...and the machine's", { record: {}, cpuCap: "compose" }, "compose"],
    ["the recipe's pin wins over the owner's", { record: {}, recipeLevel: "kit", pin: "compose" }, "kit"],
    ["the owner's pin for the model", { record: {}, recipeLevel: "auto", pin: "kit" }, "kit"],
    ["a pin above the cap is capped", { record: {}, pin: "free", maxLevel: "compose" }, "compose"],
  ])("%s", (_name, choice, level) => {
    expect(chooseLevel(choice)).toBe(level as never);
  });

  test.each<[string, LevelChoice["record"], string]>([
    // what the record shows the owner (it never caps a shot)
    ["no record", {}, "kit"],
    ["8 shots, 60% first time, 10% malformed", { compose: r(10, 6, 1) }, "compose"],
    ["too few shots", { compose: r(7, 7) }, "kit"],
    ["too many malformed", { compose: r(10, 9, 2) }, "kit"],
    ["the highest proven level", { compose: r(10, 9), free: r(10, 8) }, "free"],
    // a calibrated level counts with Calibrate's own three shots
    ["3 calibrated shots, all first time", { compose: { ...r(3, 3), calibratedAt: "t" } }, "compose"],
    ["3 calibrated shots, 1 first time", { compose: { ...r(3, 1), calibratedAt: "t" } }, "kit"],
    ["2 calibrated shots", { compose: { ...r(2, 2), calibratedAt: "t" } }, "kit"],
  ])("proven level: %s", (_name, record, level) => {
    expect(provenLevel(record)).toBe(level as never);
  });
});

describe("kit-level shots", () => {
  const shot = CALIBRATION_PLAN.shots[1]!;   // "Bunga berbunga" + body line
  const layer = (part: string, settings: Record<string, unknown> = {}, fromSec = 0, toSec = 4) => ({ part, settings, fromSec, toSec });

  test.each<[string, object, string]>([
    ["another shot's id", { shotId: "s09", layers: [layer("shade")] }, 'shotId must be "s02"'],
    ["no layers", { shotId: "s02", layers: [] }, "layers: 1 to 8 parts"],
    ["times outside the shot", { shotId: "s02", layers: [layer("shade", {}, 1, 9)] }, "must lie inside the shot's 4 s"],
    ["a part that isn't installed", { shotId: "s02", layers: [layer("neon")] }, '"neon" isn\'t an installed kit part'],
    ["a setting the part lacks", { shotId: "s02", layers: [layer("shade", { glow: 1 })] }, 'shade has no setting "glow"'],
    ["a target a kit scene doesn't have", { shotId: "s02", layers: [layer("shade", { target: ".petal" })] }, '"\.petal" isn\'t in a kit scene; use one of ".k-text", ".k-text > *", ".t-title", ".t-body"'.replace(/\\/g, "")],
    ["a line that isn't planned", { shotId: "s02", layers: [layer("shade")], text: [{ role: "title", value: "Kaya raya" }] }, 'text "Kaya raya" isn\'t one of the shot\'s planned lines'],
  ])("an answer with %s is sent back", (_name, answer, message) => {
    expect(validateKitShot(answer, shot, caps("kit"), KIT).errors!.join("\n")).toContain(message);
  });

  test("the scene Sorot writes keeps every plan-lock rule: planned text, the root, the timeline, known parts", () => {
    const answer = validateKitShot({ shotId: "s02", layers: [layer("particles", { kind: "snow" }), layer("text-reveal", { target: ".t-title" }, 0.2, 2), layer("camera")], text: [{ role: "title", value: "Bunga berbunga" }] }, shot, caps("kit"), KIT).value!;
    const html = writeKitScene({ plan: CALIBRATION_PLAN, index: 1, width: 1080, height: 1920, answer, kit: KIT });
    const kit = { installed: KIT.map((m) => m.name), allowed: caps("kit").kit.map((p) => p.name), level: "kit" as const, webgl: false };
    expect(checkScene(html, shot, 1, { assets: [], kit })).toEqual([]);
    // a part that draws gets its own layer; one with a target acts on the stage (the text, the layers)
    expect(html).toContain('SorotKitRuntime.mount("particles", layers[0], {"kind":"snow"}, { tl: tl, start: 0, duration: 4, seed: "s02-particles-0" });');
    expect(html).toContain('SorotKitRuntime.mount("text-reveal", stage, {"target":".t-title"}, { tl: tl, start: 0.2, duration: 1.8');
    expect(html).toContain('<p class="t-body">Bunga ikut menghasilkan bunga</p>');
    expect(html).not.toContain(".k-text\"), { y: 40");   // the text is revealed by a part, so no default arrival
    // the film's first shot never starts on an empty frame: its text moves in but is never transparent
    const first = writeKitScene({ plan: CALIBRATION_PLAN, index: 0, width: 1080, height: 1920, answer: { shotId: "s01", layers: [layer("shade")], text: [] }, kit: KIT });
    expect(first).toContain('tl.fromTo(root.querySelector(".k-text"), { y: 30 }, { y: 0');
  });
});

describe("calibration", () => {
  test("three sample shots at each level the machine offers; the record gets them with the time it ran", async () => {
    const store = new Store(openDatabase(":memory:"));
    const kitAnswer = (id: string) => json({ shotId: id, layers: [{ part: "shade", settings: {}, fromSec: 0, toSec: 2 }] });
    const scene = (i: number) => json({ html: sceneHtml(i, CALIBRATION_PLAN.shots[i]!.text[0]!.value) });
    const broken = json({ html: sceneHtml(0, "salah") });
    const { llm } = fakeLlm([
      kitAnswer("s01"), kitAnswer("s02"), kitAnswer("s03"),
      scene(0), broken, json({ html: sceneHtml(1, "Bunga berbunga").replace("</h1>", "</h1><p>Bunga ikut menghasilkan bunga</p>") }), broken, broken,
    ]);
    const director = new Director(llm, new DirectorLog(store), "../generator");
    const result = await calibrate({ store, director, kit: KIT, capabilities: caps, maxLevel: "compose" });
    expect(result).toEqual({ kit: { asked: 3, firstPass: 3, repaired: 0, failed: 0 }, compose: { asked: 3, firstPass: 1, repaired: 1, failed: 1 } });
    expect(recordOf(store, director.model)).toMatchObject({ kit: { asked: 3, firstPass: 3 }, compose: { asked: 3, firstPass: 1, repaired: 1 } });
    expect(store.genModelRecords()[0]!.calibratedAt).toBeString();
  });
});
