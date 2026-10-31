import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db";
import { Director } from "../../src/generate/director";
import { DirectorLog } from "../../src/generate/events";
import type { RecipeStep } from "../../src/generate/recipe";
import { STEPS, settingsOf } from "../../src/generate/steps";
import { STORYLINE_NOTE, chosenStoryline, parseStorylines, projectFlags } from "../../src/generate/steps/storylines";
import { Store } from "../../src/store";
import type { GenProject } from "../../src/types";
import { fakeLlm, quickRecipe, samplePlan } from "../helpers";
import { checkObject, STEP_SPECS, STEP_TYPES } from "../../src/generate/steps/schema";
import { notImplemented, type StepContext } from "../../src/generate/steps/types";

describe("step registry", () => {
  test.each(STEP_TYPES.map((t) => [t]))("%s: has a module whose defaults pass its own schema", (type) => {
    const mod = STEPS[type];
    expect(mod).toMatchObject({ type, spec: STEP_SPECS[type] });
    expect(typeof mod.run).toBe("function");
    const errors: string[] = [];
    checkObject(mod.spec.fields, mod.defaults, type, errors);
    expect(errors).toEqual([]);
    expect(mod.spec.gates.length).toBeGreaterThan(0);
  });

  test("settings are the recipe's values over the defaults", () => {
    expect(settingsOf("check", undefined)).toEqual({ warnings: "fix-or-hold", rounds: 3 });
    expect(settingsOf("check", { rounds: 1 })).toEqual({ warnings: "fix-or-hold", rounds: 1 });
    expect(settingsOf("storylines", { count: 5 })).toMatchObject({ count: 5, requireBold: false });
  });

  test("a step type without a module fails loudly", async () => {
    await expect(notImplemented("dance")({} as StepContext)).rejects.toThrow("dance step is not implemented");
  });
});

// ---- storylines and plan ---------------------------------------------------------

const T = "2026-01-01T00:00:00.000Z";
const story = (i: number, extra: Record<string, unknown> = {}) => ({
  title: `Film ${i}`, pitch: "satu kalimat", opening: "benih jatuh", beats: ["hook", "isi", "akhir"], look: "flat", sound: "tenang",
  bold: false, recommended: i === 1, reason: "karena", ...extra,
});

function stepRig(replies: Parameters<typeof fakeLlm>[0], over: Partial<GenProject> = {}) {
  const store = new Store(openDatabase(":memory:"));
  const { llm, requests } = fakeLlm(replies);
  const recipe = quickRecipe();
  store.saveGenProject({
    id: "p1", title: null, brief: "Jelaskan bunga majemuk", format: "9:16", targetSec: 30, language: "id", styleNotes: null, preset: null,
    recipeId: "quick", recipe: JSON.stringify(recipe), ideaId: null, briefFlags: null, narrationScript: null, concept: null, stepIndex: 0,
    stepState: null, narration: 0, storylines: null, pickedStoryline: null, status: "RUNNING", currentPlanId: null, acceptedVersionId: null,
    errorMessage: null, createdAt: T, updatedAt: T, ...over,
  });
  const ctxFor = (use: "storylines" | "plan") => {
    const step = recipe.steps.find((x) => x.use === use) as RecipeStep;
    return {
      project: store.getGenProject("p1")!, version: null, recipe, step, settings: settingsOf(use, step.with), store,
      log: new DirectorLog(store), director: new Director(llm, new DirectorLog(store), "../generator"),
      hyperframes: {} as never, jev: {} as never, exec: {} as never, config: {} as never,
      connected: () => false, catalog: async () => [{ name: "data-chart", tags: ["chart"] }], progress: () => {},
    };
  };
  return { store, requests, ctxFor };
}
const body = (req: { messages: Array<{ content: string; role: string }> }) => JSON.parse(req.messages[1]!.content);

describe("storylines step", () => {
  test("saves the storylines on the project and clears an old pick", async () => {
    const r = stepRig([JSON.stringify({ storylines: [story(1), story(2), story(3)] })], { pickedStoryline: 2 });
    const result = await STEPS.storylines.run(r.ctxFor("storylines"));
    expect(result).toEqual({ status: "done", outputRef: "storylines" });
    const project = r.store.getGenProject("p1")!;
    expect(parseStorylines(project).map((x) => x.title)).toEqual(["Film 1", "Film 2", "Film 3"]);
    expect(project.pickedStoryline).toBeNull();
    expect(body(r.requests[0]!)).toMatchObject({ count: 3, note: null });
  });

  test("a video at or under skipUnderSec goes straight to the plan", async () => {
    const r = stepRig([], { targetSec: 15 });
    expect(await STEPS.storylines.run(r.ctxFor("storylines"))).toMatchObject({ status: "skipped", reason: "a 15 s video goes straight to the plan" });
    expect(r.requests).toHaveLength(0);
    expect(r.store.getGenProject("p1")!.storylines).toBeNull();
  });

  test("the owner's note reaches the director; the chosen storyline is the pick, else the recommended one, else none", async () => {
    const r = stepRig([JSON.stringify({ storylines: [story(1), story(2)] })], { briefFlags: JSON.stringify({ [STORYLINE_NOTE]: "lebih tenang", other: 1 }) });
    await STEPS.storylines.run(r.ctxFor("storylines"));
    expect(body(r.requests[0]!).note).toBe("lebih tenang");
    expect(projectFlags(r.store.getGenProject("p1")!)).toMatchObject({ other: 1 });
    expect(chosenStoryline(r.store.getGenProject("p1")!)!.title).toBe("Film 1");
    r.store.updateGenProject("p1", { pickedStoryline: 1 });
    expect(chosenStoryline(r.store.getGenProject("p1")!)!.title).toBe("Film 2");
    r.store.updateGenProject("p1", { storylines: null });
    expect(chosenStoryline(r.store.getGenProject("p1")!)).toBeNull();
    expect(projectFlags(r.store.getGenProject("p1")!)).toEqual({ [STORYLINE_NOTE]: "lebih tenang", other: 1 });
  });
});

describe("plan step", () => {
  test("writes a new revision from the picked storyline, sets the project's current plan and title", async () => {
    const r = stepRig([JSON.stringify(samplePlan()), JSON.stringify(samplePlan({ title: "Judul dua" }))],
      { storylines: JSON.stringify([story(1), story(2)]), pickedStoryline: 1 });
    const first = await STEPS.plan.run(r.ctxFor("plan"));
    const project = r.store.getGenProject("p1")!;
    expect(first).toEqual({ status: "done", outputRef: project.currentPlanId! });
    expect(project.title).toBe("Bunga berbunga");
    expect(body(r.requests[0]!).storyline.title).toBe("Film 2");
    expect(body(r.requests[0]!)).toMatchObject({ blocks: [{ name: "data-chart", tags: ["chart"] }], fonts: expect.arrayContaining(["Inter"]) });

    await STEPS.plan.run(r.ctxFor("plan"));
    const plans = r.store.genPlansForProject("p1");
    expect(plans.map((x) => [x.revision, x.approvedAt])).toEqual([[2, null], [1, null]]);
    expect(r.store.getGenProject("p1")).toMatchObject({ currentPlanId: plans[0]!.id, title: "Judul dua" });
  });

  test("a short video has no storyline; the plan is cached on the pick, not on revisions", async () => {
    const r = stepRig([JSON.stringify(samplePlan())]);
    await STEPS.plan.run(r.ctxFor("plan"));
    expect(body(r.requests[0]!).storyline).toBeNull();
    const key = STEPS.plan.inputKey!;
    expect(key(r.ctxFor("plan"))).toBe("");
    r.store.updateGenProject("p1", { pickedStoryline: 2 });
    expect(key(r.ctxFor("plan"))).toBe("2");
  });
});
