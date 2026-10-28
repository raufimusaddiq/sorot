// Are the gate's questions right? Runs them over labelled excerpts with Jev
// (needs JEV_API_KEY, or the key saved in the app's settings is not read
// here — pass it in the env) and with the rule fallback, then prints how
// well each question separates the labelled yes / no cases.
//
//   cd backend
//   JEV_API_KEY=... bun run jev-eval                      # built-in fixture
//   JEV_API_KEY=... bun run jev-eval my-labels.json --out answers.json
//   bun run jev-eval --rules                              # rules only, no key needed
//
// The labels file has the shape of tests/fixtures/jev-gate-eval.json.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fromDecision, gateQuestions, gateState, ruleGate, type GateResult } from "../src/clipGate";
import { loadConfig } from "../src/config";
import { evaluate, formatReports, type EvalCase, type EvalReport } from "../src/gateEval";
import { Jev } from "../src/jev";
import { mapPool } from "../src/pool";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--out")
  ?? join(import.meta.dir, "..", "tests", "fixtures", "jev-gate-eval.json");
const cases = (JSON.parse(readFileSync(file, "utf8")) as { cases: EvalCase[] }).cases;

const reports: EvalReport[] = [];
const rules: Record<string, GateResult> = Object.fromEntries(cases.map((c) => [c.id, ruleGate(c.excerpt)]));
reports.push(evaluate("rules (deterministic fallback)", cases, rules));

const jev = new Jev(loadConfig());
const raw: Record<string, unknown> = {};
if (!flag("--rules")) {
  if (!jev.enabled) {
    console.error("JEV_API_KEY is not set: showing the rules only (--rules to silence this).");
  } else {
    const answers: Record<string, GateResult> = {};
    let tokens = 0;
    await mapPool(cases, 4, async (c) => {
      const withTitle = !!c.llmTitle && !!c.title;
      const d = await jev.decide(gateState(c.excerpt, withTitle ? c.title : null), gateQuestions(withTitle));
      tokens += d.inputTokens;
      raw[c.id] = d;
      answers[c.id] = fromDecision(d);
    });
    reports.unshift(evaluate(`jev (${jev.model}, ${tokens} input tokens)`, cases, answers));
  }
}
console.log(`${cases.length} cases from ${file}\n`);
console.log(formatReports(reports));
const out = value("--out");
if (out) {
  writeFileSync(out, JSON.stringify({ rules, jev: raw }, null, 2));
  console.log(`raw answers → ${out}`);
}
