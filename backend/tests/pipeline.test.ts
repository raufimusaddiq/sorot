import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIEF_SYSTEM, MINE_SYSTEM } from "../src/director";
import { LlmError, type ChatMessage } from "../src/llm";
import { mapPool } from "../src/orchestrator";
import { ruleHook } from "../src/hooks";
import {
  argAfter, clipAnswer, defaultExec, FAKE_SEGMENTS, jevReply, makeEnv, noulA, procOk, unknownFields, type JevRequest, type TestEnv,
} from "./helpers";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { await env.app.jobs.whenIdle(); env.cleanup(); });

async function importAndRun(body: Record<string, unknown> = { url: "https://www.youtube.com/watch?v=abcdefghijk" }, options?: object) {
  const videoId = (await env.json("POST", "/api/import", body)).body.data.videoId as string;
  const jobId = (await env.json("POST", "/api/process", { videoId, options })).body.data.jobId as string;
  await env.app.jobs.whenIdle();
  return { videoId, jobId };
}

const detail = async (jobId: string) => (await env.json("GET", `/api/jobs/${jobId}`)).body.data;
const segmentsFile = (videoId: string) => Bun.file(`${env.config.dataDir}/segments/${videoId}.json`).json();
const YT = { url: "https://www.youtube.com/watch?v=abcdefghijk" };
/** The LLM is configured and answers with `chat`. */
function useLlm(chat: (messages: ChatMessage[]) => string) {
  Object.assign(env.config, { llmBaseUrl: "http://llm/v1", llmModel: "qwen" });
  env.app.llm.chat = async (messages) => ({ role: "assistant", content: chat(messages) });
}

describe("full pipeline", () => {
  test("time limits grow with the video on CPU", async () => {
    env.cleanup();
    env = makeEnv({ whisperDevice: "cpu" });
    env.execHandler.fn = (cmd, args) => {
      const res = defaultExec(cmd, args);
      const out = args.at(-1) as string;
      if (cmd === "ffmpeg" && out.endsWith(".wav")) truncateSync(out, 44 + 32_000 * 3600);   // 1 h of 16 kHz mono s16
      return res;
    };
    await importAndRun();
    expect(env.calls.find((c) => c.script === "transcribe.py")!.timeoutMinutes).toBe(240);
    expect(env.calls.find((c) => c.script === "media_features.py")!.timeoutMinutes).toBe(18);
  });

  test("YouTube import runs all 9 stages and persists clips", async () => {
    const { videoId, jobId } = await importAndRun();
    const d = await detail(jobId);
    expect(d.job.status).toBe("COMPLETED");
    expect(d.job.currentStage).toBe("ANALYTICS");
    expect(d.stages.every((s: any) => s.status === "COMPLETED")).toBeTrue();
    const render = d.stages.find((s: any) => s.stage === "RENDER");
    expect(render.outputPath).toBe("2 rendered, 0 failed");
    expect(d.stages.find((s: any) => s.stage === "SUBTITLE").outputPath).toBe("Captions burned during render");
    expect(env.calls.some((c) => c.script === "subtitle.py")).toBeFalse();     // one encode per clip

    const video = env.app.store.getVideo(videoId)!;
    expect(video.title).toBe("Judul Video Test");
    expect(video.filePath).toBe(`${env.config.dataDir}/raw/${videoId}.mp4`);

    const clips = (await env.json("GET", `/api/videos/${videoId}/clips`)).body.data.clips;
    expect(clips.map((c: any) => [c.rankPos, c.tier])).toEqual([[1, "PRIMARY"], [2, "BACKUP"], [3, "SKIP"]]);
    expect(clips[0]).toMatchObject({ renderStatus: "COMPLETED", exportStatus: "COMPLETED", textContent: FAKE_SEGMENTS[0]!.text,
      scoredBy: "rules", reason: "Rule score: strong opening hook, viral keywords" });
    expect(clips[0].title).toStartWith("Kenapa rahasia ini penting banget? #rahasia");
    expect(clips[0].exportPath).toEndWith("clip_1_subtitled.mp4");
    expect(clips[2]).toMatchObject({ renderStatus: "PENDING", renderPath: null });
    const score = (await env.json("GET", `/api/clips/${clips[0].id}`)).body.data.scoreBreakdown;
    expect(score).toMatchObject({ hookStrength: 1, keywordTrigger: 1, facePresence: 1, emotionalEnergy: 0.92, topicFit: 0.5, boostTotal: 0.18 });

    // Python call contract
    const scripts = env.calls.map((c) => c.script);
    expect(scripts.filter((s) => s === "render.py")).toHaveLength(2);
    const t = env.calls.find((c) => c.script === "transcribe.py")!.args;
    expect(t).toEqual(["--audio", `${env.config.dataDir}/audio/${videoId}.wav`, "--output",
      `${env.config.dataDir}/transcripts/${videoId}.json`, "--language", "id", "--model", "large-v3-turbo", "--device", "cuda"]);
    const s = env.calls.find((c) => c.script === "media_features.py")!.args;
    expect(s).toEqual(["--segments", `${env.config.dataDir}/segments/${videoId}.json`, "--video", video.filePath,
      "--audio", `${env.config.dataDir}/audio/${videoId}.wav`]);
    expect(scripts).not.toContain("predict_supervised.py");          // no trained model
    const saved = await Bun.file(`${env.config.dataDir}/segments/${videoId}.json`).json();
    expect(saved).toMatchObject({ videoId, scoredBy: "rules" });
    expect(saved.scoredSegments.map((x: any) => [x.index, x.rank, x.tier])).toEqual([[0, 1, "PRIMARY"], [1, 2, "BACKUP"], [2, 3, "SKIP"]]);
    const report = await Bun.file(`${env.config.dataDir}/analytics/${videoId}.json`).json();
    expect(report).toMatchObject({ videoId, totalSegments: 3, tierDistribution: { PRIMARY: 1, BACKUP: 1, SKIP: 1 } });
    expect(report.topFeatures).toHaveLength(13);
    for (const sub of ["input", "clips", "variations", "logs"]) expect(existsSync(`${env.config.dataDir}/${sub}`)).toBeTrue();
  });

  test("render gets the caption style, export dir, transcript and silence-trim flags", async () => {
    const { videoId } = await importAndRun();
    const transcript = `${env.config.dataDir}/transcripts/${videoId}.json`;
    const render = env.calls.find((c) => c.script === "render.py")!.args;
    expect(argAfter(render, "--transcript")).toBe(transcript);
    expect(argAfter(render, "--reframe")).toBe("face");
    expect(argAfter(render, "--export-dir")).toBe(env.app.orchestrator.exportDir(videoId));
    expect(argAfter(render, "--style")).toBe("default");
    expect(render).not.toContain("--silence-trim");
    expect(render).not.toContain("--bgm");
  });

  test("a render limit (a CPU's default) renders the best clips; the rest render on request", async () => {
    env.config.maxRenderClips = 1;
    const { videoId, jobId } = await importAndRun();
    const render = (await detail(jobId)).stages.find((s: any) => s.stage === "RENDER");
    expect(render.outputPath).toBe("1 rendered, 0 failed, 1 more render on request");
    expect(env.calls.filter((c) => c.script === "render.py")).toHaveLength(1);
    let clips = (await env.json("GET", `/api/videos/${videoId}/clips`)).body.data.clips;
    expect(clips.map((c: any) => [c.tier, c.renderStatus])).toEqual([["PRIMARY", "COMPLETED"], ["BACKUP", "PENDING"], ["SKIP", "PENDING"]]);

    // The Render button: a re-render with no changes
    const r = await env.json("POST", `/api/clips/${clips[1].id}/rerender`, {});
    expect(r.status).toBe(200);
    clips = (await env.json("GET", `/api/videos/${videoId}/clips`)).body.data.clips;
    expect(clips[1]).toMatchObject({ renderStatus: "COMPLETED", exportStatus: "COMPLETED", startTime: 30, endTime: 55 });
  });

  test("TRANSCRIBE shows Whisper's progress while it runs, under the script's label if it gives one", async () => {
    const seen: Array<string | null | undefined> = [];
    const orig = env.scripts["transcribe.py"]!;
    env.scripts["transcribe.py"] = (args, signal, opts) => {
      const job = env.app.store.listJobs()[0]!;
      for (const label of [undefined, "Re-transcribing"]) {
        opts?.onProgress?.(37, label);
        seen.push(env.app.store.getStage(job.id, "TRANSCRIBE")?.outputPath);
      }
      return orig(args, signal, opts);
    };
    const { videoId, jobId } = await importAndRun();
    expect(seen).toEqual(["Transcribing 37%", "Re-transcribing 37%"]);
    const t = (await detail(jobId)).stages.find((s: any) => s.stage === "TRANSCRIBE");
    expect(t.outputPath).toBe(`${env.config.dataDir}/transcripts/${videoId}.json`);
  });

  test("a retry reuses the transcript; a different model transcribes again", async () => {
    const { videoId } = await importAndRun();
    const again = async () => {
      expect((await env.json("POST", "/api/process", { videoId })).status).toBe(200);
      await env.app.jobs.whenIdle();
      return env.calls.filter((c) => c.script === "transcribe.py").length;
    };
    expect(await again()).toBe(1);
    env.config.whisperModel = "small";
    expect(await again()).toBe(2);
    writeFileSync(`${env.config.dataDir}/transcripts/${videoId}.json`, "{broken");
    expect(await again()).toBe(3);
  });

  test("clips rendered without captions (before a retry) are still burned by SUBTITLE", async () => {
    env.scripts["render.py"] = (args) => {           // the old render: no captions, no --export-dir handling
      const rank = Number(argAfter(args, "--clip-index")) + 1;
      const dir = argAfter(args, "--output-dir");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `clip_${rank}.mp4`), "mp4");
      return { clips: [{ rank, status: "COMPLETED", path: join(dir, `clip_${rank}.mp4`) }] };
    };
    const { videoId, jobId } = await importAndRun();
    expect(env.calls.filter((c) => c.script === "subtitle.py")).toHaveLength(2);
    expect((await detail(jobId)).stages.find((s: any) => s.stage === "SUBTITLE").outputPath).toBe("2 burned, 0 failed");
    const clips = env.app.store.clipsForVideo(videoId);
    expect(clips[0]!.exportPath).toEndWith("clip_1_subtitled.mp4");
  });

  test("variations are off by default; on, a failure doesn't fail the job", async () => {
    const off = await importAndRun();
    expect(env.calls.some((c) => c.script === "variation.py")).toBeFalse();
    const skipped = (await detail(off.jobId)).stages.find((s: any) => s.stage === "VARIATION");
    expect(skipped).toMatchObject({ status: "COMPLETED", outputPath: "Skipped (VARIATIONS=true turns them on)" });

    env.config.variations = true;
    const on = await importAndRun({ url: "https://www.youtube.com/watch?v=bcdefghijkl" });
    const variation = env.calls.find((c) => c.script === "variation.py")!.args;
    expect(argAfter(variation, "--output-dir")).toBe(`${env.config.dataDir}/variations/${on.videoId}/`);

    env.scripts["variation.py"] = () => { throw new Error("exceeded 10 min wall-clock budget; killed"); };
    const failed = await importAndRun({ url: "https://www.youtube.com/watch?v=cdefghijklm" });
    const d = await detail(failed.jobId);
    expect(d.job.status).toBe("COMPLETED");
    expect(d.stages.find((s: any) => s.stage === "VARIATION").outputPath).toStartWith("Failed: exceeded 10 min");
  });

  test("silence trim, style and music reach the one-pass render", async () => {
    env.config.silenceTrim = true;
    env.config.silenceGapSec = 0.8;
    env.config.subtitleStyle = "hormozi";
    env.config.bgmFile = "lofi.mp3";
    await importAndRun();
    const args = env.calls.find((c) => c.script === "render.py")!.args;
    expect(args).toContain("--silence-trim");
    expect(argAfter(args, "--silence-gap")).toBe("0.8");
    expect(argAfter(args, "--style")).toBe("hormozi");
    expect(argAfter(args, "--bgm")).toBe(`${env.config.dataDir}/music/lofi.mp3`);
  });

  test("download is skipped when the raw file already exists", async () => {
    const videoId = (await env.json("POST", "/api/import", { url: "https://youtu.be/abcdefghijk" })).body.data.videoId;
    mkdirSync(`${env.config.dataDir}/raw`, { recursive: true });
    writeFileSync(`${env.config.dataDir}/raw/${videoId}.mp4`, "cached");
    await env.json("POST", "/api/process", { videoId });
    await env.app.jobs.whenIdle();
    const yt = env.execCalls.filter((c) => c.cmd === "yt-dlp");
    expect(yt).toHaveLength(1); // title only
    expect(yt[0]!.args[0]).toBe("--print");
  });

  test("failed download cleans only this video's partials", async () => {
    const videoId = (await env.json("POST", "/api/import", { url: "https://youtu.be/abcdefghijk" })).body.data.videoId;
    const raw = `${env.config.dataDir}/raw`;
    mkdirSync(raw, { recursive: true });
    writeFileSync(`${raw}/${videoId}.f137.mp4.part`, "x");
    writeFileSync(`${raw}/other-video.mp4.part`, "y");
    env.execHandler.fn = (cmd, args) => {
      if (cmd === "yt-dlp" && args[0] === "--print") return { ...procOk(), exitCode: 1 };
      if (cmd === "yt-dlp") return { exitCode: 1, stdout: "", stderr: "HTTP Error 403", timedOut: false, aborted: false };
      return defaultExec(cmd, args);
    };
    const jobId = (await env.json("POST", "/api/process", { videoId })).body.data.jobId;
    await env.app.jobs.whenIdle();
    const d = await detail(jobId);
    expect(d.job.status).toBe("FAILED");
    expect(d.job.errorMessage).toBe("Stage IMPORT failed: yt-dlp download failed (exit=1): HTTP Error 403");
    expect(d.stages[0]).toMatchObject({ stage: "IMPORT", status: "FAILED" });
    expect(d.stages[1].status).toBe("PENDING");
    expect(existsSync(`${raw}/${videoId}.f137.mp4.part`)).toBeFalse();
    expect(existsSync(`${raw}/other-video.mp4.part`)).toBeTrue();
    expect(env.app.store.getVideo(videoId)!.title).toBeNull();
  });

  test("download that exits 0 without a file fails clearly", async () => {
    env.execHandler.fn = (cmd, args) => (cmd === "yt-dlp" && args[0] !== "--print" ? procOk() : defaultExec(cmd, args));
    const { jobId } = await importAndRun();
    expect((await detail(jobId)).job.errorMessage).toContain("Downloaded file not found");
  });

  test("local file pipeline; missing local file fails at IMPORT", async () => {
    const p = join(env.dir, "local.mp4");
    writeFileSync(p, "local");
    const ok = await importAndRun({ localPath: p });
    expect((await detail(ok.jobId)).job.status).toBe("COMPLETED");
    expect(env.execCalls.some((c) => c.cmd === "yt-dlp")).toBeFalse();
    const ffmpeg = env.execCalls.find((c) => c.cmd === "ffmpeg")!;
    expect(argAfter(ffmpeg.args, "-i")).toBe(p);

    const bad = await importAndRun({ localPath: join(env.dir, "missing.mp4") });
    expect((await detail(bad.jobId)).job.errorMessage).toStartWith("Stage IMPORT failed: Local file not found");
  });

  test("ffmpeg failure fails AUDIO_EXTRACT", async () => {
    env.execHandler.fn = (cmd, args) => (cmd === "ffmpeg" ? { exitCode: 1, stdout: "", stderr: "bad input", timedOut: false, aborted: false } : defaultExec(cmd, args));
    const { jobId } = await importAndRun();
    const d = await detail(jobId);
    expect(d.job.errorMessage).toBe("Stage AUDIO_EXTRACT failed: ffmpeg audio extraction failed (exit=1): bad input");
  });

  test("per-clip render failure marks the clip FAILED but the stage completes", async () => {
    const orig = env.scripts["render.py"]!;
    env.scripts["render.py"] = (args) => {
      if (argAfter(args, "--clip-index") === "1") throw new Error("nvenc exploded");
      return orig(args);
    };
    const { videoId, jobId } = await importAndRun();
    const d = await detail(jobId);
    expect(d.job.status).toBe("COMPLETED");
    expect(d.stages.find((s: any) => s.stage === "RENDER").outputPath).toBe("1 rendered, 1 failed");
    const clips = env.app.store.clipsForVideo(videoId);
    expect(clips[1]!.renderStatus).toBe("FAILED");
  });

  test("script result statuses are applied by rank; bad ranks ignored", async () => {
    env.scripts["render.py"] = (args) => ({
      clips: [
        { rank: Number(argAfter(args, "--clip-index")) + 1, status: "FAILED", error: "empty file" },
        { rank: 0, status: "COMPLETED", path: "x" }, { rank: 99, status: "COMPLETED", path: "x" },
      ],
    });
    env.scripts["subtitle.py"] = () => ({});
    const { videoId } = await importAndRun();
    const clips = env.app.store.clipsForVideo(videoId);
    expect(clips[0]).toMatchObject({ renderStatus: "FAILED", renderPath: null, exportStatus: "PENDING" });
  });

  test("niche keywords, feedback history and a trained model feed the scorer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pipe-"));
    writeFileSync(join(dir, "model.lgb"), "model");
    writeFileSync(join(dir, "weights.json"), JSON.stringify({ weights: { hookStrength: 1 } }));
    env.config.pipelineDir = dir;
    env.config.nicheKeywords = ["teh"];
    const { videoId } = await importAndRun();
    const feats = await Bun.file(`${env.config.dataDir}/segments/${videoId}.features.json`).json();
    expect(feats[0].features).toMatchObject({ hookStrength: 1, topicFit: 0.3 });
    const clips = env.app.store.clipsForVideo(videoId);
    expect(clips.map((c) => [c.textContent!.slice(0, 5), c.tier])).toEqual([["Kenap", "PRIMARY"], ["Terny", "PRIMARY"], ["Hari ", "SKIP"]]);
    expect(env.app.store.clipScore(clips[2]!.id)!.topicFit).toBe(1);              // "teh" is in the third text
    env.scripts["predict_supervised.py"] = () => ({ predictions: {} });
    const again = await importAndRun();
    expect(env.app.store.clipsForVideo(again.videoId).map((c) => c.tier)).toEqual(["PRIMARY", "PRIMARY", "SKIP"]);
  });

  test("an LLM review blends into the scores and writes the copy; on LlmError the rules decide", async () => {
    env.config.llmDirector = false;   // review only
    useLlm((messages) => JSON.stringify({ clips: JSON.parse(messages[1]!.content).excerpts.map(({ id }: { id: number }) => ({
      id, score: id === 2 ? 95 : 10, reason: `llm ${id}`, title: `Judul LLM ${id}`, description: "Desk.", hashtags: ["seru"] })) }));
    const clips = env.app.store.clipsForVideo((await importAndRun()).videoId);
    expect(clips.map((c) => [c.textContent!.slice(0, 5), c.scoredBy, c.reason])).toEqual([
      ["Hari ", "llm+rules", "llm 2"], ["Kenap", "llm+rules", "llm 0"], ["Terny", "llm+rules", "llm 1"]]);
    expect(clips[0]).toMatchObject({ title: "Judul LLM 2 #seru", description: "Desk.\n#seru" });
    env.app.llm.chat = async () => { throw new LlmError("down"); };
    const fallback = await importAndRun();
    expect(env.app.store.clipsForVideo(fallback.videoId).map((c) => c.scoredBy)).toEqual(["rules", "rules", "rules"]);
    expect((await segmentsFile(fallback.videoId)).llmError).toBe("down");
  });

  test("the LLM director (Jev off): brief, its own moment and hook, the direction everywhere; rules on LlmError", async () => {
    const seen: ChatMessage[][] = [];
    useLlm((messages) => {
      seen.push(messages);
      if (messages[0]!.content === BRIEF_SYSTEM) return JSON.stringify({ summary: "Pak Budi tells a secret.", people: ["Pak Budi"] });
      if (messages[0]!.content === MINE_SYSTEM) return JSON.stringify({ moments: [{ start: 0, end: 1, hook: 1, why: "setup and payoff" }] });
      return JSON.stringify({ clips: JSON.parse(messages[1]!.content).excerpts.map((e: { id: number; text: string }) => ({
        id: e.id, score: e.text.includes("sederhana") && e.text.startsWith("Kenapa") ? 99 : 40, reason: "r", title: "Judul", hashtags: [] })) });
    });
    const { videoId, jobId } = await importAndRun(YT, { direction: "yang serius saja" });
    expect((await detail(jobId)).job.status).toBe("COMPLETED");
    expect(JSON.parse(env.app.store.getVideo(videoId)!.brief!)).toMatchObject({ summary: "Pak Budi tells a secret." });
    for (const m of seen) expect(m[1]!.content).toContain("yang serius saja");
    expect(JSON.parse(seen.at(-1)![1]!.content).video).toEqual({ title: "Judul Video Test", summary: "Pak Budi tells a secret.", people: ["Pak Budi"] });
    const clips = env.app.store.clipsForVideo(videoId);
    expect(clips).toHaveLength(2);   // the pick covered the first two rule windows: they were dropped
    expect(clips[0]).toMatchObject({ source: "llm", startTime: 0, endTime: 55, hookStart: 30, hookEnd: 36, scoredBy: "llm+rules" });
    expect(clips[1]).toMatchObject({ source: "rules", hookStart: null });
    const render = env.calls.find((c) => c.script === "render.py")!.args;
    expect(JSON.parse(await Bun.file(argAfter(render, "--segments")).text()).scoredSegments[0]).toMatchObject({ hookStart: 30, hookEnd: 36 });

    env.app.llm.chat = async () => { throw new LlmError("down"); };
    const down = await importAndRun();
    expect([(await segmentsFile(down.videoId)).llmError, env.app.store.getVideo(down.videoId)!.brief]).toEqual(["down", null]);
    expect(env.app.store.clipsForVideo(down.videoId).map((c) => `${c.source}/${c.scoredBy}`)).toEqual(["rules/rules", "rules/rules", "rules/rules"]);
  });

  test("Jev only gating (JEV_DIRECTOR off): held-back clips rank last and don't render; rules gate without Jev", async () => {
    expect((await segmentsFile((await importAndRun()).videoId)).gatedBy).toBe("rules");
    Object.assign(env.config, { jevApiKey: "k", jevDirector: false });
    const asked: JevRequest[] = [];
    env.fetchHandler.fn = (_url, init) => jevReply(init, (state, id) => (id === "mostly_filler" && state.excerpt.startsWith("Kenapa") ? noulA(0.9) : clipAnswer(state, id)), asked);
    env.calls.length = 0;
    const { videoId } = await importAndRun();
    expect([asked.length, (await segmentsFile(videoId)).gatedBy]).toEqual([2, "jev"]);
    const clips = env.app.store.clipsForVideo(videoId);
    expect(clips.map((c) => [c.textContent!.slice(0, 5), c.tier, c.gateVerdict])).toEqual([["Terny", "BACKUP", "PASS"], ["Hari ", "SKIP", null], ["Kenap", "SKIP", "FAIL"]]);
    expect(clips[2]!.reason).toStartWith("Held back: mostly greetings, promos or small talk.");
    expect(env.calls.filter((c) => c.script === "render.py")).toHaveLength(1);
  });

  test("Jev first: Jev finds, scores, gates, titles; its no-replay decision beats the rules' hook; the LLM isn't called", async () => {
    const lines = [[0, 8, "Jadi begini ceritanya teman-teman."], [8, 17, "Kenapa rahasia ini penting banget? Ternyata faktanya gila!"],
      [17, 25, "Pak Budi kaget dan marah waktu dengar kebenarannya."], [30, 55, FAKE_SEGMENTS[1]!.text], [60, 85, FAKE_SEGMENTS[2]!.text]] as const;
    const segments = lines.map(([start, end, text], index) => ({ index, start, end, text }));
    env.scripts["transcribe.py"] = (args) => ({ videoId: "x", language: argAfter(args, "--language"), model: argAfter(args, "--model"), segments });
    expect(ruleHook(segments, 0, 25)).toMatchObject({ hookStart: 8 });   // what the rules would replay
    env.config.jevApiKey = "k";
    useLlm(() => { throw new Error("the LLM must not be called when Jev decides"); });
    const asked: JevRequest[] = [];
    env.fetchHandler.fn = (_url, init) => jevReply(init, clipAnswer, asked);
    const { videoId, jobId } = await importAndRun(YT, { direction: "rahasia sukses" });
    expect((await detail(jobId)).job.status).toBe("COMPLETED");
    expect(asked.every((r) => unknownFields(r).length === 0)).toBeTrue();
    expect(await segmentsFile(videoId)).toMatchObject({ scoredBy: "jev+rules", gatedBy: "jev", director: { by: "jev", windows: 5, judged: 5 } });
    const clips = env.app.store.clipsForVideo(videoId);
    expect(clips[0]).toMatchObject({ startTime: 0, scoredBy: "jev+rules", gateVerdict: "PASS", hookStart: null,
      reason: expect.stringMatching(/^Jev: strong opening/), title: expect.stringMatching(/^Jadi begini ceritanya teman-teman\. #/) });
    expect(clips.at(-1)).toMatchObject({ tier: "SKIP", gateVerdict: "FAIL" });   // the small-talk window
    expect(env.app.store.getVideo(videoId)!.brief).toBeNull();
  });

  test("Jev first falls back to the rules when Jev is down", async () => {
    env.config.jevApiKey = "k";
    env.fetchHandler.fn = () => new Response("down", { status: 503 });
    const { videoId } = await importAndRun();
    const file = await segmentsFile(videoId);
    expect(file).toMatchObject({ scoredBy: "rules", gatedBy: "rules", gateError: expect.stringMatching(/^Jev HTTP 503/),
      director: { pickError: expect.stringMatching(/^Jev HTTP 503/) } });
    expect(env.app.store.clipsForVideo(videoId).map((c) => c.tier)).toEqual(["PRIMARY", "BACKUP", "SKIP"]);
  });

  test("score with no scoredSegments yields no clips; re-score replaces clips", async () => {
    const { videoId } = await importAndRun();
    const before = env.app.store.clipsForVideo(videoId).map((c) => c.id);
    env.app.orchestrator.saveClipsFromScoredSegments(videoId, {});
    expect(env.app.store.clipsForVideo(videoId)).toEqual([]);
    for (const id of before) expect(env.app.store.clipScore(id)).toBeNull();
    env.app.orchestrator.saveClipsFromScoredSegments(videoId, { scoredSegments: [{ tier: "SKIP" }] });
    expect(env.app.store.clipsForVideo(videoId)[0]).toMatchObject({ score: 0, title: null, textContent: "", startTime: 0 });
  });

  test("python stage failure is reported with stage name", async () => {
    env.scripts["media_features.py"] = () => { throw new Error("Python script media_features.py error: no video stream"); };
    const { jobId } = await importAndRun();
    const d = await detail(jobId);
    expect(d.job.status).toBe("FAILED");
    expect(d.job.currentStage).toBe("SCORE");
    expect(d.job.errorMessage).toBe("Stage SCORE failed: Python script media_features.py error: no video stream");
    expect(d.stages.find((s: any) => s.stage === "SCORE").errorMessage).toBe("Python script media_features.py error: no video stream");
  });

  test("stage row is recreated if missing", async () => {
    const videoId = (await env.json("POST", "/api/import", { url: "https://youtu.be/abcdefghijk" })).body.data.videoId;
    const job = env.app.jobs.createAndStartJob(videoId);
    env.app.store.db.query("DELETE FROM stage_status WHERE job_id = ? AND stage = 'ANALYTICS'").run(job.id);
    await env.app.jobs.whenIdle();
    expect(env.app.store.getStage(job.id, "ANALYTICS")!.status).toBe("COMPLETED");
  });

  test("job whose video vanished fails cleanly", async () => {
    const videoId = (await env.json("POST", "/api/import", { url: "https://youtu.be/abcdefghijk" })).body.data.videoId;
    env.app.store.saveJob({ id: "j-orphan", videoId: "gone", status: "QUEUED", currentStage: null, errorMessage: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await env.app.orchestrator.runPipeline("j-orphan", new AbortController().signal);
    expect(env.app.store.getJob("j-orphan")).toMatchObject({ status: "FAILED", errorMessage: "Video not found: gone" });
    await env.app.orchestrator.runPipeline("no-such-job", new AbortController().signal); // no throw
    expect(videoId).toBeString();
  });
});

describe("cancel / retry / queue", () => {
  test("cancel kills the running stage and keeps CANCELLED", async () => {
    let started!: () => void;
    const running = new Promise<void>((r) => { started = r; });
    env.scripts["transcribe.py"] = (_args, signal) => new Promise((_, reject) => {
      started();
      signal?.addEventListener("abort", () => reject(new Error("Job cancelled by user")));
    });
    const videoId = (await env.json("POST", "/api/import", { url: "https://youtu.be/abcdefghijk" })).body.data.videoId;
    const jobId = (await env.json("POST", "/api/process", { videoId })).body.data.jobId;
    await running;
    const c = await env.json("POST", `/api/jobs/${jobId}/cancel`);
    expect(c.body.data).toEqual({ jobId, status: "CANCELLED" });
    await env.app.jobs.whenIdle();
    const d = await detail(jobId);
    expect(d.job.status).toBe("CANCELLED");
    expect(d.job.errorMessage).toBe("Cancelled by user");
    expect(d.stages.find((s: any) => s.stage === "TRANSCRIBE").status).toBe("FAILED");
    expect(env.calls.some((x) => x.script === "segment.py")).toBeFalse();
    // can't cancel twice; can't retry a cancelled job
    expect((await env.json("POST", `/api/jobs/${jobId}/cancel`)).body.error).toBe("Can only cancel running or queued jobs, current: CANCELLED");
    expect((await env.json("POST", `/api/jobs/${jobId}/retry`)).status).toBe(400);
  });

  test("cancel during fan-out render stops further clips", async () => {
    let jobId = "";
    env.scripts["render.py"] = async () => {
      await env.json("POST", `/api/jobs/${jobId}/cancel`);
      return { clips: [] };
    };
    env.config.maxParallelRenders = 1;
    const videoId = (await env.json("POST", "/api/import", { url: "https://youtu.be/abcdefghijk" })).body.data.videoId;
    jobId = (await env.json("POST", "/api/process", { videoId })).body.data.jobId;
    await env.app.jobs.whenIdle();
    expect(env.calls.filter((c) => c.script === "render.py")).toHaveLength(1);
    expect((await detail(jobId)).job.status).toBe("CANCELLED");
  });

  test("render failure after abort is treated as cancel", async () => {
    let jobId = "";
    env.scripts["render.py"] = async () => {
      await env.json("POST", `/api/jobs/${jobId}/cancel`);
      throw new Error("killed");
    };
    const videoId = (await env.json("POST", "/api/import", { url: "https://youtu.be/abcdefghijk" })).body.data.videoId;
    jobId = (await env.json("POST", "/api/process", { videoId })).body.data.jobId;
    await env.app.jobs.whenIdle();
    expect((await detail(jobId)).job.status).toBe("CANCELLED");
    expect(env.app.store.clipsForVideo(videoId)[0]!.renderStatus).toBe("PENDING");
  });

  test("exec reporting aborted is a cancel", async () => {
    env.execHandler.fn = (cmd) => ({ exitCode: 1, stdout: "", stderr: "", timedOut: false, aborted: cmd === "yt-dlp" });
    const { jobId } = await importAndRun();
    expect((await detail(jobId)).job.status).toBe("FAILED");
    expect((await detail(jobId)).job.errorMessage).toBe("Job cancelled by user");
  });

  test("queued job cancelled before it starts never runs", async () => {
    env.config.maxConcurrentPipelines = 1;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    env.scripts["transcribe.py"] = async () => { await gate; return { segments: [] }; };
    const a = (await env.json("POST", "/api/import", { url: "https://youtu.be/abcdefghijk" })).body.data.videoId;
    const b = (await env.json("POST", "/api/import", { url: "https://youtu.be/zyxwvutsrqp" })).body.data.videoId;
    await env.json("POST", "/api/process", { videoId: a });
    const jobB = (await env.json("POST", "/api/process", { videoId: b })).body.data.jobId;
    expect((await env.json("POST", `/api/jobs/${jobB}/cancel`)).body.data.status).toBe("CANCELLED");
    release();
    await env.app.jobs.whenIdle();
    expect((await detail(jobB)).stages.every((s: any) => s.status === "PENDING")).toBeTrue();
  });

  test("retry re-runs a failed job to completion", async () => {
    let fail = true;
    const orig = env.scripts["media_features.py"]!;
    env.scripts["media_features.py"] = (args) => { if (fail) throw new Error("cuda OOM"); return orig(args); };
    const { jobId } = await importAndRun();
    expect((await detail(jobId)).job.status).toBe("FAILED");
    fail = false;
    const r = await env.json("POST", `/api/jobs/${jobId}/retry`);
    expect(r.body.data.jobId).toBe(jobId);
    await env.app.jobs.whenIdle();
    const d = await detail(jobId);
    expect(d.job).toMatchObject({ status: "COMPLETED", errorMessage: null });
    // no leftovers from the failed run (SCORE kept "cuda OOM" before)
    for (const s of d.stages) expect(s).toMatchObject({ status: "COMPLETED", errorMessage: null });
    expect(env.calls.filter((c) => c.script === "transcribe.py")).toHaveLength(1);   // transcript reused
  });

  test("resetStages clears a run's stage results", async () => {
    const { jobId } = await importAndRun();
    env.app.store.resetStages(jobId);
    for (const s of env.app.store.stagesForJob(jobId)) {
      expect(s).toMatchObject({ status: "PENDING", startedAt: null, completedAt: null, errorMessage: null, outputPath: null });
    }
  });

  test("queue full → 409 and the rejected job is marked FAILED", async () => {
    env.config.maxConcurrentPipelines = 1;
    env.config.queueCapacity = 1;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    env.scripts["transcribe.py"] = async () => { await gate; return {}; };
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await env.json("POST", "/api/import", { url: `https://youtu.be/abcdefghij${i}` })).body.data.videoId);
    expect((await env.json("POST", "/api/process", { videoId: ids[0] })).status).toBe(200);
    expect((await env.json("POST", "/api/process", { videoId: ids[1] })).status).toBe(200);
    const r = await env.json("POST", "/api/process", { videoId: ids[2] });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("Pipeline queue is full; try again later");
    expect(env.app.store.latestJobForVideo(ids[2]!)!.status).toBe("FAILED");
    release();
  });

  test("unexpected non-conflict error from job creation is a 500", async () => {
    env.app.jobs.createAndStartJob = () => { throw new Error("db locked"); };
    expect((await env.json("POST", "/api/process", { videoId: "v" })).status).toBe(500);
    env.app.jobs.retryJob = () => { throw new Error("db locked"); };
    expect((await env.json("POST", "/api/jobs/x/retry")).status).toBe(500);
  });

  test("orchestrator crash is contained by the queue", async () => {
    env.app.orchestrator.runPipeline = async () => { throw new Error("kaboom"); };
    const videoId = (await env.json("POST", "/api/import", { url: "https://youtu.be/abcdefghijk" })).body.data.videoId;
    expect((await env.json("POST", "/api/process", { videoId })).status).toBe(200);
    await env.app.jobs.whenIdle();
  });

  test("shutdown aborts running jobs with a distinct reason", async () => {
    let started!: () => void;
    const running = new Promise<void>((r) => { started = r; });
    env.scripts["transcribe.py"] = (_a, signal) => new Promise((_, reject) => {
      started();
      signal?.addEventListener("abort", () => reject(new Error("killed")));
    });
    const videoId = (await env.json("POST", "/api/import", { url: "https://youtu.be/abcdefghijk" })).body.data.videoId;
    const jobId = (await env.json("POST", "/api/process", { videoId })).body.data.jobId;
    await running;
    env.app.jobs.shutdown();
    await env.app.jobs.whenIdle();
    expect(env.app.store.getJob(jobId)).toMatchObject({ status: "FAILED", errorMessage: "Server shut down while job was running" });
  });
});

describe("orphan sweep", () => {
  const stale = (id: string, status: string, minutesAgo: number) => {
    const t = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    env.app.store.saveJob({ id, videoId: "v", status, currentStage: null, errorMessage: null, createdAt: t, updatedAt: t });
  };

  test("marks stale RUNNING/QUEUED jobs FAILED, leaves fresh and live ones", async () => {
    stale("old-run", "RUNNING", 45);
    stale("old-queued", "QUEUED", 45);
    stale("fresh", "RUNNING", 5);
    stale("done", "COMPLETED", 999);
    env.app.store.saveJob({ ...env.app.store.getJob("fresh")!, id: "bad-ts", updatedAt: "garbage" });
    expect(env.app.jobs.sweepOrphans(30, "startup")).toBe(2);
    expect(env.app.store.getJob("old-run")!.errorMessage).toStartWith("Orphan job recovered (startup); last heartbeat");
    expect(env.app.store.getJob("fresh")!.status).toBe("RUNNING");
    expect(env.app.store.getJob("bad-ts")!.status).toBe("RUNNING");
    expect(env.app.jobs.sweepOrphans(1, "periodic")).toBe(1);
  });

  test("live pipelines are never swept", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    env.scripts["transcribe.py"] = async () => { await gate; return {}; };
    const videoId = (await env.json("POST", "/api/import", { url: "https://youtu.be/abcdefghijk" })).body.data.videoId;
    const jobId = (await env.json("POST", "/api/process", { videoId })).body.data.jobId;
    await Bun.sleep(5);
    expect(env.app.jobs.sweepOrphans(-1, "periodic")).toBe(0);
    release();
    await env.app.jobs.whenIdle();
    expect(jobId).toBeString();
  });

  test("maintenance runs startup + periodic sweeps", async () => {
    const m = makeEnv({ orphanSweepMs: 5, orphanSweepInitialMs: 5 });
    const t = new Date(Date.now() - 45 * 60_000).toISOString();
    m.app.store.saveJob({ id: "a", videoId: "v", status: "RUNNING", currentStage: null, errorMessage: null, createdAt: t, updatedAt: t });
    m.app.start();
    expect(m.app.store.getJob("a")!.status).toBe("FAILED");
    const t2 = new Date(Date.now() - 15 * 60_000).toISOString();
    m.app.store.saveJob({ id: "b", videoId: "v", status: "QUEUED", currentStage: null, errorMessage: null, createdAt: t2, updatedAt: t2 });
    await Bun.sleep(30);
    expect(m.app.store.getJob("b")!.errorMessage).toContain("(periodic)");
    m.cleanup();
  });
});

describe("mapPool", () => {
  test("bounded concurrency, ordered results, empty input", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapPool([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(2);
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50]);
    expect(peak).toBe(2);
    expect(await mapPool([], 2, async () => 1)).toEqual([]);
  });
});
