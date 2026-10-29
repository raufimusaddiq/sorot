// Candidate clips from a transcript, and the per-video analytics report.
// Ported from ai-pipeline/segment.py and analytics.py (tests/fixtures/pipeline-rules.json).

import { pyRound } from "./pyCompat";
import type { Json } from "./types";

export interface TranscriptLine {
  start: number;
  end: number;
  text: string;
}

export interface Segment {
  index: number;
  startTime: number;
  endTime: number;
  duration: number;
  text: string;
}

/** A pause longer than this ends a segment once it has the minimum length. */
const BREAK_GAP_SEC = 2.0;

/**
 * Greedy windows: grow from each line until the next one would pass
 * `maxDuration`, or a > 2 s pause comes after at least `minDuration`.
 */
export function findSegments(lines: TranscriptLine[], minDuration = 10, maxDuration = 60): Segment[] {
  const segments: Segment[] = [];
  let i = 0;
  while (i < lines.length) {
    const start = lines[i]!.start;
    let end = lines[i]!.end;
    const text = [lines[i]!.text];
    let j = i + 1;
    while (j < lines.length) {
      const candidateEnd = lines[j]!.end;
      const candidate = candidateEnd - start;
      if (candidate > maxDuration) break;
      if (lines[j]!.start - lines[j - 1]!.end > BREAK_GAP_SEC && candidate >= minDuration) break;
      end = candidateEnd;
      text.push(lines[j]!.text);
      j++;
    }
    const duration = end - start;
    if (duration >= minDuration) {
      segments.push({ index: segments.length, startTime: pyRound(start, 2), endTime: pyRound(end, 2),
        duration: pyRound(duration, 2), text: text.join(" ") });
    }
    i = j > i + 1 ? j : i + 1;
  }
  return segments;
}

// ---- analytics ----

export interface ScoredSummary {
  tier?: string;
  finalScore?: number;
  duration?: number;
  scores?: Record<string, number>;
}

export function tierDistribution(segs: ScoredSummary[]): Record<string, number> {
  const tiers: Record<string, number> = { PRIMARY: 0, BACKUP: 0, SKIP: 0 };
  for (const s of segs) {
    const t = s.tier ?? "SKIP";
    tiers[t] = (tiers[t] ?? 0) + 1;
  }
  return tiers;
}

export function scoreStats(segs: ScoredSummary[]) {
  const xs = segs.map((s) => s.finalScore ?? 0);
  if (!xs.length) return { min: 0, max: 0, avg: 0, count: 0 };
  return { min: pyRound(Math.min(...xs), 4), max: pyRound(Math.max(...xs), 4),
    avg: pyRound(xs.reduce((a, b) => a + b, 0) / xs.length, 4), count: xs.length };
}

export function durationStats(segs: ScoredSummary[]) {
  const xs = segs.map((s) => s.duration ?? 0);
  if (!xs.length) return { min: 0, max: 0, avg: 0 };
  return { min: pyRound(Math.min(...xs), 1), max: pyRound(Math.max(...xs), 1), avg: pyRound(xs.reduce((a, b) => a + b, 0) / xs.length, 1) };
}

/** Average of each feature across segments, highest first. */
export function topFeatures(segs: ScoredSummary[]) {
  const totals = new Map<string, [sum: number, n: number]>();
  for (const s of segs) {
    for (const [k, v] of Object.entries(s.scores ?? {})) {
      if (k === "boostTotal" || k === "penaltyTotal") continue;
      const [sum, n] = totals.get(k) ?? [0, 0];
      totals.set(k, [sum + v, n + 1]);
    }
  }
  return [...totals].map(([feature, [sum, n]]) => ({ feature, average: pyRound(sum / n, 4) }))
    .sort((a, b) => b.average - a.average);
}

export function recommendations(tiers: Record<string, number>, scores: { avg: number }, durations: { avg: number }): string[] {
  const recs: string[] = [];
  if (!tiers.PRIMARY) recs.push("No PRIMARY clips found. Consider longer source video or adjusting scoring weights.");
  if ((tiers.PRIMARY ?? 0) > 5) recs.push("Many PRIMARY clips found. Consider raising the PRIMARY threshold from 0.78.");
  if (scores.avg < 0.5) recs.push("Average score is low. Content may not match viral keywords well.");
  if (durations.avg > 50) recs.push("Clips are long on average. Consider shorter segments for better short-form performance.");
  if (durations.avg < 15) recs.push("Clips are very short. May need more context for viewers.");
  if (!recs.length) recs.push("Scoring looks healthy. Good distribution of clip tiers.");
  return recs;
}

/** The analytics report written for each video (the ANALYTICS stage). */
export function analyticsReport(videoId: string, segs: ScoredSummary[]): Json {
  const tiers = tierDistribution(segs);
  const scores = scoreStats(segs);
  const durations = durationStats(segs);
  return {
    videoId,
    totalSegments: segs.length,
    tierDistribution: tiers,
    scoreStats: scores,
    durationStats: durations,
    topFeatures: topFeatures(segs),
    recommendations: recommendations(tiers, scores, durations),
  };
}
