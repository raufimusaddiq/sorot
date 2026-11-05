import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db";
import { MIRROR_FILES, mirrorProject, motionPlanMd, readMirror } from "../../src/generate/mirror";
import { validatePlan } from "../../src/generate/planSchema";
import { Store } from "../../src/store";
import { samplePlan } from "../helpers";

const T = "2026-01-01T00:00:00.000Z";
let dir: string;
let store: Store;
let cfg: { genDir: string };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vc-mirror-"));
  cfg = { genDir: dir };
  store = new Store(openDatabase(":memory:"));
  store.saveGenProject({
    id: "p1", title: "Bunga", brief: "Jelaskan bunga majemuk", format: "9:16", targetSec: 30, language: "id", styleNotes: "tenang", preset: null,
    recipeId: "quick", recipe: "{}", ideaId: null, briefFlags: null, narrationScript: null, concept: null, stepIndex: 0, stepState: null,
    narration: 0, storylines: null, pickedStoryline: null, status: "RUNNING", currentPlanId: null, acceptedVersionId: null, errorMessage: null,
    createdAt: T, updatedAt: T,
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const story = (title: string, extra: Record<string, unknown> = {}) => ({
  title, pitch: "satu kalimat", opening: "benih jatuh", beats: ["hook", "akhir"], look: "flat", sound: "tenang", bold: false, recommended: false, reason: "", ...extra,
});

describe("mirrored files", () => {
  test("a new project has only BRIEF.md, with the brief and its choices", () => {
    expect(mirrorProject(cfg, store, "p1")).toEqual(["BRIEF.md"]);
    const text = readMirror(cfg, "p1", "BRIEF.md")!;
    expect(text).toContain("# Bunga");
    expect(text).toContain("Jelaskan bunga majemuk");
    expect(text).toContain("- Format: 9:16");
    expect(text).toContain("- Style notes: tenang");
    expect(existsSync(join(dir, "p1", "STORYLINES.md"))).toBe(false);
  });

  test("storylines mark the recommended, bold and picked ones and the owner's note", () => {
    store.updateGenProject("p1", { title: null, styleNotes: null, pickedStoryline: 1, storylines: JSON.stringify([
      story("Film satu", { recommended: true, reason: "paling jelas" }), story("Film dua", { bold: true, note: "lebih tenang" }),
    ]) });
    expect(mirrorProject(cfg, store, "p1")).toEqual(["BRIEF.md", "STORYLINES.md"]);
    expect(readMirror(cfg, "p1", "BRIEF.md")).toContain("# Untitled video");
    const text = readMirror(cfg, "p1", "STORYLINES.md")!;
    expect(text).toContain("## 1. Film satu (recommended)");
    expect(text).toContain("- Why: paling jelas");
    expect(text).toContain("## 2. Film dua (bold) ← picked");
    expect(text).toContain("- Owner's note: lebih tenang");
  });

  test("SPEC.md lists the current plan and whether it is approved", () => {
    const plan = validatePlan(samplePlan({ assumptions: ["angka 5 ditambah"] }), {
      brief: "x", targetSec: 30, format: "9:16", language: "id", fonts: ["Plus Jakarta Sans"], imageConnected: false, narration: false,
    }).plan!;
    plan.shots[0]!.narration = "kata pembuka";
    plan.shots[1]!.hold = true;
    store.saveGenPlan({ id: "pl1", projectId: "p1", revision: 2, plan: JSON.stringify(plan), changeRequest: null, changeSummary: null, approvedAt: null, createdAt: T });
    store.updateGenProject("p1", { currentPlanId: "pl1" });
    mirrorProject(cfg, store, "p1");
    let spec = readMirror(cfg, "p1", "SPEC.md")!;
    expect(spec).toContain("_Plan revision 2, not approved yet._");
    expect(spec).toContain("**Message:** Bunga majemuk membuat uang tumbuh sendiri");
    expect(spec).toContain("1. **s01** · hook · 10 s");
    expect(spec).toContain("2. **s02** · beat · 10 s · hold");
    expect(spec).toContain("   - title: Uang tumbuh sendiri");
    expect(spec).toContain("   - Narration: kata pembuka");
    expect(spec).toContain("- angka 5 ditambah");
    store.updateGenPlan("pl1", { approvedAt: T });
    mirrorProject(cfg, store, "p1");
    spec = readMirror(cfg, "p1", "SPEC.md")!;
    expect(spec).toContain("_Plan revision 2, approved._");
  });

  test("a missing project writes nothing; only known names that exist can be read", () => {
    expect(mirrorProject(cfg, store, "none")).toEqual([]);
    expect(readMirror(cfg, "p1", "BRIEF.md")).toBeNull();
    mirrorProject(cfg, store, "p1");
    expect(readMirror(cfg, "p1", "BRIEF.md")).not.toBeNull();
    expect(readMirror(cfg, "p1", "MOTION_REVIEW.md")).toBeNull();
    expect(readMirror(cfg, "p1", "../p1/BRIEF.md")).toBeNull();
    expect(MIRROR_FILES).toContain("SPEC.md");
    // the voice step's own file, naming the engine and voice, is one of them
    writeFileSync(join(cfg.genDir, "p1", "voice.json"), '{"engine":"openai"}');
    expect(readMirror(cfg, "p1", "voice.json")).toContain("openai");
  });
});

describe("MOTION_PLAN.md", () => {
  const numeric = () => {
    const base = samplePlan();
    const raw = {
      ...base,
      numeric: { typography: { title: { font: "Plus Jakarta Sans", weight: 700, px: 96, tracking: 0 } }, shadow: "none", easing: { enter: "power3.out" }, durationsFrames: { enter: 18 }, staggerFrames: { words: 4 } },
      shots: base.shots.map((s: any, i: number) => ({ ...s, frames: [i * 300, i * 300 + 300], heroMove: "seed grows", reads: "a seed", handoff: "its shadow", motionPlan: i === 0 ? [{ token: "enter", fromFrame: 0, toFrame: 18, target: "title" }] : [{ token: "words", fromFrame: i * 300, toFrame: i * 300 + 12 }] })),
    };
    return validatePlan(raw, { brief: "x", targetSec: 30, format: "9:16", language: "id", fonts: ["Plus Jakarta Sans"], imageConnected: false, narration: false, numeric: true, motionPlan: true, fps: 30 }).plan!;
  };

  test("a numeric plan is written out: the spec, then each shot's frames, hero move, hand-off and moves", () => {
    const text = motionPlanMd(numeric());
    expect(text).toContain("900 frames at 30 fps (30 s)");
    expect(text).toContain("- title: Plus Jakarta Sans 700, 96 px, tracking 0 em");
    expect(text).toContain("- enter: power3.out");
    expect(text).toContain("### s02 · frames 300 to 600");
    expect(text).toContain("- Hero move: seed grows");
    expect(text).toContain("  - frames 0 to 18: enter on title");
    expect(text).toContain("  - frames 300 to 312: words");
  });

  test("a plan without a spec has none; the project mirror writes the file only for a numeric plan", () => {
    expect(motionPlanMd(validatePlan(samplePlan(), { brief: "x", targetSec: 30, format: "9:16", language: "id", fonts: ["Plus Jakarta Sans"], imageConnected: false, narration: false }).plan!)).toBe("");
    const plain = validatePlan(samplePlan(), { brief: "x", targetSec: 30, format: "9:16", language: "id", fonts: ["Plus Jakarta Sans"], imageConnected: false, narration: false }).plan!;
    store.saveGenPlan({ id: "pl1", projectId: "p1", revision: 1, plan: JSON.stringify(plain), changeRequest: null, changeSummary: null, approvedAt: T, createdAt: T });
    store.updateGenProject("p1", { currentPlanId: "pl1" });
    expect(mirrorProject(cfg, store, "p1")).toEqual(["BRIEF.md", "SPEC.md"]);
    store.saveGenPlan({ id: "pl2", projectId: "p1", revision: 2, plan: JSON.stringify(numeric()), changeRequest: null, changeSummary: null, approvedAt: T, createdAt: T });
    store.updateGenProject("p1", { currentPlanId: "pl2" });
    expect(mirrorProject(cfg, store, "p1")).toEqual(["BRIEF.md", "SPEC.md", "MOTION_PLAN.md"]);
    expect(readMirror(cfg, "p1", "MOTION_PLAN.md")).toContain("# Motion plan: Bunga berbunga");
  });
});
