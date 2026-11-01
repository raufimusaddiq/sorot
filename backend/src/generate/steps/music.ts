import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AppConfig } from "../../config";
import type { RunFn } from "./types";

/** The music bed a project settled on, and how far it ducks under the voice. */
export interface MusicChoice { assetId: string; path: string; duckUnderVoiceDb: number | null }

const musicFile = (config: Pick<AppConfig, "genDir">, projectId: string) => join(config.genDir, projectId, "music.json");

export function readMusic(config: Pick<AppConfig, "genDir">, projectId: string): MusicChoice | null {
  const path = musicFile(config, projectId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as MusicChoice;
  } catch {
    return null;
  }
}

/** Gain for `db` decibels (-12 dB is a quarter of the volume). */
export const gainOf = (db: number) => Math.round(10 ** (db / 20) * 1000) / 1000;

/**
 * Picks the music bed: the track the recipe names (by asset id or file name), else the only upload,
 * else the newest one. The plan can still choose another upload for itself; this is what the film
 * gets when it doesn't. Music is always the owner's own upload: nothing is fetched.
 */
export const run: RunFn = async (ctx) => {
  const { project, settings } = ctx;
  const tracks = ctx.store.genAssetsForProject(project.id).filter((a) => a.kind === "music");
  const named = typeof settings.track === "string" ? settings.track.trim() : "";
  if (!tracks.length) {
    if (named) throw new Error(`The music track "${named}" isn't uploaded: add it to this video's files`);
    return { status: "skipped", reason: "no music was uploaded" };
  }
  const pick = named ? tracks.find((a) => a.id === named || a.path.endsWith(named)) : tracks[tracks.length - 1];
  if (!pick) throw new Error(`The music track "${named}" isn't among the uploads (${tracks.map((a) => a.path.split("/").pop()).join(", ")})`);
  const choice: MusicChoice = { assetId: pick.id, path: pick.path, duckUnderVoiceDb: typeof settings.duckUnderVoiceDb === "number" ? settings.duckUnderVoiceDb : null };
  const file = musicFile(ctx.config, project.id);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(choice, null, 2));
  return { status: "done", outputRef: pick.id };
};
