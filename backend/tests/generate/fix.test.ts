import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { readFix } from "../../src/generate/fixes";
import { makeEnv, procOk, samplePlan, sceneHtml, scriptLlm, SAMPLE_TITLES, type TestEnv } from "../helpers";

const json = JSON.stringify;
const story = (i: number) => ({ title: `Film ${i}`, pitch: "satu", opening: "benih", beats: ["hook", "isi", "akhir"], look: "flat", sound: "tenang", bold: false, recommended: i === 1, reason: "k" });
const STORIES = json({ storylines: [story(1), story(2), story(3)] });
const PLAN = json(samplePlan());
const SCENES = [0, 1, 2].map((i) => json({ html: sceneHtml(i) }));
const JUDGE = json({
  criteria: ["opening", "pace", "main_message"].map((id) => ({ id, answer: "yes", reason: "ok" })),
  risks: [{ id: "misleading_claim", flagged: false, reason: "" }],
});
const CLEAN = json({ ok: true, lint: { findings: [] }, runtime: { findings: [] }, layout: { findings: [] } });
const TOO_SMALL = json({ ok: true, lint: { findings: [] }, runtime: { findings: [] }, layout: { findings: [
  { code: "text_below_floor", severity: "error", message: "Text is too small.", fixHint: "Make it 40 px.", selector: '[data-composition-id="shot-02"] .title' },
] } });
const probe = json({ streams: [{ codec_type: "video", width: 1080, height: 1920, avg_frame_rate: "30/1" }], format: { duration: "30.0" } });
const fix = (sceneEdits: object[], extra: object = {}) => json({ sceneEdits, summary: "Diperbaiki", ...extra });
const base = "/api/generate";

let env: TestEnv;
afterEach(() => env?.cleanup());
const gen = () => env.app.generate;
const store = () => env.app.store;

/** A project with an approved plan; the media tools answer, the check reports what `check` says. */
async function approved(opts: { check?: string; keep?: number; recipe?: (r: any) => void } = {}) {
  env = makeEnv({ llmBaseUrl: "http://llm/v1", llmModel: "m", ...(opts.keep ? { genKeepVersions: opts.keep } : {}) });
  env.app.start();
  const llm = scriptLlm(env, [STORIES, PLAN]);
  const fallback = env.execHandler.fn;
  env.hfHandlers.check = () => procOk(opts.check ?? CLEAN);
  env.execHandler.fn = (cmd, args, signal) => (cmd.includes("ffprobe") ? procOk(probe) : fallback(cmd, args, signal));
  const { id } = await gen().createProject({ brief: "Jelaskan bunga majemuk" });
  await gen().whenIdle();
  gen().pick(id, 0);
  await gen().whenIdle();
  gen().approvePlan(id, store().getGenProject(id)!.currentPlanId);
  await gen().whenIdle();
  const recipe = JSON.parse(store().getGenProject(id)!.recipe);
  recipe.steps.find((s: any) => s.use === "check").with = { rounds: 0 };   // findings stay: nothing repairs them in the build itself
  opts.recipe?.(recipe);
  store().db.query("UPDATE gen_project SET recipe = ? WHERE id = ?").run(json(recipe), id);
  return { id, llm };
}

/** Builds version 1: its TECHNICAL verdict FAILs on text that is too small in shot 2. */
async function failedBuild(opts: Parameters<typeof approved>[0] = {}) {
  const a = await approved({ check: TOO_SMALL, ...opts });
  scriptLlm(env, [...SCENES, JUDGE]);
  const v1 = gen().startBuild(a.id);
  await gen().whenIdle();
  return { ...a, v1: store().getGenVersion(v1.id)! };
}

describe("a fix round", () => {
  test("rewrites only the shot that needs it, keeps the rest, and judges the new version again; the old one stays", async () => {
    const { id, v1 } = await failedBuild();
    expect(store().genVerdictsForVersion(v1.id)[0]).toMatchObject({ kind: "TECHNICAL", status: "FAIL" });
    const before = [1, 2, 3].map((n) => readFileSync(join(v1.projectDir!, `compositions/shot-0${n}.html`), "utf-8"));

    env.hfHandlers.check = () => procOk(CLEAN);   // the fix works: the next check is clean
    const llm = scriptLlm(env, [fix([{ shotId: "s02", instruction: "Make the title 72 px." }]), json({ html: sceneHtml(1, SAMPLE_TITLES[1], "<!-- bigger -->") }), JUDGE]);
    const res = await env.json("POST", `${base}/versions/${v1.id}/fix`, {});
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ plan: null, needsApproval: false, summary: "Diperbaiki", version: { number: 2, parentVersionId: v1.id, status: "QUEUED" } });
    await gen().whenIdle();

    // the director saw the open must-fix finding, with its shot and fix
    const asked = JSON.parse(llm.requests[0]!.messages[1]!.content);
    expect(asked.findings).toEqual([expect.objectContaining({ code: "text_below_floor", shotId: "s02", severity: "must-fix", suggestedFix: "Make it 40 px." })]);
    // only shot 2 was rewritten: one repair call, with the instruction and the finding; the judge ran again
    expect(llm.requests.map((r) => r.tool_choice.function.name)).toEqual(["submit_fix", "submit_repair", "submit_judgement"]);
    const repair = JSON.parse(llm.requests[1]!.messages[1]!.content);
    expect(repair.compositionId).toBe("shot-02");
    expect(repair.findings.map((f: any) => f.code)).toEqual(["fix_request", "text_below_floor"]);
    expect(repair.findings[0].message).toBe("Make the title 72 px.");

    const v2 = store().getGenVersion(res.body.data.version.id)!;
    expect(v2).toMatchObject({ status: "BUILT", parentVersionId: v1.id });
    const after = [1, 2, 3].map((n) => readFileSync(join(v2.projectDir!, `compositions/shot-0${n}.html`), "utf-8"));
    expect(after[0]).toBe(before[0]!);
    expect(after[2]).toBe(before[2]!);
    expect(after[1]).toContain("<!-- bigger -->");
    expect(existsSync(join(v2.projectDir!, "compositions/.fixed-s02"))).toBe(true);
    expect(readFix(v2.projectDir!)).toMatchObject({ parentVersionId: v1.id, auto: false, depth: 0, summary: "Diperbaiki" });
    expect(store().genVerdictsForVersion(v2.id).map((v) => [v.kind, v.status])).toEqual([["TECHNICAL", "PASS"], ["CREATIVE", "PASS"]]);

    // version 1 and its verdicts are untouched
    expect(store().getGenVersion(v1.id)!.status).toBe("BUILT");
    expect(store().genVerdictsForVersion(v1.id)[0]!.status).toBe("FAIL");
    expect(readFileSync(join(v1.projectDir!, "compositions/shot-02.html"), "utf-8")).toBe(before[1]!);
    expect(store().getGenProject(id)!.status).toBe("BUILT");
    const detail = (await env.json("GET", `${base}/projects/${id}`)).body.data;
    expect(detail.versions.map((v: any) => v.number)).toEqual([2, 1]);
    expect(detail.verdictStatuses[v1.id]).toEqual({ TECHNICAL: "FAIL", CREATIVE: "PASS" });
  });

  test("the chosen findings and a note steer it; a note alone is enough, even on a version that passed", async () => {
    const { v1 } = await failedBuild();
    const chosen = readFileSync(join(v1.projectDir!, "findings.json"), "utf-8");
    const id = (JSON.parse(chosen) as any[]).find((f) => f.code === "text_below_floor").id as string;
    env.hfHandlers.check = () => procOk(CLEAN);
    const llm = scriptLlm(env, [fix([{ shotId: "s03", instruction: "Slow the motion." }]), json({ html: sceneHtml(2) }), JUDGE]);
    const r = await gen().fixVersion(v1.id, { findingIds: [id], note: "lebih tenang", shotId: "s03" });
    const asked = JSON.parse(llm.requests[0]!.messages[1]!.content);
    expect(asked).toMatchObject({ note: "lebih tenang", onlyShot: "s03", findings: [{ id }] });
    await gen().whenIdle();
    expect(store().getGenVersion(r.version!.id)!.status).toBe("BUILT");

    // version 2 passed: a note on its own still makes a version 3
    scriptLlm(env, [fix([{ shotId: "s01", instruction: "Add a pause." }]), json({ html: sceneHtml(0) }), JUDGE]);
    const third = await gen().fixVersion(r.version!.id, { note: "tambah jeda" });
    expect(third.version!.number).toBe(3);
    await gen().whenIdle();
  });

  test.each([
    ["an unknown finding", { findingIds: ["nope"] }, 400, "No such finding: nope"],
    ["an unknown shot", { note: "x", shotId: "s99" }, 400, "no shot s99"],
  ])("refuses %s", async (_name, body, status, message) => {
    const { v1 } = await failedBuild();
    const res = await env.json("POST", `${base}/versions/${v1.id}/fix`, body);
    expect(res.status).toBe(status);
    expect(res.body.error).toContain(message);
    expect(store().genVersionsForProject(v1.projectId)).toHaveLength(1);
  });

  test("with nothing open to fix and no note there is nothing to do; unfinished, busy and unknown versions are refused", async () => {
    const clean = await approved();
    scriptLlm(env, [...SCENES, JUDGE]);
    const v = gen().startBuild(clean.id);
    expect((await env.json("POST", `${base}/versions/${v.id}/fix`, {})).body.error).toContain("still working");
    await gen().whenIdle();
    const res = await env.json("POST", `${base}/versions/${v.id}/fix`, {});
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("nothing to fix");

    store().updateGenVersion(v.id, { status: "FAILED" });
    expect((await env.json("POST", `${base}/versions/${v.id}/fix`, { note: "x" })).body.error).toContain("finished build");
    store().updateGenVersion(v.id, { status: "BUILT", projectDir: null });
    expect((await env.json("POST", `${base}/versions/${v.id}/fix`, { note: "x" })).body.error).toContain("removed to save space");
    expect((await env.json("POST", `${base}/versions/nope/fix`, {})).status).toBe(404);
  });
});

describe("a fix that changes the plan", () => {
  const edited = (over: (s: any, i: number) => any) => ({ ...samplePlan(), shots: samplePlan().shots.map(over) });

  test("new words need the owner's approval again: nothing is built, the plan waits, and approving lets a normal build follow", async () => {
    const { id, v1 } = await failedBuild();
    const words = edited((s, i) => (i === 1 ? { ...s, text: [{ role: "title", value: "Judul lebih besar" }] } : s));
    scriptLlm(env, [fix([{ shotId: "s02", instruction: "x" }], { planEdits: words })]);
    const res = await env.json("POST", `${base}/versions/${v1.id}/fix`, { note: "ganti judul" });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ version: null, needsApproval: true, plan: { revision: 2, approvedAt: null, changeRequest: "ganti judul", changeSummary: "Diperbaiki" } });
    expect(store().genVersionsForProject(id)).toHaveLength(1);
    expect(store().getGenProject(id)!.currentPlanId).toBe(res.body.data.plan.id);
    expect((await env.json("POST", `${base}/projects/${id}/versions`)).status).toBe(409);   // FR-006

    gen().approvePlan(id, res.body.data.plan.id);
    await gen().whenIdle();
    env.hfHandlers.check = () => procOk(CLEAN);
    scriptLlm(env, [json({ html: sceneHtml(0) }), json({ html: sceneHtml(1, "Judul lebih besar") }), json({ html: sceneHtml(2) }), JUDGE]);
    const v2 = gen().startBuild(id);
    await gen().whenIdle();
    expect(store().getGenVersion(v2.id)).toMatchObject({ status: "BUILT", planId: res.body.data.plan.id, parentVersionId: null });
  });

  test("a change that keeps the approved words and timing is approved with the fix, and the shots it changed are rewritten", async () => {
    const { id, v1 } = await failedBuild();
    const motion = edited((s, i) => (i === 2 ? { ...s, motion: "slower" } : s));
    env.hfHandlers.check = () => procOk(CLEAN);
    const llm = scriptLlm(env, [fix([{ shotId: "s02", instruction: "Bigger title." }], { planEdits: motion }), json({ html: sceneHtml(1) }), json({ html: sceneHtml(2) }), JUDGE]);
    const res = await gen().fixVersion(v1.id, {});
    expect(res.needsApproval).toBe(false);
    expect(res.plan).toMatchObject({ revision: 2 });
    expect(res.plan!.approvedAt).not.toBeNull();
    await gen().whenIdle();
    const v2 = store().getGenVersion(res.version!.id)!;
    expect(v2.planId).toBe(res.plan!.id);
    expect(store().getGenProject(id)).toMatchObject({ currentPlanId: res.plan!.id, status: "BUILT" });
    const repairs = llm.requests.filter((r) => r.tool_choice.function.name === "submit_repair").map((r) => JSON.parse(r.messages[1]!.content));
    expect(repairs.map((r) => r.compositionId)).toEqual(["shot-02", "shot-03"]);
    expect(repairs[1]!.findings[0].message).toBe("The plan for this shot changed: update the scene to match it.");
    expect(gen().assertCanBuild(id).id).toBe(res.plan!.id);   // still approved: a plain build may follow
  });
});

describe("history", () => {
  test("restore makes the plan a version was built from the current one again", async () => {
    const { id, v1 } = await failedBuild();
    const planA = v1.planId;
    env.hfHandlers.check = () => procOk(CLEAN);
    scriptLlm(env, [fix([{ shotId: "s01", instruction: "x" }], { planEdits: { ...samplePlan(), shots: samplePlan().shots.map((s: any, i: number) => (i === 0 ? { ...s, motion: "faster" } : s)) } }), json({ html: sceneHtml(0) }), JUDGE]);
    const fixed = await gen().fixVersion(v1.id, {});
    await gen().whenIdle();
    const planB = fixed.plan!.id;
    expect(store().getGenProject(id)!.currentPlanId).toBe(planB);

    const res = await env.json("POST", `${base}/versions/${v1.id}/restore`);
    expect(res.body.data.project).toMatchObject({ id, currentPlanId: planA });
    expect(readFileSync(join(env.config.genDir, id, "SPEC.md"), "utf-8")).toContain("revision 1");
    expect((await env.json("POST", `${base}/versions/nope/restore`)).status).toBe(404);
    store().updateGenProject(id, { status: "BUILDING" });
    expect((await env.json("POST", `${base}/versions/${v1.id}/restore`)).body.error).toContain("still working");
    store().db.query("DELETE FROM gen_plan WHERE id = ?").run(planA);
    store().updateGenProject(id, { status: "BUILT" });
    expect((await env.json("POST", `${base}/versions/${v1.id}/restore`)).body.error).toContain("plan of that version is missing");
  });

  test("versions beyond GEN_KEEP_VERSIONS lose their files, but not the accepted one; their rows and verdicts stay", async () => {
    const a = await approved({ keep: 2 });
    const built: string[] = [];
    for (let n = 0; n < 4; n++) {
      scriptLlm(env, [...SCENES, JUDGE]);   // a plain build reuses nothing: all three scenes are written again
      built.push(gen().startBuild(a.id).id);
      await gen().whenIdle();
      if (n === 0) gen().acceptVersion(built[0]!);
    }
    const rows = built.map((id) => store().getGenVersion(id)!);
    expect(rows.map((v) => v.status)).toEqual(["BUILT", "BUILT", "BUILT", "BUILT"]);
    expect(rows.map((v) => v.projectDir !== null)).toEqual([true, false, true, true]);   // 1 is accepted; 2 is pruned; the newest two stay
    expect(existsSync(join(env.config.genDir, a.id, "v2"))).toBe(false);
    expect(existsSync(join(env.config.genDir, a.id, "v1"))).toBe(true);
    expect(rows[1]!.draftPath).toBeNull();
    expect(store().genVerdictsForVersion(built[1]!)).toHaveLength(2);
    expect((await env.json("GET", `${base}/versions/${built[1]}/sheets/review-beats`)).status).toBe(404);
  });
});

describe("automatic fix rounds", () => {
  const withRounds = (n: number) => (r: any) => { r.steps.find((s: any) => s.use === "technical").with = { autoFixRounds: n }; };

  test("a TECHNICAL FAIL goes back to the director by itself, once per round allowed", async () => {
    const a = await approved({ check: TOO_SMALL, recipe: withRounds(1) });
    const llm = scriptLlm(env, [...SCENES, JUDGE, fix([{ shotId: "s02", instruction: "Bigger." }]), json({ html: sceneHtml(1) }), JUDGE]);
    const v1 = gen().startBuild(a.id);
    await gen().whenIdle();
    const rows = store().genVersionsForProject(a.id);
    expect(rows.map((v) => [v.number, v.status, v.parentVersionId])).toEqual([[2, "BUILT", v1.id], [1, "BUILT", null]]);
    expect(readFix(rows[0]!.projectDir!)).toMatchObject({ auto: true, depth: 1 });
    // the check still reports the problem on version 2, but the round limit is 1: no third version
    expect(llm.left()).toBe(0);
    expect(store().genVerdictsForVersion(rows[0]!.id)[0]!.status).toBe("FAIL");
  });

  test("with the default of no rounds nothing happens; a passing build isn't touched; a failing fix doesn't break the queue", async () => {
    const none = await approved({ check: TOO_SMALL });
    scriptLlm(env, [...SCENES, JUDGE]);
    gen().startBuild(none.id);
    await gen().whenIdle();
    expect(store().genVersionsForProject(none.id)).toHaveLength(1);
    env.cleanup();

    const broken = await approved({ check: TOO_SMALL, recipe: withRounds(2) });
    const errors: string[] = [];
    const original = console.error;
    console.error = (m: string) => { errors.push(m); };
    try {
      scriptLlm(env, [...SCENES, JUDGE, new Error("quota exceeded")]);   // the automatic fix call fails
      gen().startBuild(broken.id);
      await gen().whenIdle();
    } finally {
      console.error = original;
    }
    expect(errors.join()).toContain("after-build work");
    expect(store().genVersionsForProject(broken.id)).toHaveLength(1);
    expect(store().getGenProject(broken.id)!.status).toBe("BUILT");
  });

  test("a CREATIVE FAIL is fixed by its own rounds, using the creative findings", async () => {
    const a = await approved({ recipe: (r) => { r.steps.find((s: any) => s.use === "creative").with = { ...r.steps.find((s: any) => s.use === "creative").with, autoFixRounds: 1 }; } });
    const failJudge = json({
      criteria: [{ id: "opening", answer: "no", reason: "plain title", shotId: "s01" }, { id: "pace", answer: "yes", reason: "" }, { id: "main_message", answer: "no", reason: "unclear" }],
      risks: [{ id: "misleading_claim", flagged: false, reason: "" }],
    });
    const llm = scriptLlm(env, [...SCENES, failJudge, fix([{ shotId: "s01", instruction: "Start with the coin." }]), json({ html: sceneHtml(0) }), JUDGE]);
    gen().startBuild(a.id);
    await gen().whenIdle();
    const asked = JSON.parse(llm.requests[4]!.messages[1]!.content);
    expect(asked.findings.map((f: any) => f.code)).toEqual(["creative.opening", "creative.main_message"]);
    const [v2] = store().genVersionsForProject(a.id);
    expect(v2!.number).toBe(2);
    expect(store().genVerdictsForVersion(v2!.id)[1]).toMatchObject({ kind: "CREATIVE", status: "PASS" });
  });
});
