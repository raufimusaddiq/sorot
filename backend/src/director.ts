// LLM director: with an LLM configured, it drives the creative choices the
// rules made alone before. It reads the whole video once (a brief: topic,
// people, audience, angle), then picks its own clip moments from the full
// transcript — where each clip starts and ends, and which line is the hook
// (replayed first with "hook first"). The creator can steer every step with
// a free-text `direction` set at import.
//
// Code keeps the constraints: line ids must exist, clips are 10-60 s, the
// hook stays inside its clip and overlapping picks are dropped. The rule
// segments are always kept as candidates, and every step falls back to the
// rules on LlmError (no brief, no picks, rule hook).

import { LlmError, parseJson, type Llm } from "./llm";
import { mapPool } from "./pool";
import { pyRound } from "./pyCompat";
import type { Json } from "./types";

export const BRIEF_CHARS = 6000;
/** Transcript part sent per call: ~5 min fits a local model's 4k context. */
export const MINE_WINDOW_SEC = 300;
export const MINE_OVERLAP_SEC = 45;
export const MINE_PER_WINDOW = 4;
export const MIN_CLIP_SEC = 10;
export const MAX_CLIP_SEC = 60;
/** Same bounds as captions.py's rule hook. */
export const HOOK_MIN_SEC = 1.2;
export const HOOK_MAX_SEC = 6.0;
const MINE_CONCURRENCY = 2;
/** After this many LLM failures in a row the remaining parts are skipped. */
const MAX_FAILURES = 2;

export interface Word {
  text?: string;
  start: number;
  end: number;
}

export interface Line {
  start: number;
  end: number;
  text: string;
  words?: Word[];
}

export interface VideoBrief {
  summary: string;
  topics: string[];
  people: string[];
  audience: string;
  angle: string;
}

export interface DirectorContext {
  title?: string | null;
  direction?: string;
  brief?: VideoBrief | null;
}

export interface MinedMoment {
  startTime: number;
  endTime: number;
  duration: number;
  text: string;
  source: "llm";
  /** Absolute seconds of the hook line, when the LLM named one inside the clip. */
  hookStart?: number;
  hookEnd?: number;
  why: string;
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const list = (v: unknown, max: number) =>
  (Array.isArray(v) ? v : []).map((x) => text(x, 80)).filter(Boolean).slice(0, max);

// ---- brief -----------------------------------------------------------------

export const BRIEF_SYSTEM = `You prepare a long video (podcast, interview, talk show; usually Indonesian) to be cut into short vertical clips.
From a sample of its transcript, write a brief for the editor. The creator may add a direction: what they want from this video.

Answer with JSON only:
{"summary": "<2-3 English sentences: what the video is about>",
 "topics": ["<3-6 short topics>"],
 "people": ["<names of speakers and people discussed, spelled correctly>"],
 "audience": "<who would share clips from it>",
 "angle": "<what makes clips from this video worth watching, in one sentence>"}`;

/** All lines, or evenly spaced runs of consecutive lines that fit `budget` characters. */
export function transcriptSample(lines: Line[], budget = BRIEF_CHARS): string {
  const rows = lines.map((l) => `${clock(l.start)} ${l.text.trim()}`);
  const total = rows.reduce((n, r) => n + r.length + 1, 0);
  if (total <= budget) return rows.join("\n");
  const blocks = 6;
  const per = Math.floor(budget / blocks);
  const out: string[] = [];
  for (let b = 0; b < blocks; b++) {
    const block: string[] = [];
    let used = 0;
    for (let i = Math.floor((b * rows.length) / blocks); i < rows.length && used + rows[i]!.length <= per; i++) {
      block.push(rows[i]!);
      used += rows[i]!.length + 1;
    }
    if (block.length) out.push(block.join("\n"));
  }
  return out.join("\n…\n");
}

export async function videoBrief(llm: Llm, lines: Line[], ctx: DirectorContext): Promise<VideoBrief> {
  const msg = await llm.chat([
    { role: "system", content: BRIEF_SYSTEM },
    { role: "user", content: JSON.stringify({
      title: ctx.title ?? "", ...(ctx.direction ? { direction: ctx.direction } : {}), transcript: transcriptSample(lines),
    }) },
  ], { temperature: 0.3, maxTokens: 800 });
  const d = parseJson(msg.content) as Json | null;
  const summary = text(d?.summary, 600);
  if (!summary) throw new LlmError("LLM brief had no summary");
  return {
    summary, topics: list(d?.topics, 6), people: list(d?.people, 12), audience: text(d?.audience, 200), angle: text(d?.angle, 300),
  };
}

// ---- moments ---------------------------------------------------------------

export const MINE_SYSTEM = `You are a short-form video editor cutting 15-60 second vertical clips from a long video (usually Indonesian).
You get one part of its transcript as numbered lines: "[id] m:ss text".

Pick the moments in this part that work as stand-alone clips. A good clip:
- starts on the line where the hook or the setup begins: never mid-thought, never on a reply to something said earlier
- ends on the line that completes the payoff: the answer, punchline, conclusion or outcome of the story
- needs no earlier context to follow
- lasts 15-60 seconds
For each moment also give the hook line: the one line inside it most likely to stop someone scrolling (it may be replayed at the start).
Skip greetings, sponsor reads, housekeeping and filler. If nothing in this part is worth a clip, return an empty list.
When the creator gives a direction, pick the moments that fit it.

Answer with JSON only:
{"moments": [{"start": <first line id>, "end": <last line id>, "hook": <line id>, "why": "<one short English sentence>"}]}
At most ${MINE_PER_WINDOW} moments, best first. Use only line ids shown in this part.`;

/** [first, last] line indices of overlapping transcript parts, ~MINE_WINDOW_SEC each. */
export function mineWindows(lines: Line[], windowSec = MINE_WINDOW_SEC, overlapSec = MINE_OVERLAP_SEC): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let first = 0;
  while (first < lines.length) {
    const until = lines[first]!.start + windowSec;
    let last = first;
    while (last + 1 < lines.length && lines[last + 1]!.start < until) last++;
    out.push([first, last]);
    if (last === lines.length - 1) break;
    let next = last;
    while (next > first + 1 && lines[next - 1]!.start >= until - overlapSec) next--;
    first = Math.max(next, first + 1);
  }
  return out;
}

const TERMINAL = /[.!?…]["')\]]*$/;

/** The hook line trimmed to one spoken sentence of 1.2-6 s (word timings when present). */
export function hookSpan(line: Line): [number, number] {
  const words = (line.words ?? []).filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start);
  if (!words.length) return [line.start, Math.min(line.end, line.start + HOOK_MAX_SEC)];
  const start = words[0]!.start;
  let end = words[0]!.end;
  for (const w of words.slice(1)) {
    if (w.end - start > HOOK_MAX_SEC) break;
    end = w.end;
    if (end - start >= HOOK_MIN_SEC && TERMINAL.test((w.text ?? "").trim())) break;
  }
  return [start, end];
}

/** Validate one LLM moment against the transcript; null when it can't be made a 10-60 s clip. */
export function momentFrom(lines: Line[], raw: unknown, lo: number, hi: number): MinedMoment | null {
  const r = (raw ?? {}) as Json;
  const start = Number(r.start);
  let end = Number(r.end);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < lo || end > hi || end < start) return null;
  const span = (a: number, b: number) => lines[b]!.end - lines[a]!.start;
  while (end > start && span(start, end) > MAX_CLIP_SEC) end--;
  // Too short: take the following lines (past the part, if needed) up to the minimum.
  while (span(start, end) < MIN_CLIP_SEC && end + 1 < lines.length && span(start, end + 1) <= MAX_CLIP_SEC) end++;
  const duration = span(start, end);
  if (duration < MIN_CLIP_SEC || duration > MAX_CLIP_SEC) return null;
  const startTime = lines[start]!.start;
  const endTime = lines[end]!.end;
  const moment: MinedMoment = {
    startTime: pyRound(startTime, 2), endTime: pyRound(endTime, 2), duration: pyRound(duration, 2),
    text: lines.slice(start, end + 1).map((l) => l.text.trim()).join(" "),
    source: "llm", why: text(r.why, 300),
  };
  const hook = Number(r.hook);
  if (Number.isInteger(hook) && hook >= start && hook <= end) {
    const [a, b] = hookSpan(lines[hook]!);
    if (a >= startTime && b <= endTime) Object.assign(moment, { hookStart: pyRound(a, 3), hookEnd: pyRound(b, 3) });
  }
  return moment;
}

/** Overlap of two time ranges as a share of the shorter one (0-1). */
export function overlapShare(a: { startTime: number; endTime: number }, b: { startTime: number; endTime: number }): number {
  const inter = Math.min(a.endTime, b.endTime) - Math.max(a.startTime, b.startTime);
  const shorter = Math.min(a.endTime - a.startTime, b.endTime - b.startTime);
  return inter > 0 && shorter > 0 ? inter / shorter : 0;
}

/** Keep the first of any two candidates overlapping by more than `max` (pass them best first). */
export function dropOverlaps<T extends { startTime: number; endTime: number }>(segs: T[], max = 0.5): T[] {
  const kept: T[] = [];
  for (const s of segs) if (!kept.some((k) => overlapShare(k, s) > max)) kept.push(s);
  return kept;
}

async function minePart(llm: Llm, lines: Line[], [lo, hi]: [number, number], part: string, ctx: DirectorContext) {
  const numbered = lines.slice(lo, hi + 1).map((l, i) => `[${lo + i}] ${clock(l.start)} ${l.text.trim()}`).join("\n");
  const msg = await llm.chat([
    { role: "system", content: MINE_SYSTEM },
    { role: "user", content: JSON.stringify({
      video: ctx.title ?? "",
      ...(ctx.brief ? { brief: { summary: ctx.brief.summary, people: ctx.brief.people } } : {}),
      ...(ctx.direction ? { direction: ctx.direction } : {}),
      part, lines: numbered,
    }) },
  ], { temperature: 0.4, maxTokens: 1200 });
  const data = parseJson(msg.content);
  const moments = Array.isArray(data) ? data : (data as Json | null)?.moments;
  if (!Array.isArray(moments)) throw new LlmError("LLM reply had no moments list");
  return moments.slice(0, MINE_PER_WINDOW).map((m) => momentFrom(lines, m, lo, hi)).filter((m): m is MinedMoment => !!m);
}

/**
 * The LLM's clip picks across the whole transcript, in transcript order,
 * without duplicates from overlapping parts. Parts the LLM can't answer are
 * skipped; returns the first error.
 */
export async function mineMoments(
  llm: Llm, lines: Line[], ctx: DirectorContext, onProgress?: (done: number, total: number) => void,
): Promise<{ moments: MinedMoment[]; error: string | null; parts: number }> {
  const windows = mineWindows(lines);
  let error: string | null = null;
  let failures = 0;
  let done = 0;
  const found = await mapPool(windows, MINE_CONCURRENCY, async (w) => {
    if (failures >= MAX_FAILURES) return [];
    try {
      const picks = await minePart(llm, lines, w, `${windows.indexOf(w) + 1}/${windows.length}`, ctx);
      failures = 0;
      return picks;
    } catch (e) {
      if (!(e instanceof LlmError)) throw e;
      error ??= e.message;
      failures++;
      return [];
    } finally {
      onProgress?.(++done, windows.length);
    }
  });
  const ordered = found.flat().sort((a, b) => a.startTime - b.startTime);
  return { moments: dropOverlaps(ordered), error, parts: windows.length };
}

