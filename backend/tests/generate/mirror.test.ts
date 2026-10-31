import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db";
import { MIRROR_FILES, mirrorProject, readMirror } from "../../src/generate/mirror";
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
  });
});
