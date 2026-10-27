// Learning from posted clips: the velocity-based viral score of real
// platform metrics, and re-weighting the scorer's features by how well each
// one correlated with that score (Pearson + EMA blend). A hand-tuned linear
// re-weighting, not model training — LightGBM training stays in Python
// (train_scorer.py) and only switches on with enough labelled clips.
// Ported from ai-pipeline/feedback.py and learn_weights.py.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pyRound } from "./pyCompat";
import { DEFAULT_WEIGHTS } from "./ruleConstants";
import { FEATURE_ORDER } from "./scoring";

/**
 * 0-1 from raw counts, normalised by time on the platform (10k views in 2 hours
 * ≠ 10k in 2 months): views/day log-scaled (35%), interactions per view (25%),
 * saves per view (20%), comments per view (20%).
 */
export function viralScore(views: number, likes: number, comments: number, shares: number, saves: number, hoursSincePost = 1.0): number {
  if (views === 0) return 0.0;
  const hours = Math.max(hoursSincePost, 0.1);
  const perDay = views / (hours / 24.0);
  const per = (x: number) => x / Math.max(views, 1);
  const velocity = Math.min(Math.log10(Math.max(perDay, 1)) / 6.0, 1.0);
  const engagement = Math.min(per(likes + comments + shares + saves) * 20, 1.0);
  const save = Math.min(per(saves) * 100, 1.0);
  const comment = Math.min(per(comments) * 200, 1.0);
  return pyRound(Math.min(velocity * 0.35 + engagement * 0.25 + save * 0.2 + comment * 0.2, 1.0), 4);
}

export function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0.0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    cov += (xs[i]! - mx) * (ys[i]! - my);
    vx += (xs[i]! - mx) ** 2;
    vy += (ys[i]! - my) ** 2;
  }
  const denom = Math.sqrt(vx * vy);
  return denom === 0 ? 0.0 : cov / denom;
}

export interface WeightsFile {
  version: number;
  trained_on: number;
  last_updated: string;
  weights: Record<string, number>;
  thresholds?: Record<string, number>;
}

/** Learned weights live in the data dir (survive image rebuilds); the shipped defaults in the pipeline dir. */
export const learnedWeightsPath = (dataDir: string) => `${dataDir}/weights.json`;

export function readWeightsFile(dataDir: string, pipelineDir: string): WeightsFile {
  for (const path of [learnedWeightsPath(dataDir), `${pipelineDir}/weights.json`]) {
    try {
      if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as WeightsFile;
    } catch {
      /* unreadable → next */
    }
  }
  return { version: 0, trained_on: 0, last_updated: "", weights: { ...DEFAULT_WEIGHTS } };
}

export interface FeedbackRecord {
  features: Record<string, number> | string;
  actual_viral_score: number | null;
}

export interface TrainResult {
  status: "trained" | "insufficient_data";
  version?: number;
  trained_on: number;
  message?: string;
  weight_changes?: Record<string, { from: number; to: number }>;
  new_weights?: Record<string, number>;
}

/**
 * Each feature's new weight = its correlation with the real viral score (floored
 * at 0.05; features with too few samples keep their weight), normalised, then
 * blended into the current weights (alpha 0.3) and normalised again.
 */
export function trainWeights(records: FeedbackRecord[], current: WeightsFile, opts: { alpha?: number; minSamples?: number; now?: Date } = {})
  : { result: TrainResult; updated?: WeightsFile } {
  const alpha = opts.alpha ?? 0.3;
  const minSamples = opts.minSamples ?? 5;
  const cur = current.weights ?? {};
  const valid = records.filter((r) => r.actual_viral_score != null);
  if (valid.length < minSamples) {
    return { result: { status: "insufficient_data", trained_on: current.trained_on ?? 0,
      message: `Need at least ${minSamples} records with actual scores, got ${valid.length}` } };
  }
  const corr: Record<string, number> = {};
  for (const f of FEATURE_ORDER) {
    const pairs: Array<[number, number]> = [];
    for (const r of valid) {
      let feats = r.features;
      if (typeof feats === "string") {
        try {
          feats = JSON.parse(feats) as Record<string, number>;
        } catch {
          continue;
        }
      }
      const v = feats?.[f];
      if (typeof v === "number") pairs.push([v, r.actual_viral_score!]);
    }
    corr[f] = pairs.length >= minSamples ? Math.max(pearson(pairs.map((p) => p[0]), pairs.map((p) => p[1])), 0.05) : (cur[f] ?? 0.1);
  }
  // Correlations are floored at 0.05, so the sums are positive unless the current weights are all 0.
  const total = Object.values(corr).reduce((a, b) => a + b, 0) || 1;
  const blended = Object.fromEntries(FEATURE_ORDER.map((k) => [k, pyRound((cur[k] ?? 0.1) * (1 - alpha) + (corr[k]! / total) * alpha, 4)]));
  const totalB = Object.values(blended).reduce((a, b) => a + b, 0) || 1;
  const weights = Object.fromEntries(FEATURE_ORDER.map((k) => [k, pyRound(blended[k]! / totalB, 4)]));

  const updated: WeightsFile = {
    ...current,
    version: (current.version ?? 0) + 1,
    trained_on: valid.length,
    last_updated: (opts.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z"),
    weights,
  };
  const changes: Record<string, { from: number; to: number }> = {};
  for (const k of FEATURE_ORDER) {
    const from = pyRound(cur[k] ?? 0, 4);
    if (Math.abs(from - weights[k]!) > 0.0001) changes[k] = { from, to: weights[k]! };
  }
  return { result: { status: "trained", version: updated.version, trained_on: valid.length, weight_changes: changes, new_weights: weights }, updated };
}

export function writeWeightsFile(dataDir: string, w: WeightsFile) {
  const path = learnedWeightsPath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(w, null, 2));
}
