import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { GATE_MAX, gateClips, heldLast } from "./clipGate";
import { reviewClips, rulesReason, type ReviewedSegment } from "./clipReview";
import type { AppConfig } from "./config";
import { dropOverlaps, mineMoments, videoBrief, type Line, type VideoBrief } from "./director";
import { ruleHook, type TranscriptSeg } from "./hooks";
import { Jev, JevError } from "./jev";
import { hookAndTitle, judgeClips, quoteTitle, screenMoments, sentenceWindows } from "./jevDirector";
import { Llm, LlmError } from "./llm";
import { captionFlags, decodeOptions, renderFlags, resolveOptions, subtitleFlags, type ResolvedOptions } from "./options";
import { timeoutFor, type ExecFn, type ScriptRunner } from "./runner";
import { now, type Store } from "./store";
import { analyticsReport, findSegments, type ScoredSummary } from "./segments";
import { determineTier, FEATURE_ORDER, loadWeights, scoreSegments, type MediaFeatures, type SegmentIn } from "./scoring";
import type { Clip, ClipScore, Json, Stage, Video } from "./types";
import { YouTube } from "./youtube";
import { mapPool } from "./pool";

export { mapPool };
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

export class PipelineOrchestrator {
  constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
    private readonly runScript: ScriptRunner,
    private readonly exec: ExecFn,
    private readonly llm: Llm = new Llm(config),
    private readonly youtube: YouTube = new YouTube(exec, config.ytdlpPath),
    private readonly jev: Jev = new Jev(config),
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
        ["IMPORT", () => this.stageImport(video, opts, signal)],
        ["AUDIO_EXTRACT", () => this.stageAudioExtract(video, signal)],
        ["TRANSCRIBE", () => this.stageTranscribe(jobId, video, opts, signal)],
        ["SEGMENT", () => this.stageSegment(jobId, video, opts)],
        ["SCORE", () => this.stageScore(jobId, video, opts, signal)],
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

  /** Media length from the audio stage's 16 kHz mono 16-bit WAV (32 000 bytes/s); 0 before it exists. */
  private audioSeconds(video: Video): number {
    try {
      return Math.max(0, (statSync(this.path("audio", `${video.id}.wav`)).size - 44) / 32_000);
    } catch {
      return 0;
    }
  }

  private sectionArgs(video: Video): [number, number] | null {
    const a = video.sectionStart ?? null;
    const b = video.sectionEnd ?? null;
    return a != null && b != null ? [a, b] : null;
  }

  private async stageImport(video: Video, opts: ResolvedOptions, signal: AbortSignal): Promise<string> {
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
    if (title.exitCode === 0 && t) {
      this.store.updateVideo(video.id, { title: t });
      video.title = t;   // later stages (director, review) read it from here
    }

    // A retry after a completed download skips straight to the cached file.
    if (!fileNonEmpty(outputPath)) {
      try {
        // A range import downloads only that window, not the whole video, as a
        // stream copy: 1.3 s for a 60 s section where forcing keyframes at the
        // cuts re-encoded it in 46 s (4 cores), and ffmpeg reads the copy on
        // the same timeline. YouTube captions are timed on the original video,
        // so with them on the cut stays exact (re-encoded).
        const sectionFlags = section
          ? ["--download-sections", `*${section[0]}-${section[1]}`, ...(opts.youtubeCaptions ? ["--force-keyframes-at-cuts"] : [])]
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

  private async stageTranscribe(jobId: string, video: Video, opts: ResolvedOptions, signal: AbortSignal) {
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
    // A retry reuses this video's transcript: on a CPU, Whisper takes about as
    // long as the video, and the audio it heard hasn't changed.
    if (this.reusableTranscript(outputPath)) return outputPath;
    // CPU Whisper runs from ~0.5x real time (12 cores) to slower than real
    // time (4 cores or fewer); this guards against a hang, so it's generous.
    const perMediaMinute = this.config.whisperDevice === "cpu" ? 4 : 0.5;
    // An hour of CPU transcription with no sign of life looks hung: show "Transcribing 37%".
    const stage = this.store.getStage(jobId, "TRANSCRIBE");
    const onProgress = (p: number) => { if (stage) this.store.updateStage(stage.id, { outputPath: `Transcribing ${p}%` }); };
    const result = await this.runScript("transcribe.py", [
      "--audio", this.path("audio", `${video.id}.wav`),
      "--output", outputPath,
      "--language", this.config.whisperLanguage,
      "--model", this.config.whisperModel,
      "--device", this.config.whisperDevice,
    ], { signal, timeoutMinutes: timeoutFor("transcribe.py", this.audioSeconds(video), perMediaMinute), onProgress });
    await Bun.write(outputPath, JSON.stringify(result));
    return outputPath;
  }

  /** A saved Whisper transcript made with the configured model and language. */
  private reusableTranscript(path: string): boolean {
    try {
      const t = readJson(path);
      return t.model === this.config.whisperModel && t.language === this.config.whisperLanguage && Array.isArray(t.segments);
    } catch {
      return false;
    }
  }

  /**
   * Candidate clips: the rules' pause-based windows, plus — with an LLM and
   * LLM_DIRECTOR on — a video brief and the LLM's own picks (director.ts).
   * Overlaps between the two are settled after scoring.
   */
  private async stageSegment(jobId: string, video: Video, opts: ResolvedOptions) {
    const outputPath = this.path("segments", `${video.id}.json`);
    const transcript = readJson(this.path("transcripts", `${video.id}.json`));
    const lines: Line[] = arr(transcript.segments).map((s) => ({
      start: num(s.start), end: num(s.end), text: str(s.text) ?? "",
      ...(Array.isArray(s.words) ? { words: s.words as Line["words"] } : {}),
    }));
    const segments: Json[] = findSegments(lines).map((s) => ({ ...s, source: "rules" }));
    const director: Json = {};
    const stage = this.store.getStage(jobId, "SEGMENT");
    const progress = (text: string) => { if (stage) this.store.updateStage(stage.id, { outputPath: text }); };
    if (this.jevFirst && lines.length) {
      // Code proposes a window at every sentence start; Jev judges them all.
      const windows = sentenceWindows(lines);
      const screened = await screenMoments(this.jev, windows, opts.direction,
        (done, total) => { if (done % 10 === 0 || done === total) progress(`Jev reading moments ${done}/${total}`); });
      for (const p of screened.picks) segments.push({ ...p, index: segments.length });
      Object.assign(director, { by: "jev", model: this.jev.model, windows: windows.length, judged: screened.judged,
        picks: screened.picks.length, tokens: screened.tokens }, screened.error ? { pickError: screened.error } : {});
      if (screened.error) console.warn(`Jev screening partly failed for ${video.id}: ${screened.error}`);
    } else if (this.llm.enabled && this.config.llmDirector && lines.length) {
      const ctx = { title: video.title, direction: opts.direction };
      let brief: VideoBrief | null = null;
      progress("LLM reading the video");
      try {
        brief = await videoBrief(this.llm, lines, ctx);
        this.store.updateVideo(video.id, { brief: JSON.stringify(brief) });
      } catch (e) {
        if (!(e instanceof LlmError)) throw e;
        director.briefError = e.message;
      }
      const mined = await mineMoments(this.llm, lines, { ...ctx, brief },
        (done, total) => progress(`LLM picking moments ${done}/${total}`));
      for (const m of mined.moments) segments.push({ ...m, index: segments.length });
      Object.assign(director, { brief, picks: mined.moments.length, parts: mined.parts, model: this.llm.model },
        mined.error ? { pickError: mined.error } : {});
      if (director.briefError || mined.error) {
        console.warn(`LLM director partly fell back to rules for ${video.id}: ${director.briefError ?? mined.error}`);
      }
    }
    await Bun.write(outputPath, JSON.stringify({
      videoId: str(transcript.videoId) ?? "", segmentCount: segments.length, segments,
      ...(Object.keys(director).length ? { director } : {}),
    }));
    return outputPath;
  }

  /**
   * Python measures the media features (media_features.py); the text rules,
   * weighting, tiers and post copy run here (scoring.ts), then the optional
   * LLM review (clipReview.ts) blends in its judgement.
   */
  private async stageScore(jobId: string, video: Video, opts: ResolvedOptions, signal: AbortSignal) {
    const segmentsPath = this.path("segments", `${video.id}.json`);
    const audioPath = this.path("audio", `${video.id}.wav`);
    const transcriptPath = this.path("transcripts", `${video.id}.json`);
    const args = ["--segments", segmentsPath, "--video", video.filePath];
    if (existsSync(audioPath)) args.push("--audio", audioPath);
    // Samples frames across the whole video: longer videos need longer.
    const measured = await this.runScript("media_features.py", args,
      { signal, timeoutMinutes: timeoutFor("media_features.py", this.audioSeconds(video), 0.3) });

    const segmentsFile = readJson(segmentsPath);
    const segments = arr(segmentsFile.segments) as unknown as SegmentIn[];
    const brief = (obj(segmentsFile.director).brief ?? null) as VideoBrief | null;
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
    const stage = this.store.getStage(jobId, "SCORE");
    const progress = (text: string) => { if (stage) this.store.updateStage(stage.id, { outputPath: text }); };
    let kept: ReviewedSegment[];
    let review: { error: string | null } = { error: null };
    let gate: { by: string | null; error: string | null };
    if (this.jevFirst) {
      // Jev scores every candidate (50/50 with the rules) and its answers are the gate verdict too; no LLM.
      const all: ReviewedSegment[] = scored.map((s) => ({ ...s, scoredBy: "rules", reason: rulesReason(s.scores) }));
      const judged = await judgeClips(this.jev, all, opts.direction, determineTier,
        (done, total) => { if (done % 10 === 0 || done === total) progress(`Jev judging clips ${done}/${total}`); });
      kept = dropOverlaps(all.sort(heldLast));   // verdicts are known here, so a FAIL never displaces a passing neighbour
      const by = new Set(kept.filter((s) => s.gate).map((s) => s.gate!.by));
      gate = { by: by.size > 1 ? "mixed" : (by.values().next().value ?? null), error: judged.error };
      if (judged.error) console.warn(`Jev fell back to rules for some clips of ${video.id}: ${judged.error}`);
    } else {
      const reviewed = await reviewClips(scored, this.llm, determineTier, { title: video.title, brief, direction: opts.direction });
      review = reviewed;
      if (reviewed.error) console.warn(`LLM review skipped for some clips of ${video.id}: ${reviewed.error}`);
      // The LLM's picks and the rule windows can cover the same moment: keep the better-scored one.
      kept = dropOverlaps(reviewed.segments.sort((a, b) => b.finalScore - a.finalScore));
      progress(this.jev.enabled ? "Jev checking clips" : "Checking clips");
      gate = await gateClips(kept, this.jev, RENDER_TIERS);
      if (gate.error) console.warn(`Jev gate fell back to rules for some clips of ${video.id}: ${gate.error}`);
    }
    // Clips the gate held back rank after the rest (render tiers stay first: render.py indexes them in order).
    const ranked = kept.sort(heldLast).map((s, i) => ({ ...s, rank: i + 1 }));
    const words = (ctx.transcript ?? []) as TranscriptSeg[];
    const jevDecided = this.jevFirst ? await this.jevHooksAndTitles(ranked, words, progress) : new Set<object>();
    // Every clip's hook is decided here (render.py only replays it): Jev's decision (null = its opening needs
    // no replay) or the LLM's line, else the rules' (null = none).
    for (const s of ranked) {
      if (!jevDecided.has(s) && typeof (s as Json).hookStart !== "number") {
        Object.assign(s, ruleHook(words, s.startTime, s.endTime) ?? { hookStart: null, hookEnd: null });
      }
    }
    const result: Json = {
      videoId: video.id,
      scoredSegments: ranked,
      scoredBy: ranked.some((s) => s.scoredBy === "jev+rules") ? "jev+rules"
        : ranked.some((s) => s.scoredBy !== "rules") ? "llm+rules" : "rules",
      ...(review.error ? { llmError: review.error } : {}),
      ...(segmentsFile.director ? { director: segmentsFile.director } : {}),   // SEGMENT's stats (windows, tokens, errors)
      ...(gate.by ? { gatedBy: gate.by } : {}),
      ...(gate.error ? { gateError: gate.error } : {}),
    };
    await Bun.write(segmentsPath, JSON.stringify(result));
    this.saveClipsFromScoredSegments(video.id, result);
    return segmentsPath;
  }

  /** Jev makes the creative decisions when it is connected and JEV_DIRECTOR is on. */
  private get jevFirst(): boolean {
    return this.jev.enabled && this.config.jevDirector;
  }

  /**
   * Hook line and quote title from Jev for the clips that will render first
   * (the CPU cap, else every render-tier clip up to the gate's limit). Returns
   * the clips whose hook Jev decided; the others get the rules' hook (and a
   * clip Jev couldn't answer keeps the rules' title).
   */
  private async jevHooksAndTitles(ranked: Array<{ startTime: number; endTime: number; text: string; tier: string; title: string }>,
    words: TranscriptSeg[], progress: (text: string) => void): Promise<Set<object>> {
    const cap = this.config.maxRenderClips > 0 ? this.config.maxRenderClips : GATE_MAX;
    const targets = ranked.filter((s) => RENDER_TIERS.includes(s.tier)).slice(0, cap);
    let done = 0;
    let failures = 0;
    const decided = new Set<object>();
    await mapPool(targets, 4, async (s) => {
      if (failures >= 3) return;
      const lines: Line[] = words.filter((w) => Number(w.start) >= s.startTime - 0.05 && Number(w.end) <= s.endTime + 0.05)
        .map((w) => ({ start: Number(w.start), end: Number(w.end), text: String(w.text ?? ""),
          ...(Array.isArray(w.words) ? { words: w.words as Line["words"] } : {}) }));
      try {
        const r = await hookAndTitle(this.jev, lines, s.startTime, s.text);
        failures = 0;
        if (r.hook !== undefined) {
          Object.assign(s, r.hook ? { hookStart: r.hook[0], hookEnd: r.hook[1] } : { hookStart: null, hookEnd: null });
          decided.add(s);
        }
        if (r.title) s.title = quoteTitle(r.title, s.text, s.tier);
      } catch (e) {
        if (!(e instanceof JevError)) throw e;
        failures++;
      }
      progress(`Jev picking hooks and titles ${++done}/${targets.length}`);
    });
    return decided;
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
          source: str(seg.source, "rules"),
          hookStart: typeof seg.hookStart === "number" ? seg.hookStart : null,
          hookEnd: typeof seg.hookEnd === "number" ? seg.hookEnd : null,
          gateVerdict: seg.gate ? str(obj(seg.gate).verdict, null) : null,
          gate: seg.gate ? JSON.stringify(seg.gate) : null,
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
   * output_path, which the UI shows. `only` narrows the clips and `note`
   * ends the final progress text; returns whether any ran.
   */
  private async fanOut(
    jobId: string, stageName: Stage, video: Video, signal: AbortSignal,
    verb: string, done: string, script: string, argsFor: (idx: number) => string[],
    apply: (result: Json) => void, field: "renderStatus" | "exportStatus",
    only: (idx: number) => boolean, note = "",
  ) {
    const indices = (await this.renderableIndices(this.path("segments", `${video.id}.json`))).filter(only);
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
    progress(`${ok} ${done}, ${failed} failed${note}`);
    return indices.length > 0;
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
      const exported = { exportStatus: status, ...(done ? { exportPath: path } : {}) };
      this.store.updateClip(clip.id, kind === "render"
        // A captioned render (captions burned in the same pass) is the export too.
        ? { renderStatus: status, ...(done ? { renderPath: path } : {}), ...(rc.captioned === true ? exported : {}) }
        : exported);
    }
  }

  private async stageRender(jobId: string, video: Video, opts: ResolvedOptions, signal: AbortSignal) {
    const segmentsPath = this.path("segments", `${video.id}.json`);
    const renderDir = this.renderDir(video.id);
    mkdirSync(renderDir, { recursive: true });
    const exportDir = this.exportDir(video.id);
    mkdirSync(exportDir, { recursive: true });
    // Only the best maxRenderClips (a CPU's default 10; a GPU renders all): the
    // rest keep their scores and copy and render on request.
    const renderable = await this.renderableIndices(segmentsPath);
    const limit = this.config.maxRenderClips;
    const top = new Set(limit > 0 ? renderable.slice(0, limit) : renderable);
    const later = renderable.length - top.size;
    // Framing, captions and music in one encode per clip (see render.py).
    await this.fanOut(jobId, "RENDER", video, signal, "Rendering", "rendered", "render.py",
      (idx) => [
        "--segments", segmentsPath, "--video", video.filePath, "--output-dir", renderDir,
        "--clip-index", String(idx),
        "--transcript", this.path("transcripts", `${video.id}.json`),
        ...renderFlags(opts),
        "--export-dir", exportDir, ...captionFlags(opts, this.config),
      ],
      (r) => this.applyClipResults(video.id, r, "render"), "renderStatus",
      (idx) => top.has(idx), later ? `, ${later} more render on request` : "");
    return null; // progress text already written to output_path
  }

  /**
   * Captions are burned during RENDER now. This only re-burns clips rendered
   * without them: a job rendered before that change and retried after it.
   */
  private async stageSubtitle(jobId: string, video: Video, opts: ResolvedOptions, signal: AbortSignal) {
    const exportDir = this.exportDir(video.id);
    mkdirSync(exportDir, { recursive: true });
    const clips = this.store.clipsForVideo(video.id);
    const uncaptioned = (idx: number) =>
      clips[idx]?.renderStatus === "COMPLETED" && clips[idx]?.exportStatus !== "COMPLETED";
    const ran = await this.fanOut(jobId, "SUBTITLE", video, signal, "Burning", "burned", "subtitle.py",
      (idx) => [
        "--transcript", this.path("transcripts", `${video.id}.json`),
        "--segments", this.path("segments", `${video.id}.json`),
        "--render-dir", this.renderDir(video.id),
        "--output-dir", exportDir,
        "--clip-index", String(idx),
        ...subtitleFlags(opts, this.config),
      ],
      (r) => this.applyClipResults(video.id, r, "export"), "exportStatus", uncaptioned);
    return ran ? null : "Captions burned during render";
  }

  private async stageVariation(video: Video, signal: AbortSignal) {
    if (!this.config.variations) return "Skipped (VARIATIONS=true turns them on)";
    // Per video: files are named by rank, like renders and exports.
    const variationDir = `${this.config.dataDir}/variations/${video.id}/`;
    try {
      await this.runScript("variation.py", [
        "--segments", this.path("segments", `${video.id}.json`),
        "--video", video.filePath,
        "--output-dir", variationDir,
      ], { signal });
    } catch (e) {
      // Optional extras: the clips are already done, so this can't fail the job.
      if (signal.aborted) throw new CancelledError();
      console.warn(`Variations failed for ${video.id}: ${(e as Error).message}`);
      return `Failed: ${(e as Error).message}`;
    }
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
