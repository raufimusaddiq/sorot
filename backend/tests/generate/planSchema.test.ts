import { describe, expect, test } from "bun:test";
import { numbersIn, validatePlan, type PlanContext } from "../../src/generate/planSchema";
import { samplePlan } from "../helpers";

const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({
  brief: "Jelaskan bunga majemuk dalam 30 detik", targetSec: 30, format: "9:16", language: "id",
  fonts: ["Plus Jakarta Sans", "Inter"], imageConnected: false, narration: false, ...over,
});
const shots = (plan: Record<string, any>, f: (s: any[]) => any[]) => ({ ...plan, shots: f(plan.shots) });
const first = (f: (s: any) => any) => (p: Record<string, any>) => shots(p, (s) => [f(s[0]), ...s.slice(1)]);

describe("validatePlan", () => {
  test("a good plan passes and is normalised from the project, not from the model", () => {
    const check = validatePlan({ ...samplePlan(), format: "16:9", language: "en", totalSec: 99, junk: 1 }, ctx());
    expect(check).toMatchObject({ ok: true, errors: [] });
    expect(check.plan).toMatchObject({ format: "9:16", language: "id", totalSec: 30, sound: { music: "none", narration: false } });
    expect(check.plan!.shots).toHaveLength(3);
    expect(check.plan!.shots[0]).toMatchObject({ id: "s01", transition: "cut", hold: false, narration: null });
    expect(check.plan).not.toHaveProperty("junk");
  });

  test.each<[string, (p: Record<string, any>) => unknown, Partial<PlanContext>, string]>([
    ["not an object", () => [], {}, "must be a JSON object"],
    ["no title", (p) => ({ ...p, title: " " }), {}, "title is required"],
    ["no message", (p) => ({ ...p, message: undefined }), {}, "message is required"],
    ["no shots", (p) => ({ ...p, shots: [] }), {}, "needs 1 to 20 shots"],
    ["21 shots", (p) => shots(p, (s) => Array.from({ length: 21 }, (_, i) => ({ ...s[0], id: `x${i}`, durationSec: 1 }))), {}, "needs 1 to 20 shots (got 21)"],
    ["shot too short", first((s) => ({ ...s, durationSec: 0.5 })), {}, "durationSec must be between 1 and 15"],
    ["shot too long", first((s) => ({ ...s, durationSec: 16 })), {}, "durationSec must be between 1 and 15"],
    ["duration missing", first((s) => ({ ...s, durationSec: undefined })), {}, "durationSec must be between"],
    ["total 15% over", first((s) => ({ ...s, durationSec: 14.5 })), {}, "add up to 34.5 s; the target is 30 s (allowed 27 to 33 s)"],
    ["total too short", (p) => shots(p, (s) => s.slice(0, 2)), {}, "add up to 20 s"],
    ["title of 7 words", first((s) => ({ ...s, text: [{ role: "title", value: "satu dua tiga empat lima enam tujuh" }] })), {}, "has 7 words; the limit is 6"],
    ["a text line over 120 chars", first((s) => ({ ...s, text: [{ role: "body", value: "x".repeat(121) }] })), {}, "121 characters; the limit is 120"],
    ["no visual description", first((s) => ({ ...s, visual: {} })), {}, "visual.description is required"],
    ["duplicate ids", (p) => shots(p, (s) => s.map((x) => ({ ...x, id: "s01" }))), {}, 'the id "s01" is used twice'],
    ["a font that is not available", (p) => ({ ...p, look: { ...p.look, fonts: ["Comic Sans"] } }), {}, "not available: Comic Sans"],
    ["blocks when the recipe forbids them", (p) => ({ ...p, blocks: ["data-chart"] }), { blocksAllowed: false }, "allow registry blocks"],
    ["an unknown block", (p) => ({ ...p, blocks: ["nope"] }), { blocks: ["data-chart"] }, "unknown blocks: nope"],
  ])("refuses: %s", (_name, mutate, over, message) => {
    const check = validatePlan(mutate(samplePlan()), ctx(over));
    expect(check.ok).toBe(false);
    expect(check.plan).toBeNull();
    expect(check.errors.join("\n")).toContain(message);
  });

  test("a font match ignores case; a known block passes; a block on a shot is cleared when blocks are off", () => {
    const p = { ...samplePlan({ blocks: ["data-chart"] }), look: { ...samplePlan().look, fonts: ["inter"] } };
    expect(validatePlan(p, ctx({ blocks: ["data-chart"] })).ok).toBe(true);
    const withBlock = first((s) => ({ ...s, visual: { ...s.visual, block: "data-chart" } }))(samplePlan());
    expect(validatePlan(withBlock, ctx({ blocksAllowed: false })).plan!.shots[0]!.visual.block).toBeNull();
    expect(validatePlan(withBlock, ctx()).plan!.shots[0]!.visual.block).toBe("data-chart");
  });

  test("generated images are kept with an image connection and dropped, keeping a fallback, without one", () => {
    const withImage = first((s) => ({ ...s, visual: { ...s.visual, generatedImage: { prompt: "a seed", style: "flat" }, fallbackVisual: "a plain seed" } }))(samplePlan());
    expect(validatePlan(withImage, ctx({ imageConnected: true })).plan!.shots[0]!.visual).toMatchObject({ generatedImage: { prompt: "a seed", style: "flat" } });
    const off = validatePlan(withImage, ctx());
    expect(off.plan!.shots[0]!.visual).toEqual({ description: "visual 1", block: null, fallbackVisual: "a plain seed" });
    expect(off.notes.join()).toContain("image prompt was dropped");
    const noFallback = first((s) => ({ ...s, visual: { ...s.visual, generatedImage: { prompt: "a seed" } } }))(samplePlan());
    expect(validatePlan(noFallback, ctx()).plan!.shots[0]!.visual.fallbackVisual).toBe("visual 1");
  });

  test("narration is kept only when it is on and a voice can speak it", () => {
    const narrated = { ...samplePlan({ narrationScript: "Halo dunia", sound: { music: "none", narration: true } }), shots: samplePlan().shots.map((s: any) => ({ ...s, narration: "kata" })) };
    const on = validatePlan(narrated, ctx({ narration: true })).plan!;
    expect(on).toMatchObject({ narrationScript: "Halo dunia", sound: { narration: true } });
    expect(on.shots[0]!.narration).toBe("kata");
    const off = validatePlan(narrated, ctx());
    expect(off.plan).toMatchObject({ narrationScript: null, sound: { narration: false } });
    expect(off.plan!.shots[0]!.narration).toBeNull();
    expect(off.notes.join()).toContain("narration was removed");
  });

  test("numbers that are not in the brief become assumptions; the brief's own stay as they are", () => {
    const brief = "Bunga 1,5% per bulan selama 12 bulan";
    const plan = first((s) => ({ ...s, text: [{ role: "title", value: "1,5% selama 12 bulan" }, { role: "body", value: "jadi 18,5% dan 40%" }] }))(samplePlan());
    const check = validatePlan(plan, ctx({ brief }));
    expect(check.plan!.assumptions).toEqual([
      "The number 18.5 is not in the brief; it was added by the director.",
      "The number 40 is not in the brief; it was added by the director.",
    ]);
    expect(check.notes).toHaveLength(2);
    // already listed by the director: not added twice
    const listed = validatePlan({ ...plan, assumptions: ["18,5% dihitung dari 12 x 1,5", "40 adalah tebakan"] }, ctx({ brief }));
    expect(listed.plan!.assumptions).toHaveLength(2);
    expect(listed.notes).toEqual([]);
  });

  test("limits can be tightened by the recipe", () => {
    expect(validatePlan(samplePlan(), ctx({ limits: { maxShots: 2 } })).errors.join()).toContain("needs 1 to 2 shots");
    expect(validatePlan(samplePlan(), ctx({ limits: { maxShotSec: 8 } })).errors.join()).toContain("between 1 and 8");
    expect(validatePlan(samplePlan(), ctx({ limits: { sumTolerance: 0 }, targetSec: 31 })).errors.join()).toContain("add up to 30 s");
  });

  test("number extraction unifies the decimal comma", () => {
    expect(numbersIn("1,5% dari 2.500 dan 40")).toEqual(["1.5", "2.500", "40"]);
    expect(numbersIn("tanpa angka")).toEqual([]);
  });
});
