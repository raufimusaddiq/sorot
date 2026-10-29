// Editing options for the render/subtitle stages: defaults from config,
// overridden per job (chosen at import) and per clip (clip editor).

import { basename } from "node:path";
import type { AppConfig } from "./config";
import { HttpError } from "./http";

export const CAPTION_STYLES = ["default", "hormozi", "storyteller", "cinematic"] as const;
export const REFRAME_MODES = ["face", "center", "blur"] as const;
/** Longest creative direction accepted (characters). */
export const MAX_DIRECTION = 500;
export const MUSIC_EXTENSIONS = [".mp3", ".m4a", ".aac", ".wav", ".ogg", ".flac"];

export interface PipelineOptions {
  style?: string;
  reframe?: string;
  silenceTrim?: boolean;
  silenceGapSec?: number;
  hookFirst?: boolean;
  youtubeCaptions?: boolean;
  allowAutoCaptions?: boolean;
  /** File name inside data/music, or "" for none. */
  bgm?: string;
  bgmVolume?: number;
  /** Free-text creative direction for Jev or the LLM ("only the funny parts", "for TikTok, under 40 s"); job level. */
  direction?: string;
}

export type ResolvedOptions = Required<PipelineOptions>;

/**
 * Seconds from "85", 85, "85s", "1:25", "01:02:03", "13m25s", "1h2m3s".
 * Returns null for empty input; throws HttpError(400) on garbage.
 */
export function parseTimestamp(value: unknown, field = "timestamp"): number | null {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    if (Number.isFinite(value) && value >= 0) return value;
    throw new HttpError(400, `${field} must be a non-negative number of seconds`);
  }
  const s = String(value).trim().toLowerCase();
  let m = /^(\d+(?:\.\d+)?)s?$/.exec(s);
  if (m) return Number(m[1]);
  m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(s);
  if (m) return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(s);
  if (m && (m[1] || m[2] || m[3])) return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  throw new HttpError(400, `${field} "${value}" is not a time (use 85, 1:25, 1:02:03 or 13m25s)`);
}

const pick = <T extends string>(value: unknown, allowed: readonly T[], field: string): T | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  const v = String(value).trim().toLowerCase() as T;
  if (!allowed.includes(v)) throw new HttpError(400, `${field} must be one of: ${allowed.join(", ")}`);
  return v;
};

const flag = (value: unknown, field: string): boolean | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  throw new HttpError(400, `${field} must be true or false`);
};

const num = (value: unknown, field: string, min: number, max: number): number | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${field} must be between ${min} and ${max}`);
  return n;
};

const textOption = (value: unknown, field: string, max: number): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new HttpError(400, `${field} must be text`);
  if (value.trim().length > max) throw new HttpError(400, `${field} may be at most ${max} characters`);
  return value.trim();
};

/** Validate a client-supplied options object; unknown keys are ignored. */
export function parseOptions(raw: unknown): PipelineOptions {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "options must be an object");
  const o = raw as Record<string, unknown>;
  const out: PipelineOptions = {
    style: pick(o.style, CAPTION_STYLES, "style"),
    reframe: pick(o.reframe, REFRAME_MODES, "reframe"),
    silenceTrim: flag(o.silenceTrim, "silenceTrim"),
    silenceGapSec: num(o.silenceGapSec, "silenceGapSec", 0.2, 5),
    hookFirst: flag(o.hookFirst, "hookFirst"),
    youtubeCaptions: flag(o.youtubeCaptions, "youtubeCaptions"),
    allowAutoCaptions: flag(o.allowAutoCaptions, "allowAutoCaptions"),
    bgm: o.bgm === undefined || o.bgm === null ? undefined : musicName(o.bgm),
    bgmVolume: num(o.bgmVolume, "bgmVolume", 0, 1),
    direction: textOption(o.direction, "direction", MAX_DIRECTION),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as PipelineOptions;
}

/** A bare file name from data/music ("" = no music). Rejects paths. */
export function musicName(value: unknown): string {
  const name = String(value ?? "").trim();
  if (name === "") return "";
  // Either OS's separators: on Linux basename() treats "C:\x.mp3" as a plain name.
  if (name !== basename(name) || /[\\/:]/.test(name) || name.startsWith(".") || !MUSIC_EXTENSIONS.some((e) => name.toLowerCase().endsWith(e))) {
    throw new HttpError(400, `bgm must be a music file name from data/music (${MUSIC_EXTENSIONS.join(", ")})`);
  }
  return name;
}

export function decodeOptions(json: string | null | undefined): PipelineOptions {
  if (!json) return {};
  try {
    return parseOptions(JSON.parse(json));
  } catch {
    return {};
  }
}

export function defaults(config: AppConfig): ResolvedOptions {
  return {
    style: config.subtitleStyle,
    reframe: config.reframeMode,
    silenceTrim: config.silenceTrim,
    silenceGapSec: config.silenceGapSec,
    hookFirst: config.hookFirst,
    youtubeCaptions: config.youtubeCaptions,
    allowAutoCaptions: config.allowAutoCaptions,
    bgm: config.bgmFile,
    bgmVolume: config.bgmVolume,
    direction: "",
  };
}

/** Later layers win: config defaults ← job options ← clip options. */
export function resolveOptions(config: AppConfig, ...layers: PipelineOptions[]): ResolvedOptions {
  return Object.assign(defaults(config), ...layers);
}

export const musicDir = (config: AppConfig) => `${config.dataDir}/music`;

/** Flags shared by render.py and subtitle.py so both plan the same timeline. */
function timelineFlags(o: ResolvedOptions): string[] {
  const out: string[] = [];
  if (o.silenceTrim) out.push("--silence-trim", "--silence-gap", String(o.silenceGapSec));
  if (o.hookFirst) out.push("--hook-first");
  return out;
}

export function renderFlags(o: ResolvedOptions): string[] {
  return ["--reframe", o.reframe, ...timelineFlags(o)];
}

function musicFlags(o: ResolvedOptions, config: AppConfig): string[] {
  return o.bgm ? ["--bgm", `${musicDir(config)}/${o.bgm}`, "--bgm-volume", String(o.bgmVolume)] : [];
}

/** render.py burning captions + music in its own pass (`--export-dir`). */
export function captionFlags(o: ResolvedOptions, config: AppConfig): string[] {
  return ["--style", o.style, ...musicFlags(o, config)];
}

export function subtitleFlags(o: ResolvedOptions, config: AppConfig): string[] {
  return ["--style", o.style, ...timelineFlags(o), ...musicFlags(o, config)];
}
