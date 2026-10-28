// Optional LLM judgement on scored clip candidates; the rule score is the
// fallback. With an LLM configured (llm.ts) each candidate's transcript is
// rated 0-100 with a reason and fresh post copy (title, description,
// hashtags), and the final score blends 50/50 with the rule score. The LLM
// sees the director's video brief and the creator's direction when there
// are some. Batches the LLM can't answer keep their rule score and template copy.
//
// Every segment gets `scoredBy` ("llm+rules" | "rules") and a plain-language
// `reason`, so the UI can show where a score came from.

import { LlmError, parseJson, type Llm } from "./llm";
import { mapPool } from "./pool";
import { pyRound } from "./pyCompat";
import type { GateResult } from "./clipGate";
import type { VideoBrief } from "./director";
import type { ScoredSegment } from "./scoring";
import type { Json } from "./types";

export const REVIEW_BATCH = 6;  // small batches fit the default 4k context of local models
export const LLM_WEIGHT = 0.5;
/** Batches in flight: a reasoning model takes ~1 min per batch; a local server just queues the second. */
export const REVIEW_CONCURRENCY = 2;
const MAX_TEXT = 1200;

export const REVIEW_SYSTEM = `You are a short-form video editor. You judge transcript excerpts of long
videos (podcasts, talk shows, stories) as candidates for 20-60 second vertical
clips on social platforms. A strong clip opens with a hook (a bold claim, a
question, conflict, a surprising fact), stands on its own without context, and
ends on a complete thought or punchline. Weak clips are greetings, sponsor
reads, filler, or need earlier context.

For every excerpt return:
- score: 0-100, how likely it is to hold viewers and get shared
- reason: one short English sentence explaining the score
- title: a punchy post title in the excerpt's language, max 70 characters, no hashtags
- description: 1-2 sentences in the excerpt's language
- hashtags: 3-6 relevant hashtags in the excerpt's language

The request may include "video" (its title, a summary and the people in it: spell their names that way)
and "direction" (what the creator wants from this video). With a direction, the score also says how well
the excerpt fits it, and the copy follows it.

Answer with JSON only: {"clips": [{"id": 0, "score": 0, "reason": "", "title": "", "description": "", "hashtags": []}]}`;

const FEATURE_LABELS: Record<string, string> = {
  hookStrength: "strong opening hook", keywordTrigger: "viral keywords", novelty: "surprising details",
  clarity: "clear, self-contained", emotionalEnergy: "high energy", textSentiment: "strong emotion",
  pauseStructure: "good pacing", facePresence: "faces on screen", sceneChange: "visual variety",
  topicFit: "on your niche", historyScore: "like your past hits", motion: "movement", onsetDensity: "lively audio",
};

export type ReviewedSegment = ScoredSegment & {
  scoredBy: "llm+rules" | "jev+rules" | "rules"; reason: string; llmScore?: number; ruleScore?: number;
  /** Set when Jev scored it (jevDirector.ts), and the gate's result (clipGate.ts). */
  jevScore?: number; gate?: GateResult;
};

/** Plain-language reason from the strongest rule signals. */
export function rulesReason(scores: Record<string, number>): string {
  const top = Object.entries(scores).filter(([k]) => k in FEATURE_LABELS).sort((a, b) => b[1] - a[1]).slice(0, 2);
  if (!top.length || top[0]![1] < 0.5) return "Rule score: no standout signal";
  return `Rule score: ${top.filter(([, v]) => v >= 0.5).map(([k]) => FEATURE_LABELS[k]).join(", ")}`;
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function hashtags(tags: unknown, limit: number): string[] {
  const out: string[] = [];
  for (const raw of Array.isArray(tags) ? tags : []) {
    let t = String(raw).trim().replace(/\s+/g, "");
    if (t && !t.startsWith("#")) t = `#${t}`;
    if (t.length > 1 && !out.includes(t)) out.push(t);
  }
  return out.slice(0, limit);
}

/** Restated after the data: a model can lose a task stated only in the system prompt. */
// It must carry the scale: with only "score" here a model answered 1-10 (read as 0.01-0.10) in one run, 0-100 in the next.
export const REVIEW_TASK = 'Rate every excerpt with a score from 0 to 100 (100 = best clip). Answer with JSON only: '
  + '{"clips": [{"id": <id>, "score": <0-100>, "reason": "", "title": "", "description": "", "hashtags": []}]}.';

export interface ReviewContext {
  title?: string | null;
  brief?: VideoBrief | null;
  direction?: string;
}

async function ask(llm: Llm, batch: ScoredSegment[], offset: number, ctx: ReviewContext): Promise<Map<number, Json>> {
  const excerpts = batch.map((s, i) => ({
    id: offset + i, start: clock(s.startTime), seconds: Math.round(s.duration), text: s.text.slice(0, MAX_TEXT),
  }));
  const video = ctx.brief
    ? { title: ctx.title ?? "", summary: ctx.brief.summary, people: ctx.brief.people }
    : ctx.title ? { title: ctx.title } : null;
  const msg = await llm.chat([
    { role: "system", content: REVIEW_SYSTEM },
    { role: "user", content: JSON.stringify({
      ...(video ? { video } : {}), ...(ctx.direction ? { direction: ctx.direction } : {}), excerpts, task: REVIEW_TASK,
    }) },
  ], { temperature: 0.3 });
  const data = parseJson(msg.content);
  const clips = Array.isArray(data) ? data : (data as Json | null)?.clips;
  if (!Array.isArray(clips)) throw new LlmError("LLM reply had no clips list");
  return new Map(clips.filter((c): c is Json => !!c && typeof c === "object").map((c) => [Number(c.id), c]));
}

/**
 * Blend LLM judgement into scored segments (input order kept; re-sort after).
 * Returns the reviewed segments and the first LLM error, if any.
 */
export async function reviewClips(
  segments: ScoredSegment[], llm: Llm, tierOf: (score: number) => string, ctx: ReviewContext = {},
): Promise<{ segments: ReviewedSegment[]; error: string | null }> {
  // A moment the director picked keeps its "why" until a review replaces it.
  const out: ReviewedSegment[] = segments.map((s) => ({
    ...s, scoredBy: "rules", reason: typeof s.why === "string" && s.why ? `LLM pick: ${s.why}` : rulesReason(s.scores),
  }));
  if (!llm.enabled) return { segments: out, error: null };
  let error: string | null = null;
  const offsets = Array.from({ length: Math.ceil(out.length / REVIEW_BATCH) }, (_, i) => i * REVIEW_BATCH);
  await mapPool(offsets, REVIEW_CONCURRENCY, async (offset) => {
    const batch = out.slice(offset, offset + REVIEW_BATCH);
    let answers: Map<number, Json>;
    try {
      answers = await ask(llm, batch, offset, ctx);
    } catch (e) {
      if (!(e instanceof LlmError)) throw e;
      error ??= e.message;
      return;
    }
    batch.forEach((s, i) => {
      const a = answers.get(offset + i);
      const raw = Number(a?.score);
      if (!a || a.score === null || a.score === undefined || !Number.isFinite(raw)) return;
      const llmScore = Math.min(Math.max(raw, 0), 100) / 100;
      s.ruleScore = s.finalScore;
      s.llmScore = pyRound(llmScore, 4);
      s.finalScore = pyRound(LLM_WEIGHT * llmScore + (1 - LLM_WEIGHT) * s.ruleScore, 4);
      s.tier = tierOf(s.finalScore);
      s.scoredBy = "llm+rules";
      if (a.reason) s.reason = String(a.reason).trim().slice(0, 300);
      const title = String(a.title ?? "").trim();
      if (title) s.title = [title.slice(0, 80), ...hashtags(a.hashtags, 2)].join(" ");
      const desc = String(a.description ?? "").trim();
      if (desc) s.description = [desc.slice(0, 400), hashtags(a.hashtags, 7).join(" ")].filter(Boolean).join("\n");
    });
  });
  return { segments: out, error };
}
