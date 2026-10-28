import { describe, expect, test } from "bun:test";
import { Jev, JevError, noul, readAnswer, type Question } from "../src/jev";
import { JEV_ON } from "./helpers";

const Q: Record<string, Question> = {
  hook: { type: "noul", instructions: "Is `opening` a hook?" },
  team: { type: "choice", instructions: "Which?", criteria: { a: "A", b: "B" } },
  payoff: { type: "score", instructions: "How much?", criteria: ["none", "some", "clear"] },
};
const GOOD = {
  model: "jev-1.14.0", usage: { input_tokens: 321, output_tokens: 12 },
  answers: {
    hook: { type: "noul", noul: 0.91 },
    team: { type: "choice", choice: "b", confidence: 0.4, probabilities: { a: 0.3, b: 0.7, junk: "x" } },
    payoff: { type: "score", score: 1.7, confidence: 0.55, legend: { 0: "none" }, probabilities: { 0: 0.1, 1: 0.1, 2: 0.8 } },
  },
};

const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
/** A Jev whose fetch answers with `replies` in turn (the last one repeats). */
function jevWith(...replies: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    if (r instanceof Error) throw r;
    return r.clone();
  }) as unknown as typeof fetch;
  return { jev: new Jev(JEV_ON, fetchFn, 0), calls };
}

describe("Jev client", () => {
  test("off without a key or when switched off", async () => {
    expect([new Jev({ ...JEV_ON, jevApiKey: "" }).enabled, new Jev({ ...JEV_ON, jevEnabled: false }).enabled, new Jev(JEV_ON).model])
      .toEqual([false, false, "jev-1.14.0"]);
    await expect(new Jev({ ...JEV_ON, jevApiKey: "" }).decide("x", Q)).rejects.toBeInstanceOf(JevError);
  });

  test("sends model, state and questions with Bearer auth; reads typed answers", async () => {
    const { jev, calls } = jevWith(reply(GOOD));
    const d = await jev.decide({ opening: "Kenapa?" }, Q);
    expect(calls[0]!.url).toBe(JEV_ON.jevUrl);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ model: "jev-1.14.0", state: { opening: "Kenapa?" }, questions: Q });
    expect(d).toEqual({ model: "jev-1.14.0", inputTokens: 321, answers: {
      hook: { type: "noul", noul: 0.91 },
      team: { type: "choice", choice: "b", confidence: 0.4, probabilities: { a: 0.3, b: 0.7 } },
      payoff: { type: "score", score: 1.7, confidence: 0.55, probabilities: { 0: 0.1, 1: 0.1, 2: 0.8 } },
    } });
    expect([noul(d.answers.hook), noul(d.answers.team), noul(undefined)]).toEqual([0.91, 0, 0]);
  });

  test("missing model / usage fall back; rounding past the range is clamped", async () => {
    const d = await jevWith(reply({ answers: { hook: { type: "noul", noul: 1.0000001 } } })).jev.decide("x", { hook: Q.hook! });
    expect(d).toEqual({ model: "jev-1.14.0", inputTokens: 0, answers: { hook: { type: "noul", noul: 1 } } });
    expect(readAnswer("p", Q.payoff!, { type: "score", score: 2.0000001 })).toEqual({ type: "score", score: 2, confidence: null, probabilities: {} });
    expect(readAnswer("t", Q.team!, { type: "choice", choice: "a", probabilities: null })).toMatchObject({ probabilities: {} });
  });

  test.each([
    ["hook", { type: "choice", choice: "a" }], ["hook", { type: "noul", noul: 1.5 }], ["hook", { type: "noul", noul: Number.NaN }],
    ["hook", null], ["team", { type: "choice", choice: "c" }], ["team", { type: "choice" }],
    ["payoff", { type: "score", score: 3 }], ["payoff", { type: "score", score: -0.5 }], ["payoff", { type: "score", score: "1" }],
  ])("a malformed %s answer is an error, never a default: %o", (id, raw) => {
    expect(() => readAnswer("x", Q[id]!, raw)).toThrow(JevError);
  });

  test.each([
    [reply({ model: "m", answers: { hook: { type: "noul", noul: 0.2 } } }), "Jev left question team unanswered"],
    [reply({ model: "m" }), "unanswered"],
    [reply({ detail: "no" }, 401), "Jev HTTP 401"],
    [reply("<html>"), "invalid JSON"],
    [new Error("ECONNREFUSED"), "Jev unreachable"],
  ])("failure %# → JevError %s", async (r, message) => {
    await expect(jevWith(r).jev.decide("x", Q)).rejects.toThrow(message);
  });

  test("429 / 529 are retried once (Retry-After honoured), then reported", async () => {
    const ok = jevWith(reply({}, 429, { "retry-after": "0.001" }), reply(GOOD));
    expect((await ok.jev.decide("x", Q)).model).toBe("jev-1.14.0");
    const busy = jevWith(reply({}, 529));
    await expect(busy.jev.decide("x", Q)).rejects.toThrow("Jev HTTP 529");
    expect([ok.calls.length, busy.calls.length]).toEqual([2, 2]);
  });
});
