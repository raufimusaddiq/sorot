import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { ProcResult } from "../../src/runner";
import { makeEnv, procOk, samplePlan, sceneHtml, scriptLlm, type TestEnv } from "../helpers";

const json = JSON.stringify;
const story = (i: number) => ({ title: `Film ${i}`, pitch: "satu", opening: "benih", beats: ["hook", "isi", "akhir"], look: "flat", sound: "tenang", bold: false, recommended: i === 1, reason: "k" });
const STORIES = json({ storylines: [story(1), story(2), story(3)] });
const PLAN = json(samplePlan());
const SCENES = [0, 1, 2].map((i) => json({ html: sceneHtml(i) }));
const JUDGE = json({
  criteria: ["opening", "pace", "main_message"].map((id) => ({ id, answer: "yes", reason: "ok" })),
  risks: [{ id: "misleading_claim", flagged: false, reason: "" }],
});
const CLEAN_CHECK = json({ ok: true, lint: { findings: [] }, runtime: { findings: [] }, layout: { findings: [] } });
const probe = (over: { width?: number; duration?: string } = {}) => json({
  streams: [{ codec_type: "video", width: over.width ?? 1080, height: 1920, avg_frame_rate: "30/1", duration: over.duration ?? "30.0" }], format: { duration: over.duration ?? "30.0" },
});
const base = "/api/generate";

let env: TestEnv;
afterEach(() => env?.cleanup());

const gen = () => env.app.generate;
const store = () => env.app.store;

/** An app whose project has an approved plan, ready to build; the media tools answer from `media`. */
async function approved(extra: { media?: () => string; replies?: Parameters<typeof scriptLlm>[1]; config?: object } = {}) {
  env = makeEnv({ llmBaseUrl: "http://llm/v1", llmModel: "m", ...extra.config });
  env.app.start();
  const llm = scriptLlm(env, [STORIES, PLAN, ...(extra.replies ?? [...SCENES, JUDGE])]);
  const fallback = env.execHandler.fn;
  env.hfHandlers.check = () => procOk(CLEAN_CHECK);
  env.execHandler.fn = (cmd, args, signal) => {
    if (cmd.includes("ffprobe")) return procOk((extra.media ?? probe)());
    if (cmd === "ffmpeg" && args.includes("volumedetect")) return { ...procOk(), stderr: "mean_volume: -20.0 dB\nmax_volume: -3.0 dB" };
    return fallback(cmd, args, signal);
  };
  const { id } = await gen().createProject({ brief: "Jelaskan bunga majemuk" });
  await gen().whenIdle();
  gen().pick(id, 0);
  await gen().whenIdle();
  gen().approvePlan(id, store().getGenProject(id)!.currentPlanId);
  await gen().whenIdle();
  return { id, llm };
}

describe("a build, from the approved plan to two verdicts", () => {
  test("queued, built, judged twice; the project and the review file follow; accepting makes the project accepted", async () => {
    const { id, llm } = await approved();
    const started = await env.json("POST", `${base}/projects/${id}/versions`);
    expect(started.status).toBe(201);
    expect(started.body.data.version).toMatchObject({ number: 1, status: "QUEUED", planId: store().getGenProject(id)!.currentPlanId, renderKind: "draft", progress: 0 });
    expect(store().getGenProject(id)!.status).toBe("BUILDING");
    await gen().whenIdle();

    const vid = started.body.data.version.id as string;
    const got = (await env.json("GET", `${base}/versions/${vid}`)).body.data;
    expect(got.version).toMatchObject({ status: "BUILT", progress: 100, step: null, hyperframesVersion: env.config.hyperframesVersion });
    expect(Object.keys(got.version.stepState)).toEqual(["author", "check", "render", "technical", "creative"]);
    expect(got.version.draftPath).toEndWith("draft.mp4");
    expect(got.verdicts.map((v: any) => [v.kind, v.status, v.judgedBy])).toEqual([["TECHNICAL", "PASS", "code"], ["CREATIVE", "PASS", "llm:m"]]);
    expect(got.verdicts[0].findings).toEqual([]);
    expect(store().getGenProject(id)!.status).toBe("BUILT");
    expect(llm.requests).toHaveLength(2 + 3 + 1);   // storylines, plan, three scenes, the judge

    const review = readFileSync(join(env.config.genDir, id, "MOTION_REVIEW.md"), "utf-8");
    expect(review).toContain("## TECHNICAL: PASS");
    expect(review).toContain("## CREATIVE: PASS");
    expect(readFileSync(`${env.config.genDir}/${id}/v1/compositions/shot-02.html`, "utf-8")).toContain("Uang tumbuh sendiri");

    // the project lists its version with the state parsed
    expect((await env.json("GET", `${base}/projects/${id}`)).body.data.versions[0]).toMatchObject({ id: vid, status: "BUILT", stepState: expect.any(Object) });

    const accepted = await env.json("POST", `${base}/versions/${vid}/accept`);
    expect(accepted.body.data.project).toMatchObject({ status: "ACCEPTED", acceptedVersionId: vid });
  });

  test("export: the accepted-quality video lands in the project's exports folder, is served, and is listed with the project", async () => {
    const { id } = await approved({ replies: [...SCENES, JUDGE, json({ title: "Bunga berbunga", description: "Uang tumbuh." })] });
    const v = (await env.json("POST", `${base}/projects/${id}/versions`)).body.data.version.id as string;
    await gen().whenIdle();
    const made = await env.json("POST", `${base}/versions/${v}/export`, { title: " Judul saya " });
    expect(made.status).toBe(201);
    const exp = made.body.data.export;
    expect(exp).toMatchObject({ projectId: id, versionId: v, title: "Judul saya", description: "Uang tumbuh.", format: "9:16" });
    expect(exp.path).toBe(join(env.config.genDir, id, "exports", `${v}.mp4`));
    expect(await (await env.req("GET", `${base}/exports/${exp.id}/file`)).text()).toBe("mp4-bytes");
    const dl = await env.req("GET", `${base}/exports/${exp.id}/file?download=1`);
    expect(dl.headers.get("content-disposition")).toContain(`${v}.mp4`);
    expect((await env.json("GET", `${base}/projects/${id}`)).body.data.exports).toHaveLength(1);
    expect((await env.json("GET", `${base}/exports`)).body.data.exports).toMatchObject([{ id: exp.id, title: "Judul saya", projectTitle: expect.any(String) }]);
    expect((await env.json("GET", `${base}/exports/nope/file`)).status).toBe(404);
    // two requests at once share one render
    const [a, b] = await Promise.all([gen().exportVersion(v, { title: "A", description: "d" }), gen().exportVersion(v, { title: "A", description: "d" })]);
    expect(a.id).toBe(b.id);
  });

  test("export is refused while TECHNICAL fails, before the build is finished, or after the files were removed", async () => {
    const { id } = await approved();
    const v = (await env.json("POST", `${base}/projects/${id}/versions`)).body.data.version.id as string;
    expect((await env.json("POST", `${base}/versions/${v}/export`)).body.error).toContain("finished build");
    await gen().whenIdle();
    const technical = store().genVerdictsForVersion(v).find((x) => x.kind === "TECHNICAL")!;
    store().saveGenVerdict({ ...technical, status: "FAIL" });
    const refused = await env.json("POST", `${base}/versions/${v}/export`);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("TECHNICAL failed");
    store().updateGenVersion(v, { projectDir: null });
    expect((await env.json("POST", `${base}/versions/${v}/export`)).body.error).toContain("removed to save space");
    expect((await env.json("POST", `${base}/versions/nope/export`)).status).toBe(404);
  });

  test("the video is served with range requests; the sheet only once the judge made one", async () => {
    const { id } = await approved();
    const v = (await env.json("POST", `${base}/projects/${id}/versions`)).body.data.version.id as string;
    await gen().whenIdle();
    const full = await env.req("GET", `${base}/versions/${v}/draft`);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("video/mp4");
    expect(await full.text()).toBe("mp4-bytes");
    const part = await env.req("GET", `${base}/versions/${v}/draft`, undefined, { range: "bytes=0-2" });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe("mp4");
    expect((await env.json("GET", `${base}/versions/${v}/sheets/review-beats`)).status).toBe(404);
    expect((await env.json("GET", `${base}/versions/${v}/sheets/other`)).status).toBe(404);
    const dir = store().getGenVersion(v)!.projectDir!;
    mkdirSync(join(dir, "sheets"), { recursive: true });
    writeFileSync(join(dir, "sheets/review-beats.jpg"), "jpeg");
    expect(await (await env.req("GET", `${base}/versions/${v}/sheets/review-beats`)).text()).toBe("jpeg");
    expect((await env.json("GET", `${base}/versions/nope/draft`)).status).toBe(404);
    store().updateGenVersion(v, { draftPath: null });
    expect((await env.json("GET", `${base}/versions/${v}/draft`)).status).toBe(404);
  });

  test("the estimate comes from builds so far", async () => {
    const { id } = await approved();
    const before = (await env.json("GET", `${base}/projects/${id}/estimate`)).body.data;
    expect(before).toEqual({ draftSec: 600, exportSec: 30 });
    await env.json("POST", `${base}/projects/${id}/versions`);
    await gen().whenIdle();
    const after = (await env.json("GET", `${base}/projects/${id}/estimate`)).body.data;
    expect(after.draftSec).toBeGreaterThanOrEqual(1);
    expect(after.draftSec).toBeLessThan(600);
  });
});

describe("refusals", () => {
  test("nothing is built before the plan is approved, and not twice at once", async () => {
    env = makeEnv({ llmBaseUrl: "http://llm/v1", llmModel: "m" });
    env.app.start();
    scriptLlm(env, [STORIES, PLAN]);
    const { id } = await gen().createProject({ brief: "x" });
    await gen().whenIdle();
    gen().pick(id, 0);
    await gen().whenIdle();
    const early = await env.json("POST", `${base}/projects/${id}/versions`);
    expect(early.status).toBe(409);
    expect(early.body.error).toContain("Approve the plan first");
    expect(store().genVersionsForProject(id)).toEqual([]);
  });

  test("a build can't start while another is running", async () => {
    const { id } = await approved();
    await env.json("POST", `${base}/projects/${id}/versions`);
    const again = await env.json("POST", `${base}/projects/${id}/versions`);
    expect(again.status).toBe(409);
    expect(again.body.error).toContain("still working");
    await gen().whenIdle();
  });

  test("a version whose TECHNICAL verdict fails can't be accepted; one that isn't finished can't either", async () => {
    const { id } = await approved({ media: () => probe({ width: 720 }) });
    const v = (await env.json("POST", `${base}/projects/${id}/versions`)).body.data.version.id as string;
    expect((await env.json("POST", `${base}/versions/${v}/accept`)).body.error).toContain("finished build");
    await gen().whenIdle();
    const verdicts = (await env.json("GET", `${base}/versions/${v}`)).body.data.verdicts;
    expect(verdicts[0]).toMatchObject({ kind: "TECHNICAL", status: "FAIL" });
    expect(verdicts[0].findings.map((f: any) => f.code)).toEqual(["output_size"]);
    const refused = await env.json("POST", `${base}/versions/${v}/accept`);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("TECHNICAL failed");
    expect(store().getGenProject(id)!.status).toBe("BUILT");
    expect(readFileSync(join(env.config.genDir, id, "MOTION_REVIEW.md"), "utf-8")).toContain("## TECHNICAL: FAIL");
  });

  test("a version without a TECHNICAL verdict can't be accepted; unknown versions are 404", async () => {
    const { id } = await approved();
    const v = (await env.json("POST", `${base}/projects/${id}/versions`)).body.data.version.id as string;
    await gen().whenIdle();
    store().db.query("DELETE FROM gen_verdict WHERE kind = 'TECHNICAL'").run();
    expect((await env.json("POST", `${base}/versions/${v}/accept`)).body.error).toContain("no TECHNICAL verdict");
    expect((await env.json("GET", `${base}/versions/nope`)).status).toBe(404);
    expect((await env.json("POST", `${base}/versions/nope/cancel`)).status).toBe(404);
    expect((await env.json("POST", `${base}/versions/${v}/cancel`)).body.error).toContain("already finished");
  });
});

describe("cancel, failure and restart", () => {
  test("a build that waits for a clip job can be cancelled; the project goes back to waiting", async () => {
    const { id } = await approved();
    const clip = store().saveJob({ id: "j1", videoId: "v", status: "RUNNING", currentStage: "RENDER", errorMessage: null, createdAt: "t", updatedAt: "t" } as never);
    expect(clip.id).toBe("j1");
    const v = (await env.json("POST", `${base}/projects/${id}/versions`)).body.data.version.id as string;
    await new Promise((r) => setTimeout(r, 20));
    expect(store().getGenVersion(v)!.status).toBe("QUEUED");   // the clip job goes first
    const cancelled = await env.json("POST", `${base}/versions/${v}/cancel`);
    expect(cancelled.body.data.version.status).toBe("CANCELLED");
    expect(store().getGenProject(id)!.status).toBe("WAITING");
    store().updateJob("j1", { status: "COMPLETED" });
  });

  test("a running build is stopped through its signal: the render is killed and the version is CANCELLED", async () => {
    const { id } = await approved();
    let renderStarted: () => void = () => {};
    const started = new Promise<void>((r) => { renderStarted = r; });
    const fallback = env.execHandler.fn;
    env.execHandler.fn = (cmd, args, signal) => {
      if (cmd === env.config.nodePath && args[1] === "render") {
        renderStarted();
        return new Promise<ProcResult>((resolve) => signal?.addEventListener("abort", () => resolve({ exitCode: 137, stdout: "", stderr: "", timedOut: false, aborted: true })));
      }
      return fallback(cmd, args, signal);
    };
    const v = (await env.json("POST", `${base}/projects/${id}/versions`)).body.data.version.id as string;
    await started;
    expect(store().getGenVersion(v)).toMatchObject({ status: "BUILDING", step: "render" });
    expect((await env.json("POST", `${base}/versions/${v}/cancel`)).status).toBe(200);
    await gen().whenIdle();
    expect(store().getGenVersion(v)!.status).toBe("CANCELLED");
    expect(store().getGenProject(id)!.status).toBe("WAITING");   // nothing was built before
    // the work already done is kept, and a new build can start
    expect(existsSync(`${env.config.genDir}/${id}/v1/compositions/shot-01.html`)).toBe(true);
  });

  test("a failing step fails the version with the reason, keeps its work, and a new build can follow", async () => {
    const { id } = await approved({ replies: [SCENES[0]!, new Error("quota exceeded")] });
    const v1 = (await env.json("POST", `${base}/projects/${id}/versions`)).body.data.version.id as string;
    await gen().whenIdle();
    expect(store().getGenVersion(v1)).toMatchObject({ status: "FAILED" });
    expect(store().getGenVersion(v1)!.errorMessage).toContain("quota exceeded");
    expect(store().getGenProject(id)).toMatchObject({ status: "FAILED" });
    expect(existsSync(`${env.config.genDir}/${id}/v1/compositions/shot-01.html`)).toBe(true);

    scriptLlm(env, [...SCENES, JUDGE]);
    const again = await env.json("POST", `${base}/projects/${id}/versions`);
    expect(again.body.data.version.number).toBe(2);
    await gen().whenIdle();
    expect(store().getGenVersion(again.body.data.version.id)!.status).toBe("BUILT");
    expect(store().getGenProject(id)!.status).toBe("BUILT");
  });

  test("a build that was still queued when the app stopped starts again at the next start", async () => {
    const { id } = await approved();
    const t = new Date().toISOString();
    store().saveGenVersion({
      id: "vq", projectId: id, planId: store().getGenProject(id)!.currentPlanId!, number: 1, parentVersionId: null, status: "QUEUED", step: null, progress: 0,
      projectDir: `${env.config.genDir}/${id}/v1`, renderKind: "draft", draftPath: null, stepState: null, hyperframesVersion: null, buildMs: null, errorMessage: null, createdAt: t, updatedAt: t,
    });
    gen().start();
    await gen().whenIdle();
    expect(store().getGenVersion("vq")!.status).toBe("BUILT");
  });

  test("a delivery render in the recipe makes a final version", async () => {
    const { id } = await approved();
    const recipe = JSON.parse(store().getGenProject(id)!.recipe);
    recipe.steps.find((s: any) => s.use === "render").with = { quality: "delivery" };
    recipe.steps.find((s: any) => s.use === "export").with = { mode: "copy" };
    store().db.query("UPDATE gen_project SET recipe = ? WHERE id = ?").run(json(recipe), id);
    const v = await gen().startBuild(id);
    expect(v.renderKind).toBe("final");
    await gen().whenIdle();
    expect(dirname(store().getGenVersion(v.id)!.draftPath!)).toEndWith("v1");
    expect(store().getGenVersion(v.id)!.draftPath).toEndWith("final.mp4");
  });
});
