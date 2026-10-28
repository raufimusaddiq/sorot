// Clip editor: caption words for review, and re-rendering one clip with new
// timing, options or corrected caption text. Uses the same one-pass render.py
// (framing + captions + music) as the pipeline, on a one-clip segments file.

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import type { AppConfig } from "./config";
import { HttpError } from "./http";
import {
  captionFlags, decodeOptions, MUSIC_EXTENSIONS, musicDir, parseOptions, parseTimestamp, renderFlags, resolveOptions,
  type PipelineOptions,
} from "./options";
import type { PipelineOrchestrator } from "./orchestrator";
import type { ScriptRunner } from "./runner";
import { now, type Store } from "./store";
import type { Clip, Json } from "./types";

export interface CaptionWord {
  text: string;
  start: number;
  end: number;
}

const MIN_CLIP_SEC = 3;
const MAX_CLIP_SEC = 180;
const MAX_WORDS = 2000;

/** Validate edited caption words (absolute source seconds). */
export function parseCaptionWords(raw: unknown): CaptionWord[] {
  if (!Array.isArray(raw)) throw new HttpError(400, "captionWords must be an array or null");
  if (raw.length > MAX_WORDS) throw new HttpError(400, `captionWords may hold at most ${MAX_WORDS} words`);
  return raw.map((w, i) => {
    const o = (w ?? {}) as Record<string, unknown>;
    const start = Number(o.start);
    const end = Number(o.end);
    if (typeof o.text !== "string" || !Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      throw new HttpError(400, `captionWords[${i}] needs text, start and end (end >= start)`);
    }
    return { text: o.text.trim().slice(0, 60), start, end };
  }).filter((w) => w.text !== "");
}

export class ClipEditor {
  private busy = new Set<string>();
  /** Renders in flight and the ones waiting for a slot (maxParallelRenders, as in the pipeline). */
  private rendering = 0;
  private waiting: Array<() => void> = [];

  constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
    private readonly runScript: ScriptRunner,
    private readonly orchestrator: PipelineOrchestrator,
  ) {}

  private clip(id: string): Clip {
    const clip = this.store.getClip(id);
    if (!clip) throw new HttpError(404, "Clip not found");
    return clip;
  }

  private transcriptPath(videoId: string) {
    return `${this.config.dataDir}/transcripts/${videoId}.json`;
  }

  /** Words shown in the editor: the saved edit, else fresh from the transcript. */
  async captions(clipId: string): Promise<{ words: CaptionWord[]; edited: boolean }> {
    const clip = this.clip(clipId);
    if (clip.captionWords) {
      try {
        return { words: parseCaptionWords(JSON.parse(clip.captionWords)), edited: true };
      } catch {
        /* corrupt edit → fall back to the transcript */
      }
    }
    const transcript = this.transcriptPath(clip.videoId);
    if (!existsSync(transcript)) throw new HttpError(409, "Transcript not available yet");
    const data = await this.runScript("captions.py", [
      "--transcript", transcript, "--start", String(clip.startTime), "--end", String(clip.endTime),
    ]);
    return { words: parseCaptionWords(data.words ?? []), edited: false };
  }

  listMusic(): string[] {
    const dir = musicDir(this.config);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((n) => !n.startsWith(".") && MUSIC_EXTENSIONS.some((e) => n.toLowerCase().endsWith(e)))
      .sort((a, b) => a.localeCompare(b));
  }

  /** Wait for a render slot: several Render clicks must not all encode at once
   *  on a CPU. Resolves to the slot's release. */
  private async renderSlot(): Promise<() => void> {
    if (this.rendering < Math.max(1, this.config.maxParallelRenders)) this.rendering++;
    else await new Promise<void>((r) => this.waiting.push(r));   // the slot is handed over, count unchanged
    return () => {
      const next = this.waiting.shift();
      if (next) next();
      else this.rendering--;
    };
  }

  async rerender(clipId: string, body: Json): Promise<Clip> {
    const clip = this.clip(clipId);
    const video = this.store.getVideo(clip.videoId);
    if (!video) throw new HttpError(404, "Video not found");
    if (this.busy.has(clipId)) throw new HttpError(409, "Clip is already re-rendering");
    const job = this.store.latestJobForVideo(clip.videoId);
    if (job && (job.status === "RUNNING" || job.status === "QUEUED")) {
      throw new HttpError(409, "Video is still processing; edit clips after the pipeline finishes");
    }

    const startTime = parseTimestamp(body.startTime, "startTime") ?? clip.startTime;
    const endTime = parseTimestamp(body.endTime, "endTime") ?? clip.endTime;
    const duration = endTime - startTime;
    if (duration < MIN_CLIP_SEC || duration > MAX_CLIP_SEC) {
      throw new HttpError(400, `Clip must be ${MIN_CLIP_SEC}-${MAX_CLIP_SEC} s long (got ${duration.toFixed(1)} s)`);
    }
    const clipOptions: PipelineOptions = body.options === undefined ? decodeOptions(clip.options) : parseOptions(body.options);
    let words: CaptionWord[] | null = clip.captionWords ? parseCaptionWords(JSON.parse(clip.captionWords)) : null;
    if (body.captionWords !== undefined) words = body.captionWords === null ? null : parseCaptionWords(body.captionWords);

    const resolved = resolveOptions(this.config, decodeOptions(job?.options), clipOptions);
    if (resolved.bgm && !existsSync(`${musicDir(this.config)}/${resolved.bgm}`)) {
      throw new HttpError(400, `Music file not found in data/music: ${resolved.bgm}`);
    }

    this.busy.add(clipId);
    this.store.updateClip(clipId, {
      startTime, endTime, durationSec: Number(duration.toFixed(3)),
      options: Object.keys(clipOptions).length ? JSON.stringify(clipOptions) : null,
      captionWords: words ? JSON.stringify(words) : null,
      renderStatus: "RENDERING", exportStatus: "RENDERING", updatedAt: now(),
    });
    const release = await this.renderSlot();
    try {
      const edits = `${this.config.dataDir}/edits`;
      mkdirSync(edits, { recursive: true });
      const segmentsFile = `${edits}/${clipId}.segments.json`;
      await Bun.write(segmentsFile, JSON.stringify({
        videoId: clip.videoId,
        scoredSegments: [{ index: 0, rank: clip.rankPos ?? 1, tier: clip.tier, startTime, endTime }],
      }));
      let transcript = this.transcriptPath(clip.videoId);
      if (words) {
        // Edited words become a one-segment transcript: render (silence trim,
        // hook) and subtitle both read the corrected text.
        transcript = `${edits}/${clipId}.transcript.json`;
        await Bun.write(transcript, JSON.stringify({
          segments: words.length
            ? [{ start: words[0]!.start, end: words[words.length - 1]!.end,
                 text: words.map((w) => w.text).join(" "), words }]
            : [],
        }));
      }
      const renderDir = this.orchestrator.renderDir(clip.videoId);
      const exportDir = this.orchestrator.exportDir(clip.videoId);
      const one = ["--clip-index", "0", "--tiers", clip.tier];

      const rendered = (await this.runScript("render.py", [
        "--segments", segmentsFile, "--video", video.filePath, "--output-dir", renderDir, ...one,
        "--transcript", transcript, ...renderFlags(resolved),
        "--export-dir", exportDir, ...captionFlags(resolved, this.config),
      ])).clips as Json[] | undefined;
      const r = rendered?.[0];
      if (!r || r.status !== "COMPLETED") throw new Error(String(r?.error ?? "render produced no clip"));
      const path = String(r.path);
      this.store.updateClip(clipId, {
        renderStatus: "COMPLETED", renderPath: path, exportStatus: "COMPLETED", exportPath: path, updatedAt: now(),
      });
      return this.store.getClip(clipId) as Clip;
    } catch (e) {
      const fresh = this.store.getClip(clipId);
      this.store.updateClip(clipId, {
        renderStatus: fresh?.renderStatus === "RENDERING" ? "FAILED" : fresh?.renderStatus,
        exportStatus: "FAILED",
      });
      throw new HttpError(500, `Re-render failed: ${(e as Error).message}`);
    } finally {
      release();
      this.busy.delete(clipId);
    }
  }
}
