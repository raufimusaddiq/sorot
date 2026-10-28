// Measures the gate's questions against labelled excerpts, for Jev and for
// the rule fallback side by side (scripts/jev-eval.ts runs it). A question is
// only "right" when its answers separate the labelled yes and no cases; this
// shows that per question, at the gate's own thresholds (YES / NO).

import { NO, YES, type GateResult, type Verdict } from "./clipGate";

export interface EvalCase {
  id: string;
  excerpt: string;
  title?: string;
  /** The title came from the LLM (only then is the title question asked). */
  llmTitle?: boolean;
  /** Expected answers: true/false for Nouls, the level 0-2 for payoff. Missing = unlabelled. */
  expect: Record<string, boolean | number>;
  verdict: Verdict | null;
}

export interface QuestionReport {
  question: string;
  labelled: number;
  /** Answers on the right side of YES / NO. */
  correct: number;
  /** Answers between NO and YES (no decision). */
  unsure: number;
  wrong: number;
  /** Mean answer for cases labelled yes minus cases labelled no (Nouls); bigger = better separated. */
  separation: number | null;
  misses: string[];
}

export interface EvalReport {
  by: string;
  questions: QuestionReport[];
  verdicts: { labelled: number; correct: number; misses: string[] };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Score each question and the verdicts; `results` by case id (missing = not answered). */
export function evaluate(by: string, cases: EvalCase[], results: Record<string, GateResult>): EvalReport {
  const questions = [...new Set(cases.flatMap((c) => Object.keys(c.expect)))].sort();
  const reports = questions.map((q): QuestionReport => {
    const rep: QuestionReport = { question: q, labelled: 0, correct: 0, unsure: 0, wrong: 0, separation: null, misses: [] };
    const yes: number[] = [];
    const no: number[] = [];
    for (const c of cases) {
      const want = c.expect[q];
      const got = results[c.id]?.answers[q];
      if (want === undefined || got === undefined) continue;
      rep.labelled++;
      if (typeof want === "number") {
        // payoff: right when the expected level is the nearest one
        if (Math.round(got) === want) rep.correct++;
        else {
          rep.wrong++;
          rep.misses.push(`${c.id} (${r3(got)}, want ${want})`);
        }
        continue;
      }
      (want ? yes : no).push(got);
      if (got > NO && got < YES) {
        rep.unsure++;
        rep.misses.push(`${c.id} (${r3(got)}, unsure)`);
      } else if ((got >= YES) === want) rep.correct++;
      else {
        rep.wrong++;
        rep.misses.push(`${c.id} (${r3(got)}, want ${want ? "yes" : "no"})`);
      }
    }
    const my = mean(yes);
    const mn = mean(no);
    rep.separation = my !== null && mn !== null ? r3(my - mn) : null;
    return rep;
  });
  const verdicts = { labelled: 0, correct: 0, misses: [] as string[] };
  for (const c of cases) {
    const got = results[c.id]?.verdict;
    if (!c.verdict || !got) continue;
    verdicts.labelled++;
    if (got === c.verdict) verdicts.correct++;
    else verdicts.misses.push(`${c.id} (${got}, want ${c.verdict})`);
  }
  return { by, questions: reports.filter((r) => r.labelled > 0), verdicts };
}

/** Plain-text table of one or more reports, question by question. */
export function formatReports(reports: EvalReport[]): string {
  const lines: string[] = [];
  for (const r of reports) {
    lines.push(`== ${r.by}`);
    lines.push("question               n  right unsure wrong  separation");
    for (const q of r.questions) {
      lines.push(`${q.question.padEnd(22)} ${String(q.labelled).padStart(2)} ${String(q.correct).padStart(6)} ${String(q.unsure).padStart(6)} ${String(q.wrong).padStart(5)}  ${q.separation === null ? "-" : q.separation.toFixed(3)}`);
      for (const m of q.misses) lines.push(`    miss: ${m}`);
    }
    lines.push(`verdicts: ${r.verdicts.correct}/${r.verdicts.labelled} right${r.verdicts.misses.length ? ` — ${r.verdicts.misses.join(", ")}` : ""}`);
    lines.push("");
  }
  return lines.join("\n");
}
