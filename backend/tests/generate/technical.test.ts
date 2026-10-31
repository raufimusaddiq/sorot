import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/config";
import { openDatabase } from "../../src/db";
import { Director } from "../../src/generate/director";
import { DirectorLog } from "../../src/generate/events";
import { readFindings, saveFindings, type NewFinding } from "../../src/generate/findings";
import { validatePlan, type Plan } from "../../src/generate/planSchema";
import { STEPS, settingsOf } from "../../src/generate/steps";
import {
  audioFindings, fpsOf, outputFindings, parseProbe, parseVolume, planHasSound, readabilityFindings, verdictOf, type Probe,
} from "../../src/generate/technical";
import type { ExecFn } from "../../src/runner";
import { Store } from "../../src/store";
import { fakeLlm, procOk, quickRecipe, samplePlan } from "../helpers";

const T = "2026-01-01T00:00:00.000Z";
const plan = (over: Record<string, unknown> = {}) => validatePlan(samplePlan(over), {
  brief: "x", targetSec: 30, format: "9:16", language: "id", fonts: ["Plus Jakarta Sans"], imageConnected: false, narration: true,
}).plan as Plan;

const probeOf = (over: Partial<{ width: number; height: number; fps: string; duration: string; audio: boolean; video: boolean }> = {}): Probe => ({
  streams: [
    ...(over.video === false ? [] : [{ codec_type: "video", width: over.width ?? 1080, height: over.height ?? 1920, avg_frame_rate: over.fps ?? "30/1", duration: over.duration ?? "30.000000" }]),
    ...(over.audio ? [{ codec_type: "audio", duration: "30.0" }] : []),
  ],
  format: { duration: over.duration ?? "30.000000" },
});
const want = { width: 1080, height: 1920, fps: 30, durationSec: 30, minSec: 5, maxSec: 90 };
const tol = { fpsTolerance: 0.5, lengthToleranceSec: 0.1 };
const codes = (f: NewFinding[]) => f.map((x) => x.code);

describe("verdict rule", () => {
  const f = (severity: NewFinding["severity"], state: NewFinding["state"] = "open") => ({ severity, state });
  test.each([
    ["nothing found", [], "PASS"],
    ["polish only", [f("polish")], "PASS"],
    ["a should-fix", [f("polish"), f("should-fix")], "REVIEW"],
    ["a must-fix", [f("should-fix"), f("must-fix")], "FAIL"],
    ["a must-fix that was kept on purpose", [f("must-fix", "kept")], "PASS"],
    ["a should-fix that was kept", [f("should-fix", "kept"), f("polish")], "PASS"],
    ["a must-fix that was fixed", [f("must-fix", "fixed")], "PASS"],
    ["a kept one next to a live must-fix", [f("should-fix", "kept"), f("must-fix")], "FAIL"],
  ] as const)("%s: %s", (_name, findings, status) => {
    expect(verdictOf([...findings])).toBe(status);
  });
});

describe("ffprobe and ffmpeg output", () => {
  test("probe JSON is read; anything else is not a probe", () => {
    expect(parseProbe(JSON.stringify({ streams: [{ codec_type: "video" }] }))).toEqual({ streams: [{ codec_type: "video" }], format: {} });
    expect(parseProbe("not json")).toBeNull();
    expect(parseProbe("{}")).toBeNull();
    expect(parseProbe("null")).toBeNull();
  });

  test("frame rates", () => {
    expect(fpsOf("30/1")).toBe(30);
    expect(fpsOf("30000/1001")).toBeCloseTo(29.97, 2);
    expect(["0/0", undefined, "abc"].map((r) => Number.isNaN(fpsOf(r)))).toEqual([true, true, true]);
  });

  test("volumedetect lines", () => {
    expect(parseVolume("[Parsed_volumedetect_0] mean_volume: -18.4 dB\n[Parsed_volumedetect_0] max_volume: -2.0 dB")).toEqual({ mean: -18.4, max: -2 });
    expect(parseVolume("no audio")).toBeNull();
  });
});

describe("output measure", () => {
  test("a video of the right size, rate and length has no findings", () => {
    expect(outputFindings(probeOf(), want, tol)).toEqual([]);
    expect(outputFindings(probeOf({ fps: "30000/1001", duration: "30.05" }), want, tol)).toEqual([]);   // inside the tolerances
  });

  test.each([
    ["no probe at all", null, ["output_unplayable"]],
    ["no video stream", probeOf({ video: false, audio: true }), ["output_unplayable"]],
    ["the wrong size", probeOf({ width: 1920, height: 1080 }), ["output_size"]],
    ["the wrong frame rate", probeOf({ fps: "24/1" }), ["output_fps"]],
    ["an unknown frame rate", probeOf({ fps: "0/0" }), ["output_fps"]],
    ["a video 0.3 s too long", probeOf({ duration: "30.3" }), ["output_length"]],
    ["an unknown length", { streams: [{ codec_type: "video", width: 1080, height: 1920, avg_frame_rate: "30/1" }], format: {} }, ["output_length"]],
  ] as const)("%s", (_name, probe, expected) => {
    const found = outputFindings(probe as Probe | null, want, tol);
    expect(codes(found)).toEqual([...expected]);
    expect(found.every((x) => x.severity === "must-fix" && x.state === "open" && x.shotId === null)).toBe(true);
  });

  test("the plan has to be inside the recipe's length window; tolerances come from the recipe", () => {
    expect(codes(outputFindings(probeOf({ duration: "100" }), { ...want, durationSec: 100 }, tol))).toEqual(["output_window"]);
    expect(codes(outputFindings(probeOf({ duration: "3" }), { ...want, durationSec: 3 }, tol))).toEqual(["output_window"]);
    expect(outputFindings(probeOf({ duration: "30.4", fps: "25/1" }), want, { fpsTolerance: 6, lengthToleranceSec: 0.5 })).toEqual([]);
  });
});

describe("readability measure", () => {
  const timed = (secs: number[], words: string[][]) => plan({
    shots: samplePlan().shots.map((s: any, i: number) => ({ ...s, durationSec: secs[i], text: words[i]!.map((value) => ({ role: "body", value })) })),
  });

  test("text needs the base time plus a little per word", () => {
    const p = timed([10, 10, 10], [["a b c"], ["satu dua tiga empat lima enam tujuh delapan"], []]);
    expect(readabilityFindings(p, { holdBaseSec: 0.5, holdPerWordSec: 0.25 })).toEqual([]);
    const tight = readabilityFindings(p, { holdBaseSec: 5, holdPerWordSec: 1.6 });
    expect(tight.map((f) => [f.code, f.shotId, f.severity])).toEqual([["readability_hold", "s02", "must-fix"]]);
    expect(tight[0]!.description).toContain("8 words on screen for 10 s; a viewer needs 17.8 s");
    expect(tight[0]).toMatchObject({ fromSec: 0, toSec: 10 });
  });

  test("a shot without words can't be too fast to read", () => {
    expect(readabilityFindings(timed([10, 10, 10], [[], [], []]), { holdBaseSec: 5, holdPerWordSec: 5 })).toEqual([]);
  });
});

describe("audio measure", () => {
  const limits = { minMeanVolumeDb: -40, maxTruePeakDb: -1 };
  test("a plan with sound needs an audio track; one can be heard and doesn't clip", () => {
    expect(codes(audioFindings(probeOf(), null, limits))).toEqual(["audio_missing"]);
    expect(audioFindings(probeOf(), null, limits)[0]!.severity).toBe("must-fix");
    expect(audioFindings(probeOf({ audio: true }), { mean: -20, max: -3 }, limits)).toEqual([]);
    expect(audioFindings(probeOf({ audio: true }), null, limits)).toEqual([]);   // couldn't measure: nothing to say
    const quiet = audioFindings(probeOf({ audio: true }), { mean: -55, max: -30 }, limits);
    expect(quiet.map((f) => [f.code, f.severity])).toEqual([["audio_too_quiet", "should-fix"]]);
    const loud = audioFindings(probeOf({ audio: true }), { mean: -10, max: 0 }, limits);
    expect(loud.map((f) => [f.code, f.severity])).toEqual([["audio_clipping", "should-fix"]]);
    expect(audioFindings(null, null, limits)[0]!.code).toBe("audio_missing");
  });

  test("which plans have sound", () => {
    const sound = (music: string, narration: boolean) => plan({ sound: { music, narration } });
    expect([planHasSound(sound("none", false)), planHasSound(sound("a1", false)), planHasSound(sound("none", true)), planHasSound(sound("", false))]).toEqual([false, true, true, false]);
  });
});

describe("technical step", () => {
  let tmp: string;
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  /** A version with a rendered file; ffprobe and ffmpeg answer from `media`. */
  function rig(opts: { planOver?: Record<string, unknown>; media?: { probe?: object | null; volume?: string }; rendered?: boolean; measures?: object; rules?: object; fps?: number } = {}) {
    tmp = mkdtempSync(join(tmpdir(), "vc-tech-"));
    const store = new Store(openDatabase(":memory:"));
    const recipe = quickRecipe();
    recipe.rules = opts.rules as Record<string, unknown> | undefined;
    const dir = join(tmp, "v1");
    mkdirSync(dir, { recursive: true });
    const video = join(dir, "draft.mp4");
    if (opts.rendered !== false) writeFileSync(video, "mp4");
    store.saveGenProject({
      id: "p1", title: null, brief: "x", format: "9:16", targetSec: 30, language: "id", styleNotes: null, preset: null, recipeId: "quick", recipe: JSON.stringify(recipe),
      ideaId: null, briefFlags: null, narrationScript: null, concept: null, stepIndex: 0, stepState: null, narration: 0, storylines: null, pickedStoryline: null,
      status: "BUILDING", currentPlanId: "pl1", acceptedVersionId: null, errorMessage: null, createdAt: T, updatedAt: T,
    });
    store.saveGenPlan({ id: "pl1", projectId: "p1", revision: 1, plan: JSON.stringify(plan(opts.planOver)), changeRequest: null, changeSummary: null, approvedAt: T, createdAt: T });
    store.saveGenVersion({
      id: "v1", projectId: "p1", planId: "pl1", number: 1, parentVersionId: null, status: "BUILDING", step: null, progress: null, projectDir: dir, renderKind: "draft",
      draftPath: video, stepState: null, hyperframesVersion: null, buildMs: null, errorMessage: null, createdAt: T, updatedAt: T,
    });
    const calls: string[][] = [];
    const exec: ExecFn = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd.includes("ffprobe")) return opts.media?.probe === null ? { ...procOk(), exitCode: 1 } : procOk(JSON.stringify(opts.media?.probe ?? probeOf({ audio: true })));
      return { ...procOk(), stderr: opts.media?.volume ?? "mean_volume: -20.0 dB\nmax_volume: -3.0 dB" };
    };
    const { llm } = fakeLlm([]);
    const step = { ...recipe.steps.find((s) => s.use === "technical")!, with: opts.measures ? { measures: opts.measures } : undefined };
    const ctx = {
      project: store.getGenProject("p1")!, version: store.getGenVersion("v1")!, recipe, step, settings: { ...settingsOf("technical", step.with), ...(opts.fps ? { fps: opts.fps } : {}) }, store,
      log: new DirectorLog(store), director: new Director(llm, new DirectorLog(store), "../generator"), hyperframes: {} as never, jev: {} as never, exec,
      config: { ...loadConfig({}), ffmpegPath: "/usr/bin/ffmpeg" }, connected: () => false, catalog: async () => [], progress: () => {},
    };
    return { store, dir, calls, ctx, verdict: () => store.genVerdictsForVersion("v1")[0]! };
  }

  test("a good build passes: one verdict, judged by code, listing every source it used", async () => {
    const r = rig();
    expect(await STEPS.technical.run(r.ctx)).toEqual({ status: "done", outputRef: "PASS" });
    expect(r.verdict()).toMatchObject({ kind: "TECHNICAL", status: "PASS", judgedBy: "code", findings: "[]" });
    expect(JSON.parse(r.verdict().inputs!)).toMatchObject({ render: { kind: "draft" }, shots: 3, measures: ["output", "planText", "layout", "readability", "firstFrame"] });
    expect(r.calls[0]![0]).toBe("/usr/bin/ffprobe");
    expect(r.calls).toHaveLength(1);   // the plan has no sound: no volume measurement
  });

  test("the build steps' findings count: a must-fix from the author step fails it, a kept warning does not", async () => {
    const r = rig();
    const found = (severity: NewFinding["severity"], extra: Partial<NewFinding> = {}): NewFinding => ({ severity, shotId: "s01", code: "x", description: "d", state: "open", ...extra });
    saveFindings(r.dir, "author", [found("must-fix", { code: "scene_missing_text" })]);
    saveFindings(r.dir, "check", [found("should-fix", { state: "kept", keptReason: "still card" })]);
    await STEPS.technical.run(r.ctx);
    expect(r.verdict().status).toBe("FAIL");
    expect(JSON.parse(r.verdict().findings).map((f: any) => [f.source, f.code, f.state])).toEqual([["author", "scene_missing_text", "open"], ["check", "x", "kept"]]);
    expect(JSON.parse(r.verdict().inputs!).sources).toEqual(["author", "check"]);

    const kept = rig();
    saveFindings(kept.dir, "check", [found("must-fix", { state: "kept", keptReason: "r" }), found("polish")]);
    await STEPS.technical.run(kept.ctx);
    expect(kept.verdict().status).toBe("PASS");
  });

  test("a title that doesn't fit its shot fails readability, with the finding on that shot; the recipe's rule sets the pace", async () => {
    const crowded = { shots: samplePlan().shots.map((s: any, i: number) => (i === 0 ? { ...s, durationSec: 1, text: [{ role: "title", value: "satu dua tiga empat lima enam" }] } : { ...s, durationSec: 14.5 })) };
    const r = rig({ planOver: crowded });
    await STEPS.technical.run(r.ctx);
    expect(r.verdict().status).toBe("FAIL");
    expect(readFindings(r.dir).find((f) => f.code === "readability_hold")).toMatchObject({ source: "technical", shotId: "s01", severity: "must-fix" });
    const slow = rig({ rules: { readability: { holdBaseSec: 20, holdPerWordSec: 1 } } });
    await STEPS.technical.run(slow.ctx);
    expect(readFindings(slow.dir).filter((f) => f.code === "readability_hold")).toHaveLength(3);
  });

  test("a video that isn't there, or that ffprobe can't read, is a must-fix", async () => {
    const none = rig({ rendered: false });
    await STEPS.technical.run(none.ctx);
    expect(none.verdict().status).toBe("FAIL");
    expect(readFindings(none.dir)[0]).toMatchObject({ code: "output_unplayable", description: "No video was rendered, so there is nothing to judge." });
    expect(none.calls).toHaveLength(0);
    const broken = rig({ media: { probe: null } });
    await STEPS.technical.run(broken.ctx);
    expect(readFindings(broken.dir)[0]!.code).toBe("output_unplayable");
  });

  test("the output measure uses the recipe's numbers and the project's format", async () => {
    const r = rig({ media: { probe: probeOf({ width: 1080, height: 1920, fps: "24/1", audio: false }) }, fps: 24, measures: { output: { lengthToleranceSec: 0.5 } } });
    await STEPS.technical.run(r.ctx);
    expect(r.verdict().status).toBe("PASS");
    const wrong = rig({ media: { probe: probeOf({ width: 1920, height: 1080 }) } });
    await STEPS.technical.run(wrong.ctx);
    expect(readFindings(wrong.dir).map((f) => f.code)).toEqual(["output_size"]);
  });

  test("a plan with sound is measured: no track fails, a quiet or loud one is a review", async () => {
    const sound = { sound: { music: "m1", narration: false } };
    const missing = rig({ planOver: sound, media: { probe: probeOf({ audio: false }) } });
    await STEPS.technical.run(missing.ctx);
    expect(missing.verdict().status).toBe("FAIL");
    expect(readFindings(missing.dir).map((f) => f.code)).toEqual(["audio_missing"]);
    expect(missing.calls).toHaveLength(1);   // nothing to measure without a track

    const loud = rig({ planOver: sound, media: { volume: "mean_volume: -9.0 dB\nmax_volume: 0.0 dB" } });
    await STEPS.technical.run(loud.ctx);
    expect(loud.verdict().status).toBe("REVIEW");
    expect(JSON.parse(loud.verdict().inputs!).measures).toContain("audio");

    const tuned = rig({ planOver: sound, media: { volume: "mean_volume: -30.0 dB\nmax_volume: -1.5 dB" }, measures: { audio: { minMeanVolumeDb: -25, maxTruePeakDb: -2 } } });
    await STEPS.technical.run(tuned.ctx);
    expect(readFindings(tuned.dir).map((f) => f.code)).toEqual(["audio_too_quiet", "audio_clipping"]);
  });

  test("the verdict is replaced when the step runs again", async () => {
    const r = rig();
    await STEPS.technical.run(r.ctx);
    saveFindings(r.dir, "check", [{ severity: "must-fix", shotId: null, code: "checker_failed", description: "could not verify", state: "open" }]);
    await STEPS.technical.run(r.ctx);
    expect(r.store.genVerdictsForVersion("v1")).toHaveLength(1);
    expect(r.verdict().status).toBe("FAIL");
  });
});
