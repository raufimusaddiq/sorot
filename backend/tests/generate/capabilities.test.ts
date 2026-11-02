import { describe, expect, test } from "bun:test";
import { atMost, capabilitiesFor, checkPartRefs, frameBudgetMs, levelBelow, type Level } from "../../src/generate/capabilities";
import type { KitManifest } from "../../src/generate/kit";

const part = (name: string, runtime: KitManifest["runtime"], gpu: KitManifest["needs"]["gpu"] = "no"): KitManifest => ({
  name, version: "1.0.0", does: `${name} does`, runtime, needs: { gpu }, example: `${name} example`,
  settings: { strength: { t: "num", min: 0, max: 1 } }, defaults: { strength: 0.5 },
});
const KIT = [part("three", "webgl", "preferred"), part("shade", "dom"), part("particles", "canvas")];
const caps = (level: Level, over: { gpu?: boolean; maxLevel?: Level; parts?: string[]; workers?: number } = {}) => capabilitiesFor({
  level, kit: KIT, parts: over.parts, maxLevel: over.maxLevel, workers: over.workers,
  config: { whisperDevice: over.gpu ? "cuda" : "cpu", hyperframesVersion: "0.8.223" }, connected: (c) => c === "voice",
});

describe("capability description", () => {
  test("a plan call gets every usable part in one line, the seams, the renderer and the connections; no part detail", () => {
    const c = caps("free");
    expect(c.kit).toEqual([
      { name: "particles", does: "particles does", runtime: "canvas" }, { name: "shade", does: "shade does", runtime: "dom" }, { name: "three", does: "three does", runtime: "webgl" },
    ]);
    expect(c.kitDetail).toBeUndefined();
    expect(c.seams).toContain("fade");
    expect(c.renderer).toEqual({ hyperframes: "0.8.223", runtimes: ["dom", "canvas", "webgl"], gpu: false, frameBudgetMs: 1000 });
    expect(c.connections).toEqual({ image: false, voice: true, vision: false });
    expect(c.levelMeans).toContain("WebGL");
  });

  test.each([
    // level asked, machine, recipe max → level given, parts offered
    ["free", { gpu: true }, "free", ["particles", "shade", "three"]],
    ["compose", { gpu: true }, "compose", ["particles", "shade"]],
    ["kit", {}, "kit", ["particles", "shade"]],
    ["free", { maxLevel: "compose" as Level }, "compose", ["particles", "shade"]],
    ["free", { gpu: false, maxLevel: "free" as Level }, "free", ["particles", "shade", "three"]],
  ])("asked %s on %o: answers at %s with %o", (level, over, given, names) => {
    const c = caps(level as Level, over);
    expect([c.level, c.kit.map((p) => p.name)] as unknown[]).toEqual([given, names]);
  });

  test("a scene call gets the full settings of the parts it may use, never of a part its level hides; the budget follows the workers", () => {
    expect(caps("compose", { parts: ["shade", "three"] }).kitDetail).toEqual({ shade: { settings: { strength: { t: "num", min: 0, max: 1 } }, defaults: { strength: 0.5 }, example: "shade example" } });
    expect([frameBudgetMs(1), frameBudgetMs(4), caps("kit", { workers: 1 }).renderer.frameBudgetMs]).toEqual([500, 2000, 500]);
    expect(caps("compose", { maxLevel: "compose" }).renderer.runtimes).toEqual(["dom", "canvas"]);
  });

  test("levels step down to kit and never above the cap", () => {
    expect([levelBelow("free"), levelBelow("compose"), levelBelow("kit"), atMost("free", "compose"), atMost("kit", "free")]).toEqual(["compose", "kit", null, "compose", "kit"]);
  });

  test.each([
    [{ part: "neon" }, "kit_unknown_part", '"neon" isn\'t an installed kit part (installed: particles, shade)'],
    [{ part: "three" }, "kit_not_allowed", '"three" (webgl) isn\'t allowed at the compose level'],
    [{ part: "shade", settings: { strength: 4 } }, "kit_bad_setting", "p[0].settings.strength: must be between 0 and 1"],
    [{ part: "shade", settings: { glow: 1 } }, "kit_bad_setting", 'shade has no setting "glow"'],
  ])("a reference %o is refused as %s", (ref, code, message) => {
    const [problem] = checkPartRefs([ref], caps("compose"), KIT, "p");
    expect(problem!.code).toBe(code as never);
    expect(problem!.message).toContain(message);
  });
});
