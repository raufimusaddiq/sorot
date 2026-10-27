import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { reviewClips } from "./clipReview";
import type { AppConfig } from "./config";
import { Llm } from "./llm";
import { decodeOptions, renderFlags, resolveOptions, subtitleFlags, type ResolvedOptions } from "./options";
import type { ExecFn, ScriptRunner } from "./runner";
import { now, type Store } from "./store";
import { analyticsReport, findSegments, type ScoredSummary } from "./segments";
import { determineTier, FEATURE_ORDER, loadWeights, scoreSegments, type MediaFeatures, type SegmentIn } from "./scoring";
import type { Clip, ClipScore, Json, Stage, Video } from "./types";
import { YouTube } from "./youtube";
import { captionTranscript } from "./youtubeCaptions";

const DATA_SUBDIRS = [
  "input", "raw", "audio", "transcripts", "segments", "clips", "renders",
  "exports", "variations", "analytics", "logs", "music", "edits",
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
const readJson = (p: string): Json => obj(JSON.parse(readFileSync(p, "utf8")));

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
    private readonly llm: Llm = new Llm(config),
    private readonly youtube: YouTube = new YouTube(exec, config.ytdlpPath),
  ) {}

  /** Per-video render/export folders: clip files are named by rank, so a
   *  shared folder let every new video overwrite older videos' clips. */
  renderDir(videoId: string) {
    return `${this.config.dataDir}/renders/${videoId}/`;
  }

  exportDir(videoId: string) {
    return `${this.config.dataDir}/exports/${videoId}/`;
  }

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

    const opts = resolveOptions(this.config, decodeOptions(job.options));
    try {
      this.store.updateJob(jobId, { status: "RUNNING" }, { unlessCancelled: true });
      this.ensureDataDirs();

      const stages: Array<[Stage, () => Promise<string | null>]> = [
        ["IMPORT", () => this.stageImport(video, signal)],
        ["AUDIO_EXTRACT", () => this.stageAudioExtract(video, signal)],
        ["TRANSCRIBE", () => this.stageTranscribe(video, opts, signal)],
        ["SEGMENT", () => this.stageSegment(video)],
        ["SCORE", () => this.stageScore(video, signal)],
        ["RENDER", () => this.stageRender(jobId, video, opts, signal)],
        ["SUBTITLE", () => this.stageSubtitle(jobId, video, opts, signal)],
        ["VARIATION", () => this.stageVariation(video, signal)],
        ["ANALYTICS", () => this.stageAnalytics(video)],
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
    this.store.updateStage(stage.id, { status: "IN_PROGRESS", startedAt: now(), completedAt: null, errorMessage: null });
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

  private sectionArgs(video: Video): [number, number] | null {
    const a = video.sectionStart ?? null;
    const b = video.sectionEnd ?? null;
    return a != null && b != null ? [a, b] : null;
  }

  private async stageImport(video: Video, signal: AbortSignal): Promise<string> {
    const section = this.sectionArgs(video);
    if (video.sourceType !== "YOUTUBE") {
      if (!fileNonEmpty(video.filePath)) throw new Error(`Local file not found: ${video.filePath}`);
      if (!section) return video.filePath;
      // Range import of a local file: cut once so every stage sees only it.
      const cut = this.path("raw", `${video.id}.mp4`);
      if (!fileNonEmpty(cut)) {
        await this.run(this.config.ffmpegPath, [
          "-ss", String(section[0]), "-to", String(section[1]), "-i", video.filePath,
          "-c", "copy", "-avoid_negative_ts", "make_zero", "-y", cut,
        ], signal, "ffmpeg range cut");
      }
      this.store.updateVideo(video.id, { filePath: cut });
      video.filePath = cut;
      return cut;
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
        // A range import downloads only that window, not the whole video.
        const sectionFlags = section
          ? ["--download-sections", `*${section[0]}-${section[1]}`, "--force-keyframes-at-cuts"]
          : [];
        await this.run(this.config.ytdlpPath, [
          "-f", YTDLP_FORMAT, "--merge-output-format", "mp4", "--no-warnings", ...sectionFlags,
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

  private async stageTranscribe(video: Video, opts: ResolvedOptions, signal: AbortSignal) {
    const outputPath = this.path("transcripts", `${video.id}.json`);
    if (opts.youtubeCaptions && video.sourceType === "YOUTUBE" && video.sourceUrl) {
      // Uploaded captions spell names right; fall back to Whisper when the
      // video has none (or the fetch fails).
      const section = this.sectionArgs(video);
      try {
        const captions = await captionTranscript(this.youtube, video.sourceUrl, video.id, {
          language: this.config.whisperLanguage, allowAuto: opts.allowAutoCaptions,
          start: section?.[0], end: section?.[1], signal,
        });
        if (signal.aborted) throw new CancelledError();
        if (captions.found === true) {
          await Bun.write(outputPath, JSON.stringify(captions));
          return outputPath;
        }
      } catch (e) {
        if (signal.aborted) throw new CancelledError();
        console.warn(`YouTube captions failed, using Whisper: ${(e as Error).message}`);
      }
    }
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

  private async stageSegment(video: Video) {
    const outputPath = this.path("segments", `${video.id}.json`);
    const transcript = readJson(this.path("transcripts", `${video.id}.json`));
    const lines = arr(transcript.segments).map((s) => ({ start: num(s.start), end: num(s.end), text: str(s.text) ?? "" }));
    const segments = findSegments(lines);
    await Bun.write(outputPath, JSON.stringify({ videoId: str(transcript.videoId) ?? "", segmentCount: segments.length, segments }));
    return outputPath;
  }

  /**
   * Python measures the media features (media_features.py); the text rules,
   * weighting, tiers and post copy run here (scoring.ts), then the optional
   * LLM review (clipReview.ts) blends in its judgement.
   */
  private async stageScore(video: Video, signal: AbortSignal) {
    const segmentsPath = this.path("segments", `${video.id}.json`);
    const audioPath = this.path("audio", `${video.id}.wav`);
    const transcriptPath = this.path("transcripts", `${video.id}.json`);
    const args = ["--segments", segmentsPath, "--video", video.filePath];
    if (existsSync(audioPath)) args.push("--audio", audioPath);
    const measured = await this.runScript("media_features.py", args, { signal });

    const segments = arr(readJson(segmentsPath).segments) as unknown as SegmentIn[];
    const media = new Map<number, MediaFeatures>(arr(measured.segments).map((m) => [num(m.index), {
      rmsRatio: typeof m.rmsRatio === "number" ? m.rmsRatio : null,
      onsetDensity: num(m.onsetDensity, 0.5), facePresence: num(m.facePresence, 0.5),
      sceneChange: num(m.sceneChange, 0.5), motion: num(m.motion, 0.5),
    }]));
    const ctx = {
      weights: loadWeights(this.config.pipelineDir, this.config.dataDir),
      niche: this.config.nicheKeywords.length ? this.config.nicheKeywords : null,
      transcript: existsSync(transcriptPath) ? arr(readJson(transcriptPath).segments) : null,
      history: this.store.feedbackHistory(),
      corpusDir: `${this.config.dataDir}/corpus`,
    };
    let scored = scoreSegments(segments, media, ctx);
    const supervised = await this.supervisedPredictions(video.id, scored, signal);
    if (supervised) scored = scoreSegments(segments, media, { ...ctx, supervised });
    const review = await reviewClips(scored, this.llm, determineTier);
    if (review.error) console.warn(`LLM review skipped for some clips of ${video.id}: ${review.error}`);
    const ranked = review.segments.sort((a, b) => b.finalScore - a.finalScore).map((s, i) => ({ ...s, rank: i + 1 }));
    const result: Json = {
      videoId: video.id,
      scoredSegments: ranked,
      scoredBy: ranked.some((s) => s.scoredBy !== "rules") ? "llm+rules" : "rules",
      ...(review.error ? { llmError: review.error } : {}),
    };
    await Bun.write(segmentsPath, JSON.stringify(result));
    this.saveClipsFromScoredSegments(video.id, result);
    return segmentsPath;
  }

  /** Predictions of the optional trained model (ai-pipeline/model.lgb), by segment index. */
  private async supervisedPredictions(videoId: string, scored: Array<{ index: number; scores: Record<string, number> }>, signal: AbortSignal) {
    if (!existsSync(`${this.config.pipelineDir}/model.lgb`)) return null;
    const featuresPath = this.path("segments", `${videoId}.features.json`);
    await Bun.write(featuresPath, JSON.stringify(scored.map((s) => ({
      index: s.index, features: Object.fromEntries(FEATURE_ORDER.map((k) => [k, s.scores[k] ?? 0])),
    }))));
    const r = await this.runScript("predict_supervised.py", ["--features", featuresPath], { signal });
    const preds = new Map<number, number>();
    for (const [k, v] of Object.entries(obj(r.predictions))) if (typeof v === "number") preds.set(Number(k), v);
    return preds.size ? preds : null;
  }

  saveClipsFromScoredSegments(videoId: string, scored: Json) {
    this.store.transaction(() => {
      for (const c of this.store.clipsForVideo(videoId)) this.store.deleteClip(c.id);
      // No clip_feedback row is pre-created here: a feedback row exists only
      // once the user submits the posted clip's real metrics (POST /api/clips/{id}/feedback).
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
          reason: str(seg.reason, null),
          scoredBy: str(seg.scoredBy, null),
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
          motion: num(s.motion),
          onsetDensity: num(s.onsetDensity),
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

  private async stageRender(jobId: string, video: Video, opts: ResolvedOptions, signal: AbortSignal) {
    const segmentsPath = this.path("segments", `${video.id}.json`);
    const renderDir = this.renderDir(video.id);
    mkdirSync(renderDir, { recursive: true });
    await this.fanOut(jobId, "RENDER", video, signal, "Rendering", "rendered", "render.py",
      (idx) => [
        "--segments", segmentsPath, "--video", video.filePath, "--output-dir", renderDir,
        "--clip-index", String(idx),
        "--transcript", this.path("transcripts", `${video.id}.json`),
        ...renderFlags(opts),
      ],
      (r) => this.applyClipResults(video.id, r, "render"), "renderStatus");
    return null; // progress text already written to output_path
  }

  private async stageSubtitle(jobId: string, video: Video, opts: ResolvedOptions, signal: AbortSignal) {
    const exportDir = this.exportDir(video.id);
    mkdirSync(exportDir, { recursive: true });
    await this.fanOut(jobId, "SUBTITLE", video, signal, "Burning", "burned", "subtitle.py",
      (idx) => [
        "--transcript", this.path("transcripts", `${video.id}.json`),
        "--segments", this.path("segments", `${video.id}.json`),
        "--render-dir", this.renderDir(video.id),
        "--output-dir", exportDir,
        "--clip-index", String(idx),
        ...subtitleFlags(opts, this.config),
      ],
      (r) => this.applyClipResults(video.id, r, "export"), "exportStatus");
    return null;
  }

  private async stageVariation(video: Video, signal: AbortSignal) {
    // Per video: files are named by rank, like renders and exports.
    const variationDir = `${this.config.dataDir}/variations/${video.id}/`;
    await this.runScript("variation.py", [
      "--segments", this.path("segments", `${video.id}.json`),
      "--video", video.filePath,
      "--output-dir", variationDir,
    ], { signal });
    return variationDir;
  }

  private async stageAnalytics(video: Video) {
    const outputPath = this.path("analytics", `${video.id}.json`);
    const scored = readJson(this.path("segments", `${video.id}.json`));
    await Bun.write(outputPath, JSON.stringify(analyticsReport(str(scored.videoId) ?? "", arr(scored.scoredSegments) as ScoredSummary[])));
    return outputPath;
  }

  private ensureDataDirs() {
    for (const d of DATA_SUBDIRS) mkdirSync(`${this.config.dataDir}/${d}`, { recursive: true });
  }
}
