import { describe, expect, test } from "bun:test";
import type { Line } from "../src/director";
import {
  hookAndTitle, JEV_PICKS, jevReason, jevScore, judgeClips, JUDGE_MAX, quoteTitle, screenMoments, sentenceWindows,
  titleCandidates, type Judgeable, type Window,
} from "../src/jevDirector";
import { determineTier } from "../src/scoring";
import { fakeJev, noulA, unknownFields } from "./helpers";

const line = (start: number, end: number, text: string, words?: Line["words"]): Line => ({ start, end, text, ...(words ? { words } : {}) });
const win = (startTime: number, text: string): Window => ({ startTime, endTime: startTime + 30, duration: 30, text });

test("sentence windows start where a sentence starts, grow to 25 s then to a sentence end, 15-60 s", () => {
  const w = sentenceWindows([
    line(0, 8, "Kenapa harganya mahal?"), line(8.2, 16, "Karena chipnya biasa"), line(16.1, 27, "dan itu bikin kecewa."),
    line(28, 40, "Terus kita lihat kameranya."), line(40.2, 60, "Hasilnya lumayan bagus sih."), line(61, 70, "Oke."),
  ]);
  expect(w.map((x) => [x.startTime, x.endTime])).toEqual([[0, 27], [8.2, 40], [28, 60], [40.2, 70]]);   // none at 16.1: mid-sentence
  expect(w[0]!.text).toBe("Kenapa harganya mahal? Karena chipnya biasa dan itu bikin kecewa.");
  expect(sentenceWindows([line(0, 5, "Halo."), line(5, 9, "Oke.")])).toEqual([]);
  expect(sentenceWindows([line(0, 70, "Satu kalimat yang sangat panjang sekali.")])).toEqual([]);
});

test("score (quality, 50/50 with the direction fit), reason, title quotes", () => {
  const a = { hook_opening: 0.9, needs_prior_context: 0.1, ends_complete: 0.9, mostly_filler: 0.05, payoff: 1.8 };
  expect([jevScore(a), jevScore({ ...a, fits_direction: 0.1 })]).toEqual([0.905, 0.5025]);
  expect(jevReason({ ...a, payoff: 1.6, fits_direction: 0.9 })).toBe("Jev: strong opening, stands alone, complete ending, clear payoff, fits your direction");
  expect(jevReason({ hook_opening: 0.5 })).toBe("Jev: no standout signal");
  expect(titleCandidates("Halo. Kenapa harga HP ini mahal banget? Jadi gini ceritanya ya teman-teman."))
    .toEqual(["Kenapa harga HP ini mahal banget?", "Jadi gini ceritanya ya teman-teman."]);
  expect(quoteTitle("Kenapa harga HP ini mahal banget?", "rahasia harga", "PRIMARY")).toStartWith("Kenapa harga HP ini mahal banget? #");
  expect(quoteTitle("x".repeat(95), "", "SKIP")).toStartWith(`${"x".repeat(77)}...`);
});

describe("screenMoments", () => {
  test("judges every window; drops FAILs and overlaps, best first; direction asked only when given", async () => {
    const { jev, requests } = fakeJev();
    const progress: string[] = [];
    const windows = [win(0, "Soal harga yang bikin kaget."), win(10, "Masih soal harga."), win(50, "Bagian lemah."), win(90, "Unboxing kotak.")];
    const r = await screenMoments(jev, windows, "fokus harga", (d, t) => progress.push(`${d}/${t}`));
    expect([r.judged, r.tokens, r.error, progress.at(-1)]).toEqual([4, 40, null, "4/4"]);
    expect(r.picks.map((p) => [p.startTime, p.source])).toEqual([[0, "jev"], [90, "jev"]]);   // 10 overlaps 0; 50 FAILs
    expect(r.picks[0]!.jevScore).toBeGreaterThan(r.picks[1]!.jevScore);
    expect(requests[0]!.state.direction).toBe("fokus harga");
    expect(Object.keys(requests[0]!.questions)).toEqual(expect.arrayContaining(["fits_direction", "payoff"]));
    expect(requests[0]!.questions).not.toHaveProperty("risk_sara");   // risks wait for the final candidates
    const plain = fakeJev();
    await screenMoments(plain.jev, windows.slice(0, 1), "");
    expect(plain.requests[0]!.questions).not.toHaveProperty("fits_direction");
  });

  test("keeps at most JEV_PICKS; stops asking after failures; bugs propagate", async () => {
    const many = Array.from({ length: JEV_PICKS + 5 }, (_, i) => win(i * 100, "harga"));
    expect((await screenMoments(fakeJev().jev, many, "")).picks).toHaveLength(JEV_PICKS);
    const down = fakeJev(() => new Error("overloaded"));
    expect(await screenMoments(down.jev, many, "")).toMatchObject({ picks: [], judged: 0, error: expect.stringMatching(/^Jev HTTP 500/) });
    expect(down.requests.length).toBeLessThan(many.length);
    const bug = fakeJev().jev;
    bug.decide = async () => { throw new TypeError("bug"); };
    await expect(screenMoments(bug, many, "")).rejects.toBeInstanceOf(TypeError);
  });
});

describe("judgeClips", () => {
  const clip = (text: string, finalScore: number, extra: Partial<Judgeable> = {}): Judgeable =>
    ({ text, finalScore, tier: determineTier(finalScore), scoredBy: "rules", reason: "Rule score", ...extra });

  test("50/50 with the rules; the same answers give the verdict; FAIL is held back", async () => {
    const segs = [clip("Soal harga yang jelas.", 0.6), clip("Bagian lemah.", 0.85)];
    expect(await judgeClips(fakeJev().jev, segs, "harga", determineTier)).toEqual({ error: null, judged: 2 });
    expect(segs[0]).toMatchObject({ scoredBy: "jev+rules", ruleScore: 0.6, gate: { verdict: "PASS", by: "jev", model: "jev-1.14.0" } });
    expect(segs[0]!.finalScore).toBeCloseTo(0.5 * segs[0]!.jevScore! + 0.3, 4);
    expect(segs[0]!.reason).toContain("fits your direction");
    expect(segs[1]).toMatchObject({ tier: "SKIP", reason: expect.stringMatching(/^Held back: mostly greetings/) });
  });

  test("Jev down: rule scores, and the rules' verdict for render tiers only", async () => {
    const segs = [clip("Kenapa ini penting? Ini jawabannya.", 0.9), clip("Terus dia pergi.", 0.85), clip("rendah", 0.3)];
    expect((await judgeClips(fakeJev(() => new Error("down")).jev, segs, "", determineTier)).error).toStartWith("Jev HTTP 500");
    expect(segs.map((s) => [s.scoredBy, s.tier, s.gate?.verdict])).toEqual([["rules", "PRIMARY", "PASS"], ["rules", "SKIP", "FAIL"], ["rules", "SKIP", undefined]]);
  });

  test("asks only the best JUDGE_MAX by rule score, plus every Jev pick", async () => {
    const { jev, requests } = fakeJev();
    const segs = Array.from({ length: JUDGE_MAX + 3 }, (_, i) => clip(`klip ${i}`, 0.5 - i / 10_000));
    segs.at(-1)!.source = "jev";
    await judgeClips(jev, segs, "", determineTier);
    expect([requests.length, segs.at(-1)!.scoredBy, segs.at(-2)!.scoredBy]).toEqual([JUDGE_MAX + 1, "jev+rules", "rules"]);
  });
});

describe("hookAndTitle: a teaser is measured against the clip's own opening", () => {
  const lines = [
    line(100, 102, "Halo semua."),
    line(103, 106, "Pakai kode SOROT buat diskon!"),
    line(106, 109, "Kok berani jualan seri Note di harga flagship?",
      [{ text: "Kok", start: 106, end: 106.5 }, { text: "berani", start: 106.6, end: 107.2 }, { text: "flagship?", start: 107.3, end: 108.4 }]),
    line(109, 112, "Ya begitulah."),
  ];
  const text = "Halo semua. Pakai kode SOROT buat diskon! Kok berani jualan seri Note di harga flagship? Ya begitulah kira-kira ceritanya.";
  /** Hook probability per line index (`hook_<i>`); line 1 is an ad. */
  const ask = (hooks: number[]) => fakeJev((_, id) => {
    if (id === "title") return { type: "choice", choice: "S1", confidence: 0.6, probabilities: { S1: 0.6 } };
    if (id.startsWith("ad_")) return noulA(id === "ad_1" ? 0.95 : 0.05);
    return noulA(hooks[Number(id.slice(5))]!);
  });

  test("weak opening: the best non-ad line better than even is replayed; the title is a quote; every field resolves", async () => {
    const { jev, requests } = ask([0.2, 0.95, 0.6, 0.3]);
    expect(await hookAndTitle(jev, lines, 100, text)).toEqual({ hook: [106, 108.4], title: "Kok berani jualan seri Note di harga flagship?" });
    const req = requests[0]!;
    expect(unknownFields(req)).toEqual([]);
    expect(req.state.context.fields).toHaveProperty("lines");
    expect(Object.keys(req.questions).filter((q) => q.startsWith("ad_"))).toEqual(["ad_1", "ad_2", "ad_3"]);   // opening seconds aren't replayed
    expect(req.questions.title.criteria.S1).toBe("Kok berani jualan seri Note di harga flagship?");
  });

  test.each([
    [[0.75, 0.1, 0.9, 0.1], null],          // the opening already hooks: no replay
    [[0.5, 0.1, 0.6, 0.1], null],           // middling opening, no strong line
    [[0.5, 0.1, 0.75, 0.1], [106, 108.4]],  // middling opening, a strong line
    [[0.2, 0.1, 0.4, 0.1], null],           // weak opening, nothing better than even
  ])("hooks %o → %o", async (hooks, hook) => {
    expect((await hookAndTitle(ask(hooks).jev, lines, 100, text)).hook).toEqual(hook as never);
  });

  test("nothing to ask: no call; under two sentences: the only quote or none", async () => {
    const idle = fakeJev();
    expect(await hookAndTitle(idle.jev, [line(0, 2, "Hai.")], 0, "Satu kalimat yang cukup panjang.")).toEqual({ title: "Satu kalimat yang cukup panjang." });
    expect(idle.requests).toHaveLength(0);
    expect((await hookAndTitle(ask([0.2, 0.1, 0.9, 0.1]).jev, lines, 100, "Pendek.")).title).toBeNull();
  });
});
