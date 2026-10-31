import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { HttpError } from "../../src/http";
import { parseStates } from "../../src/generate/runner";
import { makeEnv, quickRecipe, samplePlan, scriptLlm, userPayload, type TestEnv } from "../helpers";

const LLM = { llmBaseUrl: "http://llm/v1", llmModel: "m" };
const story = (i: number, extra: Record<string, unknown> = {}) => ({
  title: `Film ${i}`, pitch: "satu kalimat", opening: "benih jatuh", beats: ["hook", "isi", "akhir"], look: "flat", sound: "tenang",
  bold: false, recommended: i === 1, reason: "karena", ...extra,
});
const STORIES = JSON.stringify({ storylines: [story(1), story(2), story(3)] });
const PLAN = JSON.stringify(samplePlan());
const editedPlan = (title: string) => ({ ...samplePlan(), shots: samplePlan().shots.map((s: any, i: number) => (i === 1 ? { ...s, text: [{ role: "title", value: title }] } : s)) });

let env: TestEnv;
afterEach(() => env?.cleanup());

const gen = () => env.app.generate;
const store = () => env.app.store;
const project = (id: string) => store().getGenProject(id)!;
const failure = async (fn: () => unknown) => (await Promise.resolve().then(fn).catch((e) => e)) as HttpError;

async function created(replies: Parameters<typeof scriptLlm>[1], input: Record<string, unknown> = {}) {
  env = makeEnv(LLM);
  env.app.start();
  const llm = scriptLlm(env, replies);
  const p = await gen().createProject({ brief: "Jelaskan bunga majemuk", ...input });
  await gen().whenIdle();
  return { id: p.id, llm };
}

describe("brief to approved plan", () => {
  test("storylines, a pick, direct edits, a revision, then the owner's approval; every revision is kept", async () => {
    const { id, llm } = await created([STORIES, PLAN, JSON.stringify({ plan: editedPlan("Judul revisi"), changeSummary: "Judul shot 2 diganti" })]);

    // after create: three storylines, waiting at the owner's gate
    let p = project(id);
    expect(p).toMatchObject({ status: "WAITING", stepIndex: 0, targetSec: 30, format: "9:16", language: "id", recipeId: "quick" });
    expect(JSON.parse(p.storylines!)).toHaveLength(3);
    expect(parseStates(p.stepState).storylines).toMatchObject({ status: "waiting" });
    expect(p.currentPlanId).toBeNull();
    expect(JSON.parse(p.recipe).id).toBe("quick");

    // the pick (with a note) writes the plan from that storyline
    gen().pick(id, 1, "lebih tenang");
    await gen().whenIdle();
    p = project(id);
    expect(p).toMatchObject({ status: "WAITING", stepIndex: 1, pickedStoryline: 1, title: "Bunga berbunga" });
    expect(JSON.parse(p.storylines!)[1].note).toBe("lebih tenang");
    expect(userPayload(llm.requests[1]!).storyline).toMatchObject({ title: "Film 2", note: "lebih tenang" });
    expect(store().getGenPlan(p.currentPlanId!)!.approvedAt).toBeNull();

    // nothing may be built yet (FR-006)
    expect((await failure(() => gen().assertCanBuild(id))).status).toBe(409);

    // a direct edit and a plain-words revision each make a new revision, still waiting for approval
    const first = p.currentPlanId!;
    const edit = await gen().putPlan(id, editedPlan("Judul tangan"));
    expect(edit).toMatchObject({ revision: 2, changeSummary: "Edited by the owner", approvedAt: null });
    const revised = await gen().revisePlan(id, "ubah judul shot 2");
    expect(revised.changeSummary).toBe("Judul shot 2 diganti");
    expect(revised.plan).toMatchObject({ revision: 3, changeRequest: "ubah judul shot 2" });
    expect(store().genPlansForProject(id).map((x) => x.revision)).toEqual([3, 2, 1]);
    expect(project(id).currentPlanId).toBe(revised.plan.id);
    expect(parseStates(project(id).stepState).plan).toMatchObject({ status: "waiting" });

    // approving an old revision is refused; the current one goes through
    expect((await failure(() => gen().approvePlan(id, first))).status).toBe(409);
    gen().approvePlan(id, revised.plan.id);
    await gen().whenIdle();
    p = project(id);
    expect(p).toMatchObject({ status: "WAITING", stepIndex: 2 });   // ready to build: the next step is author
    expect(store().getGenPlan(revised.plan.id)!.approvedAt).not.toBeNull();
    expect(store().getGenPlan(first)!.approvedAt).toBeNull();
    expect(gen().assertCanBuild(id).id).toBe(revised.plan.id);

    // the director log and the mirrored files
    expect(gen().events(id).map((e) => e.kind).reverse()).toEqual(["storylines", "plan", "revise"]);
    const dir = `${env.config.genDir}/${id}`;
    expect(readFileSync(`${dir}/SPEC.md`, "utf-8")).toContain("approved");
    expect(readFileSync(`${dir}/SPEC.md`, "utf-8")).toContain("Judul revisi");
    expect(gen().file(id, "STORYLINES.md")).toContain("← picked");
    expect(gen().file(id, "BRIEF.md")).toContain("Jelaskan bunga majemuk");
  });

  test("a short video skips storylines and goes straight to the plan", async () => {
    const short = JSON.stringify(samplePlan({ shots: samplePlan().shots.map((x: any) => ({ ...x, durationSec: 4 })) }));
    const { id, llm } = await created([short], { targetSec: 12 });
    expect(llm.requests).toHaveLength(1);
    expect(userPayload(llm.requests[0]!).storyline).toBeNull();
    expect(parseStates(project(id).stepState).storylines).toMatchObject({ status: "skipped" });
    expect(project(id)).toMatchObject({ status: "WAITING", stepIndex: 1, storylines: null });
    expect(project(id).currentPlanId).not.toBeNull();
  });

  test("a new set of storylines (with a note) replaces the old ones and forgets the plan", async () => {
    const { id, llm } = await created([STORIES, STORIES, PLAN]);
    gen().newStorylines(id, "lebih berani");
    await gen().whenIdle();
    expect(userPayload(llm.requests[1]!).note).toBe("lebih berani");
    expect(parseStates(project(id).stepState).storylines!.status).toBe("waiting");
    expect(project(id).briefFlags).toContain("lebih berani");

    gen().pick(id, 0);
    await gen().whenIdle();
    expect(project(id).currentPlanId).not.toBeNull();

    // picking again after the plan exists writes the plan again
    scriptLlm(env, [PLAN]);
    gen().pick(id, 2);
    await gen().whenIdle();
    expect(store().genPlansForProject(id)).toHaveLength(2);
    expect(project(id).pickedStoryline).toBe(2);
    gen().newStorylines(id);   // no note clears the earlier one
    expect(project(id).briefFlags).toBeNull();
    await gen().whenIdle().catch(() => null);
  });
});

describe("the director's gates", () => {
  const auto = () => {
    const r = quickRecipe();
    r.id = "auto";
    r.steps.find((s) => s.use === "storylines")!.gate = "director";
    r.steps.find((s) => s.use === "plan")!.gate = "director";
    return r;
  };
  const addAuto = () => store().saveGenRecipe({ id: "auto", name: "Auto", version: 1, builtIn: 0, description: null, recipe: JSON.stringify(auto()), ideaCursor: null, createdAt: "t", updatedAt: "t" });
  const decision = (d: Record<string, unknown>) => JSON.stringify(d);

  test("the director picks a storyline and approves the plan, and its reasons are logged", async () => {
    env = makeEnv(LLM);
    env.app.start();
    addAuto();
    scriptLlm(env, [STORIES, decision({ decision: "pick", index: 2, reason: "paling jelas" }), PLAN, decision({ decision: "approve", reason: "siap dibangun" })]);
    const { id } = await gen().createProject({ brief: "Jelaskan bunga majemuk", recipeId: "auto" });
    await gen().whenIdle();
    const p = project(id);
    expect(p).toMatchObject({ status: "WAITING", stepIndex: 2, pickedStoryline: 2 });
    expect(parseStates(p.stepState)).toMatchObject({ storylines: { status: "done", reason: "paling jelas" }, plan: { status: "done", reason: "siap dibangun" } });
    expect(gen().assertCanBuild(id).approvedAt).not.toBeNull();
  });

  test("a plan the director rejects waits for the owner, who can still approve it", async () => {
    env = makeEnv(LLM);
    env.app.start();
    addAuto();
    scriptLlm(env, [STORIES, decision({ decision: "pick", index: 0, reason: "x" }), PLAN, decision({ decision: "reject", reason: "terlalu ramai" })]);
    const { id } = await gen().createProject({ brief: "Jelaskan bunga majemuk", recipeId: "auto" });
    await gen().whenIdle();
    expect(parseStates(project(id).stepState).plan).toMatchObject({ status: "waiting", reason: "terlalu ramai" });
    expect((await failure(() => gen().assertCanBuild(id))).status).toBe(409);
    gen().approvePlan(id, project(id).currentPlanId);
    await gen().whenIdle();
    expect(project(id).stepIndex).toBe(2);
  });

  test("other steps with a director gate go on without a decision", async () => {
    env = makeEnv(LLM);
    const decide = (gen() as unknown as { decide: (p: unknown, s: unknown) => Promise<unknown> }).decide.bind(gen());
    store().saveGenProject({ ...JSON.parse(JSON.stringify({})), id: "p", title: null, brief: "b", format: "9:16", targetSec: 30, language: "id", styleNotes: null, preset: null, recipeId: "quick", recipe: "{}", ideaId: null, briefFlags: null, narrationScript: null, concept: null, stepIndex: 0, stepState: null, narration: 0, storylines: null, pickedStoryline: null, status: "RUNNING", currentPlanId: null, acceptedVersionId: null, errorMessage: null, createdAt: "t", updatedAt: "t" });
    expect(await decide({ id: "p" }, { use: "script" })).toEqual({ approve: true, reason: "no director decision is needed for this step" });
  });
});

describe("failures", () => {
  test("a failed director call keeps the project; retry runs the failed step again and keeps finished ones", async () => {
    const { id, llm } = await created([STORIES, new Error("quota exceeded")]);
    gen().pick(id, 0);
    await gen().whenIdle();
    expect(project(id)).toMatchObject({ status: "FAILED", stepIndex: 1 });
    expect(project(id).errorMessage).toContain("quota exceeded");
    expect(parseStates(project(id).stepState)).toMatchObject({ storylines: { status: "done" }, plan: { status: "failed" } });
    expect(JSON.parse(project(id).storylines!)).toHaveLength(3);

    const again = scriptLlm(env, [PLAN]);
    gen().retry(id);
    await gen().whenIdle();
    expect(again.requests).toHaveLength(1);
    expect(project(id)).toMatchObject({ status: "WAITING", errorMessage: null });
    expect(project(id).currentPlanId).not.toBeNull();
    expect(llm.requests).toHaveLength(2);
  });

  test("retry is only for failed projects; busy projects are left alone", async () => {
    const { id } = await created([STORIES]);
    expect((await failure(() => gen().retry(id))).status).toBe(409);
    env.app.store.updateGenProject(id, { status: "BUILDING" });
    for (const act of [() => gen().pick(id, 0), () => gen().newStorylines(id), () => gen().deleteProject(id)]) {
      expect((await failure(act)).message).toContain("still working");
    }
  });

  test("an unexpected error in the background marks the project failed", async () => {
    const { id } = await created([STORIES]);
    (gen().runner as unknown as { runProject: () => Promise<never> }).runProject = async () => { throw new Error("disk full"); };
    store().updateGenProject(id, { status: "FAILED" });
    gen().retry(id);
    await gen().whenIdle();
    expect(project(id)).toMatchObject({ status: "FAILED", errorMessage: "disk full" });
  });
});

describe("refusals", () => {
  test.each<[string, Record<string, unknown>, number, string]>([
    ["no brief", { brief: "  " }, 400, "brief required"],
    ["a brief over 2,000 characters", { brief: "x".repeat(2001) }, 400, "at most 2000"],
    ["an unknown recipe", { recipeId: "nope" }, 404, "Recipe not found"],
    ["an unknown format", { format: "4:3" }, 400, "format must be"],
    ["an unknown language", { language: "fr" }, 400, "language must be"],
    ["a length under the recipe's minimum", { targetSec: 3 }, 400, "from 5 to 90"],
    ["a length over the recipe's maximum", { targetSec: 120 }, 400, "from 5 to 90"],
    ["a length that is not whole seconds", { targetSec: 12.5 }, 400, "whole number"],
  ])("create: %s", async (_name, input, status, message) => {
    env = makeEnv(LLM);
    env.app.start();
    const err = await failure(() => gen().createProject({ brief: "ok", ...input }));
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(status);
    expect(err.message).toContain(message);
  });

  test("create: without an LLM it is a 503; a recipe needing a missing connection is a 409", async () => {
    env = makeEnv();
    env.app.start();
    expect((await failure(() => gen().createProject({ brief: "ok" }))).status).toBe(503);
    env.cleanup();
    env = makeEnv(LLM);
    env.app.start();
    const r = quickRecipe();
    r.id = "needs-images";
    r.steps.splice(2, 0, { use: "images" });
    store().saveGenRecipe({ id: "needs-images", name: "N", version: 1, builtIn: 0, description: null, recipe: JSON.stringify(r), ideaCursor: null, createdAt: "t", updatedAt: "t" });
    const err = await failure(() => gen().createProject({ brief: "ok", recipeId: "needs-images" }));
    expect(err).toMatchObject({ status: 409 });
    expect(err.message).toContain("image connection");
  });

  test("pick, edit and approve need the right state", async () => {
    const { id } = await created([STORIES]);
    expect((await failure(() => gen().pick(id, 7))).message).toContain("index must be from 0 to 2");
    expect((await failure(() => gen().putPlan(id, samplePlan()))).message).toContain("no plan yet");
    expect((await failure(() => gen().approvePlan(id, "x"))).status).toBe(409);
    expect((await failure(() => gen().revisePlan(id, " "))).status).toBe(400);
    expect((await failure(() => gen().getProject("nope"))).status).toBe(404);

    gen().pick(id, 0);
    scriptLlm(env, [PLAN]);
    await gen().whenIdle();
    const bad = await failure(() => gen().putPlan(id, { ...samplePlan(), shots: [] }));
    expect(bad).toMatchObject({ status: 400 });
    expect(bad.message).toContain("The plan doesn't pass");
  });

  test("a recipe with no storylines step can't ask for new ones", async () => {
    env = makeEnv(LLM);
    env.app.start();
    const r = quickRecipe();
    r.id = "no-story";
    r.steps = r.steps.filter((s) => s.use !== "storylines");
    store().saveGenRecipe({ id: "no-story", name: "N", version: 1, builtIn: 0, description: null, recipe: JSON.stringify(r), ideaCursor: null, createdAt: "t", updatedAt: "t" });
    scriptLlm(env, [PLAN]);
    const { id } = await gen().createProject({ brief: "ok", recipeId: "no-story" });
    await gen().whenIdle();
    expect((await failure(() => gen().newStorylines(id))).status).toBe(409);
  });
});

describe("project housekeeping", () => {
  test("patch, detail, list, delete with its files", async () => {
    const { id } = await created([STORIES]);
    expect(gen().patchProject(id, { title: "  Judul saya ", narration: true, styleNotes: " tenang " })).toMatchObject({ title: "Judul saya", narration: 1, styleNotes: "tenang" });
    expect(gen().patchProject(id, { title: " ", narration: false, styleNotes: "" })).toMatchObject({ title: null, narration: 0, styleNotes: null });
    expect(gen().patchProject(id, {}).id).toBe(id);
    expect(gen().listProjects().map((p) => p.id)).toEqual([id]);
    expect(Object.keys(gen().getProject(id))).toEqual(["project", "plans", "versions", "assets", "exports"]);
    expect(gen().storyline(id)!.title).toBe("Film 1");

    const dir = `${env.config.genDir}/${id}`;
    expect(existsSync(dir)).toBe(true);
    gen().deleteProject(id);
    expect(existsSync(dir)).toBe(false);
    expect(store().getGenProject(id)).toBeNull();
    expect((await failure(() => gen().file(id, "BRIEF.md"))).status).toBe(404);
  });

  test("mirrored files: unknown names and files not written yet are 404", async () => {
    const { id } = await created([STORIES]);
    expect((await failure(() => gen().file(id, "SPEC.md"))).message).toContain("hasn't been written");
    expect((await failure(() => gen().file(id, "../../secret"))).status).toBe(404);
    expect(gen().events(id, 5000).length).toBe(1);
  });
});
