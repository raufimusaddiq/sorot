import { describe, expect, test } from "bun:test";
import type { Line } from "../src/director";
import { Jev } from "../src/jev";
import {
  hookAndTitle, JEV_PICKS, jevReason, jevScore, judgeClips, JUDGE_MAX, quoteTitle, screenMoments, sentenceWindows,
  titleCandidates, type Judgeable, type Window,
} from "../src/jevDirector";
import { determineTier } from "../src/scoring";

const ON = { jevUrl: "http://jev/v1/systemone", jevModel: "jev-1.14.0", jevApiKey: "k", jevTimeoutSec: 5 };
type Q = Record<string, { type: string }>;

/** A Jev whose answers come from `answer(state, questionId)`; records every request. */
function fakeJev(answer: (state: Record<string, unknown>, id: string, q: { type: string; criteria?: unknown }) => unknown) {
  const requests: Array<{ state: Record<string, unknown>; questions: Q }> = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const { state, questions } = JSON.parse(String(init.body));
    requests.push({ state, questions });
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(questions as Record<string, { type: string }>)) {
      const v = answer(state, id, q);
      if (v instanceof Error) return new Response(v.message, { status: 500 });
      answers[id] = v;
    }
    return Response.json({ model: "jev-1.14.0", answers, usage: { input_tokens: 100, output_tokens: 5 } });
  }) as unknown as typeof fetch;
  return { jev: new Jev(ON, fetchFn, 0), requests };
}

const noul = (p: number) => ({ type: "noul", noul: p });
const score = (s: number, confidence = 0.9) => ({ type: "score", score: s, confidence });

/** Good answers unless the excerpt has "lemah" (weak) in it. */
const quality = (text: string, id: string) => {
  const weak = text.includes("lemah");
  if (id === "payoff") return score(weak ? 0.2 : 1.9);
  if (id === "hook_opening" || id === "ends_complete") return noul(weak ? 0.1 : 0.9);
  if (id === "fits_direction") return noul(text.includes("harga") ? 0.95 : 0.05);
  return noul(id === "mostly_filler" && weak ? 0.9 : 0.05);
};

const line = (start: number, end: number, text: string, words?: Line["words"]): Line => ({ start, end, text, ...(words ? { words } : {}) });

describe("sentence windows", () => {
  test("start only where a sentence starts, grow to 25 s then to a sentence end, 15-60 s", () => {
    const ls = [
      line(0, 8, "Kenapa harganya mahal?"), line(8.2, 16, "Karena chipnya biasa"), line(16.1, 27, "dan itu bikin kecewa."),
      line(28, 40, "Terus kita lihat kameranya."), line(40.2, 60, "Hasilnya lumayan bagus sih."), line(61, 70, "Oke."),
    ];
    const w = sentenceWindows(ls);
    expect(w.map((x) => [x.startTime, x.endTime])).toEqual([[0, 27], [8.2, 40], [28, 60], [40.2, 70]]);
    expect(w[0]!.text).toBe("Kenapa harganya mahal? Karena chipnya biasa dan itu bikin kecewa.");
    // "dan itu…" follows an unfinished line with no pause: not a start (no window at 16.1).
    expect(sentenceWindows([line(0, 5, "Halo."), line(5, 9, "Oke.")])).toEqual([]);
    expect(sentenceWindows([line(0, 70, "Satu kalimat yang sangat panjang sekali.")])).toEqual([]);
  });
});

describe("scores, reasons, titles", () => {
  test("Jev score: quality, or 50/50 with the direction fit", () => {
    const a = { hook_opening: 0.9, needs_prior_context: 0.1, ends_complete: 0.9, mostly_filler: 0.05, payoff: 1.8 };
    expect(jevScore(a)).toBe(0.905);
    expect(jevScore({ ...a, fits_direction: 0.1 })).toBe(0.5025);
  });

  test("reasons name the signals that fired", () => {
    expect(jevReason({ hook_opening: 0.9, needs_prior_context: 0.1, ends_complete: 0.8, payoff: 1.6, fits_direction: 0.9 }))
      .toBe("Jev: strong opening, stands alone, complete ending, clear payoff, fits your direction");
    expect(jevReason({ hook_opening: 0.5 })).toBe("Jev: no standout signal");
  });

  test("title candidates and the quote title", () => {
    expect(titleCandidates("Halo. Kenapa harga HP ini mahal banget? Jadi gini ceritanya ya teman-teman.")).toEqual([
      "Kenapa harga HP ini mahal banget?", "Jadi gini ceritanya ya teman-teman."]);
    expect(quoteTitle("Kenapa harga HP ini mahal banget?", "rahasia harga", "PRIMARY")).toStartWith("Kenapa harga HP ini mahal banget? #");
    expect(quoteTitle("x".repeat(95), "", "SKIP")).toStartWith(`${"x".repeat(77)}...`);
  });
});

describe("screenMoments", () => {
  const windows: Window[] = [
    { startTime: 0, endTime: 30, duration: 30, text: "Soal harga yang bikin kaget." },
    { startTime: 10, endTime: 40, duration: 30, text: "Masih soal harga, overlap." },
    { startTime: 50, endTime: 80, duration: 30, text: "Bagian lemah tanpa isi." },
    { startTime: 90, endTime: 120, duration: 30, text: "Unboxing kotak." },
  ];

  test("judges every window, drops FAILs and overlaps, best first; direction asked only when given", async () => {
    const { jev, requests } = fakeJev((state, id) => quality(String(state.excerpt), id));
    const progress: string[] = [];
    const r = await screenMoments(jev, windows, "fokus harga", (d, t) => progress.push(`${d}/${t}`));
    expect(r).toMatchObject({ judged: 4, tokens: 400, error: null });
    expect(r.picks.map((p) => p.startTime)).toEqual([0, 90]);       // 10-40 overlaps 0-30; the weak one FAILs
    // (Not toMatchObject with expect.any here: in Bun 1.4.4 it overwrote the matched property.)
    expect(r.picks.map((p) => p.source)).toEqual(["jev", "jev"]);
    expect(r.picks[0]!.jevScore).toBeGreaterThan(r.picks[1]!.jevScore);
    expect(requests[0]!.state.direction).toBe("fokus harga");
    expect(Object.keys(requests[0]!.questions)).toContain("fits_direction");
    expect(Object.keys(requests[0]!.questions)).not.toContain("risk_sara");   // risks wait for the final candidates
    expect(progress.at(-1)).toBe("4/4");
    const plain = fakeJev((state, id) => quality(String(state.excerpt), id));
    await screenMoments(plain.jev, windows.slice(0, 1), "");
    expect(plain.requests[0]!.state).not.toHaveProperty("direction");
    expect(Object.keys(plain.requests[0]!.questions)).not.toContain("fits_direction");
  });

  test("keeps at most JEV_PICKS; failures are skipped, then Jev is no longer asked", async () => {
    const many = Array.from({ length: JEV_PICKS + 5 }, (_, i): Window => ({ startTime: i * 100, endTime: i * 100 + 30, duration: 30, text: "harga" }));
    expect((await screenMoments(fakeJev((s, id) => quality(String(s.excerpt), id)).jev, many, "")).picks).toHaveLength(JEV_PICKS);
    const down = fakeJev(() => new Error("overloaded"));
    const r = await screenMoments(down.jev, many, "");
    expect(r).toMatchObject({ picks: [], judged: 0 });
    expect(r.error).toStartWith("Jev HTTP 500");
    expect(down.requests.length).toBeLessThan(many.length);
    const bug = new Jev(ON, (async () => { throw new TypeError("x"); }) as unknown as typeof fetch, 0);
    bug.decide = async () => { throw new TypeError("bug"); };
    await expect(screenMoments(bug, many, "")).rejects.toBeInstanceOf(TypeError);
  });
});

describe("judgeClips", () => {
  const clip = (text: string, finalScore: number, extra: Partial<Judgeable> = {}): Judgeable =>
    ({ text, finalScore, tier: determineTier(finalScore), scoredBy: "rules", reason: "Rule score", ...extra });

  test("50/50 with the rules; the same answers give the verdict; FAIL is held back", async () => {
    const { jev, requests } = fakeJev((state, id) => quality(String(state.excerpt), id));
    const segs = [clip("Soal harga yang jelas.", 0.6), clip("Bagian lemah.", 0.85), clip("Unboxing kotak.", 0.4)];
    const r = await judgeClips(jev, segs, "harga", determineTier);
    expect(r).toEqual({ error: null, judged: 3 });
    expect(segs[0]).toMatchObject({ scoredBy: "jev+rules", ruleScore: 0.6 });
    expect(segs[0]!.reason).toContain("fits your direction");
    expect(segs[0]!.finalScore).toBeCloseTo(0.5 * segs[0]!.jevScore! + 0.3, 4);
    expect(segs[0]!.gate).toMatchObject({ verdict: "PASS", by: "jev", model: "jev-1.14.0" });
    expect(segs[1]).toMatchObject({ tier: "SKIP" });
    expect(segs[1]!.reason).toStartWith("Held back: mostly greetings, promos or small talk.");
    expect(Object.keys(requests[0]!.questions)).toEqual(expect.arrayContaining(["risk_sara", "fits_direction", "payoff"]));
  });

  test("Jev failures keep the rule score; only render tiers get the rules' verdict", async () => {
    const down = fakeJev(() => new Error("down"));
    const segs = [clip("Kenapa ini penting? Ini jawabannya.", 0.9), clip("Terus dia pergi.", 0.85), clip("rendah", 0.3)];
    const r = await judgeClips(down.jev, segs, "", determineTier);
    expect(r.error).toStartWith("Jev HTTP 500");
    expect(segs[0]).toMatchObject({ scoredBy: "rules", finalScore: 0.9, gate: { by: "rules", verdict: "PASS" } });
    expect(segs[1]).toMatchObject({ tier: "SKIP", gate: { by: "rules", verdict: "FAIL" } });
    expect(segs[2]!.gate).toBeUndefined();
  });

  test("asks only the best JUDGE_MAX by rule score, plus every Jev pick", async () => {
    const { jev, requests } = fakeJev((state, id) => quality(String(state.excerpt), id));
    const segs = Array.from({ length: JUDGE_MAX + 3 }, (_, i) => clip(`klip ${i}`, 0.5 - i / 10_000));
    segs.at(-1)!.source = "jev";
    await judgeClips(jev, segs, "", determineTier);
    expect(requests).toHaveLength(JUDGE_MAX + 1);
    expect(segs.at(-1)!.scoredBy).toBe("jev+rules");
    expect(segs.at(-2)!.scoredBy).toBe("rules");
  });
});

describe("hookAndTitle", () => {
  const lines = [
    line(100, 102, "Halo semua."),
    line(103, 106, "Dapatkan bonus kuota 600GB!", [{ text: "Dapatkan", start: 103, end: 104 }, { text: "bonus", start: 104, end: 106 }]),
    line(106, 109, "Kok berani jualan seri Note di harga flagship?",
      [{ text: "Kok", start: 106, end: 106.5 }, { text: "berani", start: 106.6, end: 107.2 }, { text: "flagship?", start: 107.3, end: 108.4 }]),
    line(109, 112, "Ya begitulah."),
  ];
  const text = "Halo semua. Dapatkan bonus kuota 600GB! Kok berani jualan seri Note di harga flagship? Ya begitulah kira-kira ceritanya.";

  test("the best non-ad line after the opening seconds, and a quoted title", async () => {
    const { jev, requests } = fakeJev((state, id) => {
      if (id === "title") return { type: "choice", choice: "S1", confidence: 0.6, probabilities: { S0: 0.3, S1: 0.7 } };
      if (id === "ad_1") return noul(0.95);
      return noul(id === "hook_1" ? 0.95 : id === "hook_2" ? 0.85 : 0.2);
    });
    const r = await hookAndTitle(jev, lines, 100, text);
    expect(r.hook).toEqual([106, 108.4]);      // the ad scored higher but is excluded; the opening line isn't asked
    expect(r.title).toBe("Kok berani jualan seri Note di harga flagship?");
    const q = Object.keys(requests[0]!.questions);
    expect(q).not.toContain("hook_0");
    expect(q).toEqual(expect.arrayContaining(["hook_1", "ad_1", "hook_2", "ad_2", "hook_3", "title"]));
  });

  test("no line good enough: no hook; nothing to ask: no call", async () => {
    const { jev } = fakeJev((_, id) => (id === "title" ? { type: "choice", choice: "S0", confidence: 1, probabilities: { S0: 1 } } : noul(0.4)));
    expect((await hookAndTitle(jev, lines, 100, text)).hook).toBeNull();
    const idle = fakeJev(() => noul(1));
    expect(await hookAndTitle(idle.jev, [line(0, 2, "Hai.")], 0, "Satu kalimat yang cukup panjang.")).toEqual({
      hook: null, title: "Satu kalimat yang cukup panjang." });
    expect(idle.requests).toHaveLength(0);
    const noTitle = fakeJev(() => noul(0.9));
    expect((await hookAndTitle(noTitle.jev, lines, 100, "Pendek.")).title).toBeNull();
  });
});
