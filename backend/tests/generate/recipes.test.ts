import { afterEach, describe, expect, test } from "bun:test";
import { makeEnv, quickRecipe, samplePlan, scriptLlm, type TestEnv } from "../helpers";

let env: TestEnv;
afterEach(() => env?.cleanup());

const base = "/api/generate";
const rig = () => {
  env = makeEnv({ llmBaseUrl: "http://llm/v1", llmModel: "m" });
  env.app.start();
  return env;
};
const mine = (over: Record<string, unknown> = {}) => ({ ...quickRecipe(), id: "mine", name: "Mine", ...over });

describe("step library and recipe routes", () => {
  test("the step library gives every type its schema, defaults and gates", async () => {
    rig();
    const { steps } = (await env.json("GET", `${base}/steps`)).body.data;
    expect(steps.map((s: any) => s.type)).toContain("voice");
    expect(steps.find((s: any) => s.type === "render")).toMatchObject({
      gates: ["none"], defaults: { quality: "draft", workers: 2 }, fields: { quality: { t: "enum" } },
    });
    expect(steps.find((s: any) => s.type === "command").required).toEqual(["name"]);
  });

  test("examples are listed with whether they can run here; validation changes nothing", async () => {
    rig();
    const { recipes } = (await env.json("GET", `${base}/recipes`)).body.data;
    expect(recipes.find((r: any) => r.id === "quick")).toMatchObject({ builtIn: true, available: true, reasons: [] });
    const bad = (await env.json("POST", `${base}/recipes/validate`, { recipe: { id: "x" } })).body.data;
    expect(bad.ok).toBeFalse();
    expect(bad.errors.length).toBeGreaterThan(0);
    expect((await env.json("POST", `${base}/recipes/validate`, { recipe: mine() })).body.data).toMatchObject({ ok: true, errors: [] });
    expect((await env.json("GET", `${base}/recipes`)).body.data.recipes).toHaveLength(recipes.length);
  });

  test("copy, edit (version +1), export, delete; an example can't be edited or deleted", async () => {
    rig();
    const copied = await env.json("POST", `${base}/recipes`, { fromId: "quick", id: "mine", name: " Mine " });
    expect(copied.status).toBe(201);
    expect(copied.body.data.recipe).toMatchObject({ id: "mine", name: "Mine", version: 1, builtIn: false, recipe: { id: "mine", builtIn: false } });
    expect((await env.json("POST", `${base}/recipes`, { fromId: "quick", id: "mine", name: "Again" })).status).toBe(409);
    expect((await env.json("POST", `${base}/recipes`, { fromId: "quick", id: "Bad Id", name: "x" })).body.error).toContain("lowercase");
    expect((await env.json("POST", `${base}/recipes`, { fromId: "quick", id: "other", name: " " })).body.error).toContain("name");
    expect((await env.json("POST", `${base}/recipes`, { fromId: "nope", id: "other", name: "x" })).status).toBe(404);

    const edited = { ...(copied.body.data.recipe.recipe as object), description: "changed" };
    const saved = await env.json("PUT", `${base}/recipes/mine`, { recipe: edited });
    expect(saved.body.data.recipe).toMatchObject({ version: 2, description: "changed" });
    expect((await env.json("PUT", `${base}/recipes/mine`, { recipe: { ...edited, steps: [] } })).status).toBe(400);
    expect((await env.json("PUT", `${base}/recipes/mine`, { recipe: { ...edited, id: "other" } })).body.error).toContain("can't change");
    expect((await env.json("PUT", `${base}/recipes/quick`, { recipe: edited })).status).toBe(409);
    expect((await env.json("DELETE", `${base}/recipes/quick`)).status).toBe(409);

    const file = await env.req("GET", `${base}/recipes/mine/export`);
    expect(file.headers.get("content-disposition")).toContain("mine.json");
    const exported = await file.json();
    expect(exported).toMatchObject({ id: "mine", version: 2 });
    expect(exported).not.toHaveProperty("builtIn");

    expect((await env.json("DELETE", `${base}/recipes/mine`)).body.data).toEqual({ deleted: true });
    expect((await env.json("GET", `${base}/recipes/mine`)).status).toBe(404);
  });

  test("an import is validated like a save, lands as the importer's own recipe and never replaces one", async () => {
    rig();
    const imported = await env.json("POST", `${base}/recipes/import`, { recipe: { ...mine(), builtIn: true, version: 9 } });
    expect(imported.status).toBe(201);
    expect(imported.body.data.recipe).toMatchObject({ id: "mine", version: 1, builtIn: false });
    expect((await env.json("POST", `${base}/recipes/import`, { recipe: mine() })).status).toBe(409);
    expect((await env.json("POST", `${base}/recipes/import`, { recipe: mine({ id: "two", steps: [] }) })).status).toBe(400);
  });

  test("a recipe that names a command nobody registered shows as unavailable, with the reason", async () => {
    rig();
    const steps = [...quickRecipe().steps.slice(0, -1), { use: "command", with: { name: "brand-check" } }, quickRecipe().steps.at(-1)];
    await env.json("POST", `${base}/recipes/import`, { recipe: mine({ steps }) });
    const found = (await env.json("GET", `${base}/recipes`)).body.data.recipes.find((r: any) => r.id === "mine");
    expect(found.available).toBeFalse();
    expect(found.reasons[0]).toContain("brand-check");
  });
});

describe("approving a step", () => {
  test("a step that waits for the owner can be passed, once; other steps and busy projects are refused", async () => {
    rig();
    const story = (i: number) => ({ title: `Film ${i}`, pitch: "satu", opening: "benih", beats: ["hook", "isi", "akhir"], look: "flat", sound: "tenang", bold: false, recommended: i === 1, reason: "k" });
    scriptLlm(env, [JSON.stringify({ storylines: [story(1), story(2), story(3)] }), JSON.stringify(samplePlan())]);
    const id = (await env.json("POST", `${base}/projects`, { brief: "Jelaskan bunga majemuk", targetSec: 30 })).body.data.project.id as string;
    expect((await env.json("POST", `${base}/projects/${id}/steps/storylines/approve`)).status).toBe(409);   // still working
    await env.app.generate.whenIdle();
    expect((await env.json("POST", `${base}/projects/${id}/steps/plan/approve`)).body.error).toContain("isn't waiting");
    const passed = await env.json("POST", `${base}/projects/${id}/steps/storylines/approve`);
    expect(passed.status).toBe(200);
    await env.app.generate.whenIdle();
    expect(env.app.store.getGenPlan(env.app.store.getGenProject(id)!.currentPlanId!)).toBeTruthy();
    expect((await env.json("POST", `${base}/projects/${id}/steps/storylines/approve`)).status).toBe(409);
  });
});
