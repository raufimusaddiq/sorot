// Jev-first creative decisions: code proposes, Jev judges and chooses.
//
// Jev can't write, but it judges fast (~40 ms server time), cheaply and
// stably (repeated requests moved ≤ 0.04 in our test) — so instead of an LLM
// reading the transcript and inventing clips, code enumerates every window
// that starts on a sentence and Jev judges them all (SEGMENT); every final
// candidate gets the full gate questions, which give both its score and its
// verdict (SCORE); and for clips that will render, Jev picks the hook line
// (one Noul per line, ads excluded) and a title quoted from the clip.
// Measured on a real 10-min transcript: 232 windows in 3.8 s for ~$0.011;
// it found the LLM director's moments and two stronger ones.
//
// When a Jev call fails the clip keeps the rules' answers (clipGate.ts
// `ruleGate`); after MAX_FAILURES in a row the rest of the video does too.

import { gateQuestions, gateState, jevState, NO, qualityOf, QUALITY_QUESTIONS, ruleGate, verdictFrom, YES, type GateResult } from "./clipGate";
import { dropOverlaps, hookSpan, type Line } from "./director";
import { JevError, type Jev, type Question } from "./jev";
import { mapPool } from "./pool";
import { pyRound } from "./pyCompat";
import * as R from "./textRules";

export const MIN_SEC = 15;
/** A window grows to at least this long, then ends at the next sentence end. */
export const TARGET_SEC = 25;
export const MAX_SEC = 60;
/** Longer cuts of each Jev pick (same start, grown to these, then to a sentence end); the best-judged one is kept. */
export const LONGER_SEC = [40, 55];
/** A longer cut must add at least this much to be worth asking about. */
const MIN_GROWTH_SEC = 5;
/**
 * Jev's questions favour tight excerpts (Bahlul, 69 min: the 25 s cut won for
 * 27 of 31 picks, usually by a hair). A longer cut wins when it is this close.
 */
export const LONGER_SLACK = 0.05;
/** Windows Jev keeps after screening (the rule windows are kept as well). */
export const JEV_PICKS = 40;
/** Final candidates judged with the full questions (best rule scores first, plus every Jev pick). */
export const JUDGE_MAX = 200;
const CONCURRENCY = 6;
const MAX_FAILURES = 3;
const TERMINAL = /[.!?…]["')\]]*$/;
const PAUSE_SEC = 0.6;

export const DIRECTION_QUESTION: Record<string, Question> = {
  fits_direction: {
    type: "noul",
    instructions: "Does `excerpt` match what `direction` asks for?",
    criteria: {
      true: "The excerpt is mainly about what `direction` asks for.",
      false: "The excerpt is mainly about something `direction` excludes or does not mention.",
    },
  },
};

/** Screening asks only the quality questions (risks are asked of the final candidates). */
const SCREEN_QUESTIONS = QUALITY_QUESTIONS;

export interface Window {
  startTime: number;
  endTime: number;
  duration: number;
  text: string;
}

/**
 * Line j ends a sentence: it ends with . ! ? … or a pause follows it. Whisper
 * sometimes drops punctuation for a whole video; the pauses still mark sentences.
 */
function endsSentence(lines: Line[], j: number): boolean {
  const next = lines[j + 1];
  return TERMINAL.test(lines[j]!.text.trim()) || !next || next.start - lines[j]!.end >= PAUSE_SEC;
}

/**
 * One window per line that starts a sentence (the first line, or after a
 * sentence end): it grows to TARGET_SEC, then to the next sentence end, never
 * past MAX_SEC; shorter than MIN_SEC is dropped.
 */
export function sentenceWindows(lines: Line[]): Window[] {
  const out: Window[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && !endsSentence(lines, i - 1)) continue;
    const w = windowAt(lines, i, TARGET_SEC);
    if (w) out.push(w);
  }
  return out;
}

/** The window starting at line i, grown to `target` s then to the next sentence end; null outside MIN_SEC-MAX_SEC. */
export function windowAt(lines: Line[], i: number, target: number): Window | null {
  const start = lines[i]!.start;
  let j = i;
  while (j + 1 < lines.length && lines[j + 1]!.end - start <= MAX_SEC
    && (lines[j]!.end - start < target || !endsSentence(lines, j))) j++;
  const end = lines[j]!.end;
  if (end - start < MIN_SEC || end - start > MAX_SEC) return null;
  return { startTime: pyRound(start, 2), endTime: pyRound(end, 2), duration: pyRound(end - start, 2),
    text: lines.slice(i, j + 1).map((l) => l.text.trim()).join(" ") };
}

/** Jev's 0-1 judgement: the quality composite, or 50/50 with the direction fit when there is one. */
export function jevScore(answers: Record<string, number>): number {
  const q = qualityOf(answers);
  return pyRound(answers.fits_direction === undefined ? q : 0.5 * q + 0.5 * answers.fits_direction, 4);
}

const SIGNALS: Array<[string, (a: Record<string, number>) => boolean]> = [
  ["strong opening", (a) => (a.hook_opening ?? 0) >= YES],
  ["stands alone", (a) => a.needs_prior_context !== undefined && a.needs_prior_context <= NO],
  ["complete ending", (a) => (a.ends_complete ?? 0) >= YES],
  ["clear payoff", (a) => (a.payoff ?? 0) >= 1.5],
  ["fits your direction", (a) => (a.fits_direction ?? 0) >= YES],
];

/** Plain-language reason from Jev's answers (Jev itself gives none). */
export function jevReason(answers: Record<string, number>): string {
  const good = SIGNALS.filter(([, ok]) => ok(answers)).map(([label]) => label);
  return good.length ? `Jev: ${good.join(", ")}` : "Jev: no standout signal";
}

function toGate(answers: Record<string, number>, model: string, payoffConfidence: number | null): GateResult {
  const { verdict, reasons } = verdictFrom(answers, payoffConfidence);
  return { verdict, reasons, by: "jev", model, answers, quality: qualityOf(answers) };
}

/** Ask one request; numbers by question id plus the payoff confidence. */
async function ask(jev: Jev, state: Record<string, unknown>, questions: Record<string, Question>) {
  const d = await jev.decide(state, questions);
  const answers: Record<string, number> = {};
  let payoffConfidence: number | null = null;
  for (const [id, a] of Object.entries(d.answers)) {
    if (a.type === "noul") answers[id] = pyRound(a.noul, 4);
    else if (a.type === "score") {
      answers[id] = pyRound(a.score, 4);
      payoffConfidence = a.confidence;
    }
  }
  return { answers, payoffConfidence, model: d.model, tokens: d.inputTokens };
}

/** Runs `fn` over items with Jev; stops calling it after MAX_FAILURES in a row. Returns the first error. */
async function withJev<T, R>(items: T[], fn: (item: T) => Promise<R>, onDone?: (n: number) => void) {
  let failures = 0;
  let done = 0;
  let error: string | null = null;
  const results = await mapPool(items, CONCURRENCY, async (item) => {
    let r: R | null = null;
    if (failures < MAX_FAILURES) {
      try {
        r = await fn(item);
        failures = 0;
      } catch (e) {
        if (!(e instanceof JevError)) throw e;
        error ??= e.message;
        failures++;
      }
    }
    onDone?.(++done);
    return r;
  });
  return { results, error };
}

export interface Pick extends Window {
  source: "jev";
  jevScore: number;
}

/**
 * Judge every sentence window (text only) and keep the best JEV_PICKS that
 * aren't FAIL, without overlaps. Windows Jev couldn't answer are skipped.
 */
export async function screenMoments(
  jev: Jev, windows: Window[], direction: string, onProgress?: (done: number, total: number) => void,
): Promise<{ picks: Pick[]; judged: number; tokens: number; error: string | null }> {
  const questions = { ...SCREEN_QUESTIONS, ...(direction ? DIRECTION_QUESTION : {}) };
  let tokens = 0;
  const { results, error } = await withJev(windows, async (w) => {
    const r = await ask(jev, gateState(w.text, null, direction), questions);
    tokens += r.tokens;
    return { w, r };
  }, (n) => onProgress?.(n, windows.length));
  const ok = results.filter((x): x is NonNullable<typeof x> => !!x)
    .filter(({ r }) => verdictFrom(r.answers, r.payoffConfidence).verdict !== "FAIL")
    .map(({ w, r }): Pick => ({ ...w, source: "jev", jevScore: jevScore(r.answers) }))
    .sort((a, b) => b.jevScore - a.jevScore);
  return { picks: dropOverlaps(ok).slice(0, JEV_PICKS), judged: results.filter(Boolean).length, tokens, error };
}

/**
 * Screening judges ~25 s windows, so every pick would be ~25 s. Ask Jev about
 * longer cuts of each pick (LONGER_SEC, same start, at most MAX_SEC) and keep
 * the longest one within LONGER_SLACK of the best-judged; FAIL cuts are out.
 */
export async function growPicks(
  jev: Jev, picks: Pick[], lines: Line[], direction: string, onProgress?: (done: number, total: number) => void,
): Promise<{ picks: Pick[]; grown: number; tokens: number; error: string | null }> {
  const questions = { ...SCREEN_QUESTIONS, ...(direction ? DIRECTION_QUESTION : {}) };
  const cuts: Array<{ pick: Pick; w: Window }> = [];
  for (const pick of picks) {
    const i = lines.findIndex((l) => pyRound(l.start, 2) === pick.startTime);
    if (i < 0) continue;
    let longest = pick.endTime;
    for (const target of LONGER_SEC) {
      const w = windowAt(lines, i, target);
      if (w && w.endTime >= longest + MIN_GROWTH_SEC) {
        cuts.push({ pick, w });
        longest = w.endTime;
      }
    }
  }
  let tokens = 0;
  const { results, error } = await withJev(cuts, async ({ w }) => {
    const r = await ask(jev, gateState(w.text, null, direction), questions);
    tokens += r.tokens;
    return r;
  }, (n) => onProgress?.(n, cuts.length));
  // Each pick and its passing cuts, shortest first.
  const options = new Map<Pick, Pick[]>(picks.map((p) => [p, [p]]));
  cuts.forEach(({ pick, w }, k) => {
    const r = results[k];
    if (!r || verdictFrom(r.answers, r.payoffConfidence).verdict === "FAIL") return;
    options.get(pick)!.push({ ...w, source: "jev", jevScore: jevScore(r.answers) });
  });
  const out = picks.map((p) => {
    const all = options.get(p)!;
    const top = Math.max(...all.map((c) => c.jevScore));
    return all.findLast((c) => c.jevScore >= top - LONGER_SLACK)!;
  });
  const grown = out.filter((p, k) => p !== picks[k]).length;
  return { picks: dropOverlaps(out.sort((a, b) => b.jevScore - a.jevScore)), grown, tokens, error };
}

export interface Judgeable {
  text: string;
  tier: string;
  finalScore: number;
  scoredBy?: string;
  reason?: string;
  gate?: GateResult;
  ruleScore?: number;
  jevScore?: number;
  source?: unknown;
}

/**
 * The full gate questions (+ direction fit) for each candidate: its score
 * (50/50 with the rule score) and its verdict come from the same answers.
 * Only the best JUDGE_MAX by rule score (and every Jev pick) are asked; the
 * rest, and any Jev failure, keep the rule score and get the rules' verdict.
 */
export async function judgeClips<T extends Judgeable>(
  jev: Jev, segments: T[], direction: string, tierOf: (score: number) => string,
  onProgress?: (done: number, total: number) => void,
): Promise<{ error: string | null; judged: number }> {
  const byRule = [...segments].sort((a, b) => b.finalScore - a.finalScore);
  const asked = new Set([...byRule.slice(0, JUDGE_MAX), ...segments.filter((s) => s.source === "jev")]);
  const targets = segments.filter((s) => asked.has(s));
  const questions = { ...gateQuestions(false), ...(direction ? DIRECTION_QUESTION : {}) };
  const { results, error } = await withJev(targets,
    (s) => ask(jev, gateState(s.text, null, direction), questions),
    (n) => onProgress?.(n, targets.length));
  targets.forEach((s, i) => {
    const r = results[i];
    if (!r) return;
    const js = jevScore(r.answers);
    s.ruleScore = s.finalScore;
    s.jevScore = js;
    s.finalScore = pyRound(0.5 * js + 0.5 * s.finalScore, 4);
    s.tier = tierOf(s.finalScore);
    s.scoredBy = "jev+rules";
    s.reason = jevReason(r.answers);
    s.gate = toGate(r.answers, r.model, r.payoffConfidence);
  });
  for (const s of segments) {
    if (s.gate) continue;
    const g = ruleGate(s.text);
    if (renderable(s.tier)) s.gate = g;   // as gateClips: only render tiers get a verdict
  }
  for (const s of segments) {
    if (s.gate?.verdict === "FAIL") {
      s.tier = "SKIP";
      s.reason = `Held back: ${s.gate.reasons[0]}. ${s.reason ?? ""}`.trim();
    }
  }
  return { error, judged: results.filter(Boolean).length };
}

const renderable = (tier: string) => tier === "PRIMARY" || tier === "BACKUP";

/** Sentences of a clip usable as a title (a quote can't claim more than the clip says). */
export function titleCandidates(text: string): string[] {
  return text.split(/(?<=[.!?…])\s+/).map((s) => s.trim()).filter((s) => s.length >= 15 && s.length <= 110);
}

/** Is this line an ad? Asked per line next to its hook question (a single Choice picked a sponsor read). */
function adQuestion(ref: string): Question {
  return {
    type: "noul",
    instructions: `Is ${ref} an advertisement, a sponsor read or a request to like, subscribe or follow?`,
    criteria: {
      true: `${ref} promotes a sponsor's product, deal or code, or asks viewers to like, subscribe, follow or share. `
        + "Example: \"Pakai kode SOROT buat diskon 20%.\"",
      false: `${ref} is part of the conversation, even when it names a product or brand.`,
    },
  };
}

/**
 * Hook line and title for one clip. Every line gets the gate's hook question
 * (one Noul per line), so a teaser is measured against the clip's own opening
 * (line 0): a strong opening needs no replay; otherwise the best non-ad line
 * from 3 s on is replayed if it is a strong hook, or at least better than even
 * when the opening is clearly weak. `hook: null` is Jev's decision (no replay);
 * undefined when there was no line to ask about (the rules decide).
 * Title: Jev's choice among the clip's sentences — a quote, so it can't claim
 * more than the clip says.
 */
export async function hookAndTitle(
  jev: Jev, clipLines: Line[], clipStart: number, text: string,
): Promise<{ hook?: [number, number] | null; title: string | null }> {
  const hookQ = QUALITY_QUESTIONS.hook_opening as Extract<Question, { type: "noul" }>;
  const ref = (i: number) => `\`lines.L${i}\``;
  const questions: Record<string, Question> = {};
  const eligible = clipLines.map((l, i) => ({ l, i })).filter(({ l }) => l.start - clipStart >= 3);
  if (eligible.length) clipLines.forEach((_, i) => {
    questions[`hook_${i}`] = {
      type: "noul", instructions: hookQ.instructions.replace("`opening`", ref(i)),
      criteria: { true: hookQ.criteria!.true.replaceAll("`opening`", ref(i)), false: hookQ.criteria!.false.replaceAll("`opening`", ref(i)) },
    };
  });
  for (const { i } of eligible) questions[`ad_${i}`] = adQuestion(ref(i));
  const sentences = titleCandidates(text);
  if (sentences.length >= 2) {
    questions.title = {
      type: "choice",
      instructions: "Which of these sentences from `excerpt`, used as the clip's post title, would make the most viewers want to watch it?",
      criteria: Object.fromEntries(sentences.map((s, i) => [`S${i}`, s])),   // options described by the sentence itself
    };
  }
  if (!Object.keys(questions).length) return { title: sentences[0] ?? null };
  const d = await jev.decide(jevState({
    lines: Object.fromEntries(clipLines.map((l, i) => [`L${i}`, l.text.trim()])),
    ...(questions.title ? { excerpt: text.slice(0, 3000) } : {}),
  }), questions);
  const p = (id: string) => { const a = d.answers[id]; return a?.type === "noul" ? a.noul : 0; };
  const opening = p("hook_0");
  const best = eligible.filter(({ i }) => p(`ad_${i}`) < 0.5).sort((a, b) => p(`hook_${b.i}`) - p(`hook_${a.i}`))[0];
  const strength = best ? p(`hook_${best.i}`) : 0;
  const replay = opening < YES && (strength >= YES || (opening <= NO && strength >= 0.5));
  const hook = !eligible.length ? undefined : best && replay ? hookSpan(best.l) : null;
  const t = d.answers.title;
  const title = t?.type === "choice" ? sentences[Number(t.choice.slice(1))] ?? null : sentences[0] ?? null;
  return { hook, title };
}

/** The quote title with the rule hashtags, within the old title limits. */
export function quoteTitle(quote: string, text: string, tier: string): string {
  const tags = R.selectHashtags(text, tier, 2);
  const t = quote.length > 80 ? `${quote.slice(0, 77)}...` : quote;
  return [t, ...tags].join(" ").slice(0, 100);
}
