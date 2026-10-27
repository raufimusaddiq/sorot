// Editing suite: options parsing, range import, per-job options in the
// pipeline, YouTube captions before Whisper, per-video output folders, and
// the clip editor (captions + one-clip re-render).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HttpError } from "../src/http";
import {
  decodeOptions, musicName, parseOptions, parseTimestamp, renderFlags, resolveOptions, subtitleFlags,
} from "../src/options";
import { parseCaptionWords } from "../src/editor";
import { argAfter, makeEnv, type TestEnv } from "./helpers";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => {
  env.app.jobs.shutdown();
  await env.app.jobs.whenIdle();
  env.cleanup();
});

const http = (fn: () => unknown) => {
  try { fn(); } catch (e) { return e instanceof HttpError ? `${e.status} ${e.message}` : String(e); }
  return "no error";
};

async function processed(body: Record<string, unknown> = { url: "https://youtu.be/abcdefghijk" }, options?: unknown) {
  const videoId = (await env.json("POST", "/api/import", body)).body.data.videoId as string;
  const r = await env.json("POST", "/api/process", { videoId, options });
  await env.app.jobs.whenIdle();
  return { videoId, jobId: r.body.data?.jobId as string, status: r.status, body: r.body };
}

describe("options", () => {
  test("parseTimestamp formats and errors", () => {
    expect(parseTimestamp(85)).toBe(85);
    expect(parseTimestamp("85")).toBe(85);
    expect(parseTimestamp("85.5s")).toBe(85.5);
    expect(parseTimestamp("1:25")).toBe(85);
    expect(parseTimestamp("01:02:03")).toBe(3723);
    expect(parseTimestamp("13m25s")).toBe(805);
    expect(parseTimestamp("1h2m")).toBe(3720);
    expect(parseTimestamp("")).toBeNull();
    expect(parseTimestamp(null)).toBeNull();
    expect(http(() => parseTimestamp("soon", "startTime"))).toStartWith('400 startTime "soon" is not a time');
    expect(http(() => parseTimestamp(-1))).toBe("400 timestamp must be a non-negative number of seconds");
  });

  test("parseOptions validates and drops unset keys", () => {
    expect(parseOptions(undefined)).toEqual({});
    expect(parseOptions({ style: "HORMOZI", reframe: "blur", silenceTrim: true, silenceGapSec: "0.8",
      hookFirst: false, youtubeCaptions: true, allowAutoCaptions: false, bgm: "lofi.mp3", bgmVolume: 0.2, junk: 1 }))
      .toEqual({ style: "hormozi", reframe: "blur", silenceTrim: true, silenceGapSec: 0.8, hookFirst: false,
        youtubeCaptions: true, allowAutoCaptions: false, bgm: "lofi.mp3", bgmVolume: 0.2 });
    expect(parseOptions({ style: "", bgm: "" })).toEqual({ bgm: "" });
    expect(http(() => parseOptions([]))).toBe("400 options must be an object");
    expect(http(() => parseOptions({ style: "comic" }))).toStartWith("400 style must be one of");
    expect(http(() => parseOptions({ silenceTrim: "yes" }))).toBe("400 silenceTrim must be true or false");
    expect(http(() => parseOptions({ bgmVolume: 3 }))).toBe("400 bgmVolume must be between 0 and 1");
  });

  test("music names cannot escape data/music", () => {
    expect(musicName(" track.MP3 ")).toBe("track.MP3");
    for (const bad of ["../x.mp3", "a/b.mp3", ".hidden.mp3", "notes.txt", "C:\\x.mp3"]) {
      expect(http(() => musicName(bad))).toStartWith("400 bgm must be a music file name");
    }
  });

  test("layering and stage flags", () => {
    expect(decodeOptions(null)).toEqual({});
    expect(decodeOptions("{broken")).toEqual({});
    expect(decodeOptions('{"style":"nope"}')).toEqual({});
    const r = resolveOptions(env.config, { style: "hormozi", silenceTrim: true }, { style: "cinematic", bgm: "a.mp3" });
    expect(r).toMatchObject({ style: "cinematic", silenceTrim: true, reframe: "face", bgm: "a.mp3", bgmVolume: 0.12 });
    expect(renderFlags(r)).toEqual(["--reframe", "face", "--silence-trim", "--silence-gap", "0.6"]);
    expect(subtitleFlags({ ...r, hookFirst: true }, env.config)).toEqual([
      "--style", "cinematic", "--silence-trim", "--silence-gap", "0.6", "--hook-first",
      "--bgm", `${env.config.dataDir}/music/a.mp3`, "--bgm-volume", "0.12"]);
    expect(subtitleFlags(resolveOptions(env.config), env.config)).toEqual(["--style", "default"]);
  });

  test("GET /api/options exposes choices and defaults", async () => {
    const r = await env.json("GET", "/api/options");
    expect(r.body.data.styles).toContain("hormozi");
    expect(r.body.data.reframeModes).toEqual(["face", "center", "blur"]);
    expect(r.body.data.defaults).toMatchObject({ style: "default", reframe: "face", silenceTrim: false });
  });
});

describe("range import and per-job options", () => {
  test("import with a range stores the section", async () => {
    const r = await env.json("POST", "/api/import", { url: "https://youtu.be/abcdefghijk", startTime: "1:00", endTime: "2:30" });
    expect(r.body.data).toMatchObject({ sectionStart: 60, sectionEnd: 150 });
    expect(env.app.store.getVideo(r.body.data.videoId)).toMatchObject({ sectionStart: 60, sectionEnd: 150 });
  });

  test("range validation", async () => {
    expect((await env.json("POST", "/api/import", { url: "u", startTime: "1:00" })).body.error)
      .toBe("Give both startTime and endTime, or neither");
    expect((await env.json("POST", "/api/import", { url: "u", startTime: 10, endTime: 15 })).body.error)
      .toBe("The range must be at least 10 s long");
    expect((await env.json("POST", "/api/import", { url: "u", startTime: "x", endTime: 15 })).status).toBe(400);
  });

  test("a YouTube range downloads only that window", async () => {
    await processed({ url: "https://youtu.be/abcdefghijk", startTime: 30, endTime: 90 });
    const dl = env.execCalls.find((c) => c.cmd === "yt-dlp" && c.args[0] !== "--print")!;
    expect(argAfter(dl.args, "--download-sections")).toBe("*30-90");
    expect(dl.args).toContain("--force-keyframes-at-cuts");
  });

  test("a local range is cut once; an existing cut is reused", async () => {
    const src = join(env.dir, "local.mp4");
    writeFileSync(src, "x");
    const { videoId } = await processed({ localPath: src, startTime: 10, endTime: 40 });
    const cut = env.execCalls.find((c) => c.cmd === "ffmpeg" && c.args.includes("-c"))!;
    expect(cut.args.slice(0, 6)).toEqual(["-ss", "10", "-to", "40", "-i", src]);
    expect(env.app.store.getVideo(videoId)!.filePath).toBe(`${env.config.dataDir}/raw/${videoId}.mp4`);

    env.execCalls.length = 0;
    const v2 = (await env.json("POST", "/api/import", { localPath: src, startTime: 10, endTime: 40 })).body.data.videoId;
    mkdirSync(`${env.config.dataDir}/raw`, { recursive: true });
    writeFileSync(`${env.config.dataDir}/raw/${v2}.mp4`, "cut");
    await env.json("POST", "/api/process", { videoId: v2 });
    await env.app.jobs.whenIdle();
    expect(env.execCalls.some((c) => c.args.includes("-c") && c.args.includes("copy"))).toBeFalse();
  });

  test("process stores options and the stages use them; bad options are rejected", async () => {
    mkdirSync(`${env.config.dataDir}/music`, { recursive: true });
    const { jobId, videoId } = await processed(undefined, {
      style: "storyteller", reframe: "blur", hookFirst: true, bgm: "lofi.mp3", bgmVolume: 0.3,
    });
    expect(JSON.parse(env.app.store.getJob(jobId)!.options!)).toMatchObject({ style: "storyteller", hookFirst: true });
    const render = env.calls.find((c) => c.script === "render.py")!.args;
    const sub = env.calls.find((c) => c.script === "subtitle.py")!.args;
    expect(argAfter(render, "--reframe")).toBe("blur");
    expect(render).toContain("--hook-first");
    expect(argAfter(sub, "--style")).toBe("storyteller");
    expect(argAfter(sub, "--bgm")).toBe(`${env.config.dataDir}/music/lofi.mp3`);
    expect(argAfter(sub, "--bgm-volume")).toBe("0.3");
    // per-video output folders (shared folders let videos overwrite each other's clips)
    expect(argAfter(render, "--output-dir")).toBe(`${env.config.dataDir}/renders/${videoId}/`);
    expect(argAfter(sub, "--output-dir")).toBe(`${env.config.dataDir}/exports/${videoId}/`);

    const bad = await env.json("POST", "/api/process", { videoId, options: { reframe: "zoom" } });
    expect(bad.status).toBe(400);
  });
});

describe("YouTube captions before Whisper", () => {
  test("uploaded captions replace Whisper when found", async () => {
    env.scripts["youtube_captions.py"] = () => ({ found: true, source: "youtube-uploaded", segments: [{ start: 0, end: 2, text: "halo" }] });
    const { videoId } = await processed({ url: "https://youtu.be/abcdefghijk", startTime: 5, endTime: 65 },
      { youtubeCaptions: true, allowAutoCaptions: true });
    const call = env.calls.find((c) => c.script === "youtube_captions.py")!.args;
    expect(call).toContain("--allow-auto");
    expect(argAfter(call, "--start")).toBe("5");
    expect(env.calls.some((c) => c.script === "transcribe.py")).toBeFalse();
    const saved = JSON.parse(readFileSync(`${env.config.dataDir}/transcripts/${videoId}.json`, "utf-8"));
    expect(saved.source).toBe("youtube-uploaded");
  });

  test("falls back to Whisper when none are found or the fetch fails", async () => {
    await processed(undefined, { youtubeCaptions: true });
    expect(env.calls.some((c) => c.script === "transcribe.py")).toBeTrue();
    env.calls.length = 0;
    env.scripts["youtube_captions.py"] = () => { throw new Error("429"); };
    await processed({ url: "https://youtu.be/zyxwvutsrqp" }, { youtubeCaptions: true });
    expect(env.calls.some((c) => c.script === "transcribe.py")).toBeTrue();
  });

  test("not used unless enabled, nor for local files", async () => {
    await processed();
    const src = join(env.dir, "l.mp4");
    writeFileSync(src, "x");
    await processed({ localPath: src }, { youtubeCaptions: true });
    expect(env.calls.some((c) => c.script === "youtube_captions.py")).toBeFalse();
  });

  test("a cancel during the captions fetch is a cancel", async () => {
    let started!: () => void;
    const running = new Promise<void>((r) => { started = r; });
    env.scripts["youtube_captions.py"] = (_a, signal) => new Promise((_, reject) => {
      started();
      signal?.addEventListener("abort", () => reject(new Error("killed")));
    });
    const videoId = (await env.json("POST", "/api/import", { url: "https://youtu.be/abcdefghijk" })).body.data.videoId;
    const jobId = (await env.json("POST", "/api/process", { videoId, options: { youtubeCaptions: true } })).body.data.jobId;
    await running;
    await env.json("POST", `/api/jobs/${jobId}/cancel`);
    await env.app.jobs.whenIdle();
    expect(env.app.store.getJob(jobId)!.status).toBe("CANCELLED");
    expect(env.calls.some((c) => c.script === "transcribe.py")).toBeFalse();
  });
});

describe("clip editor", () => {
  async function readyClip() {
    const { videoId } = await processed();
    const clip = env.app.store.clipsForVideo(videoId)[0]!;
    return { videoId, clip };
  }

  test("captions come from the transcript, then from the saved edit", async () => {
    const { clip } = await readyClip();
    const r = await env.json("GET", `/api/clips/${clip.id}/captions`);
    expect(r.body.data).toEqual({ edited: false, words: [
      { text: "halo", start: clip.startTime + 0.5, end: clip.startTime + 1 },
      { text: "dunia", start: clip.startTime + 1.2, end: clip.startTime + 2 }] });
    env.app.store.updateClip(clip.id, { captionWords: JSON.stringify([{ text: "Halo", start: 1, end: 2 }]) });
    expect((await env.json("GET", `/api/clips/${clip.id}/captions`)).body.data)
      .toEqual({ edited: true, words: [{ text: "Halo", start: 1, end: 2 }] });
    env.app.store.updateClip(clip.id, { captionWords: "{corrupt" });
    expect((await env.json("GET", `/api/clips/${clip.id}/captions`)).body.data.edited).toBeFalse();
  });

  test("captions: 404 and missing transcript", async () => {
    expect((await env.json("GET", "/api/clips/nope/captions")).status).toBe(404);
    const { clip, videoId } = await readyClip();
    const { rmSync } = await import("node:fs");
    rmSync(`${env.config.dataDir}/transcripts/${videoId}.json`);
    const r = await env.json("GET", `/api/clips/${clip.id}/captions`);
    expect(r).toEqual({ status: 409, body: { status: "error", error: "Transcript not available yet" } });
  });

  test("re-render with new timing, options and corrected words", async () => {
    const { clip, videoId } = await readyClip();
    env.calls.length = 0;
    const words = [{ text: " Halo ", start: 31, end: 31.5 }, { text: "", start: 32, end: 32.2 }, { text: "Mongol", start: 32.5, end: 33 }];
    const r = await env.json("POST", `/api/clips/${clip.id}/rerender`, {
      startTime: "0:30", endTime: 42, options: { style: "hormozi", silenceTrim: true }, captionWords: words,
    });
    expect(r.status).toBe(200);
    expect(r.body.data.clip).toMatchObject({ startTime: 30, endTime: 42, durationSec: 12, renderStatus: "COMPLETED",
      exportStatus: "COMPLETED" });
    expect(JSON.parse(r.body.data.clip.options)).toEqual({ style: "hormozi", silenceTrim: true });
    expect(JSON.parse(r.body.data.clip.captionWords)).toEqual([{ text: "Halo", start: 31, end: 31.5 },
      { text: "Mongol", start: 32.5, end: 33 }]);

    const render = env.calls.find((c) => c.script === "render.py")!.args;
    const sub = env.calls.find((c) => c.script === "subtitle.py")!.args;
    const segs = JSON.parse(readFileSync(argAfter(render, "--segments"), "utf-8"));
    expect(segs.scoredSegments).toEqual([{ index: 0, rank: clip.rankPos, tier: clip.tier, startTime: 30, endTime: 42 }]);
    expect(argAfter(render, "--tiers")).toBe(clip.tier);
    expect(argAfter(render, "--output-dir")).toBe(`${env.config.dataDir}/renders/${videoId}/`);
    expect(render).toContain("--silence-trim");
    expect(argAfter(sub, "--style")).toBe("hormozi");
    const edited = JSON.parse(readFileSync(argAfter(sub, "--transcript"), "utf-8"));
    expect(edited.segments[0]).toMatchObject({ start: 31, end: 33, text: "Halo Mongol" });
    expect(argAfter(render, "--transcript")).toBe(argAfter(sub, "--transcript"));
  });

  test("re-render keeps saved settings unless replaced; null clears the caption edit", async () => {
    const { clip, videoId } = await readyClip();
    env.app.store.updateClip(clip.id, { options: JSON.stringify({ reframe: "center" }), captionWords: JSON.stringify([{ text: "x", start: 1, end: 2 }]) });
    const r = await env.json("POST", `/api/clips/${clip.id}/rerender`, {});
    expect(JSON.parse(r.body.data.clip.options)).toEqual({ reframe: "center" });
    expect(argAfter(env.calls.at(-2)!.args, "--reframe")).toBe("center");
    const cleared = await env.json("POST", `/api/clips/${clip.id}/rerender`, { captionWords: null, options: {} });
    expect(cleared.body.data.clip).toMatchObject({ captionWords: null, options: null });
    expect(argAfter(env.calls.at(-1)!.args, "--transcript")).toBe(`${env.config.dataDir}/transcripts/${videoId}.json`);
  });

  test("an edit that deletes every word renders without captions", async () => {
    const { clip } = await readyClip();
    const r = await env.json("POST", `/api/clips/${clip.id}/rerender`, { captionWords: [{ text: " ", start: 1, end: 2 }] });
    expect(r.status).toBe(200);
    const edited = JSON.parse(readFileSync(argAfter(env.calls.at(-1)!.args, "--transcript"), "utf-8"));
    expect(edited).toEqual({ segments: [] });
  });

  test("validation and conflicts", async () => {
    const { clip, videoId } = await readyClip();
    const post = (body: unknown, id = clip.id) => env.json("POST", `/api/clips/${id}/rerender`, body);
    expect((await post({}, "nope")).status).toBe(404);
    expect((await post({ startTime: 10, endTime: 11 })).body.error).toBe("Clip must be 3-180 s long (got 1.0 s)");
    expect((await post({ captionWords: "x" })).body.error).toBe("captionWords must be an array or null");
    expect((await post({ captionWords: [{ text: "a", start: 5, end: 1 }] })).body.error)
      .toBe("captionWords[0] needs text, start and end (end >= start)");
    expect((await post({ options: { bgm: "missing.mp3" } })).body.error).toBe("Music file not found in data/music: missing.mp3");
    expect(http(() => parseCaptionWords(new Array(2001).fill({ text: "a", start: 0, end: 1 }))))
      .toBe("400 captionWords may hold at most 2000 words");

    env.app.store.saveJob({ ...env.app.store.latestJobForVideo(videoId)!, id: "j-live", status: "RUNNING",
      createdAt: new Date(Date.now() + 1000).toISOString() });
    expect((await post({})).status).toBe(409);
    env.app.store.updateJob("j-live", { status: "COMPLETED" });

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const orig = env.scripts["render.py"]!;
    env.scripts["render.py"] = async (args) => { await gate; return orig(args); };
    const first = post({});
    await Bun.sleep(5);
    expect((await post({})).body.error).toBe("Clip is already re-rendering");
    release();
    expect((await first).status).toBe(200);

    env.app.store.deleteVideoRow(videoId);
    expect((await post({})).body.error).toBe("Video not found");
  });

  test("render and subtitle failures mark the clip FAILED", async () => {
    const { clip } = await readyClip();
    env.scripts["render.py"] = () => ({ clips: [{ status: "FAILED", error: "nvenc died" }] });
    const r = await env.json("POST", `/api/clips/${clip.id}/rerender`, {});
    expect(r).toEqual({ status: 500, body: { status: "error", error: "Re-render failed: nvenc died" } });
    expect(env.app.store.getClip(clip.id)).toMatchObject({ renderStatus: "FAILED", exportStatus: "FAILED" });

    env.scripts["render.py"] = () => ({ clips: [] });
    expect((await env.json("POST", `/api/clips/${clip.id}/rerender`, {})).body.error).toBe("Re-render failed: render produced no clip");

    env.scripts["render.py"] = () => ({ clips: [{ status: "COMPLETED", path: "/r/clip_1.mp4" }] });
    env.scripts["subtitle.py"] = () => ({});
    const s = await env.json("POST", `/api/clips/${clip.id}/rerender`, {});
    expect(s.body.error).toBe("Re-render failed: subtitle produced no clip");
    expect(env.app.store.getClip(clip.id)).toMatchObject({ renderStatus: "COMPLETED", exportStatus: "FAILED" });
  });

  test("music listing", async () => {
    expect((await env.json("GET", "/api/music")).body.data.tracks).toEqual([]);
    const dir = `${env.config.dataDir}/music`;
    mkdirSync(dir, { recursive: true });
    for (const f of ["b-song.mp3", "a-loop.M4A", ".hidden.mp3", "notes.txt"]) writeFileSync(join(dir, f), "x");
    expect((await env.json("GET", "/api/music")).body.data.tracks).toEqual(["a-loop.M4A", "b-song.mp3"]);
  });
});
