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
   * Create/update a clip_feedback row with real TikTok metrics. The viral
   * score is velocity-based (normalized by hours on platform), so postedAt is
   * required. The scorer's feature vector is snapshotted on first submit so
   * the trainer can learn (features → actual score) without recomputing.
   */
  async submitTikTokMetrics(clipId: string, m: Metrics, postedAtIso: string): Promise<ClipFeedback> {
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
        tiktokViews: 0, tiktokLikes: 0, tiktokComments: 0, tiktokShares: 0, tiktokSaves: 0,
        actualViralScore: null, postedAt: null, lastChecked: null, createdAt: ts,
      };
    }
    Object.assign(fb, {
      tiktokViews: m.views, tiktokLikes: m.likes, tiktokComments: m.comments,
      tiktokShares: m.shares, tiktokSaves: m.saves, postedAt: postedAtIso, lastChecked: ts,
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
    const records: FeedbackRecord[] = this.store.feedbackWithScores().map((fb) => {
      let features: Record<string, number> = {};
      try { features = JSON.parse(fb.features); } catch { /* keep {} */ }
      return { features, actual_viral_score: fb.actualViralScore };
    });
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
