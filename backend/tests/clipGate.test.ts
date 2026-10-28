import { describe, expect, test } from "bun:test";
import {
  fromDecision, gateClips, gateQuestions, gateState, GATE_MAX, heldLast, jevState, openingAndClosing, plainTitle,
  QUALITY_QUESTIONS, qualityOf, RISK_QUESTIONS, ruleAnswers, ruleGate, verdictFrom, type Gateable,
} from "../src/clipGate";
import { Jev } from "../src/jev";
import { DIRECTION_QUESTION } from "../src/jevDirector";
import { clipAnswer, fakeJev, JEV_ON, unknownFields } from "./helpers";

const STRONG = "Kenapa orang kaya nggak pernah nabung di bank? Ternyata mereka taruh uangnya di aset. Itu rahasia yang jarang dibahas.";

describe("the questions follow TypeSafe's design rules", () => {
  const all = { ...gateQuestions(true), ...DIRECTION_QUESTION };

  test("one literal question each, naming state fields that exist; no counting or timing", () => {
    expect(unknownFields({ state: gateState("a. b.", "t", "d"), questions: all })).toEqual([]);
    for (const q of Object.values(all)) {
      expect(q.instructions).toMatch(/`\w+`.*\?$/);
      expect(q.instructions.length).toBeLessThan(140);
      expect(q.instructions).not.toMatch(/how many|count|seconds|percent|longer than/i);
      if (q.type === "noul" && q.criteria) for (const side of [q.criteria.true, q.criteria.false]) expect(side.length).toBeGreaterThan(20);
    }
    for (const id of ["hook_opening", "needs_prior_context", "ends_complete", "mostly_filler"]) {
      expect((QUALITY_QUESTIONS[id] as { criteria?: unknown }).criteria).toBeDefined();
    }
  });

  test("score levels stand alone, lowest first; risks are separate Nouls; the title question only when asked", () => {
    const payoff = QUALITY_QUESTIONS.payoff as { criteria: string[] };
    expect(payoff.criteria[0]).toStartWith("Nothing");
    for (const level of payoff.criteria) expect(level).not.toMatch(/previous|than level|more than the/i);
    expect(Object.values(RISK_QUESTIONS).every((q) => q.type === "noul")).toBeTrue();
    expect(gateQuestions(false)).not.toHaveProperty("title_overclaims");
  });
});

describe("state", () => {
  test("every request carries the context, describing only the fields it sends", () => {
    const s = gateState(STRONG, "Judul #fyp", "fokus harga");
    expect(s.context.task).toContain("short vertical clips");
    expect(Object.keys(s.context.fields as object)).toEqual(["opening", "closing", "excerpt", "title", "direction"]);
    expect(s).toMatchObject({ title: "Judul", direction: "fokus harga" });
    expect(gateState(STRONG)).not.toHaveProperty("title");
    expect(gateState("x".repeat(5000)).excerpt.length).toBe(3000);
    expect(jevState({ lines: {}, other: 1 }).context.fields).toEqual({ lines: expect.stringContaining("teaser") });
    expect(plainTitle("Rahasia orang kaya #fyp #viral")).toBe("Rahasia orang kaya");
  });

  test("opening/closing: the first and last sentence or two; 25 words when unpunctuated", () => {
    expect(openingAndClosing(STRONG)).toEqual({
      opening: "Kenapa orang kaya nggak pernah nabung di bank? Ternyata mereka taruh uangnya di aset.",
      closing: "Ternyata mereka taruh uangnya di aset. Itu rahasia yang jarang dibahas.",
    });
    const long = "Kalimat pembuka yang cukup panjang untuk berdiri sendiri sebagai satu kalimat.";
    expect(openingAndClosing(`${long} Dua. Tiga.`).opening).toBe(long);
    const { opening, closing } = openingAndClosing(Array.from({ length: 60 }, (_, i) => `w${i}`).join(" "));
    expect([opening.split(" ").length, closing.split(" ")[24]]).toEqual([25, "w59"]);
  });
});

describe("verdict, decided in code", () => {
  const good = { hook_opening: 0.9, needs_prior_context: 0.1, ends_complete: 0.9, mostly_filler: 0.05, payoff: 1.8 };

  test.each([
    [{}, 0.8, "PASS", []],
    [{ mostly_filler: 0.75 }, 0, "FAIL", ["mostly greetings, promos or small talk"]],
    [{ needs_prior_context: 0.7 }, 0, "FAIL", ["needs earlier context to make sense"]],
    [{ hook_opening: 0.2, ends_complete: 0.3 }, 0, "FAIL", ["weak opening and a cut-off ending"]],
    [{ payoff: 0.4 }, 0.6, "FAIL", ["no clear payoff"]],
    [{ payoff: 0.4 }, 0.3, "PASS", []],                                  // an unsure payoff doesn't fail
    [{ risk_accusation: 0.55 }, 0, "REVIEW", ["may accuse a real person or company of wrongdoing"]],
    [{ mostly_filler: 0.9, risk_sara: 0.9 }, 0, "FAIL", ["mostly greetings, promos or small talk", "may insult a religion, ethnicity or group (SARA)"]],
    [{ hook_opening: 0.2 }, 0, "PASS", ["weak opening"]],
    [{ ends_complete: 0.1 }, 0, "PASS", ["ending is cut off"]],
  ])("%o (payoff confidence %d) → %s", (change, confidence, verdict, reasons) => {
    expect(verdictFrom({ ...good, ...change }, confidence)).toEqual({ verdict: verdict as never, reasons });
  });

  test("quality averages what is present; held-back clips rank last", () => {
    expect([qualityOf(good), qualityOf({ hook_opening: 0.5 }), qualityOf({})]).toEqual([0.905, 0.5, 0]);
    const clips = [{ id: "fail", finalScore: 0.9, gate: { verdict: "FAIL" } }, { id: "low", finalScore: 0.4 },
      { id: "review", finalScore: 0.6, gate: { verdict: "REVIEW" } }, { id: "pass", finalScore: 0.7, gate: { verdict: "PASS" } }];
    expect(clips.sort(heldLast).map((c) => c.id)).toEqual(["pass", "review", "low", "fail"]);
  });

  test("fromDecision keeps the payoff confidence for the verdict", () => {
    expect(fromDecision({ model: "jev-1.14.0", inputTokens: 1, answers: {
      hook_opening: { type: "noul", noul: 0.8 }, payoff: { type: "score", score: 0.3, confidence: 0.9, probabilities: {} },
      other: { type: "choice", choice: "a", confidence: 1, probabilities: {} },
    } })).toMatchObject({ verdict: "FAIL", reasons: ["no clear payoff"], answers: { hook_opening: 0.8, payoff: 0.3 } });
  });
});

describe("deterministic fallback (rules)", () => {
  test.each([
    ["Tapi itu nggak bener. Dia bilang begitu.", "needs_prior_context", 0.8],
    ["Dia orangnya baik banget. Semua suka.", "needs_prior_context", 0.6],
    ["Kayak tadi aku bilang, ini penting.", "needs_prior_context", 0.6],
    [STRONG, "needs_prior_context", 0.2],
    ["Ini penting. Karena kalau", "ends_complete", 0.15],
    ["Ini penting. Jadi intinya,", "ends_complete", 0.15],
    ["Yang harus kamu lakukan adalah", "ends_complete", 0.15],
    ["Ini penting. Selesai.", "ends_complete", 0.8],
    ["ini penting banget sih", "ends_complete", 0.5],
    ["Ini penting. Kenapa?", "ends_complete", 0.3],
    ["Halo semua! Jangan lupa subscribe ya. Terima kasih sponsor kita. Oke lanjut.", "mostly_filler", 0.8],
    ["Halo semua. Makasih ya. Hari ini kita bahas uang. Dan rumah.", "mostly_filler", 0.5],
    ["Halo semua. Hari ini kita bahas. Soal uang. Dan rumah.", "mostly_filler", 0.1],
    ["", "mostly_filler", 0.1],
    ["Halo semua. Kenapa ini penting?", "hook_opening", 0.1],
    ["Minum ini dijamin diabetes kamu sembuh.", "risk_health_money", 0.6],
    ["Orang dari suku itu memang semuanya pelit.", "risk_sara", 0.6],
    ["Suku Jawa punya banyak tradisi.", "risk_sara", 0.05],
  ])("%s → %s %d", (text, id, value) => expect(ruleAnswers(text)[id]).toBe(value));

  test("same verdict code: PASS, FAIL, REVIEW; no payoff answer", () => {
    expect(ruleGate(STRONG)).toMatchObject({ verdict: "PASS", by: "rules", model: null });
    expect(ruleGate(STRONG).answers.payoff).toBeUndefined();
    expect(ruleGate("Terus dia pergi ke pasar. Ternyata tutup.").verdict).toBe("FAIL");
    expect(ruleGate("Kenapa dia bisa jadi tersangka korupsi? Itu yang mau aku bongkar.").verdict).toBe("REVIEW");
  });
});

describe("gateClips", () => {
  const seg = (text: string, finalScore: number, extra: Partial<Gateable> = {}): Gateable =>
    ({ text, title: "Rule title", tier: finalScore >= 0.8 ? "PRIMARY" : finalScore >= 0.65 ? "BACKUP" : "SKIP", finalScore, scoredBy: "rules", ...extra });
  const TIERS = ["PRIMARY", "BACKUP"];

  test("Jev answers: FAIL → SKIP with the reason, risk → REVIEW, over-claiming LLM title replaced, SKIP tier untouched", async () => {
    const { jev, requests } = fakeJev();
    const segs = [seg(STRONG, 0.9, { scoredBy: "llm+rules", title: "Orang kaya BOHONG soal bank #fyp" }),
      seg("Halo semua, makasih udah nonton.", 0.85, { reason: "Rule score" }), seg("Kenapa pejabat itu korupsi? Ini buktinya.", 0.7),
      seg(STRONG, 0.69, { scoredBy: "llm+rules", title: "Rahasia orang kaya #fyp" }), seg("low", 0.3)];
    expect(await gateClips(segs, jev, TIERS)).toMatchObject({ error: null, by: "jev" });
    expect(requests).toHaveLength(4);
    expect(requests[0]!.state.title).toBe("Orang kaya BOHONG soal bank");
    expect(segs[0]).toMatchObject({ title: expect.stringMatching(/^Kenapa orang kaya/), gate: { verdict: "PASS", by: "jev", titleReplaced: true } });
    expect(segs[1]).toMatchObject({ tier: "SKIP", reason: "Held back: mostly greetings, promos or small talk. Rule score" });
    expect(segs.slice(2).map((s) => [s.gate?.verdict, s.title])).toEqual([["REVIEW", "Rule title"], ["PASS", "Rahasia orang kaya #fyp"], [undefined, "Rule title"]]);
  });

  test("Jev failing → the rules per clip (and no more calls after 3 in a row); off → rules; capped; bugs propagate", async () => {
    const down = fakeJev(() => new Error("overloaded"));
    const segs = Array.from({ length: 6 }, (_, i) => seg(STRONG, 0.9 - i * 0.01));
    expect(await gateClips(segs, down.jev, TIERS)).toMatchObject({ by: "rules", error: expect.stringMatching(/^Jev HTTP 500/) });
    expect(down.requests.length).toBeLessThanOrEqual(6);
    let n = 0;
    const flaky = fakeJev((st, id) => (n++ === 0 ? new Error("x") : clipAnswer(st, id)));
    expect((await gateClips([seg(STRONG, 0.9), seg(STRONG, 0.8)], flaky.jev, TIERS)).by).toBe("mixed");
    const off = new Jev({ ...JEV_ON, jevApiKey: "" });
    const plain = [seg("Terus dia pergi. Ternyata tutup.", 0.9)];
    expect(await gateClips(plain, off, ["PRIMARY"])).toMatchObject({ by: "rules", error: null });
    expect(plain[0]!.tier).toBe("SKIP");
    expect((await gateClips([seg("x", 0.1)], off, ["PRIMARY"])).by).toBeNull();
    const many = Array.from({ length: GATE_MAX + 5 }, (_, i) => seg(STRONG, 0.99 - i / 1000));
    await gateClips(many, off, TIERS);
    expect(many.filter((s) => s.gate)).toHaveLength(GATE_MAX);
    const bug = fakeJev().jev;
    bug.decide = async () => { throw new TypeError("bug"); };
    await expect(gateClips([seg(STRONG, 0.9)], bug, ["PRIMARY"])).rejects.toBeInstanceOf(TypeError);
  });
});
