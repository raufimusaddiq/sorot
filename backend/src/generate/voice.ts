import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AppConfig } from "../config";
import type { ExecFn } from "../runner";
import { shotStarts } from "./composer";
import type { SpokenWord } from "./narration";
import type { Plan } from "./planSchema";

// The voiceover of a project: the script's lines, the audio file of each, how long it is and (once
// the align step ran) when every word is spoken. Kept in one file next to the project's folders so
// the plan, the build and the TECHNICAL checks all read the same thing.

export interface VoiceLine {
  id: string;
  text: string;
  /** Absolute path of the audio. */
  file: string;
  durationSec: number;
  /** Word times inside the line, from the engine or from Whisper; null until known. */
  words: SpokenWord[] | null;
}

export interface VoiceFile {
  engine: string;
  voice: string;
  lines: VoiceLine[];
  /** Where the word times came from: the engine, Whisper, or nowhere yet. */
  aligned: "engine" | "whisper" | null;
}

export const voiceDir = (config: Pick<AppConfig, "genDir">, projectId: string) => join(config.genDir, projectId, "voice");
const voiceFilePath = (config: Pick<AppConfig, "genDir">, projectId: string) => join(config.genDir, projectId, "voice.json");

export function readVoice(config: Pick<AppConfig, "genDir">, projectId: string): VoiceFile | null {
  const path = voiceFilePath(config, projectId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as VoiceFile;
  } catch {
    return null;
  }
}

export function writeVoice(config: Pick<AppConfig, "genDir">, projectId: string, voice: VoiceFile): void {
  const path = voiceFilePath(config, projectId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(voice, null, 2));
}

/** The words of a text as they are compared: lower case, no punctuation. */
export const wordsOf = (text: string): string[] => text.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").split(/\s+/).filter(Boolean);

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const norm = (text: string) => wordsOf(text).join(" ");

/** ffprobe sits next to ffmpeg. */
const probeBinary = (ffmpegPath: string) => ffmpegPath.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");

/** The length of an audio file in seconds. */
export async function audioSeconds(exec: ExecFn, ffmpegPath: string, file: string, signal?: AbortSignal): Promise<number> {
  const res = await exec(probeBinary(ffmpegPath), ["-v", "error", "-show_entries", "format=duration", "-of", "json", file], { signal, timeoutMs: 60_000 });
  const seconds = res.exitCode === 0 ? Number((JSON.parse(res.stdout) as { format?: { duration?: string } }).format?.duration) : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`Couldn't read the length of ${file}`);
  return round3(seconds);
}

const GAP_SEC = 0.15;

export interface Placed { line: VoiceLine; start: number }

/**
 * When each line starts in the film. A line whose words sit inside a shot's narration plays from
 * that shot's start (one after another within the shot); a line no shot mentions follows the one
 * before it.
 */
export function placeLines(plan: Plan, lines: VoiceLine[]): Placed[] {
  const starts = shotStarts(plan);
  const placed = new Map<string, number>();
  plan.shots.forEach((shot, i) => {
    if (!shot.narration) return;
    const spoken = ` ${norm(shot.narration)} `;
    let at = starts[i] as number;
    for (const line of lines) {
      if (placed.has(line.id) || !spoken.includes(` ${norm(line.text)} `)) continue;
      placed.set(line.id, round3(at));
      at += line.durationSec + GAP_SEC;
    }
  });
  let cursor = 0;
  return lines.map((line) => {
    const start = placed.get(line.id) ?? round3(cursor);
    cursor = start + line.durationSec + GAP_SEC;
    return { line, start };
  });
}

/**
 * `timingFrom: voice`: a shot that narrates whole lines lasts as long as they take, plus a breath.
 * Shots without matching lines keep their length.
 */
export function snapToVoice(plan: Plan, lines: VoiceLine[], padSec = 0.4): Plan {
  const shots = plan.shots.map((shot) => {
    if (!shot.narration) return shot;
    const spoken = ` ${norm(shot.narration)} `;
    const mine = lines.filter((l) => spoken.includes(` ${norm(l.text)} `));
    if (!mine.length) return shot;
    const total = mine.reduce((n, l) => n + l.durationSec, 0) + GAP_SEC * (mine.length - 1) + padSec;
    return { ...shot, durationSec: Math.ceil(total * 10) / 10 };
  });
  return { ...plan, shots, totalSec: round3(shots.reduce((n, s) => n + s.durationSec, 0)) };
}

/** Word error rate: the edit distance between what should be said and what was heard, over the words that should be said. */
export function wordErrorRate(expected: string[], heard: string[]): number {
  if (!expected.length) return heard.length ? 1 : 0;
  let prev = Array.from({ length: heard.length + 1 }, (_, j) => j);
  for (let i = 1; i <= expected.length; i++) {
    const row = [i];
    for (let j = 1; j <= heard.length; j++) {
      row[j] = Math.min((prev[j] as number) + 1, (row[j - 1] as number) + 1, (prev[j - 1] as number) + (expected[i - 1] === heard[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return round3((prev[heard.length] as number) / expected.length);
}

/**
 * The script's own words with the times Whisper heard: word for word when the counts match, spread
 * in proportion when Whisper split or merged some.
 */
export function alignWords(script: string[], heard: SpokenWord[]): SpokenWord[] {
  if (!heard.length) return [];
  return script.map((text, i) => {
    const at = script.length === heard.length ? i : Math.min(heard.length - 1, Math.round((i * (heard.length - 1)) / Math.max(1, script.length - 1)));
    const next = heard[Math.min(heard.length - 1, at + 1)] as SpokenWord;
    const w = heard[at] as SpokenWord;
    return { text, start: w.start, end: script.length === heard.length ? w.end : Math.max(w.end, i < script.length - 1 ? next.start : w.end) };
  });
}
