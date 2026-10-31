import { beforeEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db";
import type { Director } from "../../src/generate/director";
import { DirectorLog } from "../../src/generate/events";
import type { Recipe } from "../../src/generate/recipe";
import { parseStates, Runner, RunnerError, type GateDecision } from "../../src/generate/runner";
import { STEPS, type StepModule } from "../../src/generate/steps";
import { STEP_TYPES, type StepType } from "../../src/generate/steps/schema";
import type { RunFn, StepContext, StepResult } from "../../src/generate/steps/types";
import { Store } from "../../src/store";
import type { GenProject } from "../../src/types";
import { quickRecipe } from "../helpers";

const T = "2026-01-01T00:00:00.000Z";
const done: StepResult = { status: "done" };

interface Rig {
  store: Store;
  runner: Runner;
  ran: string[];
  /** Replace what a step type does (defaults to finishing at once). */
  on: (type: StepType, run: RunFn) => void;
  connections: Set<string>;
  gate: { fn: (ctx: StepContext) => Promise<GateDecision> };
  inputKeys: Record<string, string>;
}

function rig(): Rig {
  const store = new Store(openDatabase(":memory:"));
  const ran: string[] = [];
  const impl: Partial<Record<StepType, RunFn>> = {};
  const inputKeys: Record<string, string> = {};
  const steps = Object.fromEntries(STEP_TYPES.map((type): [StepType, StepModule] => [type, {
    ...STEPS[type],
    run: async (ctx) => { ran.push(ctx.step.id ?? ctx.step.use); return (impl[type] ?? (async () => done))(ctx); },
    inputKey: () => inputKeys[type] ?? "",
  }])) as Record<StepType, StepModule>;
  const connections = new Set<string>(["llm"]);
  const gate: Rig["gate"] = { fn: async () => ({ approve: true, reason: "the bold one" }) };
  const runner = new Runner(store, new DirectorLog(store), { connected: (c) => connections.has(c), directorGate: (ctx) => gate.fn(ctx), director: {} as Director, hyperframes: {} as never, jev: {} as never, exec: {} as never, config: {} as never, catalog: async () => [], steps });
  return { store, runner, ran, on: (type, run) => { impl[type] = run; }, connections, gate, inputKeys };
}

function addProject(store: Store, recipe: Recipe = quickRecipe(), over: Partial<GenProject> = {}): GenProject {
  return store.saveGenProject({
    id: "p1", title: null, brief: "brief", format: "9:16", targetSec: 30, language: "id", styleNotes: null, preset: null,
    recipeId: recipe.id, recipe: JSON.stringify(recipe), ideaId: null, briefFlags: null, narrationScript: null, concept: null,
    stepIndex: 0, stepState: null, narration: 0, storylines: null, pickedStoryline: null, status: "WAITING", currentPlanId: null,
    acceptedVersionId: null, errorMessage: null, createdAt: T, updatedAt: T, ...over,
  });
}

const states = (store: Store, id = "p1") => parseStates(store.getGenProject(id)!.stepState);

function addVersion(store: Store, id = "v1", over: Record<string, unknown> = {}) {
  store.saveGenPlan({ id: "pl1", projectId: "p1", revision: 1, plan: "{}", changeRequest: null, changeSummary: null, approvedAt: T, createdAt: T });
  return store.saveGenVersion({
    id, projectId: "p1", planId: "pl1", number: 1, parentVersionId: null, status: "QUEUED", step: null, progress: null, projectDir: null,
    renderKind: "draft", draftPath: null, stepState: null, hyperframesVersion: null, buildMs: null, errorMessage: null,
    createdAt: T, updatedAt: T, ...over,
  });
}

/** A project whose plan is approved, ready to build. */
async function approved(r: Rig) {
  addProject(r.store);
  await r.runner.runProject("p1");
  await r.runner.approveStep("p1", "storylines");
  await r.runner.approveStep("p1", "plan");
}

let r: Rig;
beforeEach(() => { r = rig(); });

describe("runner: project segment", () => {
  test("owner gates stop in turn; approving goes on; the end waits for the build", async () => {
    addProject(r.store);
    let p = await r.runner.runProject("p1");
    expect(p).toMatchObject({ status: "WAITING", stepIndex: 0 });
    expect(r.ran).toEqual(["storylines"]);
    expect(states(r.store).storylines).toMatchObject({ status: "waiting" });

    p = await r.runner.approveStep("p1", "storylines");
    expect(p).toMatchObject({ status: "WAITING", stepIndex: 1 });
    p = await r.runner.approveStep("p1", "plan");
    expect(p).toMatchObject({ status: "WAITING", stepIndex: 2, errorMessage: null });
    expect(r.ran).toEqual(["storylines", "plan"]);
    expect(Object.values(states(r.store)).map((s) => s.status)).toEqual(["done", "done"]);
  });

  test("steps whose input is unchanged are reused; resetting a step redoes it and the ones after", async () => {
    await approved(r);
    r.ran.length = 0;
    await r.runner.runProject("p1");
    expect(r.ran).toEqual([]);

    r.runner.resetFrom("p1", "plan");
    expect(states(r.store).storylines!.status).toBe("done");
    expect(states(r.store).plan).toBeUndefined();
    await r.runner.runProject("p1");
    expect(r.ran).toEqual(["plan"]);
    expect(r.store.getGenProject("p1")).toMatchObject({ status: "WAITING", stepIndex: 1 });
  });

  test("a step whose own input changes reruns, and so does everything after it", async () => {
    await approved(r);
    r.ran.length = 0;
    r.inputKeys.storylines = "new note";
    await r.runner.runProject("p1");
    expect(r.ran).toEqual(["storylines"]);   // waits at its owner gate again
    await r.runner.approveStep("p1", "storylines");
    expect(r.ran).toEqual(["storylines", "plan"]);
  });

  test("a director gate logs its decision and goes on; a declined one waits for the owner", async () => {
    const recipe = quickRecipe();
    recipe.steps[1]!.gate = "director";
    addProject(r.store, recipe);
    await r.runner.runProject("p1");
    await r.runner.approveStep("p1", "storylines");
    expect(states(r.store).plan).toMatchObject({ status: "done", reason: "the bold one" });
    expect(r.store.getGenProject("p1")!.stepIndex).toBe(2);

    r.runner.resetFrom("p1", "plan");
    r.gate.fn = async () => ({ approve: false, reason: "not sure" });
    const p = await r.runner.runProject("p1");
    expect(p.status).toBe("WAITING");
    expect(states(r.store).plan).toMatchObject({ status: "waiting", reason: "not sure" });
  });

  test("steps skip themselves or for a missing connection; a waiting step stops the run", async () => {
    const recipe = quickRecipe();
    recipe.steps.splice(1, 0, { use: "images", when: "connection:image" }, { use: "music" });
    recipe.steps[0]!.gate = "none";
    recipe.steps[3]!.gate = "none";
    addProject(r.store, recipe);
    r.on("music", async () => ({ status: "skipped", reason: "no track" }));
    const p = await r.runner.runProject("p1");
    expect(states(r.store)).toMatchObject({
      storylines: { status: "done" }, images: { status: "skipped", reason: "connection image isn't set up" },
      music: { status: "skipped", reason: "no track" }, plan: { status: "done" },
    });
    expect(p.stepIndex).toBe(4);

    r.runner.resetFrom("p1", "images");
    r.connections.add("image");
    r.on("images", async () => ({ status: "waiting", reason: "pick an image", outputRef: "x" }));
    await r.runner.runProject("p1");
    expect(states(r.store).images).toMatchObject({ status: "waiting", reason: "pick an image", outputRef: "x" });
    // still waiting on a second run: the step isn't run again
    r.ran.length = 0;
    expect((await r.runner.runProject("p1")).stepIndex).toBe(1);
    expect(r.ran).toEqual([]);
  });

  test("a failing step keeps the earlier work; retry resumes at the failed step", async () => {
    addProject(r.store);
    await r.runner.runProject("p1");
    r.on("plan", async () => { throw new Error("director offline"); });
    const p = await r.runner.approveStep("p1", "storylines");
    expect(p).toMatchObject({ status: "FAILED", errorMessage: "director offline", stepIndex: 1 });
    expect(states(r.store)).toMatchObject({ storylines: { status: "done" }, plan: { status: "failed", reason: "director offline" } });

    r.on("plan", async () => done);
    r.ran.length = 0;
    const again = await r.runner.retry("p1");
    expect(r.ran).toEqual(["plan"]);
    expect(again).toMatchObject({ status: "WAITING", errorMessage: null });
  });

  test("approval needs a waiting step; unknown ids and projects are refused", async () => {
    addProject(r.store);
    await expect(r.runner.approveStep("p1", "plan")).rejects.toThrow("isn't waiting for approval");
    expect(() => r.runner.resetFrom("p1", "nope")).toThrow(RunnerError);
    await expect(r.runner.runProject("nope")).rejects.toThrow("Project not found");
    await expect(r.runner.runBuild("nope")).rejects.toThrow("Version not found");
  });
});

describe("runner: build segment", () => {
  test("nothing is built before the plan is approved", async () => {
    addProject(r.store);
    addVersion(r.store);
    await expect(r.runner.runBuild("v1")).rejects.toThrow("plan isn't approved");
  });

  test("author to creative run in order (not the export) and the version and project end BUILT", async () => {
    await approved(r);
    addVersion(r.store);
    r.ran.length = 0;
    const v = await r.runner.runBuild("v1");
    expect(r.ran).toEqual(["author", "check", "render", "technical", "creative"]);
    expect(v).toMatchObject({ status: "BUILT", progress: 100, step: null, errorMessage: null });
    expect(v.buildMs).toBeGreaterThanOrEqual(0);
    expect(r.store.getGenProject("p1")!.status).toBe("BUILT");
    expect(Object.keys(parseStates(v.stepState))).toEqual(["author", "check", "render", "technical", "creative"]);

    r.ran.length = 0;
    await r.runner.runBuild("v1");
    expect(r.ran).toEqual([]);   // all cached
  });

  test("steps report progress on their version", async () => {
    await approved(r);
    addVersion(r.store);
    let seen = -1;
    r.on("render", async (ctx) => { ctx.progress(42.4); seen = r.store.getGenVersion("v1")!.progress!; ctx.progress(250); return done; });
    await r.runner.runBuild("v1");
    expect(seen).toBe(42);
  });

  test("a failing step fails the version and the project with the reason, and a retry resumes there", async () => {
    await approved(r);
    addVersion(r.store);
    r.on("render", async () => { throw new Error("chrome crashed"); });
    const v = await r.runner.runBuild("v1");
    expect(v).toMatchObject({ status: "FAILED", errorMessage: "chrome crashed" });
    expect(r.store.getGenProject("p1")).toMatchObject({ status: "FAILED", errorMessage: "chrome crashed" });
    expect(parseStates(v.stepState).check!.status).toBe("done");

    r.on("render", async () => done);
    r.ran.length = 0;
    expect((await r.runner.runBuild("v1")).status).toBe("BUILT");
    expect(r.ran).toEqual(["render", "technical", "creative"]);
  });

  test("cancelling ends the version CANCELLED and puts the project back", async () => {
    await approved(r);
    addVersion(r.store);
    const ctl = new AbortController();
    r.on("render", async () => { ctl.abort(); throw new Error("killed"); });
    const v = await r.runner.runBuild("v1", ctl.signal);
    expect(v).toMatchObject({ status: "CANCELLED", errorMessage: null });
    expect(r.store.getGenProject("p1")!.status).toBe("WAITING");

    r.store.saveGenVersion({ ...addVersion(r.store, "v0", { number: 0, status: "BUILT" }) });
    const ctl2 = new AbortController();
    r.on("render", async () => { ctl2.abort(); throw new Error("killed"); });
    await r.runner.runBuild("v1", ctl2.signal);
    expect(r.store.getGenProject("p1")!.status).toBe("BUILT");
  });

  test("an unattended run goes on to the export; one that waits for the owner leaves the version BUILT", async () => {
    const recipe = quickRecipe();
    recipe.steps[7]!.gate = "owner";
    addProject(r.store, recipe);
    await r.runner.runProject("p1");
    await r.runner.approveStep("p1", "storylines");
    await r.runner.approveStep("p1", "plan");
    addVersion(r.store);
    const v = await r.runner.runBuild("v1", undefined, { withExport: true });
    expect(v).toMatchObject({ status: "BUILT", progress: 100 });
    expect(parseStates(v.stepState).export).toMatchObject({ status: "waiting" });
    expect(r.ran.at(-1)).toBe("export");
  });

  test("a restart fails what was in flight and keeps its work", () => {
    addProject(r.store, quickRecipe(), { status: "RUNNING" });
    addProject(r.store, quickRecipe(), { id: "p2", status: "WAITING" });
    addVersion(r.store, "v1", { status: "BUILDING" });
    addVersion(r.store, "v2", { status: "QUEUED", number: 2 });
    expect(r.runner.recoverInterrupted()).toEqual({ projects: 1, versions: 1 });
    expect(r.store.getGenProject("p1")).toMatchObject({ status: "FAILED", errorMessage: "interrupted" });
    expect(r.store.getGenProject("p2")!.status).toBe("WAITING");
    expect(r.store.getGenVersion("v1")).toMatchObject({ status: "FAILED", errorMessage: "interrupted" });
    expect(r.store.getGenVersion("v2")!.status).toBe("QUEUED");
  });
});
