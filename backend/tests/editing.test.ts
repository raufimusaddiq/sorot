// Editing suite: options parsing, range import, per-job options in the
// pipeline, YouTube captions before Whisper, per-video output folders, and
// the clip editor (captions + one-clip re-render).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HttpError } from "../src/http";
import {
  decodeOptions, musicName, parseOptions, parseTimestamp, renderFlags, resolveOptions, subtitleFlags,
} from "../src/options";
import { parseCaptionWords } from "../src/editor";
import { argAfter, defaultExec, makeEnv, procOk, type TestEnv } from "./helpers";

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

  test("a YouTube range downloads only that window: copied, or cut exactly for YouTube captions", async () => {
    const download = () => env.execCalls.filter((c) => c.cmd === "yt-dlp" && c.args.includes("--download-sections")).at(-1)!;
    await processed({ url: "https://youtu.be/abcdefghijk", startTime: 30, endTime: 90 });
    expect(argAfter(download().args, "--download-sections")).toBe("*30-90");
    expect(download().args).not.toContain("--force-keyframes-at-cuts");   // Whisper: a stream copy

    await processed({ url: "https://youtu.be/zyxwvutsrqp", startTime: 30, endTime: 90 }, { youtubeCaptions: true });
    expect(download().args).toContain("--force-keyframes-at-cuts");
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
    expect(argAfter(render, "--reframe")).toBe("blur");
    expect(render).toContain("--hook-first");
    expect(argAfter(render, "--style")).toBe("storyteller");
    expect(argAfter(render, "--bgm")).toBe(`${env.config.dataDir}/music/lofi.mp3`);
    expect(argAfter(render, "--bgm-volume")).toBe("0.3");
    // per-video output folders (shared folders let videos overwrite each other's clips)
    expect(argAfter(render, "--output-dir")).toBe(`${env.config.dataDir}/renders/${videoId}/`);
    expect(argAfter(render, "--export-dir")).toBe(`${env.config.dataDir}/exports/${videoId}/`);

    const bad = await env.json("POST", "/api/process", { videoId, options: { reframe: "zoom" } });
    expect(bad.status).toBe(400);
  });
});

describe("YouTube captions before Whisper", () => {
  const subCalls = () => env.execCalls.filter((c) => c.args.includes("--sub-format")).map((c) => c.args);
  /** yt-dlp writes `track` for the given flag (--write-subs = uploaded, --write-auto-subs = auto). */
  const withTrack = (flag: string, track: object) => {
    env.execHandler.fn = (cmd, args) => {
      if (args.includes("--sub-format") && args.includes(flag)) {
        writeFileSync(join(dirname(argAfter(args, "-o")), "abcdefghijk.id.json3"), JSON.stringify(track));
      }
      return defaultExec(cmd, args);
    };
  };
  const AUTO = { events: [
    { tStartMs: 4800, dDurationMs: 2000, segs: [{ utf8: "halo", tOffsetMs: 0 }, { utf8: " semua", tOffsetMs: 600 }] },
    { tStartMs: 7000, dDurationMs: 1500, segs: [{ utf8: "apa kabar" }] },
  ] };

  test("captions replace Whisper when found (auto only when allowed, shifted to the range)", async () => {
    withTrack("--write-auto-subs", AUTO);
    const { videoId } = await processed({ url: "https://youtu.be/abcdefghijk", startTime: 5, endTime: 65 },
      { youtubeCaptions: true, allowAutoCaptions: true });
    expect(subCalls().map((a) => a[2])).toEqual(["--write-subs", "--write-auto-subs"]);
    expect(argAfter(subCalls()[0]!, "--sub-format")).toBe("json3");
    expect(env.calls.some((c) => c.script === "transcribe.py")).toBeFalse();
    const saved = JSON.parse(readFileSync(`${env.config.dataDir}/transcripts/${videoId}.json`, "utf-8"));
    expect(saved).toMatchObject({ found: true, videoId, source: "youtube-auto", model: "youtube-auto", language: "id" });
    // "halo" was spoken before the range → dropped; times are relative to 5 s
    expect(saved.segments).toEqual([
      { index: 0, start: 0.4, end: 1.4, text: "semua", words: [{ text: "semua", start: 0.4, end: 1.4 }] },
      { index: 1, start: 2, end: 3.5, text: "apa kabar" },
    ]);
  });

  test("uploaded captions win; auto-captions are skipped unless allowed", async () => {
    withTrack("--write-subs", { events: [{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: "[Musik]\nhalo  dunia" }] }] });
    const { videoId } = await processed(undefined, { youtubeCaptions: true });
    expect(subCalls()).toHaveLength(1);
    const saved = JSON.parse(readFileSync(`${env.config.dataDir}/transcripts/${videoId}.json`, "utf-8"));
    expect(saved.source).toBe("youtube-uploaded");
    expect(saved.segments).toEqual([{ index: 0, start: 0, end: 2, text: "halo dunia" }]);
  });

  test("falls back to Whisper when none are found, the track is empty, or yt-dlp fails", async () => {
    await processed(undefined, { youtubeCaptions: true, allowAutoCaptions: true });
    expect(subCalls()).toHaveLength(2);
    expect(env.calls.some((c) => c.script === "transcribe.py")).toBeTrue();

    env.calls.length = 0;
    withTrack("--write-subs", { events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "[Musik]" }] }] });
    await processed({ url: "https://youtu.be/zyxwvutsrqp" }, { youtubeCaptions: true });
    expect(env.calls.some((c) => c.script === "transcribe.py")).toBeTrue();

    env.calls.length = 0;
    env.execHandler.fn = (cmd, args) => (args.includes("--sub-format") ? { ...procOk("", "HTTP 429"), exitCode: 1 } : defaultExec(cmd, args));
    await processed({ url: "https://youtu.be/abcdefghijk" }, { youtubeCaptions: true });
    expect(env.calls.some((c) => c.script === "transcribe.py")).toBeTrue();
  });

  test("not used unless enabled, nor for local files", async () => {
    await processed();
    const src = join(env.dir, "l.mp4");
    writeFileSync(src, "x");
    await processed({ localPath: src }, { youtubeCaptions: true });
    expect(subCalls()).toEqual([]);
  });

  test("a cancel during the captions fetch is a cancel", async () => {
    let started!: () => void;
    const running = new Promise<void>((r) => { started = r; });
    env.execHandler.fn = (cmd, args, signal) => {
      if (!args.includes("--sub-format")) return defaultExec(cmd, args);
      started();
      return new Promise((resolve) => signal?.addEventListener("abort", () => resolve({ ...procOk(), exitCode: 1, aborted: true })));
    };
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
    expect(env.calls.some((c) => c.script === "subtitle.py")).toBeFalse();    // captions in the same pass
    const segs = JSON.parse(readFileSync(argAfter(render, "--segments"), "utf-8"));
    expect(segs.scoredSegments).toEqual([{ index: 0, rank: clip.rankPos, tier: clip.tier, startTime: 30, endTime: 42 }]);
    expect(argAfter(render, "--tiers")).toBe(clip.tier);
    expect(argAfter(render, "--output-dir")).toBe(`${env.config.dataDir}/renders/${videoId}/`);
    expect(render).toContain("--silence-trim");
    expect(argAfter(render, "--style")).toBe("hormozi");
    expect(argAfter(render, "--export-dir")).toBe(`${env.config.dataDir}/exports/${videoId}/`);
    const edited = JSON.parse(readFileSync(argAfter(render, "--transcript"), "utf-8"));
    expect(edited.segments[0]).toMatchObject({ start: 31, end: 33, text: "Halo Mongol" });
    expect(r.body.data.clip.exportPath).toBe(r.body.data.clip.renderPath);
  });

  test("re-render keeps saved settings unless replaced; null clears the caption edit", async () => {
    const { clip, videoId } = await readyClip();
    env.app.store.updateClip(clip.id, { options: JSON.stringify({ reframe: "center" }), captionWords: JSON.stringify([{ text: "x", start: 1, end: 2 }]) });
    const r = await env.json("POST", `/api/clips/${clip.id}/rerender`, {});
    expect(JSON.parse(r.body.data.clip.options)).toEqual({ reframe: "center" });
    expect(argAfter(env.calls.at(-1)!.args, "--reframe")).toBe("center");
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

  test("render failures mark the clip FAILED", async () => {
    const { clip } = await readyClip();
    env.scripts["render.py"] = () => ({ clips: [{ status: "FAILED", error: "nvenc died" }] });
    const r = await env.json("POST", `/api/clips/${clip.id}/rerender`, {});
    expect(r).toEqual({ status: 500, body: { status: "error", error: "Re-render failed: nvenc died" } });
    expect(env.app.store.getClip(clip.id)).toMatchObject({ renderStatus: "FAILED", exportStatus: "FAILED" });

    env.scripts["render.py"] = () => ({ clips: [] });
    expect((await env.json("POST", `/api/clips/${clip.id}/rerender`, {})).body.error).toBe("Re-render failed: render produced no clip");

    env.scripts["render.py"] = () => ({ clips: [{ status: "COMPLETED", captioned: true, path: "/e/clip_1_subtitled.mp4" }] });
    expect((await env.json("POST", `/api/clips/${clip.id}/rerender`, {})).status).toBe(200);
    expect(env.app.store.getClip(clip.id)).toMatchObject({ renderStatus: "COMPLETED", exportStatus: "COMPLETED",
      renderPath: "/e/clip_1_subtitled.mp4", exportPath: "/e/clip_1_subtitled.mp4" });
  });

  test("renders requested together wait for a slot (maxParallelRenders)", async () => {
    const { videoId } = await processed();
    const clips = env.app.store.clipsForVideo(videoId);
    env.config.maxParallelRenders = 2;
    let inFlight = 0;
    let most = 0;
    const gates: Array<() => void> = [];
    const orig = env.scripts["render.py"]!;
    env.scripts["render.py"] = async (args) => {
      most = Math.max(most, ++inFlight);
      await new Promise<void>((r) => gates.push(r));
      inFlight--;
      return orig(args);
    };
    const reqs = clips.map((c) => env.json("POST", `/api/clips/${c.id}/rerender`, {}));
    const tick = () => new Promise((r) => setTimeout(r, 5));
    await tick();
    expect(gates).toHaveLength(2);                       // the third waits for a slot
    expect(env.app.store.getClip(clips[2]!.id)!.renderStatus).toBe("RENDERING");
    gates.shift()!();
    await tick();
    expect(gates).toHaveLength(2);                       // …and takes the freed one
    while (gates.length) { gates.shift()!(); await tick(); }
    expect((await Promise.all(reqs)).map((r) => r.status)).toEqual([200, 200, 200]);
    expect(most).toBe(2);
  });

  test("music listing", async () => {
    expect((await env.json("GET", "/api/music")).body.data.tracks).toEqual([]);
    const dir = `${env.config.dataDir}/music`;
    mkdirSync(dir, { recursive: true });
    for (const f of ["b-song.mp3", "a-loop.M4A", ".hidden.mp3", "notes.txt"]) writeFileSync(join(dir, f), "x");
    expect((await env.json("GET", "/api/music")).body.data.tracks).toEqual(["a-loop.M4A", "b-song.mp3"]);
  });
});
