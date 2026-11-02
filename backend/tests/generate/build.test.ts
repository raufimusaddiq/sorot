import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/config";
import { openDatabase } from "../../src/db";
import { Director } from "../../src/generate/director";
import { DirectorLog } from "../../src/generate/events";
import { readFindings } from "../../src/generate/findings";
import { Hyperframes } from "../../src/generate/hyperframes";
import { Kit } from "../../src/generate/kit";
import { capabilitiesFor } from "../../src/generate/capabilities";
import { recordOf, setModelPin } from "../../src/generate/levels";
import { Llm } from "../../src/llm";
import type { ExecFn } from "../../src/runner";
import { validatePlan, type Plan } from "../../src/generate/planSchema";
import { STEPS, settingsOf } from "../../src/generate/steps";
import { Store } from "../../src/store";
import type { GenAsset } from "../../src/types";
import { writeVoice } from "../../src/generate/voice";
import { ThoughtTooLong, gatewayDown, fakeHyperframes, fakeLlm, hfFixture, procOk, quickRecipe, samplePlan, sceneHtml, SAMPLE_TITLES, type HfHandler } from "../helpers";

const T = "2026-01-01T00:00:00.000Z";
const json = (v: unknown) => JSON.stringify(v);
const html = (index: number, text = SAMPLE_TITLES[index]!, extra = "") => json({ html: sceneHtml(index, text, extra) });

let tmp: string;
let rigs = 0;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "vc-build-")); rigs = 0; });
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const lint = (...findings: object[]) => procOk(json({ ok: !findings.some((f: any) => f.severity === "error"), errorCount: findings.filter((f: any) => f.severity === "error").length, warningCount: findings.filter((f: any) => f.severity === "warning").length, infoCount: 0, findings }));
const check = (layout: object[] = [], extra: Record<string, object[]> = {}) => procOk(json({
  ok: true, lint: { findings: [] }, runtime: { findings: [] }, layout: { findings: layout },
  ...Object.fromEntries(Object.entries(extra).map(([k, f]) => [k, { findings: f }])),
}));
const finding = (code: string, severity: string, extra: object = {}) => ({ code, severity, message: `${code} happened`, fixHint: `fix ${code}`, ...extra });

function rig(replies: Parameters<typeof fakeLlm>[0], handlers: Record<string, HfHandler> = {}, planOver: Record<string, unknown> = {}, assets: GenAsset[] = []) {
  const config = { ...loadConfig({}), genDir: join(tmp, `generate${rigs++}`), generatorDir: "../generator", gsapFile: "../node_modules/gsap/dist/gsap.min.js" };
  const store = new Store(openDatabase(":memory:"));
  const recipe = quickRecipe();
  const plan = validatePlan(samplePlan(planOver), {
    brief: "x", targetSec: 30, format: "9:16", language: "id", fonts: ["Plus Jakarta Sans", "Inter", "Mine Display"], imageConnected: false, narration: false,
  }).plan as Plan;
  store.saveGenProject({
    id: "p1", title: null, brief: "x", format: "9:16", targetSec: 30, language: "id", styleNotes: null, preset: null, recipeId: "quick",
    recipe: json(recipe), ideaId: null, briefFlags: null, narrationScript: null, concept: null, stepIndex: 0, stepState: null, narration: 0,
    storylines: null, pickedStoryline: null, status: "BUILDING", currentPlanId: "pl1", acceptedVersionId: null, errorMessage: null, createdAt: T, updatedAt: T,
  });
  store.saveGenPlan({ id: "pl1", projectId: "p1", revision: 1, plan: json(plan), changeRequest: null, changeSummary: null, approvedAt: T, createdAt: T });
  const dir = join(config.genDir, "p1", "v1");
  store.saveGenVersion({
    id: "v1", projectId: "p1", planId: "pl1", number: 1, parentVersionId: null, status: "BUILDING", step: null, progress: null, projectDir: dir,
    renderKind: "draft", draftPath: null, stepState: null, hyperframesVersion: null, buildMs: null, errorMessage: null, createdAt: T, updatedAt: T,
  });
  for (const a of assets) store.saveGenAsset(a);
  const fake = fakeHyperframes(handlers);
  const { llm, requests } = fakeLlm(replies);
  const progress: number[] = [];
  const ctxFor = (use: "author" | "check" | "render" | "export", settings: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => {
    const step = { ...recipe.steps.find((s) => s.use === use)!, with: { ...recipe.steps.find((s) => s.use === use)!.with, ...settings } };
    return {
      project: store.getGenProject("p1")!, version: store.getGenVersion("v1")!, recipe, step, settings: settingsOf(use, step.with), store,
      log: new DirectorLog(store), director: new Director(llm, new DirectorLog(store), "../generator"),
      hyperframes: new Hyperframes(config, fake.exec), jev: {} as never, exec: fake.exec, config, connected: () => false, catalog: async () => [],
      progress: (p: number) => { progress.push(Math.round(p)); }, ...extra,
    };
  };
  return { config, store, dir, plan, fake, requests, progress, ctxFor, events: () => store.genEventsForProject("p1").reverse() };
}
const scenes = (dir: string) => [0, 1, 2].map((i) => readFileSync(join(dir, `compositions/shot-0${i + 1}.html`), "utf-8"));
const upload = (id: string, kind: GenAsset["kind"], path: string, meta: string | null = null): GenAsset =>
  ({ id, projectId: "p1", kind, origin: "upload", path, shotId: null, promptHash: null, meta, createdAt: T });

/** A context with the built-in kit and its capability description, at `level` unless a record says otherwise. */
function withKit(r: ReturnType<typeof rig>) {
  const kit = new Kit(r.config, r.store, new Hyperframes(r.config, r.fake.exec), r.fake.exec);
  kit.syncBuiltIns();
  const capabilities = (level = "compose" as const, parts?: string[]) => capabilitiesFor({ level, parts, kit: kit.manifests(), config: r.config, connected: () => false });
  return { kit, capabilities };
}
const kitAnswer = (id: string) => json({ shotId: id, layers: [{ part: "particles", settings: { kind: "snow" }, fromSec: 0, toSec: 5 }] });

describe("director levels", () => {
  test("a new model writes at the kit level: Sorot writes the scenes from its answers and the version records each shot's level", async () => {
    const r = rig([kitAnswer("s01"), kitAnswer("s02"), kitAnswer("s03")]);
    await STEPS.author.run(r.ctxFor("author", {}, withKit(r)));
    expect(r.requests.map((q) => q.tool_choice.function.name)).toEqual(["submit_shot_kit", "submit_shot_kit", "submit_shot_kit"]);
    expect(scenes(r.dir)[1]).toContain('SorotKitRuntime.mount("particles", layers[0]');
    expect(JSON.parse(r.store.getGenVersion("v1")!.shotLevels!)).toEqual({ s01: { planned: "kit", built: "kit" }, s02: { planned: "kit", built: "kit" }, s03: { planned: "kit", built: "kit" } });
    expect(recordOf(r.store, "m")).toMatchObject({ kit: { asked: 3, firstPass: 3 } });
    expect(readFindings(r.dir)).toEqual([]);
  });

  test("a shot that still fails at its level after the repairs is rebuilt one level down, with a level_drop finding; the record counts it", async () => {
    const lost = html(1, "Judul lain");
    const r = rig([html(0), lost, lost, kitAnswer("s02"), html(2)], {}, { shots: samplePlan().shots.map((s: any) => ({ ...s, level: "compose" })) });
    setModelPin(r.store, "m", "compose");
    await STEPS.author.run(r.ctxFor("author", { repairRounds: 1 }, withKit(r)));
    expect(JSON.parse(r.store.getGenVersion("v1")!.shotLevels!).s02).toEqual({ planned: "compose", built: "kit", reason: "compose didn't pass: scene_missing_text" });
    expect(readFindings(r.dir)).toMatchObject([{ code: "level_drop", severity: "should-fix", shotId: "s02", rule: "levels" }]);
    expect(recordOf(r.store, "m")).toMatchObject({ compose: { asked: 3, firstPass: 2, dropped: 1 }, kit: { asked: 1, firstPass: 1 } });
  });

  test("a kit-level answer that fails its checks is asked again with what was wrong, up to the repair rounds; only then does the build fail", async () => {
    const r = rig(["not json", "still not json", kitAnswer("s01"), kitAnswer("s02"), kitAnswer("s03")]);
    await STEPS.author.run(r.ctxFor("author", { repairRounds: 1 }, withKit(r)));
    expect(JSON.parse(r.requests[2]!.messages.at(-1)!.content).findings[0]).toMatchObject({ code: "kit_answer_refused" });
    const stubborn = rig(["not json", "still not json", "no", "nope"]);
    await expect(STEPS.author.run(stubborn.ctxFor("author", { repairRounds: 1 }, withKit(stubborn)))).rejects.toThrow("Shot s01 couldn't be built at any level, not even from kit parts");
  });

  test("the check step fixes a kit-level shot as kit parts, never as the model's own HTML", async () => {
    const r = rig([kitAnswer("s01"), kitAnswer("s02"), kitAnswer("s03"), kitAnswer("s02")], {
      lint: (() => { let n = 0; return () => (n++ === 0 ? lint(finding("bad_markup", "error", { file: "compositions/shot-02.html" })) : lint()); })(),
      check: () => check(),
    });
    const k = withKit(r);
    await STEPS.author.run(r.ctxFor("author", {}, k));
    await STEPS.check.run(r.ctxFor("check", { rounds: 1 }, k));
    expect(r.requests.map((q) => q.tool_choice.function.name)).toEqual(["submit_shot_kit", "submit_shot_kit", "submit_shot_kit", "submit_shot_kit"]);
    expect(JSON.parse(r.requests[3]!.messages.at(-1)!.content).findings).toMatchObject([{ code: "bad_markup" }]);
    expect(scenes(r.dir)[1]).toContain('SorotKitRuntime.mount("particles", layers[0]');
  });

  test("a heavy shot over the frame budget is rebuilt one level down by the check step", async () => {
    const heavy = html(1, SAMPLE_TITLES[1], "<script>document.createElement('canvas').getContext('webgl');</script>");
    const r = rig([html(0), heavy, html(2), html(1)], { check: () => check() }, { shots: samplePlan().shots.map((s: any) => ({ ...s, level: "free" })) });
    const k = withKit(r);
    setModelPin(r.store, "m", "free");
    await STEPS.author.run(r.ctxFor("author", {}, k));
    let t = 0;
    const ticks = [0, 1000, 1000, 5000];   // one snapshot 1 s; three snapshots 4 s: 1.5 s a frame, over the 1 s budget
    await STEPS.check.run(r.ctxFor("check", {}, { ...k, clock: () => ticks[Math.min(t++, ticks.length - 1)]! }));
    expect(r.fake.calls.filter((c) => c[0] === "snapshot").map((c) => c[2])).toEqual(["--at", "--at"]);
    expect(JSON.parse(r.store.getGenVersion("v1")!.shotLevels!).s02).toMatchObject({ planned: "free", built: "compose" });
    expect(readFindings(r.dir).find((f) => f.code === "frame_budget")).toMatchObject({ shotId: "s02", description: "s02 was rebuilt at the compose level after free didn't pass (one frame took 1500 ms to draw; the budget here is 1000 ms)." });
  });
});

describe("author step", () => {
  test("the recorded voice is laid on its own track where its shot starts; the music bed ducks under it; a failed image is a polish finding", async () => {
    const r = rig([html(0), html(1), html(2)], {}, {}, [upload("m1", "music", "assets/bed.mp3")]);
    mkdirSync(join(r.config.genDir, "p1", "assets"), { recursive: true });
    writeFileSync(join(r.config.genDir, "p1", "assets/bed.mp3"), "bed");
    const row = r.store.getGenPlan("pl1")!;
    const narrated = { ...r.plan, sound: { music: "none", narration: true }, shots: r.plan.shots.map((x, i) => (i === 1 ? { ...x, narration: "Uang tumbuh sendiri. Mulai dari sekarang." } : x)) };
    r.store.saveGenPlan({ ...row, plan: JSON.stringify(narrated) });
    const spoken = ["l1", "l2"].map((id, i) => ({ id, text: ["Uang tumbuh sendiri.", "Mulai dari sekarang."][i]!, file: join(tmp, `${id}.mp3`), durationSec: 2 + i, words: null }));
    for (const l of spoken) writeFileSync(l.file, `voice-${l.id}`);
    writeVoice(r.config, "p1", { engine: "openai", voice: "alloy", lines: spoken, aligned: null });
    writeFileSync(join(r.config.genDir, "p1", "music.json"), JSON.stringify({ assetId: "m1", path: "assets/bed.mp3", duckUnderVoiceDb: -12 }));
    writeFileSync(join(r.config.genDir, "p1", "images.json"), JSON.stringify([{ shotId: "s01", reason: "quota exceeded" }]));
    await STEPS.author.run(r.ctxFor("author"));
    const root = readFileSync(join(r.dir, "index.html"), "utf-8");
    expect(root).toContain('id="voice-l1" class="clip" src="assets/voice-l1.mp3" data-start="10" data-duration="2"');
    expect(root).toContain('id="voice-l2" class="clip" src="assets/voice-l2.mp3" data-start="12.15" data-duration="3"');
    expect(readFileSync(join(r.dir, "assets/voice-l2.mp3"), "utf-8")).toBe("voice-l2");
    expect(root).toContain('id="music" class="clip" src="assets/bed.mp3" data-start="0" data-duration="30" data-track-index="1" data-volume="0.03"');
    expect(readFindings(r.dir)).toMatchObject([{ severity: "polish", code: "image_fallback", shotId: "s01", source: "author" }]);
  });

  test("the root loads the kit parts the recipe requires, the plan's looks name and the scenes mount; the version records them", async () => {
    const mount = `<script>SorotKitRuntime.mount("particles", document.body, {}, { tl: gsap.timeline(), duration: 2 }); SorotKit["neon"];</script>`;
    const r = rig([html(0), html(1, SAMPLE_TITLES[1], mount), html(2)]);
    const looked = { ...r.plan, shots: r.plan.shots.map((s, i) => (i === 0 ? { ...s, look: { description: "lit coin", values: { lightAngleDeg: 290 }, parts: [{ part: "shade", settings: {} }] } } : s)) };
    r.store.saveGenPlan({ ...r.store.getGenPlan("pl1")!, plan: JSON.stringify(looked) });
    const kit = new Kit(r.config, r.store, new Hyperframes(r.config, r.fake.exec), r.fake.exec);
    kit.syncBuiltIns();
    await STEPS.author.run(r.ctxFor("author", { require: ["kit:camera", "typography"] }, { kit }));
    const root = readFileSync(join(r.dir, "index.html"), "utf-8");
    expect([...root.matchAll(/assets\/kit\/([\w-]+)\/part\.js/g)].map((m) => m[1])).toEqual(["camera", "particles", "shade"]);
    expect(root).toContain('"keyLightDeg":290');
    expect(existsSync(join(r.dir, "assets/kit/_runtime.js")) && existsSync(join(r.dir, "assets/kit/particles/part.js"))).toBe(true);
    // "neon" isn't installed: nothing to load (the scene check reports it)
    expect(JSON.parse(r.store.getGenVersion("v1")!.kit!)).toMatchObject({ parts: ["camera", "particles", "shade"], partVersions: { shade: "1.0.0" } });
  });

  test("lays out the project, then writes one scene per shot", async () => {
    const r = rig([html(0), html(1), html(2)]);
    const result = await STEPS.author.run(r.ctxFor("author"));
    expect(result).toEqual({ status: "done", outputRef: r.dir });

    // the HyperFrames project: made once, at the project's format
    expect(r.fake.calls.filter((c) => c[0] === "init")).toEqual([["init", r.dir, "--non-interactive", "--skip-skills", "--resolution", "portrait", "--example", "blank"]]);
    expect(existsSync(join(r.dir, "assets/gsap.min.js"))).toBe(true);
    expect(existsSync(join(r.dir, "assets/fonts/plus-jakarta-sans-latin-700-normal.woff2"))).toBe(true);
    expect(existsSync(join(r.dir, "assets/fonts/inter-latin-400-normal.woff2"))).toBe(false);   // only what the plan uses

    // the root: the plan's shots, in order, with its timing
    const root = readFileSync(join(r.dir, "index.html"), "utf-8");
    expect(root).toContain('data-composition-src="compositions/shot-02.html" data-start="10" data-duration="10" data-width="1080" data-height="1920"');
    expect(root).toContain('font-family: "Plus Jakarta Sans"; font-weight: 700');
    expect(scenes(r.dir).map((s) => s.includes("<h1"))).toEqual([true, true, true]);

    // each scene call carried its own shot; nothing was left to repair
    expect(r.requests).toHaveLength(3);
    expect(JSON.parse(r.requests[2]!.messages[1]!.content)).toMatchObject({ compositionId: "shot-03", shot: { id: "s03" }, size: { width: 1080, height: 1920 } });
    expect(readFindings(r.dir)).toEqual([]);
    expect(r.progress).toEqual([33, 67, 100]);
  });

  test("a scene call the gateway drops doesn't stop the others: it gets one more try at the end; a second drop, or a lasting error, fails the step", async () => {
    const down = () => [gatewayDown(), gatewayDown(), gatewayDown()];   // the client's own three tries
    const r = rig([...down(), html(1), html(2), html(0)]);
    await STEPS.author.run(r.ctxFor("author"));
    expect(r.requests.map((q) => JSON.parse(q.messages[1]!.content).compositionId)).toEqual(["shot-01", "shot-01", "shot-01", "shot-02", "shot-03", "shot-01"]);
    expect(scenes(r.dir).map((s) => s.includes("<h1"))).toEqual([true, true, true]);
    const twice = rig([...down(), html(1), html(2), ...down()]);
    await expect(STEPS.author.run(twice.ctxFor("author"))).rejects.toThrow("upstream unavailable");
    const thought = rig([new ThoughtTooLong(), html(1), html(2), html(0)]);   // thought past its budget: asked again once, later
    await STEPS.author.run(thought.ctxFor("author"));
    expect(scenes(thought.dir).map((s) => s.includes("<h1"))).toEqual([true, true, true]);
    const spent = rig([new Error("quota exceeded"), html(1), html(2)]);   // not transient: no second pass
    await expect(STEPS.author.run(spent.ctxFor("author"))).rejects.toThrow("quota exceeded");
  });

  test("a scene that breaks the plan goes back with its findings; what is fixed is not reported", async () => {
    const r = rig([html(0, "Judul yang salah"), html(0), html(1), html(2)]);
    await STEPS.author.run(r.ctxFor("author"));
    expect(r.requests).toHaveLength(4);
    const repair = JSON.parse(r.requests[1]!.messages[1]!.content);
    expect(repair.findings[0]).toMatchObject({ code: "scene_missing_text" });
    expect(repair.currentHtml).toContain("Judul yang salah");
    expect(scenes(r.dir)[0]).toContain("Bunga berbunga?");
    expect(readFindings(r.dir)).toEqual([]);
  });

  test("after the repair rounds what is still wrong is a must-fix finding, and the scene is kept", async () => {
    const bad = html(0, "Salah");
    const r = rig([bad, bad, bad, html(1), html(2)]);
    await STEPS.author.run(r.ctxFor("author", { repairRounds: 2 }));
    expect(r.events().map((e) => e.kind)).toEqual(["scene", "repair", "repair", "scene", "scene"]);
    expect(readFindings(r.dir)).toEqual([expect.objectContaining({
      id: "author-1", source: "author", severity: "must-fix", shotId: "s01", code: "scene_missing_text", state: "open", rule: "plan-lock",
    })]);
    expect(scenes(r.dir)[0]).toContain("Salah");

    const none = rig([bad, html(1), html(2)]);
    await STEPS.author.run(none.ctxFor("author", { repairRounds: 0 }));
    expect(none.requests).toHaveLength(3);
    expect(readFindings(none.dir)).toHaveLength(1);
  });

  test("with a concurrency setting several scenes are written at once; the files and findings still follow the plan's order", async () => {
    const peak = { now: 0, max: 0 };
    const answerFor = (body: any) => {
      const sent = JSON.parse(body.messages[1].content);
      // shot 2's scene breaks the plan, so it leaves a finding (repairs are off)
      return json({ html: sceneHtml(Number(sent.compositionId.slice(-2)) - 1, sent.compositionId === "shot-02" ? "Salah" : SAMPLE_TITLES[Number(sent.compositionId.slice(-2)) - 1]) });
    };
    const fetchFn = (async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      peak.max = Math.max(peak.max, ++peak.now);
      await new Promise((r) => setTimeout(r, 15));
      peak.now--;
      const call = { id: "c", type: "function", function: { name: body.tool_choice.function.name, arguments: answerFor(body) } };
      return Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [call] } }] });
    }) as unknown as typeof fetch;
    const concurrent = rig([]);
    const llm = new Llm({ llmBaseUrl: "http://llm/v1", llmModel: "m", llmApiKey: "", llmTimeoutSec: 5 }, fetchFn, 0);
    const ctx = concurrent.ctxFor("author", { repairRounds: 0, concurrency: 3 });
    ctx.director = new Director(llm, new DirectorLog(concurrent.store), "../generator");
    await STEPS.author.run(ctx);
    expect(peak.max).toBe(3);
    expect(scenes(concurrent.dir).map((s) => /<h1 class="title">([^<]*)</.exec(s)![1])).toEqual(["Bunga berbunga?", "Salah", "Mulai dari sekarang"]);
    expect(readFindings(concurrent.dir).map((f) => [f.shotId, f.code])).toEqual([["s02", "scene_missing_text"]]);
    expect(concurrent.progress.at(-1)).toBe(100);

    peak.max = 0;
    const one = rig([]);
    const ctx1 = one.ctxFor("author", { repairRounds: 0 });
    ctx1.director = new Director(llm, new DirectorLog(one.store), "../generator");
    await STEPS.author.run(ctx1);
    expect(peak.max).toBe(1);
  });

  test("a second run of the same version keeps clean scenes and the project; only a broken one is written again", async () => {
    const r = rig([html(0), html(1), html(2)]);
    await STEPS.author.run(r.ctxFor("author"));
    writeFileSync(join(r.dir, "compositions/shot-02.html"), sceneHtml(1, "Judul yang hilang"));
    const again = fakeLlm([html(1)]);
    const ctx = r.ctxFor("author");
    ctx.director = new Director(again.llm, new DirectorLog(r.store), "../generator");
    await STEPS.author.run(ctx);
    expect(again.requests).toHaveLength(1);
    expect(JSON.parse(again.requests[0]!.messages[1]!.content).compositionId).toBe("shot-02");
    expect(r.fake.calls.filter((c) => c[0] === "init")).toHaveLength(1);
    expect(scenes(r.dir)[1]).toContain("Uang tumbuh sendiri");
  });

  test("the owner's files, fonts and music come along; the shots may use them", async () => {
    const files = [
      upload("a1", "logo", "assets/aaaaaaaa-logo.png"), upload("f1", "font", "assets/bbbbbbbb-Mine.ttf", json({ family: "Mine Display" })),
      upload("m1", "music", "assets/cccccccc-lagu.mp3"), upload("x1", "image", "assets/dddddddd-gone.png"),
    ];
    const r = rig([html(0), html(1, undefined, '<img src="assets/aaaaaaaa-logo.png">'), html(2)],
      {}, { sound: { music: "m1", narration: false }, look: { palette: ["#0B1020"], fonts: ["Plus Jakarta Sans", "Mine Display"], pacing: "brisk", notes: "" } }, files);
    for (const f of files.slice(0, 3)) {
      mkdirSync(join(r.config.genDir, "p1/assets"), { recursive: true });
      writeFileSync(join(r.config.genDir, "p1", f.path), "bytes");
    }
    await STEPS.author.run(r.ctxFor("author"));
    expect(readFileSync(join(r.dir, "assets/aaaaaaaa-logo.png"), "utf-8")).toBe("bytes");
    expect(existsSync(join(r.dir, "assets/dddddddd-gone.png"))).toBe(false);   // the row's file was never there: nothing to copy
    const root = readFileSync(join(r.dir, "index.html"), "utf-8");
    expect(root).toContain('font-family: "Mine Display"; font-weight: 400; src: url("assets/bbbbbbbb-Mine.ttf")');
    expect(root).toContain('<audio id="music" class="clip" src="assets/cccccccc-lagu.mp3"');
    expect(JSON.parse(r.requests[0]!.messages[1]!.content).assets).toEqual(["assets/aaaaaaaa-logo.png", "assets/bbbbbbbb-Mine.ttf", "assets/cccccccc-lagu.mp3", "assets/dddddddd-gone.png"]);
    expect(readFindings(r.dir)).toEqual([]);   // the logo the second scene uses is a known file
  });

  test("registry blocks are installed when the recipe allows them, and the shot that uses one gets its source", async () => {
    const r = rig([html(0), html(1), html(2)], {
      add: (args) => {
        mkdirSync(join(args[2]!, "compositions"), { recursive: true });
        writeFileSync(join(args[2]!, "compositions/data-chart.html"), `<div>${"c".repeat(7000)}</div>`);
        return procOk("{}");
      },
    }, { blocks: ["data-chart"], shots: samplePlan().shots.map((s: any, i: number) => (i === 1 ? { ...s, visual: { ...s.visual, block: "data-chart" } } : s)) });
    await STEPS.author.run(r.ctxFor("author"));
    expect(r.fake.calls.find((c) => c[0] === "add")).toEqual(["add", "--dir", r.dir, "--no-clipboard", "data-chart", "--json"]);
    const second = JSON.parse(r.requests[1]!.messages[1]!.content);
    expect(Object.keys(second.blocks)).toEqual(["data-chart"]);
    expect(second.blocks["data-chart"]).toHaveLength(6000);
    expect(JSON.parse(r.requests[0]!.messages[1]!.content).blocks).toEqual({});

    const off = rig([html(0), html(1), html(2)], {}, { blocks: ["data-chart"] });
    const ctx = off.ctxFor("author");
    ctx.recipe.steps.find((s) => s.use === "plan")!.with = { blocks: false };
    await STEPS.author.run(ctx);
    expect(off.fake.calls.some((c) => c[0] === "add")).toBe(false);
  });

  test("refuses to run without its inputs", async () => {
    const r = rig([]);
    await expect(STEPS.author.run({ ...r.ctxFor("author"), version: null })).rejects.toThrow("needs a version with a project folder");
    await expect(STEPS.author.run({ ...r.ctxFor("author"), version: { ...r.store.getGenVersion("v1")!, planId: "nope" } })).rejects.toThrow("plan is missing");
    const noGsap = r.ctxFor("author");
    noGsap.config = { ...noGsap.config, gsapFile: join(tmp, "missing.js") };
    await expect(STEPS.author.run(noGsap)).rejects.toThrow("The GSAP file isn't at");
  });
});

describe("check step", () => {
  /** A built project with its three scenes, ready to be checked. */
  async function built(handlers: Record<string, HfHandler>, replies: Parameters<typeof fakeLlm>[0] = [], planOver: Record<string, unknown> = {}) {
    // the real CLI's sample output has a static-scene warning: a clean check is an empty one
    const r = rig([html(0), html(1), html(2), ...replies], { check: () => check(), ...handlers }, planOver);
    await STEPS.author.run(r.ctxFor("author"));
    r.requests.length = 0;
    return r;
  }
  const answers = (...each: Array<ReturnType<typeof lint> | (() => ReturnType<typeof lint>)>) => {
    let i = 0;
    return (() => { const a = each[Math.min(i++, each.length - 1)]!; return typeof a === "function" ? a() : a; }) as HfHandler;
  };

  test("a clean project has no findings and no repair", async () => {
    const r = await built({});
    expect(await STEPS.check.run(r.ctxFor("check"))).toEqual({ status: "done", outputRef: r.dir });
    expect(r.requests).toHaveLength(0);
    expect(readFindings(r.dir)).toEqual([]);
    expect(r.fake.calls.map((c) => c[0]).filter((c) => c === "lint" || c === "check")).toEqual(["lint", "check"]);
  });

  test("a lint error is repaired in its shot, then the project is checked again", async () => {
    const r = await built(
      { lint: answers(lint(finding("missing_timeline_registry", "error", { file: "x/compositions/shot-02.html" })), lint()) },
      [json({ html: sceneHtml(1, "Uang tumbuh sendiri", "<!-- repaired -->") })],
    );
    await STEPS.check.run(r.ctxFor("check"));
    const asked = JSON.parse(r.requests[0]!.messages[1]!.content);
    expect(asked).toMatchObject({ compositionId: "shot-02", findings: [{ code: "missing_timeline_registry", message: "missing_timeline_registry happened", hint: "fix missing_timeline_registry" }] });
    expect(scenes(r.dir)[1]).toContain("repaired");
    expect(r.fake.calls.filter((c) => c[0] === "lint")).toHaveLength(2);   // round 1 (an error), round 2 (clean)
    expect(readFindings(r.dir)).toEqual([]);
  });

  test("findings are mapped to shots by file, selector or time; the ones that can't be mapped stay with the video; repeats are one with a count", async () => {
    const r = await built({ check: answers(check([
      finding("text_below_floor", "error", { selector: '[data-composition-id="shot-03"] .title' }),
      finding("line_unread", "warning", { time: 12.5, sourceFile: "index.html" }),
      finding("first_frame_empty", "error", { time: 99 }),
      finding("line_unread", "warning", { time: 11, sourceFile: "index.html" }),
    ])) }, [json({ html: sceneHtml(2) }), json({ html: sceneHtml(1) })]);
    await STEPS.check.run(r.ctxFor("check", { rounds: 1 }));
    const asked = r.requests.map((q) => JSON.parse(q.messages[1]!.content).compositionId);
    expect(asked).toEqual(["shot-03", "shot-02"]);   // shot 3 by selector, shot 2 by time (10 to 20 s)
    const found = readFindings(r.dir);
    expect(found.map((f) => [f.code, f.shotId, f.severity, f.fromSec, f.count])).toEqual([
      ["text_below_floor", "s03", "must-fix", undefined, undefined], ["line_unread", "s02", "should-fix", 11, 2], ["first_frame_empty", null, "must-fix", 99, undefined],
    ]);
  });

  test("with fix-or-hold a warning the director keeps on purpose is saved with its reason, and is not asked about again", async () => {
    const w = finding("sweep_static", "warning", { selector: '[data-composition-id="shot-01"]' });
    const r = await built({ check: answers(check([w])) }, [JSON.stringify({ html: sceneHtml(0), holds: [{ code: "sweep_static", reason: "a still title card" }] })]);
    await STEPS.check.run(r.ctxFor("check", { warnings: "fix-or-hold" }));
    expect(r.requests).toHaveLength(1);
    expect(readFindings(r.dir)).toEqual([expect.objectContaining({ code: "sweep_static", severity: "should-fix", state: "kept", keptReason: "a still title card", shotId: "s01" })]);
  });

  test("with fix a hold is ignored and the warning is asked about until the rounds run out; errors can never be held", async () => {
    const w = finding("sweep_static", "warning", { selector: '[data-composition-id="shot-01"]' });
    const e = finding("text_below_floor", "error", { selector: '[data-composition-id="shot-02"]' });
    const keep = JSON.stringify({ html: sceneHtml(0), holds: [{ code: "sweep_static", reason: "still" }] });
    const r = await built({ check: answers(check([w, e])) }, [keep, json({ html: sceneHtml(1) }), keep, json({ html: sceneHtml(1) })]);
    await STEPS.check.run(r.ctxFor("check", { warnings: "fix", rounds: 2 }));
    expect(r.requests).toHaveLength(4);
    expect(readFindings(r.dir).map((f) => [f.code, f.state, f.severity])).toEqual([["sweep_static", "open", "should-fix"], ["text_below_floor", "open", "must-fix"]]);
  });

  test("with report a warning is only listed (as polish), while an error is still repaired", async () => {
    const w = finding("sweep_static", "warning", { selector: '[data-composition-id="shot-01"]' });
    const e = finding("text_below_floor", "error", { selector: '[data-composition-id="shot-02"]' });
    const r = await built({ check: answers(check([w, e])) }, [json({ html: sceneHtml(1) })]);
    await STEPS.check.run(r.ctxFor("check", { warnings: "report", rounds: 1 }));
    expect(r.requests).toHaveLength(1);
    expect(JSON.parse(r.requests[0]!.messages[1]!.content).compositionId).toBe("shot-02");
    expect(readFindings(r.dir).map((f) => [f.code, f.severity])).toEqual([["sweep_static", "polish"], ["text_below_floor", "must-fix"]]);
  });

  test("a hold shot may stand still: its static warning is kept with the plan's reason and never repaired", async () => {
    const w = finding("sweep_static", "warning", { selector: '[data-composition-id="shot-02"]' });
    const r = await built({ check: answers(check([w])) }, [], { shots: samplePlan().shots.map((s: any, i: number) => (i === 1 ? { ...s, hold: true } : s)) });
    await STEPS.check.run(r.ctxFor("check"));
    expect(r.requests).toHaveLength(0);
    expect(readFindings(r.dir)).toEqual([expect.objectContaining({ code: "sweep_static", state: "kept", keptReason: "The plan marks this shot as a hold." })]);
  });

  test("HyperFrames' 'no sound' warning is the plan's own doing when the plan has no sound; with sound it is repaired like any warning", async () => {
    const silent = finding("film_silent", "warning", { time: 0 });
    const quiet = await built({ check: answers(check([silent])) });
    await STEPS.check.run(quiet.ctxFor("check"));
    expect(quiet.requests).toHaveLength(0);
    expect(readFindings(quiet.dir)).toEqual([expect.objectContaining({ code: "film_silent", shotId: "s01", state: "kept", keptReason: "The plan has no sound." })]);

    const withSound = await built({ check: answers(check([silent])) }, [json({ html: sceneHtml(0) })], { sound: { music: "m1", narration: false } });
    await STEPS.check.run(withSound.ctxFor("check", { rounds: 1 }));
    expect(withSound.requests).toHaveLength(1);
    expect(readFindings(withSound.dir)[0]).toMatchObject({ code: "film_silent", state: "open", severity: "should-fix" });
  });

  test("Studio-only warnings, Chrome's WebGL capture notes and info are dropped", async () => {
    const r = await built({
      lint: answers(lint(
        finding("studio_missing_editable_id", "warning", { selector: '[data-composition-id="shot-01"]' }), finding("note", "info"),
        { ...finding("console_warning", "warning"), message: "[.WebGL-0x1]GL Driver Message (OpenGL, Performance, GL_CLOSE_PATH_NV, High): GPU stall due to ReadPixels" },
      )),
    });
    await STEPS.check.run(r.ctxFor("check"));
    expect(readFindings(r.dir)).toEqual([]);
    expect(r.requests).toHaveLength(0);
  });

  test("a checker that can't run is a must-fix finding, so nothing is judged on a check that didn't happen", async () => {
    const r = await built({ check: () => ({ exitCode: 2, stdout: "", stderr: "no browser", timedOut: false, aborted: false }) });
    await STEPS.check.run(r.ctxFor("check"));
    expect(readFindings(r.dir)).toEqual([expect.objectContaining({ code: "checker_failed", severity: "must-fix", shotId: null })]);
    expect(readFindings(r.dir)[0]!.description).toContain("The check could not run");
  });

  test("a cancel is not a finding", async () => {
    const r = await built({ check: () => ({ exitCode: 137, stdout: "", stderr: "", timedOut: false, aborted: true }) });
    await expect(STEPS.check.run(r.ctxFor("check"))).rejects.toThrow("cancelled");
  });

  test("a scene that lost its planned text is repaired here too, and the author's stale finding goes away", async () => {
    const bad = html(0, "Salah");
    const r = rig([bad, html(1), html(2), html(0)], { check: () => check() });
    await STEPS.author.run(r.ctxFor("author", { repairRounds: 0 }));
    expect(readFindings(r.dir).map((f) => f.source)).toEqual(["author"]);
    r.requests.length = 0;
    await STEPS.check.run(r.ctxFor("check"));
    expect(r.requests).toHaveLength(1);
    expect(scenes(r.dir)[0]).toContain("Bunga berbunga?");
    expect(readFindings(r.dir)).toEqual([]);
  });

  test("the repair rounds are a limit per shot; with none the findings are only reported", async () => {
    const e = finding("text_below_floor", "error", { selector: '[data-composition-id="shot-01"]' });
    const r = await built({ check: answers(check([e])) });
    await STEPS.check.run(r.ctxFor("check", { rounds: 0 }));
    expect(r.requests).toHaveLength(0);
    expect(readFindings(r.dir)).toHaveLength(1);
  });

  test("the fixtures from the real CLI have the sections the step reads", () => {
    const real = JSON.parse(hfFixture("check-ok"));
    expect(Object.keys(real)).toEqual(expect.arrayContaining(["lint", "runtime", "layout"]));
    expect(real.layout.findings[0].code).toBe("sweep_static");
  });
});

describe("render step", () => {
  const rendered = (r: ReturnType<typeof rig>) => r.fake.calls.find((c) => c[0] === "render")!;

  test("draft: renders the project at the recipe's frame rate and records the video on the version", async () => {
    const r = rig([]);
    mkdirSync(r.dir, { recursive: true });
    const result = await STEPS.render.run(r.ctxFor("render"));
    expect(result).toEqual({ status: "done", outputRef: join(r.dir, "draft.mp4") });
    expect(rendered(r)).toEqual(["render", r.dir, "-o", join(r.dir, "draft.mp4"), "-q", "draft", "-f", "30", "--quiet", "-w", "2", "--gpu"]);
    expect(r.store.getGenVersion("v1")).toMatchObject({ renderKind: "draft", draftPath: join(r.dir, "draft.mp4"), hyperframesVersion: r.config.hyperframesVersion });
    expect(readFileSync(join(r.dir, "draft.mp4"), "utf-8")).toBe("mp4-bytes");
  });

  test("delivery is the final render; the frame rate, workers and the CPU switch come from settings and the install", async () => {
    const r = rig([]);
    mkdirSync(r.dir, { recursive: true });
    const ctx = r.ctxFor("render", { quality: "delivery", fps: 24, workers: 4 });
    ctx.config = { ...ctx.config, whisperDevice: "cpu" };
    await STEPS.render.run(ctx);
    expect(rendered(r)).toEqual(["render", r.dir, "-o", join(r.dir, "final.mp4"), "-q", "delivery", "-f", "24", "--quiet", "-w", "4"]);
    expect(r.store.getGenVersion("v1")).toMatchObject({ renderKind: "final", draftPath: join(r.dir, "final.mp4") });
  });

  test("standard quality is a draft-kind render at HyperFrames' looks preset", async () => {
    const r = rig([]);
    mkdirSync(r.dir, { recursive: true });
    await STEPS.render.run(r.ctxFor("render", { quality: "standard" }));
    expect(rendered(r).slice(4, 6)).toEqual(["-q", "looks"]);
    expect(r.store.getGenVersion("v1")!.renderKind).toBe("draft");
  });

  test("progress lines from the renderer reach the version", async () => {
    const r = rig([]);
    mkdirSync(r.dir, { recursive: true });
    const exec: ExecFn = async (_n, args, opts) => {
      opts?.onStderrLine?.("frames 25%");
      opts?.onStderrLine?.("frames 80%");
      writeFileSync(args[args.indexOf("-o") + 1]!, "mp4");
      return procOk();
    };
    const ctx = r.ctxFor("render", {}, { hyperframes: new Hyperframes(r.config, exec) });
    await STEPS.render.run(ctx);
    expect(r.progress).toEqual([25, 80]);
  });

  test("a render that leaves no video, or an empty one, is an error; a failed render passes its error on", async () => {
    const none = rig([], { render: () => procOk() });
    mkdirSync(none.dir, { recursive: true });
    await expect(STEPS.render.run(none.ctxFor("render"))).rejects.toThrow("left no video");
    const empty = rig([], { render: (args) => { writeFileSync(args[args.indexOf("-o") + 1]!, ""); return procOk(); } });
    mkdirSync(empty.dir, { recursive: true });
    await expect(STEPS.render.run(empty.ctxFor("render"))).rejects.toThrow("left no video");
    const failed = rig([], { render: () => ({ exitCode: 1, stdout: "", stderr: "chrome crashed", timedOut: false, aborted: false }) });
    await expect(STEPS.render.run(failed.ctxFor("render"))).rejects.toThrow("chrome crashed");
    expect(failed.store.getGenVersion("v1")!.draftPath).toBeNull();
  });
});

describe("export step", () => {
  const verdict = (r: ReturnType<typeof rig>, status: "PASS" | "REVIEW" | "FAIL") =>
    r.store.saveGenVerdict({ id: "vd1", versionId: "v1", kind: "TECHNICAL", status, findings: "[]", judgedBy: "code", inputs: null, createdAt: T });
  const exported = (r: ReturnType<typeof rig>) => join(r.config.genDir, "p1", "exports", "v1.mp4");
  const COPY = json({ title: "Bunga berbunga", description: "Uang tumbuh sendiri, mulai sekarang." });

  test("a rerender writes the video to the project's exports folder and a row with the director's title and description", async () => {
    const r = rig([COPY]);
    mkdirSync(r.dir, { recursive: true });
    verdict(r, "PASS");
    const result = await STEPS.export.run(r.ctxFor("export"));
    const row = r.store.getGenExportForVersion("v1")!;
    expect(result).toEqual({ status: "done", outputRef: row.id });
    expect(rendered(r)).toEqual(["render", r.dir, "-o", exported(r), "-q", "delivery", "-f", "30", "--quiet", "-w", "2", "--gpu"]);
    expect(row).toMatchObject({ projectId: "p1", versionId: "v1", path: exported(r), format: "9:16", durationSec: 30, title: "Bunga berbunga", description: "Uang tumbuh sendiri, mulai sekarang." });
    expect(readFileSync(exported(r), "utf-8")).toBe("mp4-bytes");
  });
  const rendered = (r: ReturnType<typeof rig>) => r.fake.calls.find((c) => c[0] === "render")!;

  test("mode copy reuses a delivery render without rendering again; a draft render is rendered anew", async () => {
    const r = rig([COPY, COPY]);
    mkdirSync(r.dir, { recursive: true });
    verdict(r, "REVIEW");
    writeFileSync(join(r.dir, "final.mp4"), "final-bytes");
    r.store.updateGenVersion("v1", { renderKind: "final", draftPath: join(r.dir, "final.mp4") });
    await STEPS.export.run(r.ctxFor("export", { mode: "copy" }));
    expect(r.fake.calls.some((c) => c[0] === "render")).toBeFalse();
    expect(readFileSync(exported(r), "utf-8")).toBe("final-bytes");
    r.store.updateGenVersion("v1", { renderKind: "draft" });
    await STEPS.export.run(r.ctxFor("export", { mode: "copy" }));
    expect(rendered(r)).toBeDefined();
  });

  test("the owner's title and description are used as typed (no director call); exporting again updates the same row", async () => {
    const r = rig([]);
    mkdirSync(r.dir, { recursive: true });
    verdict(r, "PASS");
    const first = await STEPS.export.run(r.ctxFor("export", { title: " Judul saya ", description: "Isi saya" }));
    const again = await STEPS.export.run(r.ctxFor("export", { title: "Judul baru", description: "Isi saya" }));
    expect(again.outputRef).toBe(first.outputRef);
    expect(r.store.listGenExports()).toHaveLength(1);
    expect(r.store.getGenExportForVersion("v1")).toMatchObject({ title: "Judul baru", description: "Isi saya" });
    expect(r.requests).toHaveLength(0);
  });

  test("copy the director can't write falls back to the plan's title and message", async () => {
    const r = rig([json({ title: "", description: "" }), json({ title: "", description: "" })]);
    mkdirSync(r.dir, { recursive: true });
    verdict(r, "PASS");
    await STEPS.export.run(r.ctxFor("export"));
    expect(r.store.getGenExportForVersion("v1")).toMatchObject({ title: r.plan.title, description: r.plan.message });
  });

  test.each([
    ["a TECHNICAL FAIL", "FAIL", "TECHNICAL failed"],
    ["no TECHNICAL verdict yet", null, "no TECHNICAL verdict"],
  ] as const)("%s refuses to export", async (_name, status, message) => {
    const r = rig([]);
    mkdirSync(r.dir, { recursive: true });
    if (status) verdict(r, status);
    await expect(STEPS.export.run(r.ctxFor("export"))).rejects.toThrow(message);
    expect(r.store.listGenExports()).toHaveLength(0);
  });

  test("a render that leaves no video is an error", async () => {
    const r = rig([], { render: () => procOk() });
    mkdirSync(r.dir, { recursive: true });
    verdict(r, "PASS");
    await expect(STEPS.export.run(r.ctxFor("export"))).rejects.toThrow("left no video");
  });
});
