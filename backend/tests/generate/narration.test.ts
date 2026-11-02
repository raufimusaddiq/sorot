import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/config";
import { openDatabase } from "../../src/db";
import { Director } from "../../src/generate/director";
import { DirectorLog } from "../../src/generate/events";
import { Narrator } from "../../src/generate/narration";
import { readFindings } from "../../src/generate/findings";
import { validatePlan, type Plan } from "../../src/generate/planSchema";
import type { RecipeStep } from "../../src/generate/recipe";
import { STEPS, settingsOf } from "../../src/generate/steps";
import { speechFindings, voiceRouteFindings } from "../../src/generate/technical";
import { alignWords, audioSeconds, placeLines, readVoice, snapToVoice, wordErrorRate, wordsOf, writeVoice, type VoiceLine, speechWords } from "../../src/generate/voice";
import type { ExecFn } from "../../src/runner";
import { Store } from "../../src/store";
import { fakeLlm, procOk, quickRecipe, samplePlan } from "../helpers";

const T = "2026-01-01T00:00:00.000Z";
const json = JSON.stringify;
let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "vc-narr-")); });
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const LINES = [{ id: "l1", text: "Bunga majemuk membuat uang tumbuh." }, { id: "l2", text: "Mulai dari sekarang." }];

function rig(replies: Parameters<typeof fakeLlm>[0] = [], opts: { narration?: number; script?: string | null; config?: object; fetch?: (u: any, i?: any) => Promise<Response>; run?: any; durations?: Record<string, number> } = {}) {
  const config = { ...loadConfig({}), genDir: join(tmp, "generate"), ffmpegPath: "ffmpeg", voiceEngine: "openai", voiceApiKey: "k", voiceVoices: { id: "alloy" }, whisperDevice: "cpu", ...opts.config };
  const store = new Store(openDatabase(":memory:"));
  const recipe = quickRecipe();
  store.saveGenProject({
    id: "p1", title: null, brief: "Jelaskan bunga majemuk", format: "9:16", targetSec: 30, language: "id", styleNotes: null, preset: null, recipeId: "quick",
    recipe: json(recipe), ideaId: null, briefFlags: null, narrationScript: opts.script === undefined ? null : opts.script, concept: null, stepIndex: 0,
    stepState: null, narration: opts.narration ?? 1, storylines: null, pickedStoryline: null, status: "RUNNING", currentPlanId: null, acceptedVersionId: null,
    errorMessage: null, createdAt: T, updatedAt: T,
  });
  const { llm, requests } = fakeLlm(replies);
  const seen: string[][] = [];
  const exec: ExecFn = async (_cmd, args) => {
    seen.push(args);
    const file = args.at(-1) as string;
    return procOk(json({ format: { duration: String(opts.durations?.[file.split(/[\\/]/).pop() as string] ?? 2.5) } }));
  };
  let calls = 0;
  const f = opts.fetch ?? (async () => new Response(new Uint8Array([calls++, 2, 3])));
  const narrator = new Narrator(config as never, f as never, opts.run);
  const progress: number[] = [];
  const ctxFor = (use: "script" | "voice" | "align" | "plan", withSettings: Record<string, unknown> = {}) => {
    const step = { ...(recipe.steps.find((x) => x.use === use) ?? { use }), with: withSettings } as RecipeStep;
    return {
      project: store.getGenProject("p1")!, version: null, recipe, step, settings: settingsOf(use, step.with), store,
      log: new DirectorLog(store), director: new Director(llm, new DirectorLog(store), "../generator"),
      hyperframes: {} as never, jev: {} as never, exec, runScript: opts.run, narrator, config: config as never,
      connected: () => true, catalog: async () => [], progress: (p: number) => { progress.push(Math.round(p)); },
    };
  };
  return { config, store, requests, ctxFor, progress, seen, narrator };
}
const body = (req: { messages: Array<{ content: string }> }) => JSON.parse(req.messages[1]!.content);
const scriptJson = (lines = LINES) => json({ lines });

describe("script step", () => {
  test("the director writes the narration line by line; it is kept on the project and sent with the video's limits", async () => {
    const r = rig([scriptJson()]);
    expect(await STEPS.script.run(r.ctxFor("script"))).toEqual({ status: "done", outputRef: "script" });
    expect(json(JSON.parse(r.store.getGenProject("p1")!.narrationScript!))).toBe(scriptJson());
    // the recipe allows 160 words, but 30 s of voice holds 54 (1.8 words a second): the length wins
    expect(body(r.requests[0]!)).toMatchObject({ spellNumbers: true, maxWords: 54, targetSec: 30, language: "id" });
    expect(body(r.requests[0]!).task).toContain("Write every number out in words");
  });

  test("numbers must be spelled out, and a second try can fix it", async () => {
    const r = rig([scriptJson([{ id: "l1", text: "Ada 5 bunga." }]), scriptJson([{ id: "l1", text: "Ada lima bunga." }])]);
    await STEPS.script.run(r.ctxFor("script"));
    expect(JSON.parse(r.requests[1]!.messages.at(-1)!.content).problems[0]).toContain("no digits");
    expect(JSON.parse(r.store.getGenProject("p1")!.narrationScript!).lines[0].text).toBe("Ada lima bunga.");
  });

  test.each([
    ["every line needs its own id", [scriptJson([{ id: "a", text: "satu" }, { id: "a", text: "dua" }])]],
    ["most allowed is 3", [scriptJson([{ id: "a", text: "satu dua tiga empat" }])]],
    ["between 1 and 40 lines", [json({ lines: [] })]],
  ])("a script that breaks a rule twice is an error: %s", async (message, once) => {
    const r = rig([...once, ...once]);
    await expect(STEPS.script.run(r.ctxFor("script", { maxWords: 3 }))).rejects.toThrow(message);
  });

  test("a video without narration skips it; a line without an id gets one", async () => {
    const off = rig([], { narration: 0 });
    expect(await STEPS.script.run(off.ctxFor("script"))).toMatchObject({ status: "skipped" });
    const r = rig([json({ lines: [{ text: "Halo semua." }, { text: "" }] })]);
    await STEPS.script.run(r.ctxFor("script", { spellNumbers: false }));
    expect(JSON.parse(r.store.getGenProject("p1")!.narrationScript!).lines).toEqual([{ id: "l1", text: "Halo semua." }]);
  });
});

describe("voice step", () => {
  const withScript = (over: object = {}, replies: Parameters<typeof fakeLlm>[0] = []) => rig(replies, { script: json({ lines: LINES }), ...over });

  test("speaks each line, measures it and saves the voiceover; the same script costs nothing the second time", async () => {
    const r = withScript({ durations: {} });
    expect(await STEPS.voice.run(r.ctxFor("voice"))).toEqual({ status: "done", outputRef: "voice" });
    const voice = readVoice(r.config, "p1")!;
    expect(voice).toMatchObject({ engine: "openai", voice: "alloy", aligned: null, lines: [{ id: "l1", durationSec: 2.5, words: null }, { id: "l2" }] });
    expect(existsSync(voice.lines[0]!.file)).toBeTrue();
    expect(r.progress).toEqual([50, 100]);
    expect(STEPS.voice.inputKey!(r.ctxFor("voice"))).toContain("alloy");
    await STEPS.voice.run(r.ctxFor("voice"));
    expect(r.seen.filter((a) => a.includes("format=duration:stream=sample_rate"))).toHaveLength(4);   // measured again, spoken from the cache
  });

  test("with ElevenLabs the word times come along and the voiceover counts as timed", async () => {
    const alignment = { characters: [..."Halo"], character_start_times_seconds: [0, 0.1, 0.2, 0.3], character_end_times_seconds: [0.1, 0.2, 0.3, 0.4] };
    const r = rig([], {
      script: json({ lines: [LINES[0]] }), config: { voiceEngine: "elevenlabs", voiceVoices: { id: "v" } },
      fetch: async () => Response.json({ audio_base64: Buffer.from("x").toString("base64"), alignment }),
    });
    await STEPS.voice.run(r.ctxFor("voice"));
    expect(readVoice(r.config, "p1")).toMatchObject({ aligned: "engine", lines: [{ words: [{ text: "Halo", start: 0, end: 0.4 }] }] });
  });

  test("no narration is skipped; no script or no engine is an error unless the video may go on without voice", async () => {
    expect(await STEPS.voice.run(rig([], { narration: 0 }).ctxFor("voice"))).toMatchObject({ status: "skipped" });
    await expect(STEPS.voice.run(rig().ctxFor("voice"))).rejects.toThrow("no script to speak");
    const none = withScript({ config: { voiceEngine: "" } });
    await expect(STEPS.voice.run(none.ctxFor("voice"))).rejects.toThrow("No voice engine");
    const open = withScript({ config: { voiceEngine: "" } });
    const skipped = await STEPS.voice.run(open.ctxFor("voice", { failClosed: false }));
    expect(skipped).toMatchObject({ status: "skipped", reason: expect.stringContaining("without narration") });
    expect(open.store.getGenProject("p1")!.narration).toBe(0);
  });

  test("a spent balance stops the run, or (failClosed: false) lets the film go on silent; other errors always stop it", async () => {
    const broke = () => withScript({ fetch: async () => new Response("pay", { status: 402 }) });
    await expect(STEPS.voice.run(broke().ctxFor("voice"))).rejects.toThrow("no balance");
    const r = broke();
    expect(await STEPS.voice.run(r.ctxFor("voice", { failClosed: false }))).toMatchObject({ status: "skipped", reason: expect.stringContaining("no balance") });
    expect(r.store.getGenProject("p1")!.narration).toBe(0);
    const bad = withScript({ fetch: async () => new Response("x", { status: 500 }) });
    await expect(STEPS.voice.run(bad.ctxFor("voice", { failClosed: false }))).rejects.toThrow("HTTP 500");
  });

  test("the voice can be overridden in the step, and the exec of ffprobe that fails is an error", async () => {
    const r = withScript({});
    await STEPS.voice.run(r.ctxFor("voice", { voice: "nova", speed: 1.2 }));
    expect(readVoice(r.config, "p1")!.voice).toBe("nova");
    const ctx = r.ctxFor("voice", { voice: "echo" });
    ctx.exec = (async () => ({ ...procOk(), exitCode: 1 })) as ExecFn;
    await expect(STEPS.voice.run(ctx)).rejects.toThrow("Couldn't read the length");
  });
});

describe("align step", () => {
  const seeded = (words: boolean, over: object = {}) => {
    const r = rig([], { script: json({ lines: LINES }), ...over });
    const lines: VoiceLine[] = LINES.map((l, i) => ({ id: l.id, text: l.text, file: join(tmp, `${l.id}.mp3`), durationSec: 2 + i, words: words ? wordsOf(l.text).map((t, k) => ({ text: t, start: k * 0.3, end: k * 0.3 + 0.25 })) : null }));
    writeVoice(r.config, "p1", { engine: "openai", voice: "alloy", lines, aligned: words ? "engine" : null });
    return r;
  };

  test("nothing to time without a voiceover", async () => {
    expect(await STEPS.align.run(rig().ctxFor("align"))).toMatchObject({ status: "skipped" });
  });

  test("auto keeps the engine's times when every line has them; `engine` refuses a voice that gives none", async () => {
    const r = seeded(true);
    expect(await STEPS.align.run(r.ctxFor("align"))).toEqual({ status: "done", outputRef: "engine" });
    expect(readVoice(r.config, "p1")!.aligned).toBe("engine");
    const none = seeded(false);
    await expect(STEPS.align.run(none.ctxFor("align", { source: "engine" }))).rejects.toThrow("doesn't give word times");
  });

  test("whisper listens to each line and its words are mapped onto the script's", async () => {
    const asked: string[][] = [];
    const run = async (_s: string, args: string[]) => {
      asked.push(args);
      const n = args[1]!.includes("l1") ? 5 : 3;
      return { segments: [{ words: Array.from({ length: n }, (_, i) => ({ text: `w${i}`, start: i * 0.5, end: i * 0.5 + 0.4 })) }] };
    };
    const r = seeded(false, { run });
    expect(await STEPS.align.run(r.ctxFor("align"))).toEqual({ status: "done", outputRef: "whisper" });
    expect(asked[0]!.slice(0, 2)).toEqual(["--audio", join(tmp, "l1.mp3")]);
    const voice = readVoice(r.config, "p1")!;
    expect(voice.aligned).toBe("whisper");
    expect(voice.lines[0]!.words!.map((w) => w.text)).toEqual(["bunga", "majemuk", "membuat", "uang", "tumbuh"]);
    expect(voice.lines[1]!.words).toHaveLength(3);
    expect(r.progress).toEqual([10, 20]);
    const noWhisper = seeded(false);
    await expect(STEPS.align.run(noWhisper.ctxFor("align", { source: "whisper" }))).rejects.toThrow("Whisper isn't available");
    expect(STEPS.align.inputKey!(r.ctxFor("align"))).toContain("auto");
    const quiet = seeded(false, { run: async () => ({}) });
    await STEPS.align.run(quiet.ctxFor("align"));
    expect(readVoice(quiet.config, "p1")!.lines[0]!.words).toEqual([]);
  });
});

const plan = (narrations: Array<string | null>, durations = [10, 10, 10]) => validatePlan(samplePlan({
  sound: { music: "none", narration: true },
  shots: samplePlan().shots.map((s: any, i: number) => ({ ...s, durationSec: durations[i], narration: narrations[i] })),
}), { brief: "x", targetSec: 30, format: "9:16", language: "id", fonts: ["Plus Jakarta Sans"], imageConnected: false, narration: true }).plan as Plan;

describe("voice helpers", () => {
  const line = (id: string, text: string, durationSec: number): VoiceLine => ({ id, text, file: `/v/${id}.mp3`, durationSec, words: null });
  const lines = [line("l1", "Bunga majemuk membuat uang tumbuh.", 3), line("l2", "Mulai dari sekarang.", 2), line("l3", "Satu kalimat lagi.", 1)];

  test("lines are placed at the shot that narrates them, one after the other; the rest follow", () => {
    const p = plan(["Bunga majemuk membuat uang tumbuh. Mulai dari sekarang.", null, null]);
    expect(placeLines(p, lines).map((x) => [x.line.id, x.start])).toEqual([["l1", 0], ["l2", 3.15], ["l3", 5.3]]);
    const second = plan([null, "mulai dari SEKARANG!", null]);
    expect(placeLines(second, lines.slice(1)).map((x) => x.start)).toEqual([10, 12.15]);
    // a line that would run past the film's end moves earlier, and the one before it makes room
    const late = plan([null, null, "Bunga majemuk membuat uang tumbuh. Mulai dari sekarang."], [13, 13, 4]);
    expect(placeLines(late, lines.slice(0, 2)).map((x) => x.start)).toEqual([24.85, 28]);
    // speech that only just fits closes its pauses; speech longer than the film stays back to back, never overlapping
    const silent = plan([null, null, null], [13, 13, 4]);
    expect(placeLines(silent, [line("a", "x", 14), line("b", "y", 15.9)]).map((x) => x.start)).toEqual([0, 14.1]);
    expect(placeLines(silent, [line("a", "x", 14), line("b", "y", 16.5)]).map((x) => x.start)).toEqual([0, 14]);
  });

  test("a clip's length is its decoded samples over the rate (an MP3 header counts the padding); the header when decoding can't count", async () => {
    const run = (decoded: string): ExecFn => async (_cmd, args) =>
      procOk(args.includes("-af") ? decoded : JSON.stringify({ format: { duration: "6.312" }, streams: [{ sample_rate: "24000" }] }));
    expect(await audioSeconds(run("lavfi.astats.Overall.Number_of_samples=1000\nlavfi.astats.Overall.Number_of_samples=150000.000000\n"), "ffmpeg", "a.mp3")).toBe(6.25);
    expect(await audioSeconds(run(""), "ffmpeg", "a.mp3")).toBe(6.312);
  });

  test("timingFrom voice: a shot lasts as long as its lines plus a breath; others keep their length", () => {
    const p = plan(["Bunga majemuk membuat uang tumbuh. Mulai dari sekarang.", "kata yang tidak ada", null]);
    const snapped = snapToVoice(p, lines);
    expect(snapped.shots.map((s) => s.durationSec)).toEqual([5.6, 10, 10]);
    expect(snapped.totalSec).toBe(25.6);
    // a numeric plan: the frames are laid end to end again and the motion moves with its shot (cut at a shorter end)
    const numeric: Plan = {
      ...p, numeric: { fps: 30, totalFrames: 900, typography: {}, shadow: "none", easing: {}, durationsFrames: {}, staggerFrames: {} },
      shots: p.shots.map((s, i) => ({ ...s, frames: [i * 300, i * 300 + 300] as [number, number], motionPlan: [{ token: "enter", fromFrame: i * 300, toFrame: i * 300 + (i ? 18 : 290), target: "title" }] })),
    };
    const reframed = snapToVoice(numeric, lines);
    expect(reframed.shots.map((s) => [s.frames, s.motionPlan![0]!.fromFrame, s.motionPlan![0]!.toFrame])).toEqual([[[0, 168], 0, 168], [[168, 468], 168, 186], [[468, 768], 468, 486]]);
    expect(reframed.numeric!.totalFrames).toBe(768);
  });

  test("word error rate, and a script's words given the times Whisper heard", () => {
    expect(wordErrorRate(["a", "b", "c", "d"], ["a", "x", "c", "d"])).toBe(0.25);
    expect(wordErrorRate([], [])).toBe(0);
    expect(wordErrorRate([], ["a"])).toBe(1);
    const heard = [{ text: "x", start: 0, end: 1 }, { text: "y", start: 1, end: 2 }];
    expect(alignWords(["a", "b"], heard)).toEqual([{ text: "a", start: 0, end: 1 }, { text: "b", start: 1, end: 2 }]);
    expect(alignWords(["a", "b", "c", "d"], heard).map((w) => w.start)).toEqual([0, 0, 1, 1]);
    expect(alignWords(["a"], [])).toEqual([]);
    expect(readVoice({ genDir: tmp }, "nope")).toBeNull();
    mkdirSync(join(tmp, "bad"), { recursive: true });
    writeFileSync(join(tmp, "bad", "voice.json"), "{ nope");
    expect(readVoice({ genDir: tmp }, "bad")).toBeNull();
  });
});

describe("TECHNICAL: the voice", () => {
  const spoken = [
    { id: "l1", text: "Bunga majemuk membuat uang tumbuh", start: 0, durationSec: 3, firstWordAt: 0 },
    { id: "l2", text: "Mulai dari sekarang", start: 4, durationSec: 2, firstWordAt: 4 },
  ];
  const say = (text: string, start: number) => text.split(" ").map((t, i) => ({ text: t, start: start + i * 0.4, end: start + i * 0.4 + 0.3 }));

  test("a film that says the script passes", () => {
    expect(speechFindings(spoken, [...say("Bunga majemuk membuat uang tumbuh", 0), ...say("Mulai dari sekarang", 4)], 0.25)).toEqual([]);
    // numbers count by value: a spelled-out height that Whisper heard as digits (split in two) was said
    const height = [{ id: "l1", text: "Setinggi delapan ribu delapan ratus empat puluh delapan meter, lima persen", start: 0, durationSec: 4, firstWordAt: 0 }];
    expect(speechFindings(height, say("Setinggi 8 ,848 meter, 5%", 0), 0.25)).toEqual([]);
    expect(speechWords("dua koma lima persen dari 1.000")).toEqual(["n2p5pct", "dari", "n1000"]);
  });

  test("a line that is not heard is named with its time; so is a film that says something else", () => {
    const found = speechFindings(spoken, say("Bunga majemuk membuat uang tumbuh", 0), 0.25);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: "must-fix", code: "speech_mismatch", fromSec: 4 });
    expect(found[0]!.description).toContain('l2 at 4 s ("Mulai dari sekarang")');
    expect(speechFindings(spoken, say("lain sama sekali bukan itu", 0), 0.25)[0]!.description).toContain("word error rate");
  });

  test("captions more than 0.3 s from the spoken word are drift", () => {
    const late = [...say("Bunga majemuk membuat uang tumbuh", 0.8), ...say("Mulai dari sekarang", 4)];
    const found = speechFindings(spoken, late, 0.25);
    expect(found).toEqual([expect.objectContaining({ code: "caption_drift", severity: "should-fix" })]);
    expect(speechFindings([{ ...spoken[0]!, firstWordAt: null }], say("Bunga majemuk membuat uang tumbuh", 0.8), 0.25)).toEqual([]);
  });

  test("a line that runs past the end of the film is cut off", () => {
    expect(voiceRouteFindings([{ id: "l1", start: 0, durationSec: 3 }, { id: "l2", start: 29, durationSec: 3 }], 30)).toEqual([
      expect.objectContaining({ code: "voice_cut_off", severity: "must-fix", fromSec: 29, description: expect.stringContaining("l2") }),
    ]);
  });

  test("the technical step measures the voice in the render when the recipe asks for it", async () => {
    const r = rig([], { script: json({ lines: LINES }), run: async () => ({ segments: [{ words: say("tidak ada hubungannya sama sekali", 0) }] }) });
    const planned = plan(["Bunga majemuk membuat uang tumbuh. Mulai dari sekarang.", null, null]);
    r.store.saveGenPlan({ id: "pl1", projectId: "p1", revision: 1, plan: json(planned), changeRequest: null, changeSummary: null, approvedAt: T, createdAt: T });
    const dir = join(tmp, "v1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "draft.mp4"), "mp4");
    r.store.saveGenVersion({
      id: "v1", projectId: "p1", planId: "pl1", number: 1, parentVersionId: null, status: "BUILDING", step: null, progress: null, projectDir: dir, renderKind: "draft",
      draftPath: join(dir, "draft.mp4"), stepState: null, hyperframesVersion: null, buildMs: null, errorMessage: null, createdAt: T, updatedAt: T,
    });
    writeVoice(r.config, "p1", { engine: "openai", voice: "alloy", lines: [{ id: "l1", text: LINES[0]!.text, file: "/x", durationSec: 3, words: null }, { id: "l2", text: LINES[1]!.text, file: "/x", durationSec: 40, words: null }], aligned: null });
    const ctx = { ...r.ctxFor("align"), version: r.store.getGenVersion("v1")!, step: { use: "technical", with: { measures: { speechMatch: { maxWordErrorRate: 0.1 }, voiceRoute: true } } } as RecipeStep };
    ctx.settings = settingsOf("technical", ctx.step.with);
    ctx.exec = (async (_c: string, args: string[]) => (args.includes("-show_streams")
      ? procOk(json({ streams: [{ codec_type: "video", width: 1080, height: 1920, avg_frame_rate: "30/1", duration: "30" }, { codec_type: "audio" }], format: { duration: "30" } }))
      : { ...procOk("", "mean_volume: -20.0 dB\nmax_volume: -3.0 dB") })) as ExecFn;
    await STEPS.technical.run(ctx);
    const codes = readFindings(dir).map((f) => f.code);
    expect(codes).toContain("speech_mismatch");
    expect(codes).toContain("voice_cut_off");
    expect(JSON.parse(r.store.genVerdictsForVersion("v1")[0]!.inputs!).measures).toEqual(expect.arrayContaining(["voiceRoute", "speechMatch"]));
  });
});
