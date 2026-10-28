import { describe, expect, test } from "bun:test";
import {
  fromDecision, gateClips, gateQuestions, gateState, GATE_MAX, heldLast, openingAndClosing, plainTitle, QUALITY_QUESTIONS,
  qualityOf, RISK_QUESTIONS, ruleAnswers, ruleGate, TITLE_QUESTION, verdictFrom, type Gateable,
} from "../src/clipGate";
import { Jev, JevError, type Question } from "../src/jev";

const STRONG = "Kenapa orang kaya nggak pernah nabung di bank? Ternyata mereka taruh uangnya di aset. Itu rahasia yang jarang dibahas.";

describe("the questions (TypeSafe's design rules, checked)", () => {
  const all = gateQuestions(true);
  const fields = Object.keys(gateState("a. b.", "t"));

  test("one literal question each, naming the state field it reads", () => {
    for (const [id, q] of Object.entries(all)) {
      expect(q.instructions.endsWith("?")).toBeTrue();
      expect(q.instructions.length).toBeLessThan(140);
      const named = [...q.instructions.matchAll(/`(\w+)`/g)].map((m) => m[1]);
      expect(named.length).toBeGreaterThan(0);
      for (const f of named) expect(fields).toContain(f);
      // Exact work stays in code: no counting, lengths or timing asked of the model.
      expect(q.instructions).not.toMatch(/how many|count|seconds|percent|longer than/i);
      expect(id).toMatch(/^[a-z_]+$/);
    }
  });

  test("noul criteria describe both sides; quality and risk questions all have them where yes/no is ambiguous", () => {
    for (const q of Object.values(all)) {
      if (q.type !== "noul" || !q.criteria) continue;
      expect(Object.keys(q.criteria).sort()).toEqual(["false", "true"]);
      expect(q.criteria.true.length).toBeGreaterThan(20);
      expect(q.criteria.false.length).toBeGreaterThan(20);
    }
    for (const id of ["hook_opening", "needs_prior_context", "ends_complete", "mostly_filler"]) {
      expect((QUALITY_QUESTIONS[id] as { criteria?: unknown }).criteria).toBeDefined();
    }
  });

  test("score levels stand alone (no 'than the previous'), lowest first", () => {
    const payoff = QUALITY_QUESTIONS.payoff as Extract<Question, { type: "score" }>;
    expect(payoff.criteria.length).toBe(3);
    for (const level of payoff.criteria) expect(level).not.toMatch(/previous|than level|more than the/i);
    expect(payoff.criteria[0]).toStartWith("Nothing");
  });

  test("risks are separate Nouls, not a Choice (a Choice leans to its first option)", () => {
    expect(Object.values(RISK_QUESTIONS).every((q) => q.type === "noul")).toBeTrue();
    expect(Object.values(all).some((q) => q.type === "choice")).toBeFalse();
  });

  test("the title question only when there is an LLM title to check", () => {
    expect(Object.keys(gateQuestions(false))).not.toContain("title_overclaims");
    expect(Object.keys(gateQuestions(true))).toContain(Object.keys(TITLE_QUESTION)[0]!);
  });
});

describe("state", () => {
  test("opening/closing are the first and last sentence or two", () => {
    expect(openingAndClosing(STRONG)).toEqual({
      opening: "Kenapa orang kaya nggak pernah nabung di bank? Ternyata mereka taruh uangnya di aset.",
      closing: "Ternyata mereka taruh uangnya di aset. Itu rahasia yang jarang dibahas.",
    });
    const long = `${"Kalimat pembuka yang cukup panjang untuk berdiri sendiri sebagai satu kalimat."} Dua. Tiga.`;
    expect(openingAndClosing(long).opening).toBe("Kalimat pembuka yang cukup panjang untuk berdiri sendiri sebagai satu kalimat.");
  });

  test("unpunctuated speech: first and last 25 words", () => {
    const words = Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ");
    const { opening, closing } = openingAndClosing(words);
    expect(opening.split(" ")).toHaveLength(25);
    expect(closing.split(" ")[24]).toBe("w59");
  });

  test("title without hashtags, only when given", () => {
    expect(plainTitle("Rahasia orang kaya #fyp #viral")).toBe("Rahasia orang kaya");
    expect(gateState(STRONG, "Judul #fyp")).toMatchObject({ title: "Judul" });
    expect(gateState(STRONG)).not.toHaveProperty("title");
    expect(gateState("x".repeat(5000)).excerpt.length).toBe(3000);
  });
});

describe("verdict (decided in code)", () => {
  const good = { hook_opening: 0.9, needs_prior_context: 0.1, ends_complete: 0.9, mostly_filler: 0.05, payoff: 1.8 };

  test("PASS", () => {
    expect(verdictFrom(good, 0.8)).toEqual({ verdict: "PASS", reasons: [] });
  });

  test("each FAIL reason", () => {
    expect(verdictFrom({ ...good, mostly_filler: 0.75 }).reasons).toEqual(["mostly greetings, promos or small talk"]);
    expect(verdictFrom({ ...good, needs_prior_context: 0.7 }).verdict).toBe("FAIL");
    expect(verdictFrom({ ...good, hook_opening: 0.2, ends_complete: 0.3 }).reasons).toEqual(["weak opening and a cut-off ending"]);
    expect(verdictFrom({ ...good, payoff: 0.4 }, 0.6).reasons).toEqual(["no clear payoff"]);
    expect(verdictFrom({ ...good, payoff: 0.4 }, 0.3).verdict).toBe("PASS");   // unsure payoff doesn't fail
  });

  test("risks send to REVIEW; a fail still wins; single weak signals are notes", () => {
    expect(verdictFrom({ ...good, risk_accusation: 0.55 })).toEqual({ verdict: "REVIEW", reasons: ["may accuse a real person or company of wrongdoing"] });
    expect(verdictFrom({ ...good, mostly_filler: 0.9, risk_sara: 0.9 }).verdict).toBe("FAIL");
    expect(verdictFrom({ ...good, hook_opening: 0.2 }).reasons).toEqual(["weak opening"]);
    expect(verdictFrom({ ...good, ends_complete: 0.1 }).reasons).toEqual(["ending is cut off"]);
  });

  test("heldLast: FAIL clips after the rest whatever their score, then the best score first", () => {
    const clips = [
      { id: "fail", finalScore: 0.9, gate: { verdict: "FAIL" } },
      { id: "low", finalScore: 0.4 },
      { id: "review", finalScore: 0.6, gate: { verdict: "REVIEW" } },
      { id: "pass", finalScore: 0.7, gate: { verdict: "PASS" } },
    ];
    expect(clips.sort(heldLast).map((c) => c.id)).toEqual(["pass", "review", "low", "fail"]);
  });

  test("quality averages what is present", () => {
    expect(qualityOf(good)).toBe(0.905);
    expect(qualityOf({ hook_opening: 0.5 })).toBe(0.5);
    expect(qualityOf({})).toBe(0);
  });
});

describe("deterministic fallback (rules)", () => {
  test("a strong, complete excerpt passes", () => {
    const g = ruleGate(STRONG);
    expect(g).toMatchObject({ verdict: "PASS", by: "rules", model: null });
    expect(g.answers.payoff).toBeUndefined();   // rules can't judge payoff
    expect(ruleGate(STRONG)).toEqual(g);         // same input, same answer
  });

  test("continuation openings need context; pronoun openings only lean that way", () => {
    expect(ruleAnswers("Tapi itu nggak bener. Dia bilang begitu.").needs_prior_context).toBe(0.8);
    expect(ruleGate("Terus dia pergi ke pasar. Ternyata tutup.").verdict).toBe("FAIL");
    expect(ruleAnswers("Dia orangnya baik banget. Semua suka.").needs_prior_context).toBe(0.6);
    expect(ruleAnswers("Kayak tadi aku bilang, ini penting.").needs_prior_context).toBe(0.6);
    expect(ruleAnswers(STRONG).needs_prior_context).toBe(0.2);
  });

  test("endings: cut off, complete, unknown", () => {
    expect(ruleAnswers("Ini penting. Karena kalau").ends_complete).toBe(0.15);
    expect(ruleAnswers("Ini penting. Jadi intinya,").ends_complete).toBe(0.15);
    expect(ruleAnswers("Ini penting. Selesai.").ends_complete).toBe(0.8);
    expect(ruleAnswers("ini penting banget sih").ends_complete).toBe(0.5);
    expect(ruleAnswers("Ini penting. Kenapa?").ends_complete).toBe(0.3);      // a question left open
    expect(ruleAnswers("Yang harus kamu lakukan adalah").ends_complete).toBe(0.15);
  });

  test("filler share and keyword risks", () => {
    const promo = "Halo semua! Jangan lupa subscribe ya. Terima kasih sponsor kita. Oke lanjut.";
    expect(ruleAnswers(promo).mostly_filler).toBe(0.8);
    expect(ruleGate(promo).verdict).toBe("FAIL");
    expect(ruleAnswers("Halo semua. Hari ini kita bahas. Soal uang. Dan rumah.").mostly_filler).toBe(0.1);
    expect(ruleAnswers("Halo semua. Makasih ya. Hari ini kita bahas uang. Dan rumah.").mostly_filler).toBe(0.5);
    const risky = ruleGate("Kenapa dia bisa jadi tersangka korupsi? Itu yang mau aku bongkar.");
    expect(risky).toMatchObject({ verdict: "REVIEW", reasons: ["may accuse a real person or company of wrongdoing"] });
    expect(ruleAnswers("Produk ini dijamin sembuh total.").risk_health_money).toBe(0.6);
    expect(ruleAnswers("Minum ini dijamin diabetes kamu sembuh.").risk_health_money).toBe(0.6);
    expect(ruleAnswers("Orang dari suku itu memang semuanya pelit.").risk_sara).toBe(0.6);
    expect(ruleAnswers("Suku Jawa punya banyak tradisi.").risk_sara).toBe(0.05);
    expect(ruleAnswers("Halo semua. Kenapa ini penting?").hook_opening).toBe(0.1);
    expect(ruleAnswers("").mostly_filler).toBe(0.1);
  });
});

// ---- gateClips with a fake Jev ----

const ON = { jevUrl: "http://jev/v1/systemone", jevModel: "jev-1.14.0", jevApiKey: "k", jevTimeoutSec: 5 };

function answersFor(text: string, title?: string) {
  const bad = text.startsWith("Halo");
  const a: Record<string, unknown> = {
    hook_opening: { type: "noul", noul: bad ? 0.1 : 0.9 },
    needs_prior_context: { type: "noul", noul: 0.1 },
    ends_complete: { type: "noul", noul: 0.9 },
    mostly_filler: { type: "noul", noul: bad ? 0.9 : 0.05 },
    payoff: { type: "score", score: bad ? 0.2 : 1.9, confidence: 0.8 },
    risk_accusation: { type: "noul", noul: text.includes("korupsi") ? 0.8 : 0.02 },
    risk_sara: { type: "noul", noul: 0.01 }, risk_sexual: { type: "noul", noul: 0.01 },
    risk_dangerous: { type: "noul", noul: 0.01 }, risk_health_money: { type: "noul", noul: 0.01 },
  };
  if (title !== undefined) a.title_overclaims = { type: "noul", noul: title.includes("BOHONG") ? 0.9 : 0.1 };
  return a;
}

function jevWith(reply: (state: { excerpt: string; title?: string }) => Response | Error) {
  const states: Array<{ excerpt: string; title?: string }> = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    states.push(body.state);
    const r = reply(body.state);
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  return { jev: new Jev(ON, fetchFn, 0), states };
}

const ok = (state: { excerpt: string; title?: string }) =>
  new Response(JSON.stringify({ model: "jev-1.14.0", answers: answersFor(state.excerpt, state.title), usage: { input_tokens: 10, output_tokens: 1 } }));

const seg = (text: string, finalScore: number, extra: Partial<Gateable> = {}): Gateable =>
  ({ text, title: "Rule title", tier: finalScore >= 0.8 ? "PRIMARY" : finalScore >= 0.65 ? "BACKUP" : "SKIP", finalScore, scoredBy: "rules", ...extra });

describe("gateClips", () => {
  test("Jev answers; FAIL goes to SKIP with a reason; risk goes to REVIEW; SKIP tier untouched", async () => {
    const { jev, states } = jevWith(ok);
    const segs = [seg(STRONG, 0.9), seg("Halo semua, makasih udah nonton.", 0.85, { reason: "Rule score" }),
      seg("Kenapa pejabat itu korupsi? Ini buktinya.", 0.7), seg("low", 0.3)];
    const out = await gateClips(segs, jev, ["PRIMARY", "BACKUP"]);
    expect(out).toMatchObject({ error: null, by: "jev" });
    expect(states).toHaveLength(3);
    expect(segs[0]!.gate).toMatchObject({ verdict: "PASS", by: "jev", model: "jev-1.14.0" });
    expect(segs[1]).toMatchObject({ tier: "SKIP", reason: "Held back: mostly greetings, promos or small talk. Rule score" });
    expect(segs[1]!.gate!.answers.payoff).toBe(0.2);
    expect(segs[2]!.gate!.verdict).toBe("REVIEW");
    expect(segs[3]!.gate).toBeUndefined();
  });

  test("an LLM title is checked, and replaced by the rule title when it over-claims", async () => {
    const { jev, states } = jevWith(ok);
    const segs = [seg(STRONG, 0.9, { scoredBy: "llm+rules", title: "Orang kaya BOHONG soal bank #fyp" }),
      seg(STRONG, 0.85, { scoredBy: "llm+rules", title: "Rahasia orang kaya #fyp" })];
    await gateClips(segs, jev, ["PRIMARY", "BACKUP"]);
    expect(states[0]!.title).toBe("Orang kaya BOHONG soal bank");
    expect(segs[0]!.title).toStartWith("Kenapa orang kaya nggak pernah nabung di bank?");
    expect(segs[0]!.gate).toMatchObject({ titleReplaced: true, verdict: "PASS" });
    expect(segs[0]!.gate!.reasons.at(-1)).toBe("LLM title claimed more than the clip says; replaced");
    expect(segs[1]!.title).toBe("Rahasia orang kaya #fyp");
  });

  test("Jev failures fall back to the rules per clip, and stop calling Jev after 3 in a row", async () => {
    const { jev, states } = jevWith(() => new Response("overloaded", { status: 500 }));
    const segs = Array.from({ length: 6 }, (_, i) => seg(STRONG, 0.9 - i * 0.01));
    const out = await gateClips(segs, jev, ["PRIMARY", "BACKUP"]);
    expect(out.error).toStartWith("Jev HTTP 500");
    expect(out.by).toBe("rules");
    expect(states.length).toBeLessThanOrEqual(3 + 3);   // in-flight requests may already be past the check
    expect(segs.every((s) => s.gate?.by === "rules" && s.gate.verdict === "PASS")).toBeTrue();
  });

  test("mixed answers, rules without Jev, nothing to gate, the cap, unexpected errors", async () => {
    let n = 0;
    const { jev } = jevWith((s) => (n++ === 0 ? new Error("boom") : ok(s)));
    const segs = [seg(STRONG, 0.9), seg(STRONG, 0.8)];
    expect((await gateClips(segs, jev, ["PRIMARY", "BACKUP"])).by).toBe("mixed");

    const off = new Jev({ ...ON, jevApiKey: "" });
    const plain = [seg("Terus dia pergi. Ternyata tutup.", 0.9)];
    expect(await gateClips(plain, off, ["PRIMARY"])).toMatchObject({ by: "rules", error: null });
    expect(plain[0]!.tier).toBe("SKIP");
    expect((await gateClips([seg("x", 0.1)], off, ["PRIMARY"])).by).toBeNull();

    const many = Array.from({ length: GATE_MAX + 5 }, (_, i) => seg(STRONG, 0.99 - i / 1000));
    await gateClips(many, off, ["PRIMARY", "BACKUP"]);
    expect(many.filter((s) => s.gate).length).toBe(GATE_MAX);

    const broken = new Jev(ON, (async () => { throw new TypeError("bug"); }) as unknown as typeof fetch);
    broken.decide = async () => { throw new TypeError("bug"); };
    await expect(gateClips([seg(STRONG, 0.9)], broken, ["PRIMARY"])).rejects.toBeInstanceOf(TypeError);
  });

  test("fromDecision keeps the payoff confidence for the verdict", () => {
    const g = fromDecision({ model: "jev-1.14.0", inputTokens: 1, answers: {
      hook_opening: { type: "noul", noul: 0.8 },
      payoff: { type: "score", score: 0.3, confidence: 0.9, probabilities: {} },
      other: { type: "choice", choice: "a", confidence: 1, probabilities: {} },
    } });
    expect(g).toMatchObject({ verdict: "FAIL", reasons: ["no clear payoff"], answers: { hook_opening: 0.8, payoff: 0.3 } });
    expect(JevError).toBeDefined();
  });
});
