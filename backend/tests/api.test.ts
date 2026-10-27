// HTTP contract tests. The first blocks port the Java *IT suites 1:1
// (controller/VideoControllerIT, JobControllerIT, ClipControllerIT,
// DiscoveryControllerIT, HealthControllerIT); the rest cover the endpoints
// those suites never reached.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeCaptions, parseVttLines, predictScore } from "../src/captionAnalysis";
import { CATEGORY_SEED_QUERIES } from "../src/channels";
import { viralScore } from "../src/learning";
import { DEFAULT_WEIGHTS } from "../src/ruleConstants";
import { FEATURE_ORDER } from "../src/scoring";
import { TRENDING_HASHTAGS, TRENDING_NICHE_QUERIES } from "../src/youtube";
import { argAfter, defaultExec, FAKE_VTT, makeEnv, procOk, ytLines, type TestEnv } from "./helpers";

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
    const hours = (Date.now() - Date.parse("2026-01-01T00:00:00+07:00")) / 3_600_000;
    expect(r.body.data).toEqual({ clipId: "c1", viralScore: viralScore(1000, 50, 3, 2, 1, hours), views: 1000, likes: 50,
      postedAt: "2026-01-01T00:00:00+07:00" });

    await env.json("POST", "/api/clips/c1/feedback", { postedAt: "2026-01-01T00:00:00Z", views: 2000 });
    expect(env.app.store.countFeedback()).toEqual({ total: 1, withScores: 1 });
    const fb = env.app.store.feedbackForClip("c1")!;
    expect(fb.tiktokViews).toBe(2000);
    expect(fb.features).toBe("{}"); // no clip_score row existed at first submit
    await env.json("POST", "/api/clips/c1/feedback", { postedAt: "2026-01-01T00:00:00Z", views: 0 });
    expect(env.app.store.feedbackForClip("c1")!.actualViralScore).toBe(0);
  });

  test("all 13 features are snapshotted; training writes learned weights to the data dir", async () => {
    const pipelineDir = join(env.dir, "pipeline");
    mkdirSync(pipelineDir);
    writeFileSync(join(pipelineDir, "weights.json"), JSON.stringify({ version: 3, trained_on: 0, last_updated: "x",
      weights: DEFAULT_WEIGHTS, thresholds: { PRIMARY: 0.8, BACKUP: 0.65 } }));
    env.config.pipelineDir = pipelineDir;
    expect((await env.json("POST", "/api/feedback/train")).body.data).toEqual({ status: "insufficient_data", version: 0, trained_on: 0,
      message: "Need at least 5 records with actual scores, got 0" });

    // six clips: hook strength tracks the real score, everything else is flat
    for (let i = 0; i < 6; i++) {
      seedClip(`c${i}`);
      env.app.store.saveClipScore({ id: `s${i}`, clipId: `c${i}`, hookStrength: i / 5, keywordTrigger: 0.5, novelty: 0.5,
        clarity: 0.5, emotionalEnergy: 0.5, textSentiment: 0.5, pauseStructure: 0.5, facePresence: 0.5, sceneChange: 0.5,
        topicFit: 0.5, historyScore: 0.5, motion: 0.5, onsetDensity: 0.5, boostTotal: 0, penaltyTotal: 0 });
      await env.json("POST", `/api/clips/c${i}/feedback`, { postedAt: "2026-01-01T00:00:00Z", views: 1000 * (i + 1), likes: 100 * i, saves: 10 * i });
    }
    expect(Object.keys(JSON.parse(env.app.store.feedbackForClip("c0")!.features))).toEqual([...FEATURE_ORDER]);
    // a corrupt features column must not break training
    env.app.store.saveFeedback({ ...env.app.store.feedbackForClip("c0")!, id: "f-bad", clipId: "c-bad", features: "not json" });

    const r = (await env.json("POST", "/api/feedback/train")).body.data;
    expect(r).toMatchObject({ status: "trained", version: 4, trained_on: 7 });
    expect(Object.keys(r.new_weights)).toEqual([...FEATURE_ORDER]);
    expect(r.new_weights.hookStrength).toBeGreaterThan(DEFAULT_WEIGHTS.hookStrength);
    expect(r.weight_changes.hookStrength.from).toBe(DEFAULT_WEIGHTS.hookStrength);
    const learned = JSON.parse(readFileSync(join(env.config.dataDir, "weights.json"), "utf8"));
    expect(learned).toMatchObject({ version: 4, trained_on: 7, thresholds: { PRIMARY: 0.8, BACKUP: 0.65 } });
    expect(learned.last_updated).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(JSON.parse(readFileSync(join(pipelineDir, "weights.json"), "utf8")).version).toBe(3);   // shipped defaults untouched

    const w = (await env.json("GET", "/api/feedback/weights")).body.data;
    expect(w).toMatchObject({ version: 4, trained_on: 7, total_feedback: 7, with_actual_scores: 7, weights: r.new_weights });
  });

  test("weights status falls back to the shipped file, then to defaults", async () => {
    env.config.pipelineDir = join(env.dir, "nowhere");
    expect((await env.json("GET", "/api/feedback/weights")).body.data).toEqual({ version: 0, trained_on: 0, last_updated: "",
      total_feedback: 0, with_actual_scores: 0, weights: DEFAULT_WEIGHTS });
    mkdirSync(env.config.dataDir, { recursive: true });
    writeFileSync(join(env.config.dataDir, "weights.json"), "{broken");
    expect((await env.json("GET", "/api/feedback/weights")).body.data.version).toBe(0);
    writeFileSync(join(env.config.dataDir, "weights.json"), JSON.stringify({ version: "x", weights: { hookStrength: 1 } }));
    expect((await env.json("GET", "/api/feedback/weights")).body.data).toMatchObject({ version: 0, last_updated: "", weights: { hookStrength: 1 } });
  });
});

describe("discovery (DiscoveryControllerIT / DiscoveryServiceTest)", () => {
  const ytCalls = () => env.execCalls.filter((c) => c.cmd === "yt-dlp").map((c) => c.args);
  const failYtDlp = () => { env.execHandler.fn = (cmd, args) => (cmd === "yt-dlp" ? { ...procOk("", "HTTP 429"), exitCode: 1 } : defaultExec(cmd, args)); };

  test("search/channel validation → 400", async () => {
    expect((await env.json("POST", "/api/discover/search", {})).body).toEqual({ status: "error", error: "query is required" });
    expect((await env.json("POST", "/api/discover/search", { query: "   " })).status).toBe(400);
    expect((await env.json("POST", "/api/discover/channel", {})).body.error).toBe("channelUrl is required");
    expect((await env.json("POST", "/api/discover/channel", { channelUrl: "  " })).status).toBe(400);
  });

  test("yt-dlp failure → 500 for search and channel; trending degrades to empty", async () => {
    failYtDlp();
    const r = await env.json("POST", "/api/discover/search", { query: "x" });
    expect(r.status).toBe(500);
    expect(r.body.error).toContain("HTTP 429");
    expect((await env.json("POST", "/api/discover/channel", { channelUrl: "https://youtube.com/@t" })).status).toBe(500);
    expect((await env.req("POST", "/api/discover/trending")).status).toBe(200);
    // a missing yt-dlp binary reads as a failed run, not a crash
    env.execHandler.fn = () => { throw new Error("ENOENT"); };
    expect((await env.json("POST", "/api/discover/search", { query: "x" })).body.error).toContain("yt-dlp not found");
  });

  test("search filters, persists, then scores whole videos from their captions", async () => {
    const r = await env.json("POST", "/api/discover/search", { query: "podcast", maxResults: 10, minDuration: 120, maxDuration: "7200" });
    expect(r.body.data).toMatchObject({ mode: "search", query: "podcast", count: 2 });
    const [v, two] = r.body.data.videos;
    expect(v).toMatchObject({ videoId: "abcdefghijk", youtubeId: "abcdefghijk", title: "Podcast rahasia sukses", duration: 3600,
      viewCount: 1000, status: "NEW", sourceMode: "search", sourceQuery: "podcast", channelId: "UCch", contentType: "PODCAST",
      isLikelyClipped: false, speechDensityWpm: null, strongMoments: null, topMoments: [], reason: null });
    expect(v.relevanceScore).toBeGreaterThan(two.relevanceScore);
    expect(v.why).toEqual(["Long-form (60 min)"]);
    expect(two).toMatchObject({ videoId: "zyxwvutsrqp", viewCount: null, channelId: null, contentType: "OTHER" });
    expect(ytCalls()[0]).toEqual(["ytsearch10:podcast", "--dump-json", "--skip-download",
      "--match-filters", "upload_date >=(today-90days)", "--no-warnings", "--no-check-certificates"]);

    await env.app.discovery.whenIdle();
    const subs = ytCalls().filter((a) => a.includes("--sub-format"));
    expect(subs).toHaveLength(2);
    expect(subs[0]).toContain("--write-auto-subs");
    const row = env.app.store.discoveredByYoutubeId("abcdefghijk")!;
    const analysis = analyzeCaptions(parseVttLines(FAKE_VTT))!;
    expect(row).toMatchObject({ transcriptScore: analysis.transcriptScore, strongMoments: analysis.strongMoments,
      speechDensityWpm: analysis.speechWpm, transcriptSample: analysis.topMoments[0]!.text });
    expect(row.predictedScore).toBe(predictScore(analysis, 3600, 1000, row.ageHours!));
    expect(row.enrichedAt).toBeString();

    const c = (await env.json("GET", "/api/discover/candidates")).body.data;
    expect(c.count).toBe(2);
    const best = c.videos.find((x: { videoId: string }) => x.videoId === "abcdefghijk");
    expect(best.topMoments).toHaveLength(analysis.topMoments.length);
    expect(best.rankScore).toBe(row.predictedScore);
    expect(best.why[0]).toMatch(/^(No standout moments|\d+ strong moments?, best at \d+:\d\d)/);
    expect(best.why.some((w: string) => w.includes(`(${analysis.speechWpm} wpm)`))).toBeTrue();
    env.app.store.updateDiscovered(best.id, { ageHours: 91 * 24 });
    expect((await env.json("GET", "/api/discover/candidates")).body.data.count).toBe(1);
    expect((await env.json("GET", "/api/discover/candidates?status=new")).body.data.count).toBe(2);
  });

  test("trending merges hashtag feeds and niche searches; channel reads the uploads tab", async () => {
    const t = await env.json("POST", "/api/discover/trending", { maxResults: 15, region: "US" });
    expect(t.body.data).toMatchObject({ mode: "trending", query: "US", count: 2 });
    expect(t.body.data.videos[0].sourceMode).toBe("trending");
    const feeds = ytCalls().filter((a) => a[0]!.startsWith("https://www.youtube.com/hashtag/")).map((a) => a[0]);
    expect(feeds.sort()).toEqual(TRENDING_HASHTAGS.map((h) => `https://www.youtube.com/hashtag/${h}`).sort());
    expect(ytCalls().filter((a) => a[0]!.startsWith("ytsearch3:"))).toHaveLength(TRENDING_NICHE_QUERIES.length);
    await env.req("POST", "/api/discover/trending");   // defaults

    env.execCalls.length = 0;
    const r = await env.json("POST", "/api/discover/channel", { channelUrl: "https://youtube.com/@test/", maxResults: 1, minDuration: 60, maxDuration: 6000 });
    expect(r.body.data).toMatchObject({ mode: "channel", count: 1 });
    expect(r.body.data.videos[0].videoId).toBe("abcdefghijk");
    expect(ytCalls()[0]!.slice(0, 2)).toEqual(["https://youtube.com/@test/videos", "--flat-playlist"]);
    expect(argAfter(ytCalls()[0]!, "--playlist-end")).toBe("3");
  });

  test("channel falls back to the bare URL when the uploads tab fails", async () => {
    env.execHandler.fn = (cmd, args) => (cmd === "yt-dlp" && args[0]!.endsWith("/videos") ? { ...procOk(), exitCode: 1 } : defaultExec(cmd, args));
    const r = await env.json("POST", "/api/discover/channel", { channelUrl: "https://youtube.com/@test" });
    expect(r.body.data.count).toBe(2);
    expect(ytCalls()[1]![0]).toBe("https://youtube.com/@test");
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

  test("no captions → ranked on views and length alone; enrichment errors are swallowed", async () => {
    env.execHandler.fn = (cmd, args) => (args.includes("--sub-format") ? procOk() : defaultExec(cmd, args));
    await env.json("POST", "/api/discover/search", { query: "x" });
    await env.app.discovery.whenIdle();
    const row = env.app.store.discoveredByYoutubeId("abcdefghijk")!;
    expect(row).toMatchObject({ transcriptScore: 0, strongMoments: null, topMoments: null, transcriptSample: null });
    expect(row.predictedScore).toBe(predictScore(null, 3600, 1000, row.ageHours!));
    expect(ytCalls().filter((a) => a.includes("--sub-format") && a[0]!.includes("abcdefghijk")).map((a) => argAfter(a, "--sub-lang"))).toEqual(["id", "en", "*"]);
    const map = (await env.json("GET", "/api/discover/candidates")).body.data.videos[0];
    expect(map.why).toContain("No captions to analyze");

    const fresh = makeEnv();
    try {
      fresh.app.discovery.analyze = () => { throw new Error("boom"); };
      await fresh.json("POST", "/api/discover/search", { query: "x" });
      await fresh.app.discovery.whenIdle();
      expect(fresh.app.store.discoveredByYoutubeId("abcdefghijk")!.enrichedAt).toBeNull();
    } finally {
      fresh.cleanup();
    }
  });

  test("ranking: rejected channels hidden, known and clipped channels lifted", async () => {
    await env.json("POST", "/api/discover/search", { query: "x" });
    await env.app.discovery.whenIdle();
    const base = (await env.json("GET", "/api/discover/candidates")).body.data.videos;
    const score = (vs: Array<{ videoId: string; rankScore: number }>, id: string) => vs.find((v) => v.videoId === id)?.rankScore;
    const before = score(base, "abcdefghijk")!;

    const ch = env.app.store.saveChannel({
      id: "c1", youtubeChannelId: "UCch", channelName: "Ch", channelUrl: "https://yt/UCch", primaryCategory: "PODCAST",
      avgDurationSec: 3600, medianViewCount: 1, uploadsPerWeek: 1, subscriberCount: 0, isLikelyClipperChannel: 0,
      trustScore: 0.5, trustSamples: 0, pollCadenceHours: 24, status: "ACTIVE", firstSeenAt: "t", lastCrawledAt: null,
      lastProfileRefreshAt: "t",
    });
    let vs = (await env.json("GET", "/api/discover/candidates")).body.data.videos;
    expect(score(vs, "abcdefghijk")).toBeCloseTo(before + 0.05, 4);
    expect(vs.find((v: { videoId: string }) => v.videoId === "abcdefghijk").why).toContain("Known source channel (PODCAST)");

    // a clipped video from the same channel → second lift
    const other = env.app.store.discoveredByYoutubeId("zyxwvutsrqp")!;
    env.app.store.updateDiscovered(other.id, { channelId: "UCch", status: "IMPORTED" });
    vs = (await env.json("GET", "/api/discover/candidates")).body.data.videos;
    expect(score(vs, "abcdefghijk")).toBeCloseTo(before + 0.1, 4);
    expect(vs[0].why).toContain("You've clipped this channel before");

    env.app.store.updateChannel(ch.id, { status: "REJECTED" });
    expect((await env.json("GET", "/api/discover/candidates")).body.data.count).toBe(0);
  });

  test("status update, queue and drain", async () => {
    const r = await env.json("POST", "/api/discover/search", { query: "x" });
    const [a, b] = r.body.data.videos;
    expect((await env.json("POST", `/api/discover/candidates/${a.id}/status`, {})).status).toBe(400);
    expect((await env.json("POST", "/api/discover/candidates/nope/status", { status: "NEW" })).status).toBe(404);
    const s = await env.json("POST", `/api/discover/candidates/${b.id}/status`, { status: "new" });
    expect(s.body.data).toMatchObject({ id: b.id, status: "NEW" });
    expect(s.body.data.why).toBeArray();

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
    const origCreate = env.app.jobs.createAndStartJob.bind(env.app.jobs);
    env.app.jobs.createAndStartJob = () => { throw new Error("queue full"); };
    const d = await env.json("POST", "/api/discover/queue/drain");
    expect(d.body.data.failed[0].error).toBe("queue full");
    env.app.jobs.createAndStartJob = origCreate;
  });
});

describe("source channels (crawler)", () => {
  // Seed searches return these channels (plus a row without a channel id).
  const seedEntries = (...ids: string[]) => [
    ...ids.map((id) => ({ id: `v${id}xxxxxxx`, channel_id: id, channel: `name ${id}`, channel_url: `https://yt/${id}` })),
    { id: "noidxxxxxxx", channel: "no id" },
  ];
  // Upload listings per channel: a podcast, a 10-minute vlog channel, a clip farm.
  const uploads: Record<string, object[]> = {
    "https://yt/UC1/videos": [1, 2, 3].map((i) => ({ id: `p${i}xxxxxxxxx`, title: `Podcast eps ${i}`, duration: 3600,
      view_count: 50000 + i, channel: "Podcast One", channel_id: "UC1" })),
    "https://yt/UC2/videos": [1, 2].map((i) => ({ id: `s${i}xxxxxxxxx`, title: `Vlog harian ${i}`, duration: 600 })),
    "https://yt/UC3/videos": [1, 2].map((i) => ({ id: `c${i}xxxxxxxxx`, title: `Best moments clip ${i}`, duration: 3600 })),
  };
  const crawler = (seed: string[], profiles = uploads) => (cmd: string, args: string[]) => {
    if (cmd !== "yt-dlp") return defaultExec(cmd, args);
    if (args[0]!.startsWith("ytsearch")) return procOk(ytLines(seedEntries(...seed)));
    const rows = profiles[args[0]!];
    return rows ? procOk(ytLines(rows)) : { ...procOk("", "channel gone"), exitCode: 1 };
  };

  test("reseed stores new channels and profiles them in the background", async () => {
    env.execHandler.fn = crawler(["UC1", "UC2", "UC3"]);
    const r = await env.json("POST", "/api/discover/channels/reseed");
    expect(r.body.data).toEqual({ upserted: 3, alreadyKnown: 0, queued: 3 });
    const searches = env.execCalls.filter((c) => c.args[0]!.startsWith("ytsearch15:")).map((c) => c.args[0]!.slice(11));
    expect(searches.sort()).toEqual([...CATEGORY_SEED_QUERIES].sort());
    await env.app.channels.whenIdle();

    const active = (await env.json("GET", "/api/discover/channels")).body.data;
    expect(active.count).toBe(1);
    expect(active.channels[0]).toMatchObject({
      youtubeChannelId: "UC1", channelName: "Podcast One", channelUrl: "https://yt/UC1", primaryCategory: "PODCAST",
      avgDurationSec: 3600, medianViewCount: 50002, uploadsPerWeek: 0, isLikelyClipperChannel: false,
      trustScore: 0.5, trustSamples: 0, pollCadenceHours: 24, status: "ACTIVE", lastCrawledAt: null,
    });
    expect(active.channels[0].lastProfileRefreshAt).toBeString();
    const rejected = (await env.json("GET", "/api/discover/channels?status=rejected")).body.data.channels;
    expect(rejected.map((c: { youtubeChannelId: string }) => c.youtubeChannelId).sort()).toEqual(["UC2", "UC3"]);
    const byId = (id: string) => rejected.find((c: { youtubeChannelId: string }) => c.youtubeChannelId === id);
    expect(byId("UC2")).toMatchObject({ channelName: "name UC2", avgDurationSec: 600, primaryCategory: "MIXED", isLikelyClipperChannel: false });
    expect(byId("UC3")).toMatchObject({ isLikelyClipperChannel: true });

    const again = await env.json("POST", "/api/discover/channels/reseed");
    expect(again.body.data).toEqual({ upserted: 0, alreadyKnown: 3, queued: 0 });
  });

  test("a failed profile is retried on the next reseed, never twice at once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let profileCalls = 0;
    env.execHandler.fn = async (cmd, args) => {
      if (args[0]!.startsWith("ytsearch")) return procOk(ytLines(seedEntries("UC9")));
      if (args[0] === "https://yt/UC9/videos") {
        profileCalls++;
        await gate;
      }
      return { ...procOk("", "HTTP 429"), exitCode: 1 };   // uploads tab and bare URL both fail
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
    env.execHandler.fn = crawler(["UC3"], { "https://yt/UC3/videos": uploads["https://yt/UC1/videos"]! });
    await env.json("POST", "/api/discover/channels/reseed");
    await env.app.channels.whenIdle();
    const id = (await env.json("GET", "/api/discover/channels")).body.data.channels[0].id;

    env.execHandler.fn = crawler(["UC3"]);
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

  test("failed seed searches store nothing", async () => {
    env.execHandler.fn = () => ({ ...procOk("", "HTTP 429"), exitCode: 1 });
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
