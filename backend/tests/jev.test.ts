import { describe, expect, test } from "bun:test";
import { Jev, JevError, noul, readAnswer, type Question } from "../src/jev";

const ON = { jevUrl: "https://api.typesafe.ai/v1/systemone", jevModel: "jev-1.14.0", jevApiKey: "k", jevTimeoutSec: 5 };

const Q: Record<string, Question> = {
  hook: { type: "noul", instructions: "Is `opening` a hook?" },
  team: { type: "choice", instructions: "Which?", criteria: { a: "A", b: "B" } },
  payoff: { type: "score", instructions: "How much?", criteria: ["none", "some", "clear"] },
};

const GOOD = {
  model: "jev-1.14.0",
  answers: {
    hook: { type: "noul", noul: 0.91 },
    team: { type: "choice", choice: "b", confidence: 0.4, probabilities: { a: 0.3, b: 0.7, junk: "x" } },
    payoff: { type: "score", score: 1.7, confidence: 0.55, legend: { 0: "none" }, probabilities: { 0: 0.1, 1: 0.1, 2: 0.8 } },
  },
  usage: { input_tokens: 321, output_tokens: 12 },
};

function fakeFetch(...replies: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    if (r instanceof Error) throw r;
    return r.clone();
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });

describe("Jev client", () => {
  test("off without a key or when switched off", async () => {
    expect(new Jev({ ...ON, jevApiKey: "" }).enabled).toBeFalse();
    expect(new Jev({ ...ON, jevEnabled: false }).enabled).toBeFalse();
    await expect(new Jev({ ...ON, jevApiKey: "" }).decide("x", Q)).rejects.toBeInstanceOf(JevError);
    expect(new Jev(ON).model).toBe("jev-1.14.0");
  });

  test("sends model, state and questions with Bearer auth; reads typed answers", async () => {
    const f = fakeFetch(json(GOOD));
    const d = await new Jev(ON, f.fn).decide({ opening: "Kenapa?" }, Q);
    expect(f.calls[0]!.url).toBe(ON.jevUrl);
    expect((f.calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ model: "jev-1.14.0", state: { opening: "Kenapa?" }, questions: Q });
    expect(d).toEqual({
      model: "jev-1.14.0", inputTokens: 321,
      answers: {
        hook: { type: "noul", noul: 0.91 },
        team: { type: "choice", choice: "b", confidence: 0.4, probabilities: { a: 0.3, b: 0.7 } },
        payoff: { type: "score", score: 1.7, confidence: 0.55, probabilities: { 0: 0.1, 1: 0.1, 2: 0.8 } },
      },
    });
    expect(noul(d.answers.hook)).toBe(0.91);
    expect(noul(d.answers.team)).toBe(0);
    expect(noul(undefined)).toBe(0);
  });

  test("missing model / usage fall back; out-of-range rounding is clamped", async () => {
    const f = fakeFetch(json({ answers: { hook: { type: "noul", noul: 1.0000001 } } }));
    const d = await new Jev(ON, f.fn).decide("x", { hook: Q.hook! });
    expect(d).toEqual({ model: "jev-1.14.0", inputTokens: 0, answers: { hook: { type: "noul", noul: 1 } } });
    expect(readAnswer("p", Q.payoff!, { type: "score", score: 2.0000001 })).toEqual({ type: "score", score: 2, confidence: null, probabilities: {} });
    expect(readAnswer("t", Q.team!, { type: "choice", choice: "a", probabilities: null })).toMatchObject({ choice: "a", probabilities: {} });
  });

  test("malformed answers are errors, never a default", () => {
    const bad: Array<[Question, unknown]> = [
      [Q.hook!, { type: "choice", choice: "a" }],
      [Q.hook!, { type: "noul", noul: 1.5 }],
      [Q.hook!, { type: "noul", noul: Number.NaN }],
      [Q.hook!, null],
      [Q.team!, { type: "choice", choice: "c" }],
      [Q.team!, { type: "choice" }],
      [Q.payoff!, { type: "score", score: 3 }],
      [Q.payoff!, { type: "score", score: -0.5 }],
      [Q.payoff!, { type: "score", score: "1" }],
    ];
    for (const [q, raw] of bad) expect(() => readAnswer("x", q, raw)).toThrow(JevError);
  });

  test("an unanswered question is an error", async () => {
    const f = fakeFetch(json({ model: "m", answers: { hook: { type: "noul", noul: 0.2 } } }));
    await expect(new Jev(ON, f.fn).decide("x", Q)).rejects.toThrow("Jev left question team unanswered");
  });

  test("HTTP errors, invalid JSON and network failures throw JevError", async () => {
    await expect(new Jev(ON, fakeFetch(json({ detail: "no" }, 401)).fn).decide("x", Q)).rejects.toThrow("Jev HTTP 401");
    await expect(new Jev(ON, fakeFetch(json("<html>")).fn).decide("x", Q)).rejects.toThrow("invalid JSON");
    await expect(new Jev(ON, fakeFetch(new Error("ECONNREFUSED")).fn).decide("x", Q)).rejects.toThrow("Jev unreachable");
    const noAnswers = fakeFetch(json({ model: "m" }));
    await expect(new Jev(ON, noAnswers.fn).decide("x", { hook: Q.hook! })).rejects.toThrow("unanswered");
  });

  test("429 / 529 are retried once (Retry-After honoured), then reported", async () => {
    const ok = fakeFetch(json({}, 429, { "retry-after": "0.001" }), json(GOOD));
    expect((await new Jev(ON, ok.fn, 0).decide("x", Q)).model).toBe("jev-1.14.0");
    expect(ok.calls.length).toBe(2);
    const busy = fakeFetch(json({}, 529));
    await expect(new Jev(ON, busy.fn, 0).decide("x", Q)).rejects.toThrow("Jev HTTP 529");
    expect(busy.calls.length).toBe(2);
  });
});
