import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ruleGate, type GateResult } from "../src/clipGate";
import { evaluate, formatReports, type EvalCase } from "../src/gateEval";

const fx = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "jev-gate-eval.json"), "utf-8")) as { cases: EvalCase[] };
const result = (answers: Record<string, number>, verdict: GateResult["verdict"] = "PASS"): GateResult =>
  ({ verdict, by: "jev", model: "m", reasons: [], answers, quality: 0 });

test("the fixture labels every question, with yes and no where both exist; the rules run over it deterministically", () => {
  const values = (q: string) => fx.cases.map((c) => c.expect[q]).filter((v) => v !== undefined);
  for (const q of ["payoff", "risk_accusation", "risk_sara", "risk_dangerous", "risk_health_money"]) expect(values(q).length).toBeGreaterThan(0);
  for (const q of ["hook_opening", "needs_prior_context", "ends_complete", "mostly_filler", "title_overclaims"]) {
    expect(values(q)).toEqual(expect.arrayContaining([true, false]));
  }
  const rules = () => evaluate("rules", fx.cases, Object.fromEntries(fx.cases.map((c) => [c.id, ruleGate(c.excerpt)])));
  expect(rules()).toEqual(rules());
  expect(rules().verdicts.labelled).toBe(12);
  expect(rules().questions.map((q) => q.question)).not.toContain("payoff");   // rules don't answer it
});

test("right / unsure / wrong per question at the gate's thresholds, separation, and the report", () => {
  const cases: EvalCase[] = [
    { id: "a", excerpt: "", expect: { hook_opening: true, payoff: 2 }, verdict: "PASS" },
    { id: "b", excerpt: "", expect: { hook_opening: false, payoff: 0 }, verdict: "FAIL" },
    { id: "c", excerpt: "", expect: { hook_opening: true }, verdict: "REVIEW" },
    { id: "d", excerpt: "", expect: { hook_opening: false }, verdict: null },
    { id: "e", excerpt: "", expect: { hook_opening: true }, verdict: "PASS" },   // unanswered
  ];
  const r = evaluate("jev", cases, { a: result({ hook_opening: 0.9, payoff: 1.8 }), b: result({ hook_opening: 0.1, payoff: 1.2 }),
    c: result({ hook_opening: 0.5 }, "REVIEW"), d: result({ hook_opening: 0.8 }) });
  expect(r.questions).toEqual([
    { question: "hook_opening", labelled: 4, correct: 2, unsure: 1, wrong: 1, separation: 0.25, misses: ["c (0.5, unsure)", "d (0.8, want no)"] },
    { question: "payoff", labelled: 2, correct: 1, unsure: 0, wrong: 1, separation: null, misses: ["b (1.2, want 0)"] },
  ]);
  expect(r.verdicts).toEqual({ labelled: 3, correct: 2, misses: ["b (PASS, want FAIL)"] });
  const text = formatReports([r]);
  for (const line of ["== jev", "hook_opening            4      2      1     1  0.250", "payoff                  2      1      0     1  -",
    "verdicts: 2/3 right — b (PASS, want FAIL)"]) expect(text).toContain(line);
  expect(formatReports([{ by: "x", questions: [], verdicts: { labelled: 0, correct: 0, misses: [] } }])).toContain("verdicts: 0/0 right\n");
});
