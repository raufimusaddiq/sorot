// Quality gate for clip candidates, run after scoring and before render:
// PASS (render), REVIEW (render, but a person should look before posting) or
// FAIL (held back: tier SKIP, still listed and renderable on request).
//
// Jev answers a fixed set of atomic questions about the clip's transcript
// (docs/creative-loop.md has the reasoning behind each one). Without Jev, or
// when a call fails, the same questions are answered by deterministic text
// rules, so every gated clip gets a verdict either way (`by`: "jev" | "rules").
// The verdict itself is always decided here, in code, from those answers.

import { JevError, type Decision, type Jev, type Question } from "./jev";
import { mapPool } from "./pool";
import { pyRound } from "./pyCompat";
import * as R from "./textRules";

/** TypeSafe's suggested starting points for a Noul: ≥ 0.7 reads as yes, ≤ 0.3 as no.
 *  Not yet calibrated on Indonesian clips — scripts/jev-eval.ts measures them. */
export const YES = 0.7;
export const NO = 0.3;
/** A risk this likely sends the clip to REVIEW (a person decides; never an automatic FAIL). */
export const RISK = 0.5;
/** Payoff level (0-2) at or below this, answered with this confidence, fails the clip. */
export const NO_PAYOFF = 0.5;
export const PAYOFF_CONFIDENCE = 0.5;
/** Clips gated per video (best scores first) and Jev requests in flight. */
export const GATE_MAX = 40;
const CONCURRENCY = 4;
/** After this many Jev failures in a row the rest of the video uses the rules. */
const MAX_FAILURES = 3;
const MAX_EXCERPT = 3000;

export type Verdict = "PASS" | "REVIEW" | "FAIL";

export interface GateResult {
  verdict: Verdict;
  by: "jev" | "rules";
  /** The Jev build that answered; null for the rules. */
  model: string | null;
  /** Plain-language reasons, the deciding ones first. */
  reasons: string[];
  /** Noul probabilities by question id, and `payoff` as a level 0-2 (absent when unknown). */
  answers: Record<string, number>;
  /** Composite 0-1 of the quality answers (display, and a feature for later learning). */
  quality: number;
  /** The LLM title claimed more than the clip says and was replaced by the rule title. */
  titleReplaced?: boolean;
}

// ---- the questions --------------------------------------------------------
// One judgment per question, each naming the state field it reads, with
// criteria that describe what can be observed in the text (Jev reads
// literally, and English is its strongest language — the Indonesian examples
// show what the markers look like). Counting, lengths and timing stay in code.

// Jev has no system prompt — a request is `state` + `questions` — so the
// briefing rides in the state, as TypeSafe's state guide says ("the material
// you would present to a panel of experts"). Every request carries this
// `context`, describing only the fields that request sends.
const CONTEXT = {
  task: "Judging moments of a longer Indonesian video (a talk, podcast, interview, review or vlog) as short vertical clips "
    + "of 15 to 60 seconds for TikTok, Instagram Reels and YouTube Shorts.",
  viewer: "Each clip is posted on its own. Its viewers have not seen the rest of the video, decide within the first "
    + "seconds whether to keep watching, and stay only if the clip pays off.",
  text: "All text is Indonesian speech from speech recognition: punctuation is guessed and some words may be misheard.",
};
const FIELDS: Record<string, string> = {
  excerpt: "everything said in the clip, in order",
  opening: "the first sentence or two of `excerpt`",
  closing: "the last sentence or two of `excerpt`",
  title: "a title written for the clip",
  direction: "what the creator wants the clips to be about",
  lines: "the clip's lines in order; one of them may be replayed as a teaser before the clip starts",
  posts: "the post text written for each platform",
};

/** A Jev state: the shared context (describing the fields present), then the fields. */
export function jevState<T extends Record<string, unknown>>(fields: T): T & { context: Record<string, unknown> } {
  const described = Object.keys(fields).filter((k) => FIELDS[k]).map((k) => [k, FIELDS[k]]);
  return { context: { ...CONTEXT, fields: Object.fromEntries(described) }, ...fields };
}

export const QUALITY_QUESTIONS: Record<string, Question> = {
  hook_opening: {
    type: "noul",
    instructions: "Would `opening`, heard at the very start of a short video, make a viewer want to keep watching?",
    criteria: {
      true: "`opening` contains a direct question, a bold or surprising claim, a conflict or disagreement, a strong emotion, "
        + "a promise of what the viewer will learn, or the start of a story with tension. "
        + "Example: \"Kenapa orang kaya nggak pernah nabung di bank?\"",
      false: "`opening` is a greeting, thanks, filler words (\"oke\", \"jadi\", \"nah\"), a sponsor read, a calm neutral statement, "
        + "or a fragment that only makes sense after what came before. Example: \"Oke jadi, tadi kan kita udah bahas itu.\"",
    },
  },
  needs_prior_context: {
    type: "noul",
    instructions: "Does `excerpt` depend on something that was said before it started?",
    criteria: {
      true: "Following `excerpt` requires an earlier part of the video: it starts in the middle of a story or argument, "
        + "answers a question that is not inside `excerpt`, or refers to a person, thing or event "
        + "(\"dia\", \"itu\", \"yang tadi\", \"kayak tadi\") that `excerpt` never introduces.",
      false: "A first-time viewer can follow `excerpt` on its own: everything it refers to is introduced inside it, or is common knowledge.",
    },
  },
  ends_complete: {
    type: "noul",
    instructions: "Does `closing` finish the point that `excerpt` was making?",
    criteria: {
      true: "`closing` is a complete sentence that delivers the answer, conclusion, punchline or outcome of the story.",
      false: "`closing` stops mid-sentence, mid-list, right after a question, or before the answer, conclusion or punchline arrives.",
    },
  },
  mostly_filler: {
    type: "noul",
    instructions: "Is most of `excerpt` greetings, thanks, sponsor reads, channel promotion, housekeeping or small talk?",
    criteria: {
      true: "More than half of `excerpt` is hello or goodbye, thanking guests or viewers, asking to like, subscribe or follow, "
        + "a sponsor or product read, schedule or logistics talk, or chatter without a topic.",
      false: "Most of `excerpt` is about a real topic: a story, an opinion, an explanation, an argument, a joke or information.",
    },
  },
  payoff: {
    type: "score",
    instructions: "What does a viewer get from `excerpt` by watching it to the end?",
    criteria: [
      "Nothing to take away: no information, insight, joke, story outcome or emotional moment.",
      "A small takeaway: a minor point or a mild joke, or a payoff that arrives slowly and is diluted by unrelated talk.",
      "A clear takeaway: a memorable insight, useful information, a punchline, a story outcome or a strong emotional moment.",
    ],
  },
};

// Content risks are separate Nouls (not one Choice): they can co-occur, and a
// Choice leans toward its first option.
export const RISK_QUESTIONS: Record<string, Question> = {
  risk_accusation: {
    type: "noul",
    instructions: "Does `excerpt` accuse a named, real person, company or institution of a crime or wrongdoing?",
    criteria: {
      true: "A specific, identifiable person or organisation is said to have committed a crime, corruption, fraud, abuse, "
        + "cheating or other misconduct, or such a rumour about them is repeated.",
      false: "No identifiable person or organisation is accused of wrongdoing.",
    },
  },
  risk_sara: {
    type: "noul",
    instructions: "Does `excerpt` insult, mock or stereotype people because of their religion, ethnicity, race or group?",
    criteria: {
      true: "It contains insults, slurs, mockery or negative generalisations about a religion, ethnic group, race "
        + "or other social group (suku, agama, ras, antargolongan).",
      false: "Religion, ethnicity and groups are mentioned neutrally or not at all.",
    },
  },
  risk_sexual: {
    type: "noul",
    instructions: "Does `excerpt` describe sexual acts or intimate body parts explicitly?",
  },
  risk_dangerous: {
    type: "noul",
    instructions: "Does `excerpt` encourage or explain violence, self-harm, illegal drug use or another dangerous act?",
  },
  risk_health_money: {
    type: "noul",
    instructions: "Does `excerpt` present a health cure or a guaranteed money result as fact?",
    criteria: {
      true: "It says a treatment, product, food or habit cures or prevents an illness, or that an investment, business or scheme "
        + "guarantees profit, stated as fact.",
      false: "There is no such claim, or it is clearly framed as opinion, personal experience or with caveats.",
    },
  },
};

export const TITLE_QUESTION: Record<string, Question> = {
  title_overclaims: {
    type: "noul",
    instructions: "Does `title` claim something that `excerpt` does not say?",
    criteria: {
      true: "`title` states a fact, number, name, outcome or promise that is not in `excerpt`, or exaggerates what `excerpt` says.",
      false: "Everything `title` claims is said or clearly implied in `excerpt`.",
    },
  },
};

const RISK_LABELS: Record<string, string> = {
  risk_accusation: "may accuse a real person or company of wrongdoing",
  risk_sara: "may insult a religion, ethnicity or group (SARA)",
  risk_sexual: "may be sexually explicit",
  risk_dangerous: "may encourage violence or dangerous acts",
  risk_health_money: "may make a health or money claim as fact",
};

// ---- state ----------------------------------------------------------------

const SENTENCE = /(?<=[.!?…])\s+/;
const MIN_EDGE_CHARS = 60;

function edge(parts: string[], fromEnd: boolean): string {
  const picked: string[] = [];
  const order = fromEnd ? [...parts].reverse() : parts;
  for (const p of order) {
    picked.push(p);
    if (picked.join(" ").length >= MIN_EDGE_CHARS || picked.length >= 2) break;
  }
  return (fromEnd ? picked.reverse() : picked).join(" ");
}

/** The first and last sentence or two (code finds them, so no question has to). */
export function openingAndClosing(text: string): { opening: string; closing: string } {
  const clean = text.replace(/\s+/g, " ").trim();
  const sentences = clean.split(SENTENCE).filter(Boolean);
  if (sentences.length >= 2) return { opening: edge(sentences, false), closing: edge(sentences, true) };
  // Unpunctuated speech: the first and last 25 words.
  const words = clean.split(" ").filter(Boolean);
  return { opening: words.slice(0, 25).join(" "), closing: words.slice(-25).join(" ") };
}

/** Title as Jev should read it: without hashtags. */
export const plainTitle = (title: string) => title.replace(/#\S+/g, "").replace(/\s+/g, " ").trim();

export function gateState(text: string, title?: string | null, direction?: string) {
  const { opening, closing } = openingAndClosing(text);
  return jevState({
    opening,
    closing,
    excerpt: text.slice(0, MAX_EXCERPT),
    ...(title ? { title: plainTitle(title) } : {}),
    ...(direction ? { direction } : {}),
  });
}

export function gateQuestions(withTitle: boolean): Record<string, Question> {
  return { ...QUALITY_QUESTIONS, ...RISK_QUESTIONS, ...(withTitle ? TITLE_QUESTION : {}) };
}

// ---- the verdict (code, not the model) ------------------------------------

/** Weighted 0-1 of the quality answers present (missing ones are left out of the average). */
export function qualityOf(a: Record<string, number>): number {
  const parts: Array<[number, number | undefined]> = [
    [0.25, a.hook_opening], [0.25, a.needs_prior_context === undefined ? undefined : 1 - a.needs_prior_context],
    [0.15, a.ends_complete], [0.10, a.mostly_filler === undefined ? undefined : 1 - a.mostly_filler],
    [0.25, a.payoff === undefined ? undefined : a.payoff / 2],
  ];
  const present = parts.filter((p): p is [number, number] => p[1] !== undefined);
  const weight = present.reduce((s, [w]) => s + w, 0);
  return weight ? pyRound(present.reduce((s, [w, v]) => s + w * v, 0) / weight, 3) : 0;
}

/** Clip order: clips the gate held back (FAIL) after the rest, then the best score first. */
export function heldLast(a: { gate?: { verdict: string } | null; finalScore: number }, b: { gate?: { verdict: string } | null; finalScore: number }): number {
  const held = (s: typeof a) => (s.gate?.verdict === "FAIL" ? 1 : 0);
  return held(a) - held(b) || b.finalScore - a.finalScore;
}

export function verdictFrom(a: Record<string, number>, payoffConfidence: number | null = null): { verdict: Verdict; reasons: string[] } {
  const fails: string[] = [];
  if ((a.mostly_filler ?? 0) >= YES) fails.push("mostly greetings, promos or small talk");
  if ((a.needs_prior_context ?? 0) >= YES) fails.push("needs earlier context to make sense");
  const weakOpening = a.hook_opening !== undefined && a.hook_opening <= NO;
  const cutOff = a.ends_complete !== undefined && a.ends_complete <= NO;
  if (weakOpening && cutOff) fails.push("weak opening and a cut-off ending");
  if (a.payoff !== undefined && a.payoff <= NO_PAYOFF && (payoffConfidence ?? 0) >= PAYOFF_CONFIDENCE) {
    fails.push("no clear payoff");
  }
  const risks = Object.keys(RISK_LABELS).filter((k) => (a[k] ?? 0) >= RISK).map((k) => RISK_LABELS[k] as string);
  const notes: string[] = [];
  if (weakOpening && !cutOff) notes.push("weak opening");
  if (cutOff && !weakOpening) notes.push("ending is cut off");
  const verdict: Verdict = fails.length ? "FAIL" : risks.length ? "REVIEW" : "PASS";
  return { verdict, reasons: [...fails, ...risks, ...notes] };
}

// ---- deterministic fallback -----------------------------------------------

/** Openings that continue an earlier thought ("and / but / so / because …"). */
const CONTINUATION = /^(dan|tapi|tetapi|terus|trus|lalu|makanya|soalnya|karena|karna|sehingga|sedangkan|padahal)\b/;
/** Openings that point at someone or something introduced earlier. */
const BACK_REFERENCE = /^(dia|mereka|beliau|itu|gitu|begitu|yang tadi|kayak tadi)\b|\b(yang tadi|kayak tadi|seperti tadi|barusan)\b/;
/** Words a finished Indonesian sentence can't end on (conjunctions, prepositions, "is"). */
const CONNECTOR_END = /\b(dan|tapi|terus|karena|yang|jadi|atau|kalau|kayak|untuk|sama|dengan|adalah|yaitu|yakni|bahwa|seperti|misalnya|di|ke|dari|pada|buat|biar|supaya|agar)$/;
const FILLER = /\b(halo|hai|assalamualaikum|selamat (pagi|siang|sore|malam)|terima ?kasih|makasih|subscribe|like|follow|share|sponsor|disponsori|promo|voucher|link (di|ada di) (bio|deskripsi)|jangan lupa|ketemu lagi|sampai jumpa)\b/;
// Keyword checks only: they flag clips for a person to look at (REVIEW), nothing more.
const RISK_WORDS: Record<string, RegExp> = {
  risk_accusation: /\b(korupsi|koruptor|penipu|penipuan|menipu|nipu|maling|mencuri|nyolong|selingkuh|tersangka|pelecehan|suap|disuap|pungli|scammer|menggelapkan|penggelapan)\b/,
  // Labels used as insults, or "<group> … all / always … <bad trait>" generalisations.
  risk_sara: /\b(kafir|kadrun|cebong|kampret|aseng|antek asing)\b|\b(orang|suku|agama|etnis|ras|bangsa)\b[^.!?]{0,40}\b(semua(nya)?|pasti|memang|selalu)\b[^.!?]{0,20}\b(pelit|licik|bodoh|malas|jahat|kotor|penipu|curang)\b/,
  risk_sexual: /\b(seks|ngeseks|ngewe|bokep|porno|telanjang|bugil)\b/,
  risk_dangerous: /\b(bunuh diri|narkoba|sabu|ganja|tawuran|bacok|sampai pingsan|jangan ditiru)\b/,
  risk_health_money: /\b(pasti|dijamin|garansi)\b[^.!?]{0,40}\b(untung|cuan|kaya|sembuh)\b|\b(menyembuhkan|sembuh total|obat ampuh|anti rugi)\b/,
};

/** The same questions answered by text rules (no payoff or title answer: rules can't judge those). */
export function ruleAnswers(text: string): Record<string, number> {
  const { opening, closing } = openingAndClosing(text);
  const open = opening.toLowerCase().replace(/^[^\p{L}]+/u, "");
  const close = closing.toLowerCase().trim();
  const sentences = text.toLowerCase().split(SENTENCE).filter(Boolean);
  const fillerShare = sentences.length ? sentences.filter((s) => FILLER.test(s)).length / sentences.length : 0;
  const lower = text.toLowerCase();
  const endsPunct = /[.!…]$/.test(close);
  const bare = close.replace(/[^\p{L}\p{N}\s]+$/u, "");
  return {
    // A greeting or promo opening is no hook, however short.
    hook_opening: FILLER.test(open.split(SENTENCE)[0] ?? "") ? 0.1 : R.hookStrength(opening),
    needs_prior_context: CONTINUATION.test(open) ? 0.8 : BACK_REFERENCE.test(open) ? 0.6 : 0.2,
    // Ending on a question asks something the clip doesn't answer: leans "no".
    ends_complete: /[,;:\-–]$/.test(close) || CONNECTOR_END.test(bare) ? 0.15 : endsPunct ? 0.8 : close.endsWith("?") ? 0.3 : 0.5,
    mostly_filler: fillerShare > 0.5 ? 0.8 : fillerShare > 0.25 ? 0.5 : 0.1,
    ...Object.fromEntries(Object.entries(RISK_WORDS).map(([k, re]) => [k, re.test(lower) ? 0.6 : 0.05])),
  };
}

export function ruleGate(text: string): GateResult {
  const answers = ruleAnswers(text);
  return { ...verdictFrom(answers), by: "rules", model: null, answers, quality: qualityOf(answers) };
}

// ---- Jev ------------------------------------------------------------------

export function fromDecision(d: Decision): GateResult {
  const answers: Record<string, number> = {};
  let payoffConfidence: number | null = null;
  for (const [id, a] of Object.entries(d.answers)) {
    if (a.type === "noul") answers[id] = pyRound(a.noul, 4);
    else if (a.type === "score") {
      answers[id] = pyRound(a.score, 4);
      payoffConfidence = a.confidence;
    }
  }
  const { verdict, reasons } = verdictFrom(answers, payoffConfidence);
  return { verdict, reasons, by: "jev", model: d.model, answers, quality: qualityOf(answers) };
}

export interface Gateable {
  text: string;
  title: string;
  tier: string;
  finalScore: number;
  scoredBy?: string;
  gate?: GateResult;
  reason?: string;
}

/**
 * Gate the best `GATE_MAX` clips in the render tiers (others are left as
 * they are). Jev when enabled; any clip it can't answer gets the rules.
 * FAIL moves a clip to SKIP; an over-claiming LLM title is replaced by the
 * rule title. Mutates and returns the segments, plus the first Jev error.
 */
export async function gateClips<T extends Gateable>(
  segments: T[], jev: Jev, renderTiers: string[],
): Promise<{ segments: T[]; error: string | null; by: "jev" | "rules" | "mixed" | null }> {
  const targets = segments.filter((s) => renderTiers.includes(s.tier))
    .sort((a, b) => b.finalScore - a.finalScore).slice(0, GATE_MAX);
  let error: string | null = null;
  let failures = 0;
  await mapPool(targets, CONCURRENCY, async (s) => {
    const askTitle = s.scoredBy === "llm+rules" && !!plainTitle(s.title);
    let result: GateResult | null = null;
    if (jev.enabled && failures < MAX_FAILURES) {
      try {
        result = fromDecision(await jev.decide(gateState(s.text, askTitle ? s.title : null), gateQuestions(askTitle)));
        failures = 0;
      } catch (e) {
        if (!(e instanceof JevError)) throw e;
        error ??= e.message;
        failures++;
      }
    }
    result ??= ruleGate(s.text);
    if ((result.answers.title_overclaims ?? 0) >= YES) {
      s.title = R.clipTitle(s.text, s.tier);
      result.titleReplaced = true;
      result.reasons.push("LLM title claimed more than the clip says; replaced");
    }
    if (result.verdict === "FAIL") {
      s.tier = "SKIP";
      s.reason = `Held back: ${result.reasons[0]}. ${s.reason ?? ""}`.trim();
    }
    s.gate = result;
  });
  const used = new Set(targets.map((s) => s.gate?.by));
  const by = targets.length === 0 ? null : used.size > 1 ? "mixed" : (used.values().next().value as "jev" | "rules");
  return { segments, error, by };
}
