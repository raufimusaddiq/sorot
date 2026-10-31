import type { Question } from "../jev";
import { NO, YES } from "../clipGate";
import { visibleText } from "./composer";
import type { NewFinding } from "./findings";
import type { Plan } from "./planSchema";
import type { JudgeAnswer, Storyline } from "./director";
import type { VerdictStatus } from "./technical";

// The CREATIVE verdict (research R7, contracts/director.md): a separate judge with fresh context
// that sees the brief, the approved plan and what was built, never how it was made. Jev answers
// the recipe's own questions first; a fresh LLM judge does when Jev is off or fails. The verdict
// is decided here, in code, from the answers, with no numeric score. It guides a fix round and
// never blocks export.

export interface Criterion {
  id: string;
  question: string;
  /** `main`: a failed answer makes the whole verdict FAIL. */
  fail?: "main";
}

/** Sorot always asks this one, unless the recipe marks one of its own questions as the main one (FR-013). */
export const MAIN_MESSAGE: Criterion = {
  id: "main_message", fail: "main",
  question: "Does `shots`, watched once with the sound off, get across the message stated in `message`?",
};

/** A risk Sorot always checks for. */
export const MISLEADING_CLAIM: Criterion = { id: "misleading_claim", question: "Does `shots` state a fact or a number that `brief` does not support?" };

/**
 * What Sorot asks, from the recipe: the user's criteria (plus the main-message question unless one
 * of theirs is the main one), and the risks: the always-on claim check, each leftover default the
 * recipe wants audited and each non-blocking content rule.
 */
export function questionsFor(settings: Record<string, unknown>, rules: Record<string, unknown> | undefined): { criteria: Criterion[]; risks: Criterion[] } {
  const own = (Array.isArray(settings.criteria) ? settings.criteria : []) as Criterion[];
  const criteria = own.some((c) => c.fail === "main") ? own : [...own, MAIN_MESSAGE];
  const audit = (Array.isArray(rules?.defaultsAudit) ? (rules?.defaultsAudit as string[]) : []).map((item, i): Criterion => ({
    id: `default_${i + 1}`, question: `Does \`shots\` show this common default: ${item}?`,
  }));
  const content = ((Array.isArray(rules?.content) ? rules?.content : []) as Array<{ id: string; question: string; blocking?: boolean }>)
    .filter((r) => !r.blocking).map((r): Criterion => ({ id: r.id, question: r.question }));
  return { criteria, risks: [MISLEADING_CLAIM, ...audit, ...content] };
}

// ---- the questions' design rules (TypeSafe, as clipGate.test.ts holds Sorot's own to) --------

/** Problems with a question a person wrote: it should be one judgment, name a state field, and leave counting and timing to code. */
export function lintQuestion(question: string): string[] {
  const problems: string[] = [];
  if (!/`\w+`/.test(question)) problems.push("name the thing it reads in backticks, for example `shots`, `opening` or `message`");
  if (!question.trim().endsWith("?")) problems.push("end it with a question mark");
  if (question.length >= 140) problems.push("keep it short (under 140 characters): one question, one judgment");
  if (/how many|count|seconds|percent|longer than/i.test(question)) problems.push("leave counting and timing to the checks: ask about what can be seen, not how many or how long");
  if ((question.match(/\b(and|or|dan|atau)\b/gi) ?? []).length >= 2) problems.push("ask one thing at a time");
  return problems;
}

// ---- what the judge is shown ---------------------------------------------------------------

export interface BuiltFacts {
  brief: string;
  message: string;
  storyline: string | null;
  look: string;
  opening: string;
  ending: string;
  shots: Array<{ id: string; seconds: number; from: number; role: string; onScreen: string; planned: string[]; drawn: string; moves: string; hold: boolean }>;
}

const clipText = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The brief, the plan and what each scene actually shows (its on-screen text), without any of the build history. */
export function builtFacts(brief: string, plan: Plan, storyline: Storyline | null, sceneHtml: (index: number) => string | null): BuiltFacts {
  let from = 0;
  const shots = plan.shots.map((s, i) => {
    const html = sceneHtml(i);
    const row = {
      id: s.id, seconds: s.durationSec, from, role: s.purpose, onScreen: html === null ? "(no scene was written)" : clipText(visibleText(html), 400),
      planned: s.text.map((t) => t.value), drawn: s.visual.description, moves: s.motion, hold: s.hold,
    };
    from = Math.round((from + s.durationSec) * 1000) / 1000;
    return row;
  });
  const describe = (i: number) => `${shots[i]!.onScreen} — ${shots[i]!.drawn}`;
  return {
    brief, message: plan.message, storyline: storyline ? `${storyline.title}: ${storyline.pitch} Opening: ${storyline.opening}` : null,
    look: `${plan.look.palette.join(" ")}; ${plan.look.fonts.join(", ")}; ${plan.look.pacing}${plan.look.notes ? `; ${plan.look.notes}` : ""}`,
    opening: describe(0), ending: describe(shots.length - 1), shots,
  };
}

// ---- Jev ------------------------------------------------------------------------------------

const CONTEXT = {
  task: "Judging a finished short 2D motion video (animated text and shapes, no footage) made from a written brief.",
  viewer: "The viewer watches it once on a phone, often with the sound off, and decides within the first seconds whether to keep watching.",
  text: "All text is what is written on screen, in Indonesian or English as the brief says.",
};
const FIELDS: Record<string, string> = {
  brief: "what the owner asked for, in their words",
  message: "the one thing the viewer should remember",
  storyline: "the film that was chosen: its idea and how it opens",
  look: "the colours, type and pace the plan chose",
  opening: "what the viewer sees in the first shot",
  ending: "what the viewer sees in the last shot",
  shots: "every shot in order: the words on screen, what is drawn and how it moves",
};

/** A Jev state: the shared context (describing the fields present), then the facts. */
export function creativeState(facts: BuiltFacts): Record<string, unknown> {
  const fields: Record<string, unknown> = { ...facts };
  if (facts.storyline === null) delete fields.storyline;
  const described = Object.keys(fields).filter((k) => FIELDS[k]).map((k) => [k, FIELDS[k]]);
  return { context: { ...CONTEXT, fields: Object.fromEntries(described) }, ...fields };
}

/** One Noul per question. */
export function jevQuestions(list: Criterion[]): Record<string, Question> {
  return Object.fromEntries(list.map((c) => [c.id, { type: "noul", instructions: c.question } as Question]));
}

// ---- answers to a verdict (code) --------------------------------------------------------------

export type Level = "yes" | "borderline" | "no";

export interface Judgement {
  criterion: Criterion;
  kind: "criterion" | "risk";
  /** Criteria: yes, borderline or no. Risks: `no` means flagged (something is there). */
  level: Level;
  reason?: string;
  shotId?: string;
  fromSec?: number;
  toSec?: number;
  suggestedFix?: string;
}

/** Jev's probabilities: a criterion fails under 0.3 and is borderline under 0.7; a risk is flagged from 0.7. */
export function fromJev(answers: Record<string, number>, criteria: Criterion[], risks: Criterion[]): Judgement[] {
  return [
    ...criteria.map((c): Judgement => {
      const p = answers[c.id] ?? 0;
      return { criterion: c, kind: "criterion", level: p >= YES ? "yes" : p <= NO ? "no" : "borderline" };
    }),
    ...risks.map((c): Judgement => ({ criterion: c, kind: "risk", level: (answers[c.id] ?? 0) >= YES ? "no" : "yes" })),
  ];
}

/** The LLM judge's answers: no fails a criterion, partly is borderline; a flagged risk is a finding. */
export function fromLlm(a: JudgeAnswer, criteria: Criterion[], risks: Criterion[]): Judgement[] {
  return [
    ...criteria.map((c): Judgement => {
      const x = a.criteria.find((y) => y.id === c.id)!;
      return { criterion: c, kind: "criterion", level: x.answer === "yes" ? "yes" : x.answer === "partly" ? "borderline" : "no", reason: x.reason, shotId: x.shotId, fromSec: x.fromSec, toSec: x.toSec, suggestedFix: x.suggestedFix };
    }),
    ...risks.map((c): Judgement => {
      const x = a.risks.find((y) => y.id === c.id)!;
      return { criterion: c, kind: "risk", level: x.flagged ? "no" : "yes", reason: x.reason, shotId: x.shotId, suggestedFix: x.suggestedFix };
    }),
  ];
}

const plain = (q: string) => q.replace(/`/g, "");

/**
 * FAIL when the main question fails or three criteria fail; REVIEW when anything failed, is
 * borderline or flagged; PASS otherwise. A failed criterion is a should-fix, a borderline one polish,
 * a flagged risk a should-fix: nothing here blocks export.
 */
export function creativeVerdict(judgements: Judgement[]): { status: VerdictStatus; findings: NewFinding[] } {
  const criteria = judgements.filter((j) => j.kind === "criterion");
  const failed = criteria.filter((j) => j.level === "no");
  const status: VerdictStatus = failed.some((j) => j.criterion.fail === "main") || failed.length >= 3 ? "FAIL"
    : judgements.some((j) => j.level !== "yes") ? "REVIEW" : "PASS";
  const findings = judgements.filter((j) => j.level !== "yes").map((j): NewFinding => {
    const risk = j.kind === "risk";
    const q = plain(j.criterion.question);
    return {
      severity: risk || j.level === "no" ? "should-fix" : "polish", shotId: j.shotId ?? null,
      ...(j.fromSec !== undefined ? { fromSec: j.fromSec } : {}), ...(j.toSec !== undefined ? { toSec: j.toSec } : {}),
      code: `creative.${j.criterion.id}`,
      description: j.reason || (risk ? `Possible risk: ${q}` : j.level === "no" ? `Not met: ${q}` : `Only partly met: ${q}`),
      ...(j.suggestedFix ? { suggestedFix: j.suggestedFix } : {}), state: "open", rule: j.criterion.id,
    };
  });
  return { status, findings };
}
