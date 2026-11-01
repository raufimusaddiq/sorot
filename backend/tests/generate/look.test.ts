import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/config";
import { openDatabase } from "../../src/db";
import { Director } from "../../src/generate/director";
import { DirectorLog } from "../../src/generate/events";
import { readFindings } from "../../src/generate/findings";
import { Hyperframes } from "../../src/generate/hyperframes";
import { beatTimes, expectations, lookFindings, type LookAnswer } from "../../src/generate/look";
import { validatePlan, type Plan } from "../../src/generate/planSchema";
import type { RecipeStep } from "../../src/generate/recipe";
import { STEPS, settingsOf } from "../../src/generate/steps";
import { Llm } from "../../src/llm";
import { Store } from "../../src/store";
import { fakeHyperframes, procOk, quickRecipe, samplePlan, sceneHtml, type HfHandler } from "../helpers";

const T = "2026-01-01T00:00:00.000Z";
const json = JSON.stringify;
let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "vc-look-")); });
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const plan = (): Plan => validatePlan(samplePlan(), { brief: "x", targetSec: 30, format: "9:16", language: "id", fonts: ["Plus Jakarta Sans"], imageConnected: false, narration: false }).plan as Plan;
const frame = (shotId: string, over: object = {}) => ({ shotId, description: "A seed on a dark ground.", objects: ["seed"], unexplained: [], matches: true, heroVisible: true, ...over });
const answer = (frames: object[], defaultsSeen: string[] = []) => json({ frames, defaultsSeen });
const CLEAN = answer(["s01", "s02", "s03"].map((id) => frame(id)));

describe("look: where to look and what it means", () => {
  test("one frame per shot, a little after it starts and never past its end", () => {
    expect(beatTimes(plan(), 0.3)).toEqual([0.3, 10.3, 20.3]);
    expect(beatTimes(plan(), 0)).toEqual([0, 10, 20]);
    expect(beatTimes(plan(), 50)).toEqual([9.9, 19.9, 29.9]);
  });

  test("what the plan meant: what each shot reads as, and its hero move (else the visual and the motion)", () => {
    expect(expectations(plan())[0]).toEqual({ shotId: "s01", reads: "visual 1", heroMove: "slide in" });
    const p = plan();
    p.shots[0]!.reads = "a seed";
    p.shots[0]!.heroMove = "it falls";
    expect(expectations(p)[0]).toEqual({ shotId: "s01", reads: "a seed", heroMove: "it falls" });
  });

  test("an unexplained object is must-fix; a frame that reads wrongly, a hidden hero move and a visible default are should-fix", () => {
    const found = lookFindings({
      frames: [frame("s01", { unexplained: ["floating ring", "grey bar"] }), frame("s02", { matches: false, description: "a blank grid" }), frame("s03", { heroVisible: false }), frame("ghost")],
      defaultsSeen: ["a centred title on a dark gradient"],
    } as LookAnswer, plan(), [0.3, 10.3, 20.3], true);
    expect(found.map((f) => [f.severity, f.code, f.shotId, f.fromSec])).toEqual([
      ["must-fix", "look_unexplained", "s01", 0.3], ["must-fix", "look_unexplained", "s01", 0.3],
      ["should-fix", "look_mismatch", "s02", 10.3], ["should-fix", "look_hero_hidden", "s03", 20.3], ["should-fix", "look_default", null, undefined],
    ]);
    expect(found[0]!.description).toBe('A stranger can\'t tell what "floating ring" is for in s01.');
    expect(found[2]!.description).toContain('looks like "a blank grid", but it should read as "visual 2"');
    expect(found.every((f) => f.rule === "look" && f.state === "open")).toBeTrue();
    expect(lookFindings({ frames: [], defaultsSeen: ["x"] }, plan(), [], false)).toEqual([]);
  });
});

function rig(replies: string[], over: { vision?: string; handlers?: Record<string, HfHandler>; settings?: Record<string, unknown>; rules?: Record<string, unknown> } = {}) {
  const config = { ...loadConfig({}), genDir: join(tmp, "generate") };
  const store = new Store(openDatabase(":memory:"));
  const recipe = { ...quickRecipe(), rules: over.rules ?? { defaultsAudit: ["a centred title on a dark gradient"] } };
  store.saveGenProject({
    id: "p1", title: null, brief: "x", format: "9:16", targetSec: 30, language: "id", styleNotes: null, preset: null, recipeId: "quick", recipe: json(recipe),
    ideaId: null, briefFlags: null, narrationScript: null, concept: null, stepIndex: 0, stepState: null, narration: 0, storylines: null, pickedStoryline: null,
    status: "BUILDING", currentPlanId: "pl1", acceptedVersionId: null, errorMessage: null, createdAt: T, updatedAt: T,
  });
  store.saveGenPlan({ id: "pl1", projectId: "p1", revision: 1, plan: json(plan()), changeRequest: null, changeSummary: null, approvedAt: T, createdAt: T });
  const dir = join(config.genDir, "p1", "v1");
  mkdirSync(join(dir, "compositions"), { recursive: true });
  for (let i = 0; i < 3; i++) writeFileSync(join(dir, `compositions/shot-0${i + 1}.html`), sceneHtml(i));
  store.saveGenVersion({
    id: "v1", projectId: "p1", planId: "pl1", number: 1, parentVersionId: null, status: "BUILDING", step: null, progress: null, projectDir: dir, renderKind: "draft",
    draftPath: null, stepState: null, hyperframesVersion: null, buildMs: null, errorMessage: null, createdAt: T, updatedAt: T,
  });
  const requests: any[] = [];
  const queue = [...replies];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push(body);
    const next = queue.shift() ?? "";
    return Response.json({ choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "c", type: "function", function: { name: body.tool_choice?.function?.name, arguments: next } }] } }] });
  }) as unknown as typeof fetch;
  const llm = new Llm({ llmBaseUrl: "http://llm/v1", llmModel: "text", llmApiKey: "", llmTimeoutSec: 5, llmVisionModel: over.vision === undefined ? "vl-model" : over.vision }, fetchFn, 0);
  const snaps: number[][] = [];
  const fake = fakeHyperframes({
    snapshot: (args) => {
      const times = args[args.indexOf("--at") + 1]!.split(",").map(Number);
      snaps.push(times);
      const out = join(tmp, "snaps");
      mkdirSync(out, { recursive: true });
      const frames = times.map((t, i) => { const path = join(out, `f${i}.png`); writeFileSync(path, `PIC${i}`); return { path, time: t }; });
      return procOk(json({ ok: true, outputDir: out, frames: frames.reverse() }));
    },
    ...over.handlers,
  });
  const step = { use: "look", with: over.settings ?? {} } as RecipeStep;
  const progress: number[] = [];
  const ctx = {
    project: store.getGenProject("p1")!, version: store.getGenVersion("v1")!, recipe, step, settings: settingsOf("look", step.with), store,
    log: new DirectorLog(store), director: new Director(llm, new DirectorLog(store), "../generator"), hyperframes: new Hyperframes(config, fake.exec),
    config: config as never, progress: (p: number) => progress.push(Math.round(p)), exec: fake.exec,
  } as any;
  return { ctx, dir, store, requests, snaps, progress };
}

describe("look step", () => {
  test("shows the vision model one picture per shot, in shot order, without asking for anything the stranger shouldn't know first", async () => {
    const r = rig([CLEAN], { settings: { rounds: 0 } });
    expect(await STEPS.look.run(r.ctx)).toEqual({ status: "done", outputRef: "0 findings" });
    expect(r.snaps).toEqual([[0.3, 10.3, 20.3]]);
    const req = r.requests[0]!;
    expect(req.model).toBe("vl-model");
    expect(req.tool_choice.function.name).toBe("submit_look");
    const parts = req.messages[1].content;
    expect(parts.filter((p: any) => p.type === "image_url").map((p: any) => p.image_url.url)).toEqual([0, 1, 2].map((i) => `data:image/png;base64,${Buffer.from(`PIC${i}`).toString("base64")}`));
    expect(JSON.parse(parts[0].text)).toMatchObject({ pictures: 3, shots: ["s01", "s02", "s03"], defaultsAudit: ["a centred title on a dark gradient"] });
    expect(readFindings(r.dir)).toEqual([]);
  });

  test("what the stranger finds becomes findings of the build; the defaults audit can be turned off", async () => {
    const reply = answer([frame("s01", { unexplained: ["floating ring"] }), frame("s02"), frame("s03", { matches: false })], ["a centred title on a dark gradient"]);
    const r = rig([reply], { settings: { rounds: 0 } });
    await STEPS.look.run(r.ctx);
    expect(readFindings(r.dir).map((f) => [f.source, f.code, f.severity])).toEqual([
      ["look", "look_unexplained", "must-fix"], ["look", "look_mismatch", "should-fix"], ["look", "look_default", "should-fix"],
    ]);
    const quiet = rig([reply], { settings: { rounds: 0, audit: false } });
    await STEPS.look.run(quiet.ctx);
    expect(readFindings(quiet.dir).map((f) => f.code)).toEqual(["look_unexplained", "look_mismatch"]);
    expect(JSON.parse(quiet.requests[0].messages[1].content[0].text).defaultsAudit).toEqual([]);
  });

  test("a shot with something unexplained gets its scene rewritten and is looked at again, up to `rounds` times", async () => {
    const bad = answer([frame("s01", { unexplained: ["floating ring"] }), frame("s02"), frame("s03")]);
    const fixedScene = json({ html: sceneHtml(0, "Bunga berbunga?", "<!-- ring removed -->") });
    const r = rig([bad, fixedScene, CLEAN], { settings: { rounds: 2 } });
    await STEPS.look.run(r.ctx);
    expect(r.snaps).toHaveLength(2);
    expect(r.requests[1]!.tool_choice.function.name).toBe("submit_repair");
    expect(JSON.parse(r.requests[1]!.messages[1].content).findings).toEqual([expect.objectContaining({ code: "look_unexplained", message: expect.stringContaining("floating ring") })]);
    expect(readFileSync(join(r.dir, "compositions/shot-01.html"), "utf-8")).toContain("ring removed");
    expect(readFindings(r.dir)).toEqual([]);
    expect(r.progress).toEqual([33, 67]);
  });

  test("what is still wrong after the rounds stays a finding; a rewrite that breaks the plan is not kept", async () => {
    const bad = answer([frame("s01", { unexplained: ["floating ring"] }), frame("s02"), frame("s03")]);
    const broken = json({ html: "<div>no composition here at all, just a long enough string to pass the shape check</div>" });
    const r = rig([bad, broken, bad], { settings: { rounds: 1 } });
    const before = readFileSync(join(r.dir, "compositions/shot-01.html"), "utf-8");
    await STEPS.look.run(r.ctx);
    expect(readFileSync(join(r.dir, "compositions/shot-01.html"), "utf-8")).toBe(before);
    expect(readFindings(r.dir).map((f) => f.code)).toEqual(["look_unexplained"]);
    // a finding without a scene file to fix is skipped, not a crash
    const gone = rig([bad, bad], { settings: { rounds: 1 } });
    rmSync(join(gone.dir, "compositions/shot-01.html"));
    await STEPS.look.run(gone.ctx);
    expect(gone.requests).toHaveLength(2);
  });

  test("it needs a vision model, and says how to skip the step when there is none", async () => {
    await expect(STEPS.look.run(rig([], { vision: "" }).ctx)).rejects.toThrow("needs a vision model");
  });

  test("a shot the model leaves out is asked about again", async () => {
    const r = rig([answer([frame("s01"), frame("s02")]), CLEAN], { settings: { rounds: 0 } });
    await STEPS.look.run(r.ctx);
    expect(JSON.parse(r.requests[1]!.messages.at(-1)!.content).problems[0]).toContain("you didn't describe: s03");
  });

  test("with no recipe rules there is nothing to audit; frames come back matched to the nearest time", async () => {
    const r = rig([CLEAN], { settings: { rounds: 0 }, rules: {} });
    await STEPS.look.run(r.ctx);
    expect(JSON.parse(r.requests[0].messages[1].content[0].text).defaultsAudit).toEqual([]);
  });
});
