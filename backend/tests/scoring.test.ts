// Golden test: the Bun scorer reproduces Python's score_segment() on real
// segments + transcripts with pinned media features (fixtures/scoring.json,
// written by ai-pipeline/tools/golden_scoring.py), except keyword matching:
// `keywordTrigger`, `finalScore` and `tier` come from the Bun rules since
// keywords match whole words (textRules.ts).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pyRound } from "../src/pyCompat";
import { CTA_PHRASES, DEFAULT_WEIGHTS } from "../src/ruleConstants";
import { determineTier, FEATURE_ORDER, loadWeights, scoreSegment, scoreSegments, type MediaFeatures, type SegmentIn } from "../src/scoring";
import golden from "./fixtures/scoring.json";

const ctxFor = (c: (typeof golden.cases)[number]) => ({
  weights: golden.weights as Record<string, number>, niche: null, transcript: c.transcript, history: [],
});

describe("matches Python score_segment on real videos", () => {
  test(`${golden.cases.length} videos / ${golden.cases.reduce((n, c) => n + c.expected.length, 0)} segments`, () => {
    const mismatches: unknown[] = [];
    for (const c of golden.cases) {
      for (const [i, seg] of (c.segments as SegmentIn[]).entries()) {
        // platform-neutral generic hashtag (the Python said #tiktokindonesia)
        const want = { ...c.expected[i]!, description: c.expected[i]!.description.replaceAll("#tiktokindonesia", "#indonesia") };
        const got = scoreSegment(seg, (c.media as unknown as Record<string, MediaFeatures>)[String(seg.index)], ctxFor(c));
        const sameDesc = got.description.split("\n").slice(0, -1).join("\n") === want.description.split("\n").slice(0, -1).join("\n")
          && CTA_PHRASES.includes(got.description.split("\n").at(-1)!);
        if (JSON.stringify(got.scores) !== JSON.stringify(want.scores) || got.finalScore !== want.finalScore
          || got.tier !== want.tier || got.title !== want.title || !sameDesc) {
          mismatches.push({ video: c.video, index: seg.index, got: [got.finalScore, got.tier, got.scores], want: [want.finalScore, want.tier, want.scores] });
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});

describe("scorer behaviour", () => {
  const seg = (index: number, text: string): SegmentIn => ({ index, startTime: index * 30, endTime: index * 30 + 25, duration: 25, text });

  test("sorts best first, ranks, neutral media when unmeasured, supervised override", () => {
    const ctx = { weights: { ...DEFAULT_WEIGHTS }, niche: ["rahasia"], transcript: null, history: [] };
    const out = scoreSegments([seg(0, "Hari ini biasa."), seg(1, "Kenapa rahasia ini penting? Ternyata gila!")], new Map(), ctx);
    expect(out.map((s) => [s.index, s.rank])).toEqual([[1, 1], [0, 2]]);
    expect(out[0]!.scores.facePresence).toBe(0.5);
    expect(out[0]!.scores.topicFit).toBe(1.0);
    const sup = scoreSegment(seg(0, "Hari ini biasa."), undefined, { ...ctx, supervised: new Map([[0, 0.99]]) });
    expect(sup.finalScore).toBe(pyRound(Math.min(0.99 + sup.scores.boostTotal! - sup.scores.penaltyTotal!, 1), 4));
    expect(sup.tier).toBe(determineTier(sup.finalScore));
    expect(Object.keys(out[0]!.scores).slice(0, 13)).toEqual([...FEATURE_ORDER]);
  });

  test("the final score is capped at 1", () => {
    const hot = { rmsRatio: 2, onsetDensity: 1, facePresence: 1, sceneChange: 1, motion: 1 };
    const s = scoreSegment(seg(0, "Rahasia penting! Kenapa? Tapi ternyata! Wow kaget! Pertama kedua ketiga!"), hot,
      { weights: { ...DEFAULT_WEIGHTS }, niche: ["rahasia", "penting"], transcript: null, history: [] });
    expect(s.finalScore).toBe(1);
  });

  test("tiers and weights.json loading", () => {
    expect([0.8, 0.79, 0.65, 0.64].map(determineTier)).toEqual(["PRIMARY", "BACKUP", "BACKUP", "SKIP"]);
    const dir = mkdtempSync(join(tmpdir(), "w-"));
    expect(loadWeights(dir)).toEqual(DEFAULT_WEIGHTS);
    writeFileSync(join(dir, "weights.json"), JSON.stringify({ weights: { hookStrength: 0.5, extra: 0.1 } }));
    expect(loadWeights(dir)).toMatchObject({ hookStrength: 0.5, extra: 0.1, novelty: DEFAULT_WEIGHTS.novelty });
    writeFileSync(join(dir, "weights.json"), "{broken");
    expect(loadWeights(dir)).toEqual(DEFAULT_WEIGHTS);
    writeFileSync(join(dir, "weights.json"), "{}");
    expect(loadWeights(dir)).toEqual(DEFAULT_WEIGHTS);
    // learned weights (data dir) win; a broken learned file falls back to the shipped one
    const data = mkdtempSync(join(tmpdir(), "d-"));
    writeFileSync(join(dir, "weights.json"), JSON.stringify({ weights: { hookStrength: 0.3 } }));
    expect(loadWeights(dir, data).hookStrength).toBe(0.3);
    writeFileSync(join(data, "weights.json"), JSON.stringify({ weights: { hookStrength: 0.4 } }));
    expect(loadWeights(dir, data).hookStrength).toBe(0.4);
    writeFileSync(join(data, "weights.json"), "{broken");
    expect(loadWeights(dir, data).hookStrength).toBe(0.3);
  });
});
