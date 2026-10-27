// HTTP contract tests. The first blocks port the Java *IT suites 1:1
// (controller/VideoControllerIT, JobControllerIT, ClipControllerIT,
// DiscoveryControllerIT, HealthControllerIT); the rest cover the endpoints
// those suites never reached.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, type TestEnv } from "./helpers";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => {
  env.app.jobs.shutdown(); // releases any pipeline a test parked at TRANSCRIBE
  await env.app.jobs.whenIdle();
  await env.app.discovery.whenIdle();
  await env.app.channels.whenIdle();
  env.cleanup();
});

const seedVideo = (id = "v1", filePath = "/test.mp4", title: string | null = null) =>
  env.app.store.saveVideo({ id, sourceUrl: null, sourceType: "LOCAL", title, durationSec: null, filePath, createdAt: new Date().toISOString() });

function seedClip(id: string, fields: Record<string, unknown> = {}) {
  seedVideo("vc");
  env.app.store.saveClip({
    id, videoId: "vc", rankPos: 1, score: 0.9, tier: "PRIMARY", title: null, description: null,
    startTime: 0, endTime: 10, durationSec: 10, textContent: "t", renderStatus: "PENDING", renderPath: null,
    exportStatus: "PENDING", exportPath: null, createdAt: new Date().toISOString(), ...fields,
  });
}

describe("health (HealthControllerIT)", () => {
  test("GET /api/health", async () => {
    const r = await env.json("GET", "/api/health");
    expect(r).toEqual({ status: 200, body: { status: "ok", data: { healthy: true } } });
  });
});

describe("videos (VideoControllerIT)", () => {
  test("import with YouTube URL returns videoId", async () => {
    const r = await env.json("POST", "/api/import", { url: "https://www.youtube.com/watch?v=test123" });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("ok");
    expect(r.body.data.videoId).toBeString();
    expect(r.body.data.sourceType).toBe("YOUTUBE");
    const v = env.app.store.getVideo(r.body.data.videoId);
    expect(v?.filePath).toBe(`${env.config.dataDir}/raw/${r.body.data.videoId}.mp4`);
  });

  test("import with local path returns LOCAL", async () => {
    const r = await env.json("POST", "/api/import", { localPath: "/videos/test.mp4" });
    expect(r.body.data.sourceType).toBe("LOCAL");
    expect(env.app.store.getVideo(r.body.data.videoId)?.filePath).toBe("/videos/test.mp4");
  });

  test("import with no input still creates LOCAL (legacy behavior)", async () => {
    const r = await env.json("POST", "/api/import", {});
    expect(r.status).toBe(200);
    expect(r.body.data.sourceType).toBe("LOCAL");
  });

  test("list returns all videos, newest first", async () => {
    seedVideo("v1");
    await Bun.sleep(2);
    seedVideo("v2");
    const r = await env.json("GET", "/api/videos");
    expect(r.body.data.videos.map((v: any) => v.id)).toEqual(["v2", "v1"]);
    // Jackson-compatible camelCase keys, nulls included
    expect(Object.keys(r.body.data.videos[0]).sort()).toEqual(
      ["createdAt", "durationSec", "filePath", "id", "sectionEnd", "sectionStart", "sourceType", "sourceUrl", "title"]);
  });

  test("get existing video", async () => {
    seedVideo("v1", "/test.mp4", "Test Video");
    const r = await env.json("GET", "/api/videos/v1");
    expect(r.body.data.title).toBe("Test Video");
  });

  test("get missing video → 404 error envelope", async () => {
    const r = await env.json("GET", "/api/videos/nonexistent");
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ status: "error", error: "Video not found" });
  });

  test("delete removes video, clips, scores, jobs, stages and files; keeps feedback", async () => {
    const d = env.config.dataDir;
    for (const [sub, ext] of [["raw", "mp4"], ["audio", "wav"], ["segments", "json"]]) {
      mkdirSync(`${d}/${sub}`, { recursive: true });
      writeFileSync(`${d}/${sub}/vc.${ext}`, "x");
    }
    mkdirSync(`${d}/renders`, { recursive: true });
    writeFileSync(`${d}/renders/c.mp4`, "x");
    seedClip("c1", { renderPath: `${d}/renders/c.mp4` });
    env.app.store.saveClipScore({ id: "s1", clipId: "c1", hookStrength: 1, keywordTrigger: 0, novelty: 0, clarity: 0,
      emotionalEnergy: 0, textSentiment: 0, pauseStructure: 0, facePresence: 0, sceneChange: 0, topicFit: 0,
      historyScore: 0, boostTotal: 0, penaltyTotal: 0 });
    await env.json("POST", "/api/clips/c1/feedback", { postedAt: "2026-01-01T00:00:00Z", views: 10 });
    env.scripts["media_features.py"] = () => { throw new Error("stop"); }; // let the job fail fast
    const job = (await env.json("POST", "/api/process", { videoId: "vc" })).body.data.jobId;
    await env.app.jobs.whenIdle();

    const r = await env.json("DELETE", "/api/videos/vc");
    expect(r.body.data).toEqual({ deleted: true, videoId: "vc" });
    expect(env.app.store.getVideo("vc")).toBeNull();
    expect(env.app.store.getClip("c1")).toBeNull();
    expect(env.app.store.clipScore("c1")).toBeNull();
    expect(env.app.store.getJob(job)).toBeNull();
    expect(env.app.store.stagesForJob(job)).toEqual([]);
    expect(env.app.store.feedbackForClip("c1")).not.toBeNull();
    expect(await Bun.file(`${d}/raw/vc.mp4`).exists()).toBeFalse();
    expect(await Bun.file(`${d}/renders/c.mp4`).exists()).toBeFalse();
  });
});

describe("jobs (JobControllerIT / JobServiceIT)", () => {
  // Park every pipeline at TRANSCRIBE so a job stays active for the whole test
  // (the Java ITs relied on `echo` subprocesses being slow for the same effect).
  beforeEach(() => {
    const file = join(env.dir, "test.mp4");
    writeFileSync(file, "x");
    seedVideo("v1", file);
    env.scripts["transcribe.py"] = (_a, signal) =>
      new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
  });

  test("process without videoId → 400", async () => {
    const r = await env.json("POST", "/api/process", {});
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("videoId required");
  });

  test("process missing video → 409", async () => {
    const r = await env.json("POST", "/api/process", { videoId: "nonexistent" });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("Video not found: nonexistent");
  });

  test("process existing video → jobId + QUEUED, with 9 stage rows", async () => {
    const r = await env.json("POST", "/api/process", { videoId: "v1" });
    expect(r.status).toBe(200);
    expect(r.body.data.jobId).toBeString();
    expect(r.body.data.status).toBe("QUEUED");
    expect(r.body.data.currentStage).toBe("");
    expect(env.app.jobs.getStageStatuses(r.body.data.jobId)).toHaveLength(9);
  });

  test("duplicate active job → 409", async () => {
    await env.json("POST", "/api/process", { videoId: "v1" });
    const r = await env.json("POST", "/api/process", { videoId: "v1" });
    expect(r.status).toBe(409);
    expect(r.body.error).toStartWith("Video already has an active job");
  });

  test("get job → job + ordered stages", async () => {
    const jobId = (await env.json("POST", "/api/process", { videoId: "v1" })).body.data.jobId;
    const r = await env.json("GET", `/api/jobs/${jobId}`);
    expect(r.body.data.job.id).toBe(jobId);
    expect(r.body.data.stages.map((s: any) => s.stage)).toEqual([
      "IMPORT", "AUDIO_EXTRACT", "TRANSCRIBE", "SEGMENT", "SCORE", "RENDER", "SUBTITLE", "VARIATION", "ANALYTICS"]);
  });

  test("get missing job → 404 error envelope", async () => {
    const r = await env.json("GET", "/api/jobs/nonexistent");
    expect(r.status).toBe(404);
    expect(r.body.status).toBe("error");
  });

  test("list jobs", async () => {
    await env.json("POST", "/api/process", { videoId: "v1" });
    const r = await env.json("GET", "/api/jobs");
    expect(r.body.data.jobs).toBeArrayOfSize(1);
  });

  test("retry non-failed job → 400; retry/cancel missing job → 400", async () => {
    const jobId = (await env.json("POST", "/api/process", { videoId: "v1" })).body.data.jobId;
    expect((await env.json("POST", `/api/jobs/${jobId}/retry`)).status).toBe(400);
    expect((await env.json("POST", "/api/jobs/nope/retry")).body.error).toBe("Job not found: nope");
    expect((await env.json("POST", "/api/jobs/nope/cancel")).status).toBe(400);
  });
});

describe("clips (ClipControllerIT)", () => {
  test("list clips for unknown video → empty", async () => {
    const r = await env.json("GET", "/api/videos/nonexistent/clips");
    expect(r.body.data.clips).toEqual([]);
  });

  test("get missing clip → 404 error envelope", async () => {
    const r = await env.json("GET", "/api/clips/nonexistent");
    expect(r.status).toBe(404);
    expect(r.body.status).toBe("error");
  });

  test("get clip with and without score breakdown", async () => {
    seedClip("c1");
    expect((await env.json("GET", "/api/clips/c1")).body.data).toContainAllKeys(["clip"]);
    env.app.store.saveClipScore({ id: "s1", clipId: "c1", hookStrength: 0.5, keywordTrigger: null, novelty: null,
      clarity: null, emotionalEnergy: null, textSentiment: null, pauseStructure: null, facePresence: null,
      sceneChange: null, topicFit: null, historyScore: null, boostTotal: 0, penaltyTotal: 0 });
    const r = await env.json("GET", "/api/clips/c1");
    expect(r.body.data.clip.rankPos).toBe(1);
    expect(r.body.data.scoreBreakdown.hookStrength).toBe(0.5);
  });

  test("export with no / empty clipIds → 400", async () => {
    expect((await env.json("POST", "/api/clips/export", {})).status).toBe(400);
    expect((await env.json("POST", "/api/clips/export", { clipIds: [] })).status).toBe(400);
  });

  test("export copies best file; skips unrendered; unknown id → 500", async () => {
    const p = join(env.dir, "render.mp4");
    writeFileSync(p, "render");
    seedClip("c1", { renderPath: p });
    env.app.store.saveClip({ ...env.app.store.getClip("c1")!, id: "c2", renderPath: null });
    const r = await env.json("POST", "/api/clips/export", { clipIds: ["c1", "c2"] });
    expect(r.body.data.exported).toHaveLength(1);
    const exportPath = `${env.config.dataDir}/exports/c1_final.mp4`;
    expect(r.body.data.exported[0].exportPath).toBe(exportPath);
    expect(await Bun.file(exportPath).text()).toBe("render");
    // second export copies from the export itself (no self-copy crash)
    expect((await env.json("POST", "/api/clips/export", { clipIds: ["c1"] })).status).toBe(200);
    const bad = await env.json("POST", "/api/clips/export", { clipIds: ["missing"] });
    expect(bad.status).toBe(500);
    expect(bad.body.error).toBe("Clip not found: missing");
  });

  test("preview / download for missing clip → 404", async () => {
    expect((await env.req("GET", "/api/clips/nonexistent/preview")).status).toBe(404);
    expect((await env.req("GET", "/api/clips/nonexistent/export")).status).toBe(404);
  });

  test("preview / download with no file paths → 404", async () => {
    seedClip("c1");
    expect((await env.json("GET", "/api/clips/c1/preview")).body.error).toBe("No rendered file available");
    expect((await env.json("GET", "/api/clips/c1/export")).body.error).toBe("No exported file available");
    env.app.store.updateClip("c1", { renderPath: join(env.dir, "gone.mp4") });
    expect((await env.json("GET", "/api/clips/c1/preview")).body.error).toBe("File not found or empty: gone.mp4");
  });

  test("preview streams with Range support; download is an attachment", async () => {
    const p = join(env.dir, "clip.mp4");
    writeFileSync(p, "0123456789");
    seedClip("c1", { renderPath: p, exportPath: p });

    const full = await env.req("GET", "/api/clips/c1/preview");
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("video/mp4");
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(await full.text()).toBe("0123456789");

    const part = await env.req("GET", "/api/clips/c1/preview", undefined, { range: "bytes=2-5" });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await part.text()).toBe("2345");

    const open = await env.req("GET", "/api/clips/c1/preview", undefined, { range: "bytes=7-" });
    expect(await open.text()).toBe("789");
    const suffix = await env.req("GET", "/api/clips/c1/preview", undefined, { range: "bytes=-3" });
    expect(await suffix.text()).toBe("789");
    const bad = await env.req("GET", "/api/clips/c1/preview", undefined, { range: "bytes=50-60" });
    expect(bad.status).toBe(416);
    expect(bad.headers.get("content-range")).toBe("bytes */10");

    const dl = await env.req("GET", "/api/clips/c1/export");
    expect(dl.headers.get("content-disposition")).toBe('attachment; filename="clip.mp4"');
    expect(dl.headers.get("content-type")).toBe("application/octet-stream");
  });
});

describe("feedback", () => {
  test("postedAt required", async () => {
    const r = await env.json("POST", "/api/clips/c1/feedback", { views: 1 });
    expect(r.status).toBe(400);
    expect(r.body.error).toStartWith("postedAt is required");
  });

  test("invalid / future postedAt and unknown clip → 400", async () => {
    seedClip("c1");
    expect((await env.json("POST", "/api/clips/c1/feedback", { postedAt: "yesterday" })).body.error).toStartWith("postedAt must be ISO-8601");
    expect((await env.json("POST", "/api/clips/c1/feedback", { postedAt: "2999-01-01T00:00:00Z" })).body.error).toStartWith("postedAt is in the future");
    const r = await env.json("POST", "/api/clips/nope/feedback", { postedAt: "2026-01-01T00:00:00Z" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("Clip not found: nope");
  });

  test("submit computes viral score from velocity and upserts one row", async () => {
    seedClip("c1");
    const r = await env.json("POST", "/api/clips/c1/feedback", {
      postedAt: "2026-01-01T00:00:00+07:00", views: "1000", likes: 50, comments: 3, shares: 2, saves: 1,
    });
    expect(r.body.data).toEqual({ clipId: "c1", viralScore: 0.42, views: 1000, likes: 50, postedAt: "2026-01-01T00:00:00+07:00" });
    const call = env.calls.find((c) => c.script === "feedback.py")!;
    expect(call.args).toContain("calc-viral-score");
    expect(Number(call.args[call.args.indexOf("--hours-since-post") + 1])).toBeGreaterThan(1);

    await env.json("POST", "/api/clips/c1/feedback", { postedAt: "2026-01-01T00:00:00Z", views: 2000 });
    expect(env.app.store.countFeedback()).toEqual({ total: 1, withScores: 1 });
    const fb = env.app.store.feedbackForClip("c1")!;
    expect(fb.tiktokViews).toBe(2000);
    expect(fb.features).toBe("{}"); // no clip_score row existed at first submit
  });

  test("viral-score failure still saves metrics", async () => {
    seedClip("c1");
    env.scripts["feedback.py"] = () => { throw new Error("boom"); };
    const r = await env.json("POST", "/api/clips/c1/feedback", { postedAt: "2026-01-01T00:00:00Z", views: 5 });
    expect(r.status).toBe(200);
    expect(r.body.data.viralScore).toBeNull();
  });

  test("feature snapshot and training export", async () => {
    seedClip("c1");
    env.app.store.saveClipScore({ id: "s1", clipId: "c1", hookStrength: 0.8, keywordTrigger: 0.1, novelty: 0.2,
      clarity: 0.3, emotionalEnergy: 0.4, textSentiment: 0.5, pauseStructure: 0.6, facePresence: 0.7,
      sceneChange: 0.8, topicFit: 0.9, historyScore: 1, boostTotal: 0, penaltyTotal: 0 });
    await env.json("POST", "/api/clips/c1/feedback", { postedAt: "2026-01-01T00:00:00Z", views: 5 });
    expect(JSON.parse(env.app.store.feedbackForClip("c1")!.features).hookStrength).toBe(0.8);
    // a corrupt features column must not break the export
    seedVideo("v9");
    env.app.store.saveFeedback({ ...env.app.store.feedbackForClip("c1")!, id: "f2", clipId: "c9", features: "not json" });

    const r = await env.json("POST", "/api/feedback/train");
    expect(r.body.data).toEqual({
      status: "trained", version: 4, trained_on: 6,
      weight_changes: { hookStrength: { from: 0.1, to: 0.12 } }, new_weights: { hookStrength: 0.12 }, message: "ok",
    });
    const exported = await Bun.file(`${env.config.dataDir}/feedback/feedback_export.json`).json();
    expect(exported).toHaveLength(2);
    expect(exported[0].features.hookStrength).toBe(0.8);
    expect(exported[1].features).toEqual({});
  });

  test("train with minimal result; weights status; script errors → 500", async () => {
    env.scripts["learn_weights.py"] = (args) =>
      args.includes("train") ? { status: "insufficient_data" } : { version: 3, trained_on: 5, last_updated: "2026-10-01", weights: { hookStrength: 0.1, junk: "x" } };
    expect((await env.json("POST", "/api/feedback/train")).body.data).toEqual({ status: "insufficient_data", version: 0, trained_on: 0 });
    const w = await env.json("GET", "/api/feedback/weights");
    expect(w.body.data).toEqual({ version: 3, trained_on: 5, last_updated: "2026-10-01", total_feedback: 0,
      with_actual_scores: 0, weights: { hookStrength: 0.1, junk: 0 } });
    env.scripts["learn_weights.py"] = () => ({});
    expect((await env.json("GET", "/api/feedback/weights")).body.data.last_updated).toBe("");
    env.scripts["learn_weights.py"] = () => { throw new Error("no model"); };
    const r = await env.json("GET", "/api/feedback/weights");
    expect(r).toEqual({ status: 500, body: { status: "error", error: "no model" } });
  });
});

describe("discovery (DiscoveryControllerIT / DiscoveryServiceTest)", () => {
  test("search/channel validation → 400", async () => {
    expect((await env.json("POST", "/api/discover/search", {})).body).toEqual({ status: "error", error: "query is required" });
    expect((await env.json("POST", "/api/discover/search", { query: "   " })).status).toBe(400);
    expect((await env.json("POST", "/api/discover/channel", {})).body.error).toBe("channelUrl is required");
    expect((await env.json("POST", "/api/discover/channel", { channelUrl: "  " })).status).toBe(400);
  });

  test("script failure → 5xx", async () => {
    env.scripts["discover.py"] = () => { throw new Error("yt-dlp missing"); };
    expect((await env.json("POST", "/api/discover/search", { query: "x" })).status).toBe(500);
    expect((await env.req("POST", "/api/discover/trending")).status).toBe(500);
    expect((await env.json("POST", "/api/discover/channel", { channelUrl: "https://youtube.com/@t" })).status).toBe(500);
  });

  test("search builds args, persists, parses fields, enriches top candidates", async () => {
    const r = await env.json("POST", "/api/discover/search", { query: "indonesian viral", maxResults: 10, minDuration: 120, maxDuration: "1800" });
    expect(r.body.data.mode).toBe("search");
    expect(r.body.data.count).toBe(2);
    const v = r.body.data.videos[0];
    expect(v).toMatchObject({ videoId: "abcdefghijk", youtubeId: "abcdefghijk", title: "Test", duration: 300,
      relevanceScore: 0.75, viewCount: 1000, ageHours: 12.5, status: "NEW", sourceMode: "search", sourceQuery: "indonesian viral" });
    expect(v).toMatchObject({ channelId: "UCch", contentType: "PODCAST", isLikelyClipped: false, speechDensityWpm: null });
    expect(r.body.data.videos[1]).toMatchObject({ viewCount: null, channelId: null, contentType: null, isLikelyClipped: true });
    expect(env.calls[0]!.args).toEqual(["--mode", "search", "--query", "indonesian viral", "--max-results", "10",
      "--min-duration", "120", "--max-duration", "1800"]);

    await env.app.discovery.whenIdle();
    const enrich = env.calls.filter((c) => c.args.includes("enrich"));
    expect(enrich).toHaveLength(2);
    expect(enrich[1]!.args).toContain("9999"); // missing age_hours default
    const c = await env.json("GET", "/api/discover/candidates");
    expect(c.body.data.count).toBe(1); // "Two" has no known age → hidden from the default view
    expect(c.body.data.videos[0].predictedScore).toBe(0.7);
    env.app.store.updateDiscovered(c.body.data.videos[0].id, { ageHours: 91 * 24 });
    expect((await env.json("GET", "/api/discover/candidates")).body.data.count).toBe(0);
    expect((await env.json("GET", "/api/discover/candidates?status=new")).body.data.count).toBe(2);
    expect(env.app.store.discoveredByYoutubeId("abcdefghijk")!.transcriptSample).toBe("contoh transkrip");
  });

  test("trending and channel args; defaults", async () => {
    await env.json("POST", "/api/discover/trending", { maxResults: 15, region: "US" });
    expect(env.calls[0]!.args).toEqual(["--mode", "trending", "--max-results", "15", "--region", "US"]);
    await env.req("POST", "/api/discover/trending");
    expect(env.calls.at(-1)!.args).toEqual(["--mode", "trending", "--max-results", "20", "--region", "ID"]);
    const r = await env.json("POST", "/api/discover/channel", { channelUrl: "https://youtube.com/@test", maxResults: 10, minDuration: 60, maxDuration: 600 });
    expect(r.body.data.mode).toBe("channel");
    expect(env.calls.at(-1)!.args).toEqual(["--mode", "channel", "--channel-url", "https://youtube.com/@test",
      "--max-results", "10", "--min-duration", "60", "--max-duration", "600"]);
  });

  test("re-search keeps user decisions; already-imported videos flagged", async () => {
    await env.json("POST", "/api/import", { url: "https://youtu.be/zyxwvutsrqp?t=3" });
    const first = await env.json("POST", "/api/discover/search", { query: "a" });
    const [a, b] = first.body.data.videos;
    expect(b.status).toBe("IMPORTED");
    await env.json("POST", `/api/discover/candidates/${a.id}/status`, { status: "skipped" });
    const again = await env.json("POST", "/api/discover/search", { query: "b" });
    expect(again.body.data.videos[0]).toMatchObject({ id: a.id, status: "SKIPPED", sourceQuery: "b" });
    expect((await env.json("GET", "/api/discover/candidates?status=skipped")).body.data.count).toBe(1);
  });

  test("enrichment failure is swallowed", async () => {
    env.scripts["discover.py"] = (args) => {
      if (args.includes("enrich")) throw new Error("no captions");
      return { videos: [{ videoId: "abcdefghijk", url: "u", relevanceScore: 1 }] };
    };
    const r = await env.json("POST", "/api/discover/search", { query: "x" });
    expect(r.body.data.mode).toBe("search"); // falls back when script omits mode
    await env.app.discovery.whenIdle();
    expect(env.app.store.discoveredByYoutubeId("abcdefghijk")!.enrichedAt).toBeNull();
  });

  test("status update, queue and drain", async () => {
    const r = await env.json("POST", "/api/discover/search", { query: "x" });
    const [a, b] = r.body.data.videos;
    expect((await env.json("POST", `/api/discover/candidates/${a.id}/status`, {})).status).toBe(400);
    expect((await env.json("POST", "/api/discover/candidates/nope/status", { status: "NEW" })).status).toBe(404);

    expect((await env.json("POST", "/api/discover/queue", {})).body.error).toBe("ids[] is required");
    expect((await env.json("POST", "/api/discover/queue", { ids: [null] })).body.error).toBe("ids[] is empty");
    env.app.store.updateDiscovered(b.id, { status: "IMPORTED" });
    const q = await env.json("POST", "/api/discover/queue", { ids: [a.id, b.id, "missing"] });
    expect(q.body.data.count).toBe(1);
    expect(q.body.data.videos[0].status).toBe("QUEUED");

    const d = await env.json("POST", "/api/discover/queue/drain");
    expect(d.body.data.failed).toEqual([]);
    expect(d.body.data.started).toHaveLength(1);
    const row = env.app.store.getDiscovered(a.id)!;
    expect(row.status).toBe("IMPORTED");
    expect(row.jobId).toBe(d.body.data.started[0].jobId);
    await env.app.jobs.whenIdle();
  });

  test("drain records per-candidate failures", async () => {
    const r = await env.json("POST", "/api/discover/search", { query: "x" });
    await env.json("POST", "/api/discover/queue", { ids: [r.body.data.videos[0].id] });
    const env2 = env;
    const origCreate = env2.app.jobs.createAndStartJob.bind(env2.app.jobs);
    env2.app.jobs.createAndStartJob = () => { throw new Error("queue full"); };
    const d = await env.json("POST", "/api/discover/queue/drain");
    expect(d.body.data.failed[0].error).toBe("queue full");
    env2.app.jobs.createAndStartJob = origCreate;
  });
});

describe("source channels (channel_crawler.py)", () => {
  const seed = (...ids: string[]) => () => ({
    count: ids.length,
    channels: [...ids.map((id) => ({ youtubeChannelId: id, channelName: `name ${id}`, channelUrl: `https://yt/${id}` })),
      { youtubeChannelId: "  ", channelName: "no id" }],
  });
  const profiles: Record<string, Record<string, unknown>> = {
    "https://yt/UC1": { channelName: "Podcast One", avgDurationSec: 3600, medianViewCount: 50000.7, uploadsPerWeek: 2.5,
      subscriberCount: 0, isLikelyClipperChannel: 0, primaryCategory: "PODCAST" },
    "https://yt/UC2": { channelName: "", avgDurationSec: 240, isLikelyClipperChannel: 0, primaryCategory: "" },
    "https://yt/UC3": { avgDurationSec: 0, isLikelyClipperChannel: 1 },
  };
  const profile = (args: string[]) => {
    const p = profiles[args[args.indexOf("--channel-url") + 1] as string];
    if (!p) throw new Error("channel gone");
    return p;
  };
  const crawler = (args: string[]) => (args.includes("category_seed") ? seed("UC1", "UC2", "UC3")() : profile(args));

  test("reseed stores new channels and profiles them in the background", async () => {
    env.scripts["channel_crawler.py"] = crawler;
    const r = await env.json("POST", "/api/discover/channels/reseed");
    expect(r.body.data).toEqual({ upserted: 3, alreadyKnown: 0, queued: 3 });
    await env.app.channels.whenIdle();

    const active = (await env.json("GET", "/api/discover/channels")).body.data;
    expect(active.count).toBe(1);
    expect(active.channels[0]).toMatchObject({
      youtubeChannelId: "UC1", channelName: "Podcast One", channelUrl: "https://yt/UC1", primaryCategory: "PODCAST",
      avgDurationSec: 3600, medianViewCount: 50000, uploadsPerWeek: 2.5, isLikelyClipperChannel: false,
      trustScore: 0.5, trustSamples: 0, pollCadenceHours: 24, status: "ACTIVE", lastCrawledAt: null,
    });
    expect(active.channels[0].lastProfileRefreshAt).toBeString();
    const rejected = (await env.json("GET", "/api/discover/channels?status=rejected")).body.data.channels;
    expect(rejected.map((c: { youtubeChannelId: string }) => c.youtubeChannelId).sort()).toEqual(["UC2", "UC3"]);
    const short = rejected.find((c: { youtubeChannelId: string }) => c.youtubeChannelId === "UC2");
    expect(short).toMatchObject({ channelName: "name UC2", primaryCategory: "MIXED", isLikelyClipperChannel: false });

    const again = await env.json("POST", "/api/discover/channels/reseed");
    expect(again.body.data).toEqual({ upserted: 0, alreadyKnown: 3, queued: 0 });
  });

  test("a failed profile is retried on the next reseed, never twice at once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let profileCalls = 0;
    env.scripts["channel_crawler.py"] = async (args) => {
      if (args.includes("category_seed")) return seed("UC9")();
      profileCalls++;
      await gate;
      throw new Error("yt-dlp 429");
    };
    await env.json("POST", "/api/discover/channels/reseed");
    const second = await env.json("POST", "/api/discover/channels/reseed");   // still profiling UC9
    expect(second.body.data).toEqual({ upserted: 0, alreadyKnown: 1, queued: 1 });
    release();
    await env.app.channels.whenIdle();
    expect(profileCalls).toBe(1);
    const ch = (await env.json("GET", "/api/discover/channels")).body.data.channels[0];
    expect(ch).toMatchObject({ status: "ACTIVE", lastProfileRefreshAt: null });

    await env.json("POST", "/api/discover/channels/reseed");
    await env.app.channels.whenIdle();
    expect(profileCalls).toBe(2);
  });

  test("refresh profiles one channel now; status can be changed by hand", async () => {
    env.scripts["channel_crawler.py"] = (args) => (args.includes("category_seed") ? seed("UC3")() : { avgDurationSec: 3600 });
    await env.json("POST", "/api/discover/channels/reseed");
    await env.app.channels.whenIdle();
    const id = (await env.json("GET", "/api/discover/channels")).body.data.channels[0].id;

    env.scripts["channel_crawler.py"] = crawler;
    const r = await env.json("POST", `/api/discover/channels/${id}/refresh`);
    expect(r.body.data).toMatchObject({ rejected: true, channel: { status: "REJECTED", isLikelyClipperChannel: true } });
    expect((await env.json("POST", "/api/discover/channels/nope/refresh")).status).toBe(404);

    expect((await env.json("POST", `/api/discover/channels/${id}/status`, {})).status).toBe(400);
    expect((await env.json("POST", `/api/discover/channels/${id}/status`, { status: "gone" })).body.error)
      .toBe("status must be one of ACTIVE, PAUSED, REJECTED");
    expect((await env.json("POST", "/api/discover/channels/nope/status", { status: "ACTIVE" })).status).toBe(404);
    const paused = await env.json("POST", `/api/discover/channels/${id}/status`, { status: "paused" });
    expect(paused.body.data.status).toBe("PAUSED");
    expect((await env.json("GET", "/api/discover/channels?status=PAUSED")).body.data.count).toBe(1);
  });

  test("seed failure → 500; a seed without channels stores nothing", async () => {
    env.scripts["channel_crawler.py"] = () => { throw new Error("yt-dlp missing"); };
    expect((await env.json("POST", "/api/discover/channels/reseed")).status).toBe(500);
    env.scripts["channel_crawler.py"] = () => ({ count: 0 });
    expect((await env.json("POST", "/api/discover/channels/reseed")).body.data).toEqual({ upserted: 0, alreadyKnown: 0, queued: 0 });
  });
});

describe("http plumbing", () => {
  test("unknown route → 404 envelope; wrong method → 405", async () => {
    expect((await env.json("GET", "/api/nope")).status).toBe(404);
    const r = await env.json("PUT", "/api/health");
    expect(r.status).toBe(405);
    expect(r.body.status).toBe("error");
  });

  test("malformed JSON → 400", async () => {
    expect((await env.json("POST", "/api/process", "{nope")).body.error).toBe("Invalid JSON body");
    expect((await env.json("POST", "/api/process", "[1]")).body.error).toBe("JSON body must be an object");
  });

  test("unexpected handler error → 500 envelope", async () => {
    env.app.store.listVideos = () => { throw new Error("disk on fire"); };
    const r = await env.json("GET", "/api/videos");
    expect(r).toEqual({ status: 500, body: { status: "error", error: "disk on fire" } });
  });

  test("CORS: allowed origins only; preflight", async () => {
    const pre = await env.req("OPTIONS", "/api/import", undefined, {
      origin: "http://localhost:3000", "access-control-request-headers": "content-type",
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(pre.headers.get("access-control-allow-headers")).toBe("content-type");
    const ok = await env.req("GET", "/api/health", undefined, { origin: "http://127.0.0.1:3000" });
    expect(ok.headers.get("access-control-allow-credentials")).toBe("true");
    const evil = await env.req("GET", "/api/health", undefined, { origin: "http://evil.test" });
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("non-API path without static dir → 404", async () => {
    expect((await env.req("GET", "/")).status).toBe(404);
  });
});

describe("static frontend", () => {
  let s: TestEnv;
  beforeEach(() => {
    const root = join(env.dir, "out");
    mkdirSync(join(root, "_next/static/chunks"), { recursive: true });
    mkdirSync(join(root, "about"), { recursive: true });
    writeFileSync(join(root, "index.html"), "<html>home</html>");
    writeFileSync(join(root, "docs.html"), "docs");
    writeFileSync(join(root, "about/index.html"), "about");
    writeFileSync(join(root, "_next/static/chunks/app.js"), "js");
    s = makeEnv({ staticDir: root });
  });
  afterEach(() => s.cleanup());

  test("serves index, .html and dir index; SPA fallback; caching", async () => {
    expect(await (await s.req("GET", "/")).text()).toBe("<html>home</html>");
    expect(await (await s.req("GET", "/docs")).text()).toBe("docs");
    expect(await (await s.req("GET", "/about")).text()).toBe("about");
    expect(await (await s.req("GET", "/some/client/route")).text()).toBe("<html>home</html>");
    const js = await s.req("GET", "/_next/static/chunks/app.js");
    expect(js.headers.get("cache-control")).toContain("immutable");
    expect((await s.req("GET", "/missing.png")).status).toBe(404);
    expect((await s.req("POST", "/")).status).toBe(404);
  });

  test("rejects traversal and bad encodings", async () => {
    writeFileSync(join(env.dir, "secret.txt"), "secret");
    const r = await s.req("GET", "/..%5Csecret.txt");
    expect(r.status).toBe(404);
    expect(await r.text()).not.toContain("secret\"");
    // URL parsing collapses %2e%2e; the result stays inside root (SPA shell)
    expect(await (await s.req("GET", "/%2e%2e/%2e%2e/etc/passwd")).text()).toBe("<html>home</html>");
    expect((await s.req("GET", "/%E0%A4%A")).status).toBe(404);
  });

  test("missing static dir → 404", async () => {
    const m = makeEnv({ staticDir: join(env.dir, "nothing") });
    expect((await m.req("GET", "/")).status).toBe(404);
    m.cleanup();
  });
});
