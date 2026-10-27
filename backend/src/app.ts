import type { Database } from "bun:sqlite";
import type { AppConfig } from "./config";
import { CHANNEL_STATUSES, ChannelCrawler, channelToMap } from "./channels";
import { openDatabase } from "./db";
import { Llm } from "./llm";
import { YouTube } from "./youtube";
import { DiscoveryService } from "./discovery";
import { DiscoveryAgent } from "./discoveryAgent";
import { WebSearch } from "./webSearch";
import { FeedbackService, ValidationError } from "./feedback";
import { corsHeaders, fail, ok, Router, serveFile, serveStatic, withHeaders, type Body } from "./http";
import { ClipEditor } from "./editor";
import { ConflictError, JobService } from "./jobs";
import { CAPTION_STYLES, parseOptions, parseTimestamp, REFRAME_MODES } from "./options";
import { PipelineOrchestrator } from "./orchestrator";
import { createPythonRunner, spawnCapture, type ExecFn, type ScriptRunner } from "./runner";
import { ClipService, VideoService } from "./services";
import { Store } from "./store";

export interface AppDeps {
  db?: Database;
  exec?: ExecFn;
  runScript?: ScriptRunner;
  /** fetch for the LLM and web search (tests inject a fake). */
  fetch?: typeof fetch;
}

const strArg = (body: Body, key: string): string => {
  const v = body[key];
  return typeof v === "string" ? v : "";
};

const intArg = (body: Body, key: string, fallback: number): number => {
  const v = body[key];
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return Number.parseInt(v, 10);
  return fallback;
};

export function createApp(config: AppConfig, deps: AppDeps = {}) {
  const db = deps.db ?? openDatabase(config.dbPath);
  const store = new Store(db);
  const exec = deps.exec ?? spawnCapture;
  const runScript = deps.runScript ?? createPythonRunner(config, exec);

  const httpFetch = deps.fetch ?? globalThis.fetch;
  const llm = new Llm(config, httpFetch);
  const youtube = new YouTube(exec, config.ytdlpPath);
  const orchestrator = new PipelineOrchestrator(config, store, runScript, exec, llm, youtube);
  const jobs = new JobService(config, store, orchestrator);
  const videos = new VideoService(config, store);
  const clips = new ClipService(config, store);
  const discovery = new DiscoveryService(store, youtube, `${config.dataDir}/corpus`);
  const channels = new ChannelCrawler(store, youtube);
  const agent = new DiscoveryAgent(store, discovery, youtube, llm, new WebSearch(config.webSearch, httpFetch));
  const feedback = new FeedbackService(config, store);
  const editor = new ClipEditor(config, store, runScript, orchestrator);

  const router = new Router();

  router.on("GET", "/api/health", () => ok({ healthy: true }));

  // ---- videos ----
  router.on("POST", "/api/import", async (c) => {
    const b = await c.body();
    // Optional range: only this part of the source is downloaded/processed.
    const start = parseTimestamp(b.startTime, "startTime");
    const end = parseTimestamp(b.endTime, "endTime");
    if ((start === null) !== (end === null)) return fail(400, "Give both startTime and endTime, or neither");
    if (start !== null && end !== null && end - start < 10) return fail(400, "The range must be at least 10 s long");
    const section = start !== null && end !== null ? { start, end } : null;
    const v = videos.importVideo(strArg(b, "url") || null, strArg(b, "localPath") || null, section);
    return ok({ videoId: v.id, sourceType: v.sourceType, sectionStart: v.sectionStart, sectionEnd: v.sectionEnd });
  });
  router.on("GET", "/api/videos", () => ok({ videos: videos.listVideos() }));
  router.on("GET", "/api/videos/:id", (c) => {
    const v = videos.getVideo(c.params.id as string);
    return v ? ok(v) : fail(404, "Video not found");
  });
  router.on("DELETE", "/api/videos/:id", (c) => {
    const id = c.params.id as string;
    videos.deleteVideo(id);
    return ok({ deleted: true, videoId: id });
  });

  // ---- jobs ----
  router.on("POST", "/api/process", async (c) => {
    const b = await c.body();
    const videoId = strArg(b, "videoId");
    if (!videoId.trim()) return fail(400, "videoId required");
    const options = parseOptions(b.options);
    try {
      const job = jobs.createAndStartJob(videoId, options);
      return ok({ jobId: job.id, status: job.status, currentStage: job.currentStage ?? "" });
    } catch (e) {
      if (e instanceof ConflictError) return fail(409, e.message);
      throw e;
    }
  });
  router.on("GET", "/api/jobs", () => ok({ jobs: jobs.listJobs() }));
  router.on("GET", "/api/jobs/:id", (c) => {
    const id = c.params.id as string;
    const job = jobs.getJob(id);
    return job ? ok({ job, stages: jobs.getStageStatuses(id) }) : fail(404, "Job not found");
  });
  for (const action of ["retry", "cancel"] as const) {
    router.on("POST", `/api/jobs/:id/${action}`, (c) => {
      try {
        const id = c.params.id as string;
        const job = action === "retry" ? jobs.retryJob(id) : jobs.cancelJob(id);
        return ok({ jobId: job.id, status: job.status });
      } catch (e) {
        if (e instanceof ConflictError) return fail(400, e.message);
        throw e;
      }
    });
  }

  // ---- clips ----
  router.on("GET", "/api/videos/:id/clips", (c) => ok({ clips: clips.listClips(c.params.id as string) }));
  // ---- clip editor ----
  router.on("GET", "/api/clips/:id/captions", async (c) => ok(await editor.captions(c.params.id as string)));
  router.on("POST", "/api/clips/:id/rerender", async (c) =>
    ok({ clip: await editor.rerender(c.params.id as string, await c.body()) }));
  router.on("GET", "/api/music", () => ok({ tracks: editor.listMusic() }));
  router.on("GET", "/api/options", () => ok({
    styles: CAPTION_STYLES, reframeModes: REFRAME_MODES,
    defaults: {
      style: config.subtitleStyle, reframe: config.reframeMode, silenceTrim: config.silenceTrim,
      silenceGapSec: config.silenceGapSec, hookFirst: config.hookFirst, youtubeCaptions: config.youtubeCaptions,
      allowAutoCaptions: config.allowAutoCaptions, bgm: config.bgmFile, bgmVolume: config.bgmVolume,
    },
  }));

  router.on("GET", "/api/clips/:id", (c) => {
    const id = c.params.id as string;
    const clip = clips.getClip(id);
    if (!clip) return fail(404, "Clip not found");
    const score = clips.getClipScore(id);
    return ok(score ? { clip, scoreBreakdown: score } : { clip });
  });
  router.on("POST", "/api/clips/export", async (c) => {
    const ids = (await c.body()).clipIds;
    if (!Array.isArray(ids) || ids.length === 0) return fail(400, "clipIds required");
    try {
      return ok({ exported: clips.exportClips(ids.map(String)) });
    } catch (e) {
      return fail(500, (e as Error).message);
    }
  });
  router.on("GET", "/api/clips/:id/preview", (c) => {
    const clip = clips.getClip(c.params.id as string);
    if (!clip) return fail(404, "Clip not found");
    const path = clip.exportPath ?? clip.renderPath;
    if (!path) return fail(404, "No rendered file available");
    return serveFile(c.req, path, { contentType: "video/mp4" });
  });
  router.on("GET", "/api/clips/:id/export", (c) => {
    const clip = clips.getClip(c.params.id as string);
    if (!clip) return fail(404, "Clip not found");
    if (!clip.exportPath) return fail(404, "No exported file available");
    return serveFile(c.req, clip.exportPath, { contentType: "application/octet-stream", attachment: true });
  });

  // ---- feedback ----
  router.on("POST", "/api/clips/:id/feedback", async (c) => {
    const b = await c.body();
    const postedAt = b.postedAt;
    if (postedAt == null || String(postedAt).trim() === "") {
      return fail(400, "postedAt is required (ISO-8601 time the clip was posted)");
    }
    const n = (k: string) => Math.max(intArg(b, k, 0), 0);
    try {
      const fb = await feedback.submitPostMetrics(c.params.id as string, {
        views: n("views"), likes: n("likes"), comments: n("comments"), shares: n("shares"), saves: n("saves"),
      }, String(postedAt));
      return ok({
        clipId: fb.clipId, viralScore: fb.actualViralScore, views: fb.postViews,
        likes: fb.postLikes, postedAt: fb.postedAt,
      });
    } catch (e) {
      if (e instanceof ValidationError) return fail(400, e.message);
      throw e;
    }
  });
  router.on("POST", "/api/feedback/train", async () => ok(await feedback.triggerTraining()));
  router.on("GET", "/api/feedback/weights", async () => ok(await feedback.getWeightsStatus()));

  // ---- discovery ----
  router.on("POST", "/api/discover/search", async (c) => {
    const b = await c.body();
    const query = strArg(b, "query");
    if (!query.trim()) return fail(400, "query is required");
    return ok(await discovery.search(query, intArg(b, "maxResults", 20), intArg(b, "minDuration", 0), intArg(b, "maxDuration", 0)));
  });
  router.on("POST", "/api/discover/trending", async (c) => {
    const b = await c.body();
    return ok(await discovery.trending(intArg(b, "maxResults", 20), strArg(b, "region") || "ID"));
  });
  router.on("POST", "/api/discover/channel", async (c) => {
    const b = await c.body();
    const url = strArg(b, "channelUrl");
    if (!url.trim()) return fail(400, "channelUrl is required");
    return ok(await discovery.channel(url, intArg(b, "maxResults", 20), intArg(b, "minDuration", 0), intArg(b, "maxDuration", 0)));
  });
  /** Auto-discover: LLM agent (web + YouTube tools), or the algorithm without an LLM. Runs in the background. */
  router.on("POST", "/api/discover/auto", async (c) => {
    const b = await c.body();
    try {
      return ok(agent.start(strArg(b, "goal"), intArg(b, "maxResults", 10)));
    } catch (e) {
      if (e instanceof ConflictError) return fail(409, e.message);
      throw e;
    }
  });
  router.on("GET", "/api/discover/auto", () => {
    const run = agent.latest();
    return run ? ok(run) : fail(404, "No auto-discover run yet");
  });
  router.on("GET", "/api/discover/auto/:id", (c) => {
    const run = agent.get(c.params.id as string);
    return run ? ok(run) : fail(404, "Run not found");
  });
  router.on("GET", "/api/discover/candidates", (c) => {
    const rows = discovery.listCandidates(c.url.searchParams.get("status"));
    return ok({ count: rows.length, videos: rows });
  });
  router.on("POST", "/api/discover/candidates/:id/status", async (c) => {
    const status = strArg(await c.body(), "status");
    if (!status.trim()) return fail(400, "status is required");
    const d = discovery.updateStatus(c.params.id as string, status);
    return d ? ok(discovery.withContext([d])[0]) : fail(404, "not found");
  });
  router.on("POST", "/api/discover/queue", async (c) => {
    const ids = (await c.body()).ids;
    if (!Array.isArray(ids)) return fail(400, "ids[] is required");
    const clean = ids.filter((x) => x != null).map(String);
    if (clean.length === 0) return fail(400, "ids[] is empty");
    const rows = discovery.withContext(discovery.queueByIds(clean));
    return ok({ count: rows.length, videos: rows });
  });
  /** Drain: import + start a job for every QUEUED candidate. */
  router.on("POST", "/api/discover/queue/drain", () => {
    const started: Body[] = [];
    const failed: Body[] = [];
    for (const d of discovery.listCandidates("QUEUED")) {
      try {
        const video = videos.importVideo(d.url, null);
        const job = jobs.createAndStartJob(video.id);
        discovery.markImported(d.id, job.id, video.id);
        started.push({ discoveredId: d.id, jobId: job.id, videoId: video.id });
      } catch (e) {
        failed.push({ discoveredId: d.id, error: (e as Error).message });
      }
    }
    return ok({ started, failed });
  });

  // ---- source channels ----
  router.on("GET", "/api/discover/channels", (c) => {
    const rows = channels.list(c.url.searchParams.get("status")).map(channelToMap);
    return ok({ count: rows.length, channels: rows });
  });
  router.on("POST", "/api/discover/channels/reseed", async () => ok(await channels.reseed()));
  router.on("POST", "/api/discover/channels/:id/refresh", async (c) => {
    const r = await channels.refresh(c.params.id as string);
    return r ? ok(r) : fail(404, "not found");
  });
  router.on("POST", "/api/discover/channels/:id/status", async (c) => {
    const status = strArg(await c.body(), "status").trim().toUpperCase();
    if (!CHANNEL_STATUSES.includes(status)) return fail(400, `status must be one of ${CHANNEL_STATUSES.join(", ")}`);
    const ch = channels.setStatus(c.params.id as string, status);
    return ch ? ok(channelToMap(ch)) : fail(404, "not found");
  });

  const allowedOrigins = new Set(["http://localhost:3000", "http://127.0.0.1:3000", config.frontendUrl]);

  async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const cors = corsHeaders(req, allowedOrigins);
    if (url.pathname.startsWith("/api/")) {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      const res = (await router.handle(req, url)) ?? fail(404, `No route for ${req.method} ${url.pathname}`);
      return withHeaders(res, cors);
    }
    if ((req.method === "GET" || req.method === "HEAD") && config.staticDir) {
      const res = serveStatic(config.staticDir, url.pathname);
      if (res) return res;
    }
    return fail(404, "Not found");
  }

  return {
    fetch,
    store, jobs, discovery, channels, orchestrator, llm, youtube, agent,
    start() { jobs.startMaintenance(); },
    close() {
      jobs.shutdown();
      db.close();
    },
  };
}

export type App = ReturnType<typeof createApp>;
