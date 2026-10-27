import { mkdirSync } from "node:fs";
import type { AppConfig } from "./config";
import { readWeightsFile, trainWeights, viralScore, writeWeightsFile, type FeedbackRecord } from "./learning";
import { FEATURE_ORDER } from "./scoring";
import { now, type Store } from "./store";
import type { ClipFeedback, Json } from "./types";

export class ValidationError extends Error {}

// ISO-8601 instant with an explicit zone (Z or ±hh:mm), as Instant.parse accepted.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

export interface Metrics {
  views: number; likes: number; comments: number; shares: number; saves: number;
}

export class FeedbackService {
  constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
  ) {}

  /**
   * Create/update a clip_feedback row with real metrics of the posted clip. The viral
   * score is velocity-based (normalized by hours on platform), so postedAt is
   * required. The scorer's feature vector is snapshotted on first submit so
   * the trainer can learn (features → actual score) without recomputing.
   */
  async submitPostMetrics(clipId: string, m: Metrics, postedAtIso: string): Promise<ClipFeedback> {
    const postedAt = ISO_INSTANT.test(postedAtIso) ? Date.parse(postedAtIso) : Number.NaN;
    if (Number.isNaN(postedAt)) {
      throw new ValidationError(`postedAt must be ISO-8601 (e.g. 2026-04-22T10:00:00Z); got: ${postedAtIso}`);
    }
    const nowMs = Date.now();
    if (postedAt > nowMs) throw new ValidationError(`postedAt is in the future: ${postedAtIso}`);
    const hoursSincePost = Math.max((nowMs - postedAt) / 3_600_000, 0.1);
    const ts = now();

    let fb = this.store.feedbackForClip(clipId);
    if (!fb) {
      const clip = this.store.getClip(clipId);
      if (!clip) throw new ValidationError(`Clip not found: ${clipId}`);
      fb = {
        id: crypto.randomUUID(), clipId, videoId: clip.videoId, features: this.serializeFeatures(clipId),
        predictedScore: clip.score ?? 0, predictedTier: clip.tier || "UNKNOWN",
        postViews: 0, postLikes: 0, postComments: 0, postShares: 0, postSaves: 0,
        actualViralScore: null, postedAt: null, lastChecked: null, createdAt: ts,
      };
    }
    Object.assign(fb, {
      postViews: m.views, postLikes: m.likes, postComments: m.comments,
      postShares: m.shares, postSaves: m.saves, postedAt: postedAtIso, lastChecked: ts,
    });

    fb.actualViralScore = viralScore(m.views, m.likes, m.comments, m.shares, m.saves, hoursSincePost);
    return this.store.saveFeedback(fb);
  }

  private serializeFeatures(clipId: string): string {
    const cs = this.store.clipScore(clipId);
    if (!cs) return "{}";
    return JSON.stringify(Object.fromEntries(FEATURE_ORDER.map((k) => [k, cs[k] ?? null])));
  }

  /** Re-weight the scorer from posted clips' real scores; learned weights go to data/weights.json. */
  async triggerTraining(): Promise<Json> {
    const rows = this.store.feedbackWithScores().map((fb) => {
      let features: Record<string, number> = {};
      try { features = JSON.parse(fb.features); } catch { /* keep {} */ }
      return { clipId: fb.clipId, features, predicted_score: fb.predictedScore, predicted_tier: fb.predictedTier,
        actual_viral_score: fb.actualViralScore };
    });
    // The same rows feed the optional LightGBM trainer: python train_scorer.py --feedback <this file>
    mkdirSync(`${this.config.dataDir}/feedback`, { recursive: true });
    await Bun.write(`${this.config.dataDir}/feedback/feedback_export.json`, JSON.stringify(rows));
    const records: FeedbackRecord[] = rows;
    const { result, updated } = trainWeights(records, readWeightsFile(this.config.dataDir, this.config.pipelineDir), { minSamples: 5 });
    if (updated) writeWeightsFile(this.config.dataDir, updated);
    return { ...result, version: result.version ?? 0 };
  }

  async getWeightsStatus() {
    const w = readWeightsFile(this.config.dataDir, this.config.pipelineDir);
    const counts = this.store.countFeedback();
    return {
      version: Math.trunc(Number(w.version) || 0),
      trained_on: Math.trunc(Number(w.trained_on) || 0),
      last_updated: typeof w.last_updated === "string" ? w.last_updated : "",
      total_feedback: counts.total,
      with_actual_scores: counts.withScores,
      weights: w.weights ?? {},
    };
  }
}
