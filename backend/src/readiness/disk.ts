import { existsSync, statSync, statfsSync } from "node:fs";
import { dirname } from "node:path";
import type { AppConfig } from "../config";

/** Facts the preflight needs, injected so tests never look at a real disk. */
export interface DiskDeps {
  /** Free bytes on the volume holding `dir` (or its nearest existing parent). */
  freeBytes(dir: string): number;
  /** Size of a file, or null when it is missing. */
  fileBytes(path: string): number | null;
}

export const defaultDiskDeps: DiskDeps = {
  freeBytes(dir) {
    let d = dir;
    while (!existsSync(d) && dirname(d) !== d) d = dirname(d);
    try {
      const s = statfsSync(d);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      return Number.POSITIVE_INFINITY; // cannot tell: do not block the user
    }
  },
  fileBytes: (path) => (existsSync(path) ? statSync(path).size : null),
};

/** A YouTube source's size is unknown until it downloads; this is a long episode's worth. */
export const URL_SOURCE_GUESS_BYTES = 2 * 1024 ** 3;
/** One rendered 9:16 clip with captions, with room to spare. */
export const RENDER_CLIP_BYTES = 80 * 1024 ** 2;
/** Render-tier clips when the config renders them all (GPU installs). */
export const ALL_CLIPS_GUESS = 40;

/** Bytes a job needs: the source × factor (download, audio, frames, transcript) plus the render tier. */
export function jobBytes(config: AppConfig, sourceBytes: number | null): number {
  const clips = config.maxRenderClips || ALL_CLIPS_GUESS;
  return Math.ceil((sourceBytes ?? URL_SOURCE_GUESS_BYTES) * config.diskFactor + clips * RENDER_CLIP_BYTES);
}
