import { mkdirSync } from "node:fs";
import type { AppConfig } from "./config";
import type { ScriptRunner } from "./runner";
import { now, type Store } from "./store";
import type { ClipFeedback, Json } from "./types";

export class ValidationError extends Error {}

const FEATURE_KEYS = [
  "hookStrength", "keywordTrigger", "novelty", "clarity", "emotionalEnergy", "textSentiment",
  "pauseStructure", "facePresence", "sceneChange", "topicFit", "historyScore",
] as const;

// ISO-8601 instant with an explicit zone (Z or ±hh:mm), as Instant.parse accepted.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

const numMap = (v: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v as Json)) out[k] = typeof x === "number" ? x : 0;
  }
  return out;
};

export interface Metrics {
  views: number; likes: number; comments: number; shares: number; saves: number;
}

export class FeedbackService {
  constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
    private readonly runScript: ScriptRunner,
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

    try {
      const result = await this.runScript("feedback.py", [
        "--action", "calc-viral-score",
        "--views", String(m.views), "--likes", String(m.likes), "--comments", String(m.comments),
        "--shares", String(m.shares), "--saves", String(m.saves),
        "--hours-since-post", String(hoursSincePost),
      ]);
      fb.actualViralScore = typeof result.viralScore === "number" ? result.viralScore : 0;
    } catch (e) {
      console.warn(`Failed to calculate viral score: ${(e as Error).message}`);
    }
    return this.store.saveFeedback(fb);
  }

  private serializeFeatures(clipId: string): string {
    const cs = this.store.clipScore(clipId);
    if (!cs) return "{}";
    return JSON.stringify(Object.fromEntries(FEATURE_KEYS.map((k) => [k, cs[k]])));
  }

  async triggerTraining() {
    const dir = `${this.config.dataDir}/feedback`;
    mkdirSync(dir, { recursive: true });
    const file = `${dir}/feedback_export.json`;
    const rows = this.store.feedbackWithScores().map((fb) => {
      let features: unknown = {};
      try { features = JSON.parse(fb.features); } catch { /* keep {} */ }
      return {
        clipId: fb.clipId, features, predicted_score: fb.predictedScore,
        predicted_tier: fb.predictedTier, actual_viral_score: fb.actualViralScore, text: "",
      };
    });
    await Bun.write(file, JSON.stringify(rows));

    const r = await this.runScript("learn_weights.py", [
      "--action", "train", "--feedback", file, "--min-samples", "5",
    ]);
    const out: Json = {
      status: typeof r.status === "string" ? r.status : "",
      version: Math.trunc(Number(r.version) || 0),
      trained_on: Math.trunc(Number(r.trained_on) || 0),
    };
    if (r.weight_changes && typeof r.weight_changes === "object") {
      out.weight_changes = Object.fromEntries(
        Object.entries(r.weight_changes as Json).map(([k, v]) => {
          const c = numMap(v);
          return [k, { from: c.from ?? 0, to: c.to ?? 0 }];
        }),
      );
    }
    if (r.new_weights) out.new_weights = numMap(r.new_weights);
    if (typeof r.message === "string") out.message = r.message;
    return out;
  }

  async getWeightsStatus() {
    const r = await this.runScript("learn_weights.py", ["--action", "status"]);
    const counts = this.store.countFeedback();
    return {
      version: Math.trunc(Number(r.version) || 0),
      trained_on: Math.trunc(Number(r.trained_on) || 0),
      last_updated: typeof r.last_updated === "string" ? r.last_updated : "",
      total_feedback: counts.total,
      with_actual_scores: counts.withScores,
      weights: numMap(r.weights),
    };
  }
}
