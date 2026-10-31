import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db";
import type { Finding } from "../../src/generate/findings";
import { mirrorReview, readMirror, reviewMarkdown } from "../../src/generate/mirror";
import { Store } from "../../src/store";
import type { GenVerdict, GenVersion } from "../../src/types";

const T = "2026-01-01T00:00:00.000Z";
const found = (over: Partial<Finding>): Finding => ({ id: "f", severity: "must-fix", shotId: null, code: "x", description: "d", state: "open", source: "check", ...over });
const verdict = (kind: "TECHNICAL" | "CREATIVE", status: GenVerdict["status"], findings: Finding[], judgedBy = "code"): GenVerdict => ({
  id: kind, versionId: "v1", kind, status, findings: JSON.stringify(findings), judgedBy, inputs: null, createdAt: T,
});
const version = (over: Partial<GenVersion> = {}): GenVersion => ({
  id: "v1", projectId: "p1", planId: "pl", number: 2, parentVersionId: null, status: "BUILT", step: null, progress: 100, projectDir: null, renderKind: "draft",
  draftPath: null, stepState: null, hyperframesVersion: "0.8.223", buildMs: 1000, errorMessage: null, createdAt: T, updatedAt: T, ...over,
});

describe("MOTION_REVIEW.md", () => {
  test("both verdicts, the worst findings first, with the shot and the time; the fix follows each", () => {
    const text = reviewMarkdown("Bunga berbunga", version(), [
      verdict("TECHNICAL", "FAIL", [
        found({ severity: "polish", code: "craft", description: "a nit" }),
        found({ severity: "must-fix", shotId: "s02", fromSec: 4.2, toSec: 5, code: "text_below_floor", description: "Text is too small.", suggestedFix: "Make it 40 px." }),
        found({ severity: "should-fix", shotId: "s03", fromSec: 12, code: "sweep_static", description: "Nothing moves." }),
      ]),
      verdict("CREATIVE", "REVIEW", [found({ severity: "should-fix", code: "creative.opening", description: "The opening is a plain title.", source: "creative" })], "jev:jev-1.14.0"),
    ]);
    expect(text).toContain("# Motion review: Bunga berbunga, version 2");
    expect(text).toContain("Draft render with HyperFrames 0.8.223. A FAIL in TECHNICAL blocks the export");
    expect(text).toContain("## TECHNICAL: FAIL");
    expect(text).toContain("## CREATIVE: REVIEW\n\nJudged by jev:jev-1.14.0.");
    const lines = text.split("\n").filter((l) => l.startsWith("- **"));
    expect(lines).toEqual([
      "- **must-fix** (s02, 4.2 to 5 s) `text_below_floor`: Text is too small. Fix: Make it 40 px.",
      "- **should-fix** (s03, 12 s) `sweep_static`: Nothing moves.",
      "- **polish** `craft`: a nit",
      "- **should-fix** `creative.opening`: The opening is a plain title.",
    ]);
  });

  test("warnings kept on purpose are listed with their reasons and don't count as findings", () => {
    const text = reviewMarkdown("T", version({ renderKind: "final", hyperframesVersion: null }), [
      verdict("TECHNICAL", "PASS", [
        found({ severity: "should-fix", shotId: "s01", code: "sweep_static", state: "kept", keptReason: "a still title card" }),
        found({ severity: "should-fix", code: "dead_stretch", state: "kept" }),
      ]),
      verdict("CREATIVE", "PASS", []),
    ]);
    expect(text).toContain("Final render. ");
    expect(text).toContain("Nothing to fix.");
    expect(text).toContain("Kept on purpose:\n- `sweep_static` (s01): a still title card\n- `dead_stretch`: no reason given");
    expect(text).not.toContain("**should-fix**");
  });

  test("a verdict that hasn't run yet says so", () => {
    expect(reviewMarkdown("T", version(), [verdict("TECHNICAL", "PASS", [])])).toContain("## CREATIVE\n\n_Not judged yet._");
  });

  describe("on disk", () => {
    let dir: string;
    let store: Store;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "vc-review-"));
      store = new Store(openDatabase(":memory:"));
      store.saveGenProject({
        id: "p1", title: null, brief: "b", format: "9:16", targetSec: 30, language: "id", styleNotes: null, preset: null, recipeId: "quick", recipe: "{}",
        ideaId: null, briefFlags: null, narrationScript: null, concept: null, stepIndex: 0, stepState: null, narration: 0, storylines: null, pickedStoryline: null,
        status: "BUILT", currentPlanId: null, acceptedVersionId: null, errorMessage: null, createdAt: T, updatedAt: T,
      });
      store.saveGenVersion(version());
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    test("the project gets the review of the version, and it can be read back through the mirrored files", () => {
      store.saveGenVerdict(verdict("TECHNICAL", "PASS", []));
      store.saveGenVerdict(verdict("CREATIVE", "REVIEW", [found({ severity: "polish", code: "creative.pace", description: "Pace drags.", source: "creative" })]));
      expect(mirrorReview({ genDir: dir }, store, "v1")).toBe(true);
      const text = readMirror({ genDir: dir }, "p1", "MOTION_REVIEW.md")!;
      expect(text).toContain("# Motion review: Untitled video, version 2");
      expect(text).toContain("## TECHNICAL: PASS");
      expect(text).toContain("`creative.pace`: Pace drags.");
    });

    test("an unknown version writes nothing", () => {
      expect(mirrorReview({ genDir: dir }, store, "nope")).toBe(false);
      store.deleteGenProject("p1");
      expect(mirrorReview({ genDir: dir }, store, "v1")).toBe(false);
    });
  });
});
