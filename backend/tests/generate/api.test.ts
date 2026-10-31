import { afterEach, describe, expect, test } from "bun:test";
import { makeEnv, samplePlan, scriptLlm, type TestEnv } from "../helpers";

let env: TestEnv;
afterEach(() => env?.cleanup());

describe("generate API", () => {
  test("GET /api/generate/status reports availability under the usual envelope", async () => {
    env = makeEnv({ llmBaseUrl: "http://llm/v1", llmModel: "m" });
    const { status, body } = await env.json("GET", "/api/generate/status");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      status: "ok",
      data: { available: true, reasons: [], hyperframes: { ok: true }, llm: { configured: true }, compute: "gpu", presets: [] },
    });
  });

  test("without an LLM it still answers, with the reason", async () => {
    env = makeEnv();
    const { body } = await env.json("GET", "/api/generate/status");
    expect(body.data).toMatchObject({ available: false, llm: { configured: false } });
    expect(body.data.reasons[0]).toContain("Connect an LLM");
  });
});

// ---- projects, storylines and the plan -----------------------------------------------

const story = (i: number) => ({
  title: `Film ${i}`, pitch: "satu kalimat", opening: "benih jatuh", beats: ["hook", "isi", "akhir"], look: "flat", sound: "tenang",
  bold: false, recommended: i === 1, reason: "karena",
});
const STORIES = JSON.stringify({ storylines: [story(1), story(2), story(3)] });
const PLAN = JSON.stringify(samplePlan());
const revised = (title: string) => ({
  ...samplePlan(), shots: samplePlan().shots.map((x: any, i: number) => (i === 1 ? { ...x, text: [{ role: "title", value: title }] } : x)),
});
const base = "/api/generate/projects";

describe("generate API: projects and plan", () => {
  const start = async (replies: Parameters<typeof scriptLlm>[1] = [STORIES]) => {
    env = makeEnv({ llmBaseUrl: "http://llm/v1", llmModel: "m" });
    env.app.start();
    scriptLlm(env, replies);
    const created = await env.json("POST", base, { brief: "Jelaskan bunga majemuk", targetSec: 30 });
    await env.app.generate.whenIdle();
    return created.body.data.project.id as string;
  };

  test("the whole flow over HTTP: create, pick, edit, revise, approve", async () => {
    env = makeEnv({ llmBaseUrl: "http://llm/v1", llmModel: "m" });
    env.app.start();
    scriptLlm(env, [STORIES, PLAN, JSON.stringify({ plan: revised("Judul revisi"), changeSummary: "Judul shot 2 diganti" })]);

    const created = await env.json("POST", base, { brief: "Jelaskan bunga majemuk", format: "9:16", targetSec: 30, styleNotes: "tenang" });
    expect(created.status).toBe(201);
    expect(created.body.data.project).toMatchObject({ brief: "Jelaskan bunga majemuk", status: "RUNNING", recipeId: "quick", storylines: null });
    const id = created.body.data.project.id as string;
    await env.app.generate.whenIdle();

    // JSON columns come back parsed, with camelCase keys
    const detail = (await env.json("GET", `${base}/${id}`)).body.data;
    expect(detail.project).toMatchObject({ status: "WAITING", pickedStoryline: null });
    expect(detail.project.storylines).toHaveLength(3);
    expect(detail.project.stepState.storylines.status).toBe("waiting");
    expect(detail.project.recipe.id).toBe("quick");
    expect(detail).toMatchObject({ plans: [], versions: [], assets: [], exports: [] });
    expect((await env.json("GET", base)).body.data.projects[0]).toMatchObject({ id, status: "WAITING" });
    expect((await env.json("GET", base)).body.data.projects[0]).not.toHaveProperty("recipe");

    const picked = await env.json("POST", `${base}/${id}/storylines/1/pick`, { note: "lebih tenang" });
    expect(picked.status).toBe(200);
    await env.app.generate.whenIdle();
    let plans = (await env.json("GET", `${base}/${id}`)).body.data.plans;
    expect(plans).toHaveLength(1);
    expect(plans[0].plan.shots).toHaveLength(3);
    expect(plans[0].approvedAt).toBeNull();

    const edited = await env.json("PUT", `${base}/${id}/plan`, { plan: revised("Judul tangan") });
    expect(edited.body.data.plan).toMatchObject({ revision: 2, changeSummary: "Edited by the owner" });
    const asked = await env.json("POST", `${base}/${id}/plan/revise`, { request: "ubah judul shot 2" });
    expect(asked.body.data).toMatchObject({ changeSummary: "Judul shot 2 diganti", plan: { revision: 3 } });

    const stale = await env.json("POST", `${base}/${id}/plan/approve`, { planId: plans[0].id });
    expect(stale.status).toBe(409);
    const approved = await env.json("POST", `${base}/${id}/plan/approve`, { planId: asked.body.data.plan.id });
    expect(approved.body.data.project.id).toBe(id);
    await env.app.generate.whenIdle();
    plans = (await env.json("GET", `${base}/${id}`)).body.data.plans;
    expect(plans.map((x: any) => [x.revision, !!x.approvedAt])).toEqual([[3, true], [2, false], [1, false]]);
    expect((await env.json("GET", `${base}/${id}`)).body.data.project).toMatchObject({ status: "WAITING", stepIndex: 2 });
  });

  test("errors use the usual envelope", async () => {
    const id = await start();
    expect(await env.json("POST", base, { brief: "" })).toMatchObject({ status: 400, body: { status: "error", error: "brief required" } });
    expect((await env.json("POST", base, { brief: "x", recipeId: "nope" })).status).toBe(404);
    expect((await env.json("GET", `${base}/nope`)).status).toBe(404);
    expect((await env.json("POST", `${base}/${id}/storylines/9/pick`, {})).status).toBe(400);
    expect((await env.json("PUT", `${base}/${id}/plan`, { plan: samplePlan() })).status).toBe(409);
    expect((await env.json("POST", `${base}/${id}/plan/revise`, {})).status).toBe(400);
    expect((await env.json("POST", `${base}/${id}/retry`)).status).toBe(409);
    expect((await env.json("PUT", `${base}/${id}/plan`, "not json")).status).toBe(400);
  });

  test("a failed project can be retried", async () => {
    const id = await start([STORIES, new Error("quota")]);
    await env.json("POST", `${base}/${id}/storylines/0/pick`, {});
    await env.app.generate.whenIdle();
    expect((await env.json("GET", `${base}/${id}`)).body.data.project).toMatchObject({ status: "FAILED" });
    scriptLlm(env, [PLAN]);
    expect((await env.json("POST", `${base}/${id}/retry`)).body.data.project.id).toBe(id);
    await env.app.generate.whenIdle();
    expect((await env.json("GET", `${base}/${id}`)).body.data.project.status).toBe("WAITING");
  });

  test("new storylines, patch and delete", async () => {
    const id = await start([STORIES, STORIES]);
    await env.json("POST", `${base}/${id}/storylines`, { note: "lebih berani" });
    await env.app.generate.whenIdle();
    expect((await env.json("PATCH", `${base}/${id}`, { title: "Judul saya", narration: true })).body.data.project).toMatchObject({ title: "Judul saya", narration: 1 });
    expect((await env.json("DELETE", `${base}/${id}`)).body.data).toEqual({ deleted: true });
    expect((await env.json("GET", `${base}/${id}`)).status).toBe(404);
  });

  test("the director log and the mirrored files", async () => {
    const id = await start();
    const events = (await env.json("GET", `${base}/${id}/events?limit=10`)).body.data.events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "storylines", ok: 1, model: "m" });
    expect((await env.json("GET", `${base}/${id}/events?limit=abc`)).body.data.events).toHaveLength(1);

    const res = await env.req("GET", `${base}/${id}/files/STORYLINES.md`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toContain("## 1. Film 1 (recommended)");
    expect((await env.json("GET", `${base}/${id}/files/SPEC.md`)).status).toBe(404);
  });

  test("uploads go in as multipart, come back in the project and can be deleted", async () => {
    const id = await start();
    const upload = (form: FormData) => env.app.fetch(new Request(`http://localhost${base}/${id}/assets`, { method: "POST", body: form }));
    const form = new FormData();
    form.set("file", new File([new Uint8Array(8)], "logo.png", { type: "image/png" }));
    form.set("kind", "logo");
    const res = await upload(form);
    expect(res.status).toBe(201);
    const asset = ((await res.json()) as any).data.asset;
    expect(asset).toMatchObject({ kind: "logo", origin: "upload", projectId: id });
    expect((await env.json("GET", `${base}/${id}`)).body.data.assets.map((a: any) => a.id)).toEqual([asset.id]);

    const shot = new FormData();
    shot.set("file", new File([new Uint8Array(8)], "a.png"));
    shot.set("kind", "image");
    shot.set("shotId", "s02");
    expect((((await (await upload(shot)).json()) as any).data.asset.shotId)).toBe("s02");

    const noFile = new FormData();
    noFile.set("kind", "logo");
    expect((await upload(noFile)).status).toBe(400);
    const bad = new FormData();
    bad.set("file", new File([new Uint8Array(8)], "a.exe"));
    bad.set("kind", "logo");
    expect((await upload(bad)).status).toBe(400);
    expect((await env.app.fetch(new Request(`http://localhost${base}/nope/assets`, { method: "POST", body: form }))).status).toBe(404);

    expect((await env.json("DELETE", `/api/generate/assets/${asset.id}`)).body.data).toEqual({ deleted: true });
    expect((await env.json("DELETE", `/api/generate/assets/${asset.id}`)).status).toBe(404);
  });

  test("PATCH is allowed from the dev server's origin", async () => {
    env = makeEnv();
    const res = await env.app.fetch(new Request("http://localhost/api/generate/status", { method: "OPTIONS", headers: { origin: "http://localhost:3000" } }));
    expect(res.headers.get("access-control-allow-methods")).toContain("PATCH");
  });
});
