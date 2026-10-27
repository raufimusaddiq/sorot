// "How clippable is this whole video?" from its YouTube captions: parse the
// timed VTT, cut it into clip-sized 45 s windows, score each window with the
// text rules, and summarise (best moments, strong-moment count, speech
// density). Then a hand-weighted ranking score for discovery candidates.
// Ported from ai-pipeline/discover.py (tests/fixtures/discovery.json).

import { cpLen, cpSlice, pyRound, pySplit } from "./pyCompat";
import * as R from "./textRules";
import { durationFit } from "./youtube";

export const WINDOW_SEC = 45;
export const TOP_MOMENTS = 5;
/** A window at or above this is a "strong moment". Hand-set: ~10% of windows on a horror
 *  story channel, over half on a busy talk podcast — compare counts within a search. */
export const STRONG_MOMENT = 0.55;

export type CaptionLine = [start: number, text: string];

export interface Moment {
  start: number;
  score: number;
  text: string;
}

export interface CaptionAnalysis {
  transcriptScore: number;
  strongMoments: number;
  topMoments: Moment[];
  speechWpm: number | null;
  captionMinutes: number;
  windows: number;
}

const CUE_RE = /^(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{1,3})\s+-->/;

/**
 * Spoken lines with start times. YouTube auto-captions roll — each phrase
 * appears in two cues and only the line with inline word timings (`<c>`) is
 * new speech; uploaded captions have no such tags, so repeats are collapsed.
 */
export function parseVttLines(vtt: string): CaptionLine[] {
  const cues: Array<[number, string[]]> = [];
  for (const block of vtt.replaceAll("\r", "").split("\n\n")) {
    const rows = block.replace(/^\n+|\n+$/g, "").split("\n");
    for (let i = 0; i < rows.length; i++) {
      const m = CUE_RE.exec(rows[i]!.trim());
      if (!m) continue;
      const t = Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]!.padEnd(3, "0")) / 1000;
      cues.push([t, rows.slice(i + 1)]);
      break;
    }
  }
  const rolling = cues.some(([, rows]) => rows.some((r) => r.includes("<c>")));
  const lines: CaptionLine[] = [];
  let last: string | null = null;
  for (const [t, rows] of cues) {
    for (const row of rows) {
      if (rolling && !row.includes("<c>")) continue;
      const text = row.replace(/<[^>]+>/g, "").trim();
      if (text && text !== last) {
        lines.push([pyRound(t, 2), text]);
        last = text;
      }
    }
  }
  return lines;
}

export function captionWindows(lines: CaptionLine[], window = WINDOW_SEC): CaptionLine[] {
  const windows: Array<[number, string[]]> = [];
  for (const [t, text] of lines) {
    if (!windows.length || t - windows.at(-1)![0] >= window) windows.push([t, []]);
    windows.at(-1)![1].push(text);
  }
  return windows.map(([start, parts]) => [start, parts.join(" ")]);
}

/** Text-only clip potential of one window (the clip scorer's text rules). */
export function windowScore(text: string, corpusDir?: string): number {
  if (!text || cpLen(text) < 40) return 0.0;
  return pyRound(R.hookStrength(text) * 0.35 + R.keywordTrigger(text, corpusDir) * 0.3 + R.novelty(text) * 0.2
    + Math.abs(R.sentiment(text) - 0.5) * 2 * 0.15, 4);
}

/** Score every window of the video; null without captions. */
export function analyzeCaptions(lines: CaptionLine[], corpusDir?: string): CaptionAnalysis | null {
  if (!lines.length) return null;
  const windows = captionWindows(lines).map(([start, text]) => ({ start, text, score: windowScore(text, corpusDir) }));
  const best = [...windows].sort((a, b) => b.score - a.score).slice(0, TOP_MOMENTS);
  const words = lines.reduce((n, [, text]) => n + pySplit(text).length, 0);
  const minutes = Math.max((lines.at(-1)![0] - lines[0]![0]) / 60, 0);
  return {
    transcriptScore: pyRound(best.reduce((s, w) => s + w.score, 0) / best.length, 4),
    strongMoments: windows.filter((w) => w.score >= STRONG_MOMENT).length,
    topMoments: best.map((w) => ({ start: pyRound(w.start), score: w.score, text: cpSlice(w.text, 0, 160) })),
    speechWpm: minutes >= 1 ? pyRound(words / minutes) : null,
    captionMinutes: pyRound(minutes, 1),
    windows: windows.length,
  };
}

/** 0 for music / gameplay with little talk (< 60 wpm), 1 for steady talk (≥ 110). */
export function speechFit(wpm: number | null | undefined): number {
  if (!wpm) return 0.0;
  return pyRound(Math.min(Math.max((wpm - 60) / 50, 0.0), 1.0), 3);
}

/** Views per hour, log-scaled, for uploads younger than 30 days. */
export function velocityScore(views: number | null | undefined, ageHours: number | null | undefined): number {
  if (ageHours && ageHours < 720 && views && views > 0) {
    return Math.min(Math.log10(Math.max(views / Math.max(ageHours, 1), 1)) / 5.0, 1.0);
  }
  return 0.0;
}

/**
 * Ranking score for a candidate (0-1). Hand-set weights — a heuristic, not a
 * trained model: 40% best-moments text score, 15% strong moments per 10
 * captioned minutes (2+ saturates), 10% speech density, 20% view velocity,
 * 15% duration fit. Without captions only velocity and duration count.
 */
export function predictScore(a: CaptionAnalysis | null, duration = 0, views = 0, ageHours = 9999): number {
  let transcript = 0;
  let momentRate = 0;
  let speech = 0;
  if (a) {
    transcript = a.transcriptScore;
    momentRate = Math.min(a.strongMoments / Math.max(a.captionMinutes / 10, 1) / 2, 1.0);
    speech = speechFit(a.speechWpm);
  }
  const predicted = transcript * 0.4 + momentRate * 0.15 + speech * 0.1 + velocityScore(views, ageHours) * 0.2 + durationFit(duration) * 0.15;
  return pyRound(Math.min(predicted, 1.0), 4);
}
