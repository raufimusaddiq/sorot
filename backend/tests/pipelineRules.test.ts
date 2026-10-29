// Golden tests for the Bun port of segment.py, analytics.py, feedback.py and
// learn_weights.py: real transcripts and scored segments from data/, run
// through the Python originals (fixtures/pipeline-rules.json).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pearson, trainWeights, viralScore, type WeightsFile } from "../src/learning";
import { DEFAULT_WEIGHTS } from "../src/ruleConstants";
import { FEATURE_ORDER } from "../src/scoring";
import { analyticsReport, findSegments, type ScoredSummary } from "../src/segments";

const fx = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "pipeline-rules.json"), "utf-8"));

describe("matches the Python on real data", () => {
  test("segments from every transcript", () => {
    for (const c of fx.segmentCases) expect(findSegments(fx.transcripts[c.transcript], c.min, c.max)).toEqual(c.segments);
    expect(findSegments(fx.transcripts[0])).toEqual(fx.segmentCases[0].segments);   // defaults 10-60 s
  });

  test("analytics reports", () => {
    for (const c of fx.analytics) {
      const r = analyticsReport("v", c.segments as ScoredSummary[]);
      // platform-neutral wording (the Python said "TikTok"); PRIMARY is 0.78 since whole-word keywords
      const recs = c.report.recommendations.map((x: string) => x.replace("better TikTok performance", "better short-form performance")
        .replace("threshold from 0.80", "threshold from 0.78"));
      expect(r).toEqual({ videoId: "v", totalSegments: c.segments.length, ...c.report, recommendations: recs });
    }
    expect(analyticsReport("v", [{}]).tierDistribution).toEqual({ PRIMARY: 0, BACKUP: 0, SKIP: 1 });
    expect(analyticsReport("v", [{ duration: 70, finalScore: 0.9, tier: "PRIMARY" }]).recommendations)
      .toEqual(["Clips are long on average. Consider shorter segments for better short-form performance."]);
  });

  test("viral score and correlation", () => {
    for (const c of fx.viral) expect(viralScore(c.args[0], c.args[1], c.args[2], c.args[3], c.args[4], c.hours)).toBe(c.score);
    expect(viralScore(10, 0, 0, 0, 0)).toBe(viralScore(10, 0, 0, 0, 0, 1));
    for (const c of fx.pearson) expect(pearson(c.x, c.y)).toBeCloseTo(c.r, 12);
  });
});

describe("trainWeights", () => {
  const current: WeightsFile = { version: 3, trained_on: 0, last_updated: "", weights: { ...DEFAULT_WEIGHTS }, thresholds: { PRIMARY: 0.8 } };
  const rec = (hook: number, y: number | null) => ({ features: { ...Object.fromEntries(FEATURE_ORDER.map((k) => [k, 0.5])), hookStrength: hook },
    actual_viral_score: y });

  test("needs enough labelled rows", () => {
    const { result, updated } = trainWeights([rec(1, 0.9), rec(0, null)], current);
    expect(result).toEqual({ status: "insufficient_data", trained_on: 0, message: "Need at least 5 records with actual scores, got 1" });
    expect(updated).toBeUndefined();
  });

  test("correlated features gain weight; flat ones floor at 0.05; weights stay normalised", () => {
    const rows = [0, 0.2, 0.4, 0.6, 0.8, 1].map((h) => rec(h, h * 0.8 + 0.1));
    const { result, updated } = trainWeights(rows, current, { now: new Date("2026-10-27T12:00:00.123Z") });
    expect(updated).toMatchObject({ version: 4, trained_on: 6, last_updated: "2026-10-27T12:00:00Z", thresholds: { PRIMARY: 0.8 } });
    const w = result.new_weights!;
    expect(Object.keys(w)).toEqual([...FEATURE_ORDER]);
    expect(Object.values(w).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 3);
    expect(w.hookStrength).toBeGreaterThan(DEFAULT_WEIGHTS.hookStrength);
    expect(w.novelty).toBeLessThan(DEFAULT_WEIGHTS.novelty);
    expect(result.weight_changes!.hookStrength).toEqual({ from: DEFAULT_WEIGHTS.hookStrength, to: w.hookStrength });
  });

  test("JSON-string features, broken rows, features with too few samples, empty weights", () => {
    const rows = [0, 0.25, 0.5, 0.75, 1].map((h) => ({ features: JSON.stringify({ hookStrength: h }), actual_viral_score: h }));
    rows.push({ features: "not json", actual_viral_score: 0.3 });
    const { result } = trainWeights(rows, { ...current, weights: {} });
    // only hookStrength has 5 samples; the rest keep the 0.1 fallback
    expect(result.trained_on).toBe(6);
    expect(result.new_weights!.hookStrength).toBeGreaterThan(result.new_weights!.novelty!);
    const zero = trainWeights(rows, { ...current, weights: Object.fromEntries(FEATURE_ORDER.map((k) => [k, 0])) });
    expect(Object.values(zero.result.new_weights!).every(Number.isFinite)).toBeTrue();
  });
});
