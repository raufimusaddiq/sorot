import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db";
import { EVENT_RESPONSE_MAX, Store } from "../../src/store";
import type { GenEvent, GenProject, GenVerdict, GenVersion } from "../../src/types";

const T = "2026-01-01T00:00:00.000Z";
const project = (over: Partial<GenProject> = {}): GenProject => ({
  id: "p1", title: null, brief: "brief", format: "9:16", targetSec: 30, language: "id", styleNotes: null, preset: null,
  recipeId: "quick", recipe: "{}", ideaId: null, briefFlags: null, narrationScript: null, concept: null, stepIndex: 0,
  stepState: null, narration: 0, storylines: null, pickedStoryline: null, status: "RUNNING", currentPlanId: null,
  acceptedVersionId: null, errorMessage: null, createdAt: T, updatedAt: T, ...over,
});
const version = (over: Partial<GenVersion> = {}): GenVersion => ({
  id: "v1", projectId: "p1", planId: "pl1", number: 1, parentVersionId: null, status: "QUEUED", step: null, progress: null,
  projectDir: null, renderKind: "draft", draftPath: null, stepState: null, hyperframesVersion: null, buildMs: null,
  errorMessage: null, createdAt: T, updatedAt: T, ...over,
});
const verdict = (over: Partial<GenVerdict> = {}): GenVerdict => ({
  id: "d1", versionId: "v1", kind: "TECHNICAL", status: "PASS", findings: "[]", judgedBy: "code", inputs: null, createdAt: T, ...over,
});
const event = (over: Partial<GenEvent> = {}): GenEvent => ({
  id: "e1", projectId: "p1", versionId: null, kind: "plan", model: "m", request: "r", response: "ok", ok: 1, ms: 5, tokens: 9,
  createdAt: T, ...over,
});

const make = () => new Store(openDatabase(":memory:"));

describe("generate store", () => {
  test("a project round-trips with camelCase keys and updates bump updatedAt", () => {
    const s = make();
    s.saveGenProject(project());
    expect(s.getGenProject("p1")).toMatchObject({ id: "p1", targetSec: 30, recipeId: "quick", status: "RUNNING" });
    s.updateGenProject("p1", { status: "WAITING", title: "T" });
    expect(s.getGenProject("p1")).toMatchObject({ status: "WAITING", title: "T" });
    expect(s.getGenProject("p1")!.updatedAt).not.toBe(T);
    s.saveGenProject(project({ id: "p2", createdAt: "2027-01-01" }));
    expect(s.listGenProjects().map((p) => p.id)).toEqual(["p2", "p1"]);
    expect(s.getGenProject("none")).toBeNull();
  });

  test("plans list newest revision first; versions newest number first", () => {
    const s = make();
    for (const revision of [1, 2]) {
      s.saveGenPlan({ id: `pl${revision}`, projectId: "p1", revision, plan: "{}", changeRequest: null, changeSummary: null, approvedAt: null, createdAt: T });
      s.saveGenVersion(version({ id: `v${revision}`, number: revision }));
    }
    s.updateGenPlan("pl2", { approvedAt: T });
    expect(s.genPlansForProject("p1").map((p) => p.revision)).toEqual([2, 1]);
    expect(s.getGenPlan("pl2")!.approvedAt).toBe(T);
    expect(s.genVersionsForProject("p1").map((v) => v.number)).toEqual([2, 1]);
    s.updateGenVersion("v1", { status: "BUILDING" });
    expect(s.genVersionsByStatus("BUILDING").map((v) => v.id)).toEqual(["v1"]);
    expect(s.getGenVersion("v1")!.status).toBe("BUILDING");
  });

  test("judging a kind again replaces its verdict", () => {
    const s = make();
    s.saveGenVerdict(verdict());
    s.saveGenVerdict(verdict({ id: "d2", kind: "CREATIVE", status: "REVIEW" }));
    s.saveGenVerdict(verdict({ id: "d3", status: "FAIL" }));
    expect(s.genVerdictsForVersion("v1").map((v) => [v.kind, v.status])).toEqual([["TECHNICAL", "FAIL"], ["CREATIVE", "REVIEW"]]);
  });

  test("the director log keeps the newest first and cuts long answers", () => {
    const s = make();
    s.saveGenEvent(event({ response: "x".repeat(EVENT_RESPONSE_MAX + 50) }));
    s.saveGenEvent(event({ id: "e2", response: null, ok: 0 }));
    const events = s.genEventsForProject("p1");
    expect(events.map((e) => e.id)).toEqual(["e2", "e1"]);
    expect(events[1]!.response!.length).toBe(EVENT_RESPONSE_MAX);
    expect(s.genEventsForProject("p1", 1)).toHaveLength(1);
  });

  test("assets, exports, facts, ideas and recipes save, update and delete", () => {
    const s = make();
    s.saveGenAsset({ id: "a1", projectId: "p1", kind: "logo", origin: "upload", path: "assets/l.png", shotId: null, promptHash: null, meta: null, createdAt: T });
    expect(s.genAssetsForProject("p1")).toHaveLength(1);
    s.deleteGenAsset("a1");
    expect(s.getGenAsset("a1")).toBeNull();

    s.saveGenExport({ id: "x1", projectId: "p1", versionId: "v1", path: "e.mp4", format: "9:16", durationSec: 30, title: null, description: null, createdAt: T });
    expect(s.getGenExport("x1")!.durationSec).toBe(30);
    expect(s.genExportsForProject("p1")).toHaveLength(1);
    expect(s.listGenExports()).toHaveLength(1);

    s.saveGenFact({ id: "f1", projectId: "p1", ideaId: null, claim: "c", value: "5%", sourceUrl: "u", status: "unverified", originalValue: null, evidence: null, addedBy: "owner", createdAt: T, updatedAt: T });
    s.updateGenFact("f1", { status: "corrected", originalValue: "6%" });
    expect(s.genFactsForProject("p1")[0]).toMatchObject({ status: "corrected", originalValue: "6%" });
    s.deleteGenFact("f1");
    expect(s.getGenFact("f1")).toBeNull();

    s.saveGenIdea({ id: "i1", slug: "idea-1", brief: "b", flags: null, status: "new", projectId: null, createdAt: T, updatedAt: T });
    s.updateGenIdea("i1", { status: "used" });
    expect(s.listGenIdeas().map((i) => i.status)).toEqual(["used"]);
    s.deleteGenIdea("i1");
    expect(s.getGenIdea("i1")).toBeNull();

    s.saveGenRecipe({ id: "mine", name: "Mine", version: 1, builtIn: 0, description: null, recipe: "{}", ideaCursor: null, createdAt: T, updatedAt: T });
    s.saveGenRecipe({ id: "quick", name: "Quick", version: 1, builtIn: 1, description: null, recipe: "{}", ideaCursor: null, createdAt: T, updatedAt: T });
    s.updateGenRecipe("mine", { version: 2 });
    expect(s.listGenRecipes().map((r) => r.id)).toEqual(["quick", "mine"]);
    expect(s.getGenRecipe("mine")!.version).toBe(2);
    s.deleteGenRecipe("mine");
    expect(s.getGenRecipe("mine")).toBeNull();
  });

  test("deleting a project removes everything that belongs to it and nothing else", () => {
    const s = make();
    for (const id of ["p1", "p2"]) {
      s.saveGenProject(project({ id }));
      s.saveGenPlan({ id: `pl-${id}`, projectId: id, revision: 1, plan: "{}", changeRequest: null, changeSummary: null, approvedAt: null, createdAt: T });
      s.saveGenVersion(version({ id: `v-${id}`, projectId: id, planId: `pl-${id}` }));
      s.saveGenVerdict(verdict({ id: `d-${id}`, versionId: `v-${id}` }));
      s.saveGenEvent(event({ id: `e-${id}`, projectId: id }));
    }
    s.deleteGenProject("p1");
    expect(s.getGenProject("p1")).toBeNull();
    expect(s.genPlansForProject("p1")).toEqual([]);
    expect(s.genVerdictsForVersion("v-p1")).toEqual([]);
    expect(s.genEventsForProject("p1")).toEqual([]);
    expect(s.genVersionsForProject("p2")).toHaveLength(1);
    expect(s.genVerdictsForVersion("v-p2")).toHaveLength(1);
  });
});
