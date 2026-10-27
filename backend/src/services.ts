import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import type { AppConfig } from "./config";
import { now, type Store } from "./store";
import type { Clip, Video } from "./types";

export class NotFoundError extends Error {}

function removeFile(path: string | null) {
  if (!path) return;
  try {
    rmSync(path, { force: true });
  } catch (e) {
    console.warn(`Failed to delete file ${path}: ${(e as Error).message}`);
  }
}

export class VideoService {
  constructor(private readonly config: AppConfig, private readonly store: Store) {}

  importVideo(
    url?: string | null, localPath?: string | null,
    section: { start: number; end: number } | null = null,
  ): Video {
    const id = crypto.randomUUID();
    const isYoutube = !!url && url.trim() !== "";
    const video: Video = {
      id,
      sourceUrl: url ?? null,
      sourceType: isYoutube ? "YOUTUBE" : "LOCAL",
      title: null,
      durationSec: null,
      filePath: isYoutube ? `${this.config.dataDir}/raw/${id}.mp4` : (localPath ?? ""),
      createdAt: now(),
      sectionStart: section?.start ?? null,
      sectionEnd: section?.end ?? null,
    };
    return this.store.saveVideo(video);
  }

  listVideos() { return this.store.listVideos(); }
  getVideo(id: string) { return this.store.getVideo(id); }

  /** Removes the video, its clips (+ scores), jobs (+ stages) and media files.
   *  clip_feedback rows are kept on purpose: they're the scorer's training data. */
  deleteVideo(videoId: string) {
    const clips = this.store.clipsForVideo(videoId);
    const jobs = this.store.jobsByVideo(videoId);
    this.store.transaction(() => {
      for (const c of clips) this.store.deleteClip(c.id);
      for (const j of jobs) this.store.deleteJob(j.id);
      this.store.deleteVideoRow(videoId);
    });
    for (const c of clips) {
      removeFile(c.renderPath);
      removeFile(c.exportPath);
    }
    const d = this.config.dataDir;
    removeFile(`${d}/raw/${videoId}.mp4`);
    removeFile(`${d}/audio/${videoId}.wav`);
    for (const sub of ["transcripts", "segments", "analytics"]) removeFile(`${d}/${sub}/${videoId}.json`);
    console.info(`Deleted video ${videoId} with ${clips.length} clips, ${jobs.length} jobs, and associated files`);
  }
}

export class ClipService {
  constructor(private readonly config: AppConfig, private readonly store: Store) {}

  listClips(videoId: string) { return this.store.clipsForVideo(videoId); }
  getClip(id: string) { return this.store.getClip(id); }
  getClipScore(id: string) { return this.store.clipScore(id); }

  /** Copy each clip's best file (subtitled export, else raw render) to exports/{id}_final.mp4. */
  exportClips(clipIds: string[]): Clip[] {
    const exported: Clip[] = [];
    mkdirSync(`${this.config.dataDir}/exports`, { recursive: true });
    for (const clipId of clipIds) {
      const clip = this.store.getClip(clipId);
      if (!clip) throw new NotFoundError(`Clip not found: ${clipId}`);
      if (!clip.renderPath) continue;
      const exportPath = `${this.config.dataDir}/exports/${clip.id}_final.mp4`;
      const source = clip.exportPath ?? clip.renderPath;
      if (source !== exportPath) copyFileSync(source, exportPath);
      this.store.updateClip(clip.id, { exportStatus: "COMPLETED", exportPath });
      exported.push({ ...clip, exportStatus: "COMPLETED", exportPath });
    }
    return exported;
  }
}
