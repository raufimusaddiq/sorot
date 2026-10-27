import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import type { AppConfig } from "./config";
import type { ExecFn, ScriptRunner } from "./runner";
import { now, type Store } from "./store";
import type { Clip, ClipScore, Json, Stage, Video } from "./types";

const DATA_SUBDIRS = [
  "input", "raw", "audio", "transcripts", "segments", "clips", "renders",
  "exports", "variations", "analytics", "logs",
];
const RENDER_TIERS = ["PRIMARY", "BACKUP"];
const YTDLP_FORMAT = "bv[vcodec^=avc1][ext=mp4]+ba[ext=m4a]/bv[vcodec^=avc1]+ba/b[ext=mp4]/b";

export class CancelledError extends Error {
  constructor() { super("Job cancelled by user"); }
}

// Jackson-style lenient readers for the Python scripts' JSON.
const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const str = (v: unknown, fallback: string | null = ""): string | null =>
  typeof v === "string" ? v : v === undefined || v === null ? fallback : String(v);
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): Json[] => (Array.isArray(v) ? v.map(obj) : []);

const fileNonEmpty = (p: string) => existsSync(p) && statSync(p).size > 0;

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export class PipelineOrchestrator {
  constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
    private readonly runScript: ScriptRunner,
    private readonly exec: ExecFn,
  ) {}

  private path(sub: string, file: string) {
    return `${this.config.dataDir}/${sub}/${file}`;
  }

  async runPipeline(jobId: string, signal: AbortSignal): Promise<void> {
    const job = this.store.getJob(jobId);
    if (!job || job.status === "CANCELLED") return;
    const video = this.store.getVideo(job.videoId);
    if (!video) {
      this.store.updateJob(jobId, { status: "FAILED", errorMessage: `Video not found: ${job.videoId}` });
      return;
    }

    try {
      this.store.updateJob(jobId, { status: "RUNNING" }, { unlessCancelled: true });
      this.ensureDataDirs();

      const stages: Array<[Stage, () => Promise<string | null>]> = [
        ["IMPORT", () => this.stageImport(video, signal)],
        ["AUDIO_EXTRACT", () => this.stageAudioExtract(video, signal)],
        ["TRANSCRIBE", () => this.stageTranscribe(video, signal)],
        ["SEGMENT", () => this.stageSegment(video, signal)],
        ["SCORE", () => this.stageScore(video, signal)],
        ["RENDER", () => this.stageRender(jobId, video, signal)],
        ["SUBTITLE", () => this.stageSubtitle(jobId, video, signal)],
        ["VARIATION", () => this.stageVariation(video, signal)],
        ["ANALYTICS", () => this.stageAnalytics(video, signal)],
      ];
      for (const [name, fn] of stages) await this.runStage(jobId, name, fn, signal);

      this.store.updateJob(jobId, { status: "COMPLETED" }, { unlessCancelled: true });
      console.info(`Pipeline completed for job ${jobId}`);
    } catch (e) {
      const reason = signal.aborted ? (signal.reason as Error | undefined)?.message : undefined;
      const msg = reason ?? (e as Error).message;
      console.error(`Pipeline failed for job ${jobId}: ${msg}`);
      // A user cancel already set CANCELLED; don't overwrite it with FAILED.
      this.store.updateJob(jobId, { status: "FAILED", errorMessage: msg }, { unlessCancelled: true });
    }
  }

  private checkCancelled(jobId: string, signal: AbortSignal) {
    if (signal.aborted || this.store.getJob(jobId)?.status === "CANCELLED") throw new CancelledError();
  }

  private async runStage(
    jobId: string, stageName: Stage, fn: () => Promise<string | null>, signal: AbortSignal,
  ) {
    this.checkCancelled(jobId, signal);
    let stage = this.store.getStage(jobId, stageName);
    if (!stage) {
      stage = this.store.saveStage({
        id: crypto.randomUUID(), jobId, stage: stageName, status: "PENDING",
        startedAt: null, completedAt: null, errorMessage: null, outputPath: null,
      });
    }
    this.store.updateStage(stage.id, { status: "IN_PROGRESS", startedAt: now() });
    this.store.updateJob(jobId, { currentStage: stageName });

    try {
      const outputPath = await fn();
      this.store.updateStage(stage.id, { status: "COMPLETED", completedAt: now(), outputPath: outputPath ?? undefined });
    } catch (e) {
      const msg = (e as Error).message;
      this.store.updateStage(stage.id, { status: "FAILED", errorMessage: msg });
      if (e instanceof CancelledError || signal.aborted) throw new CancelledError();
      throw new Error(`Stage ${stageName} failed: ${msg}`);
    }
  }

  private async run(cmd: string, args: string[], signal: AbortSignal, what: string) {
    const res = await this.exec(cmd, args, { signal, stdoutTail: 64 * 1024 });
    if (res.aborted) throw new CancelledError();
    if (res.exitCode !== 0) {
      throw new Error(`${what} failed (exit=${res.exitCode}): ${res.stderr.slice(-500)}`);
    }
    return res;
  }

  // ---- stages ----

  private async stageImport(video: Video, signal: AbortSignal): Promise<string> {
    if (video.sourceType !== "YOUTUBE") {
      if (!fileNonEmpty(video.filePath)) throw new Error(`Local file not found: ${video.filePath}`);
      return video.filePath;
    }
    const sourceUrl = video.sourceUrl ?? "";
    const outputPath = this.path("raw", `${video.id}.mp4`);

    const title = await this.exec(
      this.config.ytdlpPath, ["--print", "title", "--no-warnings", sourceUrl], { signal },
    );
    if (title.aborted) throw new CancelledError();
    const t = title.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(" ");
    if (title.exitCode === 0 && t) this.store.updateVideo(video.id, { title: t });

    // A retry after a completed download skips straight to the cached file.
    if (!fileNonEmpty(outputPath)) {
      try {
        await this.run(this.config.ytdlpPath, [
          "-f", YTDLP_FORMAT, "--merge-output-format", "mp4", "--no-warnings",
          "-o", outputPath, sourceUrl,
        ], signal, "yt-dlp download");
      } finally {
        this.cleanupPartials(video.id);
      }
      if (!existsSync(outputPath)) throw new Error(`Downloaded file not found: ${outputPath}`);
    }
    this.store.updateVideo(video.id, { filePath: outputPath });
    video.filePath = outputPath;
    return outputPath;
  }

  /** Only this video's partials — a concurrent pipeline may be mid-download. */
  private cleanupPartials(videoId: string) {
    const rawDir = `${this.config.dataDir}/raw`;
    if (!existsSync(rawDir)) return;
    for (const name of readdirSync(rawDir)) {
      if (name.startsWith(videoId) && name.endsWith(".part")) {
        rmSync(`${rawDir}/${name}`, { force: true });
      }
    }
  }

  private async stageAudioExtract(video: Video, signal: AbortSignal) {
    const audioPath = this.path("audio", `${video.id}.wav`);
    await this.run(this.config.ffmpegPath, [
      "-i", video.filePath, "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", "-y", audioPath,
    ], signal, "ffmpeg audio extraction");
    return audioPath;
  }

  private async stageTranscribe(video: Video, signal: AbortSignal) {
    const outputPath = this.path("transcripts", `${video.id}.json`);
    const result = await this.runScript("transcribe.py", [
      "--audio", this.path("audio", `${video.id}.wav`),
      "--output", outputPath,
      "--language", this.config.whisperLanguage,
      "--model", this.config.whisperModel,
      "--device", this.config.whisperDevice,
    ], { signal });
    await Bun.write(outputPath, JSON.stringify(result));
    return outputPath;
  }

  private async stageSegment(video: Video, signal: AbortSignal) {
    const outputPath = this.path("segments", `${video.id}.json`);
    const result = await this.runScript("segment.py", [
      "--transcript", this.path("transcripts", `${video.id}.json`),
      "--output", outputPath,
    ], { signal });
    await Bun.write(outputPath, JSON.stringify(result));
    return outputPath;
  }

  private async stageScore(video: Video, signal: AbortSignal) {
    const segmentsPath = this.path("segments", `${video.id}.json`);
    const audioPath = this.path("audio", `${video.id}.wav`);
    const transcriptPath = this.path("transcripts", `${video.id}.json`);
    const args = ["--segments", segmentsPath, "--video", video.filePath];
    if (existsSync(audioPath)) args.push("--audio", audioPath);
    if (existsSync(transcriptPath)) args.push("--transcript", transcriptPath);

    const result = await this.runScript("score.py", args, { signal });
    await Bun.write(segmentsPath, JSON.stringify(result));
    this.saveClipsFromScoredSegments(video.id, result);
    return segmentsPath;
  }

  saveClipsFromScoredSegments(videoId: string, scored: Json) {
    this.store.transaction(() => {
      for (const c of this.store.clipsForVideo(videoId)) this.store.deleteClip(c.id);
      // No clip_feedback row is pre-created here: a feedback row exists only
      // once the user submits real TikTok metrics (POST /api/clips/{id}/feedback).
      arr(scored.scoredSegments).forEach((seg, i) => {
        const clip: Clip = {
          id: crypto.randomUUID(),
          videoId,
          rankPos: i + 1,
          score: num(seg.finalScore),
          tier: str(seg.tier) as string,
          title: str(seg.title, null),
          description: str(seg.description, null),
          startTime: num(seg.startTime),
          endTime: num(seg.endTime),
          durationSec: num(seg.duration),
          textContent: str(seg.text),
          renderStatus: "PENDING",
          renderPath: null,
          exportStatus: "PENDING",
          exportPath: null,
          createdAt: now(),
        };
        this.store.saveClip(clip);
        const s = obj(seg.scores);
        const score: ClipScore = {
          id: crypto.randomUUID(),
          clipId: clip.id,
          hookStrength: num(s.hookStrength),
          keywordTrigger: num(s.keywordTrigger),
          novelty: num(s.novelty),
          clarity: num(s.clarity),
          emotionalEnergy: num(s.emotionalEnergy),
          textSentiment: num(s.textSentiment),
          pauseStructure: num(s.pauseStructure),
          facePresence: num(s.facePresence),
          sceneChange: num(s.sceneChange),
          topicFit: num(s.topicFit),
          historyScore: num(s.historyScore),
          boostTotal: num(s.boostTotal),
          penaltyTotal: num(s.penaltyTotal),
        };
        this.store.saveClipScore(score);
      });
    });
  }

  /** Indices (into scoredSegments) of clips in the render tiers. */
  private async renderableIndices(segmentsPath: string): Promise<number[]> {
    const data = obj(await Bun.file(segmentsPath).json());
    const out: number[] = [];
    arr(data.scoredSegments).forEach((s, i) => {
      if (RENDER_TIERS.includes(str(s.tier) as string)) out.push(i);
    });
    return out;
  }

  /**
   * Fan out one script call per clip (2 in flight). Each call is an
   * independent ffmpeg job on its own file. Progress goes in the stage's
   * output_path, which the UI shows.
   */
  private async fanOut(
    jobId: string, stageName: Stage, video: Video, signal: AbortSignal,
    verb: string, done: string, script: string, argsFor: (idx: number) => string[],
    apply: (result: Json) => void, field: "renderStatus" | "exportStatus",
  ) {
    const indices = await this.renderableIndices(this.path("segments", `${video.id}.json`));
    const stage = this.store.getStage(jobId, stageName);
    let ok = 0;
    let failed = 0;
    const progress = (text: string) => { if (stage) this.store.updateStage(stage.id, { outputPath: text }); };

    await mapPool(indices, this.config.maxParallelRenders, async (idx) => {
      this.checkCancelled(jobId, signal);
      try {
        apply(await this.runScript(script, argsFor(idx), { signal }));
        ok++;
      } catch (e) {
        if (signal.aborted) throw new CancelledError();
        console.warn(`${stageName} failed for clip index ${idx}: ${(e as Error).message}`);
        const clip = this.store.clipsForVideo(video.id)[idx];
        if (clip) this.store.updateClip(clip.id, { [field]: "FAILED" });
        failed++;
      }
      progress(`${verb} ${ok + failed}/${indices.length} clips`);
    });
    progress(`${ok} ${done}, ${failed} failed`);
  }

  /** Map script results back onto clips by rank (1-based position in score order). */
  private applyClipResults(videoId: string, result: Json, kind: "render" | "export") {
    const clips = this.store.clipsForVideo(videoId);
    for (const rc of arr(result.clips)) {
      const rank = Math.trunc(num(rc.rank));
      const clip = clips[rank - 1];
      if (rank <= 0 || !clip) continue;
      const status = str(rc.status) as string;
      const path = str(rc.path) as string;
      const done = status === "COMPLETED" && path !== "";
      this.store.updateClip(clip.id, kind === "render"
        ? { renderStatus: status, ...(done ? { renderPath: path } : {}) }
        : { exportStatus: status, ...(done ? { exportPath: path } : {}) });
    }
  }

  /** Same flags for render.py and subtitle.py so captions follow the cut video. */
  private silenceArgs(): string[] {
    return this.config.silenceTrim
      ? ["--silence-trim", "--silence-gap", String(this.config.silenceGapSec)]
      : [];
  }

  private async stageRender(jobId: string, video: Video, signal: AbortSignal) {
    const segmentsPath = this.path("segments", `${video.id}.json`);
    const renderDir = `${this.config.dataDir}/renders/`;
    mkdirSync(renderDir, { recursive: true });
    await this.fanOut(jobId, "RENDER", video, signal, "Rendering", "rendered", "render.py",
      (idx) => [
        "--segments", segmentsPath, "--video", video.filePath, "--output-dir", renderDir,
        "--clip-index", String(idx),
        "--transcript", this.path("transcripts", `${video.id}.json`),
        "--reframe", this.config.reframeMode,
        ...this.silenceArgs(),
      ],
      (r) => this.applyClipResults(video.id, r, "render"), "renderStatus");
    return null; // progress text already written to output_path
  }

  private async stageSubtitle(jobId: string, video: Video, signal: AbortSignal) {
    const exportDir = `${this.config.dataDir}/exports/`;
    mkdirSync(exportDir, { recursive: true });
    await this.fanOut(jobId, "SUBTITLE", video, signal, "Burning", "burned", "subtitle.py",
      (idx) => [
        "--transcript", this.path("transcripts", `${video.id}.json`),
        "--segments", this.path("segments", `${video.id}.json`),
        "--render-dir", `${this.config.dataDir}/renders/`,
        "--output-dir", exportDir,
        "--clip-index", String(idx),
        "--style", this.config.subtitleStyle,
        ...this.silenceArgs(),
      ],
      (r) => this.applyClipResults(video.id, r, "export"), "exportStatus");
    return null;
  }

  private async stageVariation(video: Video, signal: AbortSignal) {
    const variationDir = `${this.config.dataDir}/variations/`;
    await this.runScript("variation.py", [
      "--segments", this.path("segments", `${video.id}.json`),
      "--video", video.filePath,
      "--output-dir", variationDir,
    ], { signal });
    return variationDir;
  }

  private async stageAnalytics(video: Video, signal: AbortSignal) {
    const outputPath = this.path("analytics", `${video.id}.json`);
    const result = await this.runScript("analytics.py", [
      "--segments", this.path("segments", `${video.id}.json`),
      "--output", outputPath,
    ], { signal });
    await Bun.write(outputPath, JSON.stringify(result));
    return outputPath;
  }

  private ensureDataDirs() {
    for (const d of DATA_SUBDIRS) mkdirSync(`${this.config.dataDir}/${d}`, { recursive: true });
  }
}
