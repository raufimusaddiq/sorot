// Clip scoring: text rules (textRules.ts) + media features measured in Python
// (ai-pipeline/media_features.py: loudness, onsets, faces, scene changes,
// motion), combined with the weights in ai-pipeline/weights.json. A weighted
// sum of hand-written signals — see docs/ai-audit.md. clipReview.ts can blend
// an LLM's judgement on top. Ported from ai-pipeline/score.py; identical
// results on tests/fixtures/scoring.json.

import { existsSync, readFileSync } from "node:fs";
import { pyRound } from "./pyCompat";
import { DEFAULT_WEIGHTS } from "./ruleConstants";
import * as R from "./textRules";

/** Feature order of the original scorer: the weighted sum adds in this order. */
export const FEATURE_ORDER = [
  "hookStrength", "keywordTrigger", "novelty", "clarity", "emotionalEnergy", "textSentiment", "pauseStructure",
  "facePresence", "sceneChange", "topicFit", "historyScore", "motion", "onsetDensity",
] as const;

export interface SegmentIn {
  index: number;
  startTime: number;
  endTime: number;
  duration: number;
  text: string;
  [key: string]: unknown;
}

export interface MediaFeatures {
  rmsRatio: number | null;
  onsetDensity: number;
  facePresence: number;
  sceneChange: number;
  motion: number;
}

export interface ScoringContext {
  weights: Record<string, number>;
  niche: string[] | null;
  transcript: R.TranscriptSegment[] | null;
  history: Array<{ text: string; viralScore: number | null }>;
  corpusDir?: string;
  /** Predictions of the optional trained model, by segment index (replace the weighted sum). */
  supervised?: Map<number, number>;
}

export interface ScoredSegment extends SegmentIn {
  scores: Record<string, number>;
  finalScore: number;
  tier: string;
  title: string;
  description: string;
  rank?: number;
}

const NEUTRAL_MEDIA: MediaFeatures = { rmsRatio: null, onsetDensity: 0.5, facePresence: 0.5, sceneChange: 0.5, motion: 0.5 };

export function determineTier(score: number): string {
  return score >= 0.8 ? "PRIMARY" : score >= 0.65 ? "BACKUP" : "SKIP";
}

/** weights.json, with defaults for any feature it lacks. */
export function loadWeights(pipelineDir: string): Record<string, number> {
  const path = `${pipelineDir}/weights.json`;
  try {
    if (existsSync(path)) {
      const w = (JSON.parse(readFileSync(path, "utf8")) as { weights?: Record<string, number> }).weights ?? {};
      return { ...w, ...Object.fromEntries(Object.entries(DEFAULT_WEIGHTS).filter(([k]) => !(k in w))) };
    }
  } catch {
    /* unreadable → defaults */
  }
  return { ...DEFAULT_WEIGHTS };
}

export function featureScores(seg: SegmentIn, media: MediaFeatures, ctx: ScoringContext): Record<string, number> {
  const { text, duration, startTime, endTime } = seg;
  return {
    hookStrength: R.hookStrength(text),
    keywordTrigger: R.keywordTrigger(text, ctx.corpusDir),
    novelty: R.novelty(text),
    clarity: R.clarity(duration, text),
    emotionalEnergy: R.emotionalEnergy(text, media.rmsRatio),
    textSentiment: R.sentiment(text),
    pauseStructure: R.pauseStructure(text, duration, R.silenceRatio(ctx.transcript, startTime, endTime)),
    facePresence: media.facePresence,
    sceneChange: media.sceneChange,
    topicFit: R.topicFit(text, ctx.niche),
    historyScore: R.historyScore(ctx.history, text),
    motion: media.motion,
    onsetDensity: media.onsetDensity,
  };
}

export function scoreSegment(seg: SegmentIn, media: MediaFeatures | undefined, ctx: ScoringContext): ScoredSegment {
  const scores = featureScores(seg, media ?? NEUTRAL_MEDIA, ctx);
  let base = 0;
  for (const k of FEATURE_ORDER) base += (ctx.weights[k] ?? 0) * scores[k]!;
  const boosts = R.boosts(seg.text);
  const penalties = R.penalties(seg.text, seg.duration, scores);
  const supervised = ctx.supervised?.get(seg.index);
  if (supervised !== undefined) base = supervised;
  const finalScore = pyRound(Math.min(base + boosts - penalties, 1.0), 4);
  const tier = determineTier(finalScore);
  return {
    ...seg,
    scores: { ...scores, boostTotal: boosts, penaltyTotal: penalties },
    finalScore,
    tier,
    title: R.clipTitle(seg.text, tier),
    description: R.clipDescription(seg.text, tier),
  };
}

/** Score, sort best first (stable) and number the ranks. */
export function scoreSegments(segments: SegmentIn[], media: Map<number, MediaFeatures>, ctx: ScoringContext): ScoredSegment[] {
  return segments
    .map((s) => scoreSegment(s, media.get(s.index), ctx))
    .sort((a, b) => b.finalScore - a.finalScore)
    .map((s, i) => ({ ...s, rank: i + 1 }));
}
