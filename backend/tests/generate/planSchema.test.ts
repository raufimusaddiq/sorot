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

describe("validatePlan: a numeric plan", () => {
  const numericCtx = (over: Partial<PlanContext> = {}) => ctx({ numeric: true, motionPlan: true, fps: 30, fonts: ["Plus Jakarta Sans", "Inter", "Bebas Neue"], ...over });
  /** Three shots of 10 s at 30 fps: frames 0-300, 300-600, 600-900. */
  const numericPlan = (over: Record<string, any> = {}) => {
    const base = samplePlan();
    return {
      ...base,
      numeric: {
        typography: { title: { font: "Plus Jakarta Sans", weight: 700, px: 96, tracking: -0.02 }, body: { font: "Inter", weight: 400, px: 48, tracking: 0 } },
        shadow: "0 8px 24px rgba(0,0,0,.4)",
        easing: { enter: "power3.out", exit: "cubic-bezier(0.4, 0, 1, 1)" },
        durationsFrames: { enter: 18, hold: 60 }, staggerFrames: { words: 4 },
      },
      shots: base.shots.map((s: any, i: number) => ({
        ...s, frames: [i * 300, i * 300 + 300], heroMove: "the seed grows", reads: "a seed becomes a tree", handoff: "the tree's shadow",
        motionPlan: [{ token: "enter", fromFrame: i * 300, toFrame: i * 300 + 18, target: "title" }],
      })),
      ...over,
    };
  };
  const errorsOf = (plan: unknown, c = numericCtx()) => validatePlan(plan, c).errors;
  const shotsOf = (f: (s: any, i: number) => any) => numericPlan({ shots: numericPlan().shots.map(f) });

  test("a complete spec passes, and keeps its numbers on the plan and its shots", () => {
    const check = validatePlan(numericPlan(), numericCtx());
    expect(check.errors).toEqual([]);
    expect(check.plan!.numeric).toEqual({
      fps: 30, totalFrames: 900,
      typography: { title: { font: "Plus Jakarta Sans", weight: 700, px: 96, tracking: -0.02 }, body: { font: "Inter", weight: 400, px: 48, tracking: 0 } },
      shadow: "0 8px 24px rgba(0,0,0,.4)", easing: { enter: "power3.out", exit: "cubic-bezier(0.4, 0, 1, 1)" }, durationsFrames: { enter: 18, hold: 60 }, staggerFrames: { words: 4 },
    });
    expect(check.plan!.shots[1]).toMatchObject({ frames: [300, 600], heroMove: "the seed grows", reads: "a seed becomes a tree", handoff: "the tree's shadow", motionPlan: [{ token: "enter", fromFrame: 300, toFrame: 318, target: "title" }] });
  });

  test("a plan that is not numeric is untouched by all this", () => {
    const check = validatePlan(samplePlan(), ctx());
    expect(check.plan).not.toHaveProperty("numeric");
    expect(check.plan!.shots[0]).not.toHaveProperty("frames");
  });

  test.each<[string, (p: any) => any, string]>([
    ["one palette colour", (p) => ({ ...p, look: { ...p.look, palette: ["#0B1020"] } }), "at least two hex colours"],
    ["a colour name", (p) => ({ ...p, look: { ...p.look, palette: ["#0B1020", "gold"] } }), "at least two hex colours"],
    ["no typography", (p) => ({ ...p, numeric: { ...p.numeric, typography: {} } }), "numeric.typography: give the font"],
    ["a font that isn't there", (p) => ({ ...p, numeric: { ...p.numeric, typography: { title: { font: "Comic", weight: 700, px: 96, tracking: 0 } } } }), 'the font "Comic" isn\'t available'],
    ["a weight of 450", (p) => ({ ...p, numeric: { ...p.numeric, typography: { title: { font: "Inter", weight: 450, px: 96, tracking: 0 } } } }), "weight is 100"],
    ["a 2 px font", (p) => ({ ...p, numeric: { ...p.numeric, typography: { title: { font: "Inter", weight: 400, px: 2, tracking: 0 } } } }), "px is a number from 8 to 400"],
    ["wild tracking", (p) => ({ ...p, numeric: { ...p.numeric, typography: { title: { font: "Inter", weight: 400, px: 40, tracking: 3 } } } }), "tracking is in em"],
    ["no shadow", (p) => ({ ...p, numeric: { ...p.numeric, shadow: "" } }), "numeric.shadow"],
    ["a made-up ease", (p) => ({ ...p, numeric: { ...p.numeric, easing: { enter: "smooth" } } }), "numeric.easing.enter"],
    ["no easing", (p) => ({ ...p, numeric: { ...p.numeric, easing: {} } }), "numeric.easing: give an easing curve"],
    ["half a frame", (p) => ({ ...p, numeric: { ...p.numeric, durationsFrames: { enter: 1.5 } } }), "numeric.durationsFrames.enter: a whole number"],
    ["a negative stagger", (p) => ({ ...p, numeric: { ...p.numeric, staggerFrames: { words: -1 } } }), "numeric.staggerFrames.words"],
    ["a wrong total", (p) => ({ ...p, numeric: { ...p.numeric, totalFrames: 600 } }), "numeric.totalFrames is 600; 30 s at 30 fps is 900"],
    ["a gap between shots", () => shotsOf((s, i) => (i === 1 ? { ...s, frames: [310, 600] } : s)), "frames start at 310 but the shot before ends at 300"],
    ["frames that end early", () => shotsOf((s, i) => (i === 2 ? { ...s, frames: [600, 590] } : s)), "frames end before they start"],
    ["frames that disagree with the seconds", () => shotsOf((s, i) => (i === 0 ? { ...s, frames: [0, 200] } : s)), "200 frames is 6.7 s but durationSec is 10"],
    ["frames missing", () => shotsOf((s, i) => (i === 0 ? { ...s, frames: undefined } : s)), "frames is [from, to]"],
    ["no hero move", () => shotsOf((s, i) => (i === 0 ? { ...s, heroMove: "" } : s)), "heroMove is required"],
    ["nothing read", () => shotsOf((s, i) => (i === 1 ? { ...s, reads: undefined } : s)), "reads is required"],
    ["no hand-off", () => shotsOf((s, i) => (i === 2 ? { ...s, handoff: " " } : s)), "handoff is required"],
    ["a token not in the spec", () => shotsOf((s, i) => (i === 0 ? { ...s, motionPlan: [{ token: "bounce-big", fromFrame: 0, toFrame: 10 }] } : s)), '"bounce-big", which isn\'t in the spec'],
    ["a motion backwards", () => shotsOf((s, i) => (i === 0 ? { ...s, motionPlan: [{ token: "enter", fromFrame: 10, toFrame: 5 }] } : s)), "fromFrame < toFrame"],
    ["a motion outside its shot", () => shotsOf((s, i) => (i === 0 ? { ...s, motionPlan: [{ token: "enter", fromFrame: 290, toFrame: 310 }] } : s)), "outside the shot's frames 0 to 300"],
    ["no motion at all", () => shotsOf((s, i) => (i === 0 ? { ...s, motionPlan: [] } : s)), "motionPlan needs at least one step"],
  ])("%s is refused", (_name, make, message) => {
    const plan = make(numericPlan());
    expect(errorsOf(plan).join("\n")).toContain(message);
  });

  test("without the motion plan setting the shots carry no motion steps; the frame rate comes from the recipe", () => {
    const check = validatePlan(numericPlan(), numericCtx({ motionPlan: false }));
    expect(check.plan!.shots[0]).not.toHaveProperty("motionPlan");
    expect(validatePlan(numericPlan(), numericCtx({ fps: undefined })).plan!.numeric!.fps).toBe(30);
    expect(errorsOf(numericPlan(), numericCtx({ fps: 24 })).join("\n")).toContain("720 frames");
  });
});
