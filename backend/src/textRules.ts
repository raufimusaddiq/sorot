// Rule-based text signals for clip scoring and discovery, ported from
// ai-pipeline/features/text.py, context.py and score.py's copy templates.
// Hand-written Indonesian heuristics — not a trained model. Outputs match the
// Python originals exactly (tests/fixtures/text-rules.json).

import { readdirSync, readFileSync } from "node:fs";
import { cpLen, cpSlice, pyIsDigit, pyIsUpper, pyRound, pySplit } from "./pyCompat";
import {
  BOOST_CONDITIONS, CONFLICT_WORDS, CONVERSATION_MARKERS, CTA_PHRASES, EMOTION_WORDS, GENERIC_HASHTAGS,
  HASHTAG_MAP, HOOK_PHRASES, KEYWORD_TRIGGERS, NEGATIVE_WORDS, PENALTY_CONDITIONS, POSITIVE_WORDS, QUESTION_WORDS,
} from "./ruleConstants";

const has = (hay: string, words: string[]) => words.some((w) => hay.includes(w));
const count = (hay: string, words: string[]) => words.filter((w) => hay.includes(w)).length;

/** Up to the first `.`, `?` or `!` (in that priority, as the original), else the first comma clause. */
export function firstSentence(text: string): string {
  for (const delim of [".", "?", "!"]) {
    const idx = text.indexOf(delim);
    if (idx > 0) return text.slice(0, idx + 1);
  }
  return text.includes(",") ? (text.split(",")[0] as string) : text;
}

export function hookStrength(text: string): number {
  const first = firstSentence(text);
  const lower = first.toLowerCase();
  const isQuestion = first.includes("?");
  const hasHook = has(lower, HOOK_PHRASES);
  const words = pySplit(lower);
  const hasQuestionWord = QUESTION_WORDS.slice(0, 5).some((w) => words.includes(w));
  const isShort = pySplit(first).length < 10;
  if (isQuestion && hasHook) return 1.0;
  if (hasHook && isShort) return 0.9;
  if (isQuestion || hasHook) return 0.7;
  if (hasQuestionWord) return 0.6;
  if (isShort) return 0.4;
  return 0.2;
}

// ---- keyword trigger: static list, or TF-IDF over data/corpus/*.txt when present ----

const TOKEN_RE = /(?<![\p{L}\p{N}_])[\p{L}\p{N}_]{3,}(?![\p{L}\p{N}_])/gu;
const corpusCache = new Map<string, Record<string, number> | null>();

/** `{token: idf}` from `dir/*.txt` (one document each); null with fewer than 2 documents. */
export function loadKeywordCorpus(dir: string): Record<string, number> | null {
  if (corpusCache.has(dir)) return corpusCache.get(dir) ?? null;
  let docs: Set<string>[] = [];
  try {
    docs = readdirSync(dir)
      .filter((n) => n.toLowerCase().endsWith(".txt"))
      .map((n) => new Set(readFileSync(`${dir}/${n}`, "utf8").toLowerCase().match(TOKEN_RE) ?? []))
      .filter((d) => d.size > 0);
  } catch {
    docs = [];
  }
  let idf: Record<string, number> | null = null;
  if (docs.length >= 2) {
    const df = new Map<string, number>();
    for (const d of docs) for (const t of d) df.set(t, (df.get(t) ?? 0) + 1);
    const out: Record<string, number> = {};
    for (const [t, f] of df) if (f >= 2 && f <= 0.8 * docs.length) out[t] = Math.log(1 + docs.length / f);
    idf = Object.keys(out).length ? out : null;
  }
  corpusCache.set(dir, idf);
  return idf;
}

export function clearKeywordCorpusCache() {
  corpusCache.clear();
}

function keywordTfidf(text: string, idf: Record<string, number>): number {
  const tokens = text.toLowerCase().match(TOKEN_RE) ?? [];
  if (tokens.length === 0) return 0.1;
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  let total = 0;
  let matched = 0;
  for (const [t, c] of tf) {
    const w = idf[t];
    if (w === undefined) continue;
    total += c * w;
    matched++;
  }
  if (matched === 0) return 0.1;
  const density = total / tokens.length;
  if (density > 0.8) return 1.0;
  if (density > 0.5) return 0.85;
  if (density > 0.25) return 0.65;
  if (density > 0.1) return 0.4;
  return 0.2;
}

export function keywordTrigger(text: string, corpusDir?: string): number {
  const idf = corpusDir ? loadKeywordCorpus(corpusDir) : null;
  if (idf) return keywordTfidf(text, idf);
  const n = count(text.toLowerCase(), KEYWORD_TRIGGERS);
  const density = n / Math.max(pySplit(text).length / 10, 1);
  if (n >= 4 || density > 0.8) return 1.0;
  if (n >= 3) return 0.85;
  if (n === 2) return 0.65;
  if (n === 1) return 0.4;
  return 0.1;
}

export function novelty(text: string): number {
  let s = 0.15;
  const lower = text.toLowerCase();
  if (Array.from(text).some(pyIsDigit)) s += 0.25;
  const proper = pySplit(text).filter((w) => cpLen(w) > 3 && pyIsUpper(Array.from(w)[0] as string)).length;
  if (proper >= 2) s += 0.25;
  else if (proper >= 1) s += 0.15;
  if (has(lower, ["pertama", "kedua", "ketiga", "keempat", "terakhir"])) s += 0.2;
  if (has(lower, ["ternyata", "nyatanya", "faktanya", "malah", "justru", "bohong"])) s += 0.2;
  return Math.min(s, 1.0);
}

export function clarity(duration: number, text: string): number {
  let base = duration < 15 ? 0.9 : duration < 30 ? 0.85 : duration < 45 ? 0.7 : duration < 60 ? 0.55 : 0.4;
  if (has(text.toLowerCase(), ["jadi", "maksudnya", "singkatnya", "intinya", "artinya", "maksud gue"])) {
    base = Math.min(base + 0.15, 1.0);
  }
  return base;
}

export function sentiment(text: string): number {
  const lower = text.toLowerCase();
  const pos = count(lower, POSITIVE_WORDS);
  const neg = count(lower, NEGATIVE_WORDS);
  const total = pos + neg;
  if (total === 0) return 0.5;
  const confidence = Math.min(total / 5.0, 1.0);
  return pyRound(Math.max(0, Math.min(1, 0.5 + (pos / total - 0.5) * confidence)), 4);
}

/** Text half of emotional energy (emotion words, `!`, shouted words), 0.3–1.0. */
export function energyText(text: string): number {
  let s = 0.3;
  const n = count(text.toLowerCase(), EMOTION_WORDS);
  const excl = text.split("!").length - 1;
  const caps = pySplit(text).filter((w) => pyIsUpper(w) && cpLen(w) > 2).length;
  if (n >= 3) s += 0.4;
  else if (n >= 2) s += 0.3;
  else if (n >= 1) s += 0.2;
  if (excl >= 2) s += 0.15;
  else if (excl >= 1) s += 0.1;
  if (caps >= 2) s += 0.1;
  return Math.min(s, 1.0);
}

/** Emotional energy: text alone, or 40% text + 60% loudness when the segment's RMS ratio is known. */
export function emotionalEnergy(text: string, rmsRatio: number | null): number {
  const t = energyText(text);
  if (rmsRatio === null) return pyRound(t, 4);
  const audio = rmsRatio > 1.8 ? 1.0 : rmsRatio > 1.3 ? 0.8 : rmsRatio > 0.8 ? 0.5 : rmsRatio > 0.4 ? 0.3 : 0.1;
  return pyRound(t * 0.4 + audio * 0.6, 4);
}

export function boosts(text: string): number {
  let total = 0;
  const lower = text.toLowerCase();
  const first = firstSentence(text);
  if (first.includes("?") && has(first.toLowerCase(), QUESTION_WORDS)) total += BOOST_CONDITIONS.sharp_question;
  if (has(lower, CONFLICT_WORDS)) total += BOOST_CONDITIONS.opinion_conflict;
  if (has(lower, ["pertama", "kedua", "ketiga", "1", "2", "3"])) total += BOOST_CONDITIONS.number_list;
  if (has(lower, EMOTION_WORDS)) total += BOOST_CONDITIONS.emotional_moment;
  const words = pySplit(lower);
  if (CONVERSATION_MARKERS.filter((m) => words.includes(m)).length >= 3) total += BOOST_CONDITIONS.conversational_tone;
  return pyRound(total, 2);
}

export function penalties(text: string, duration: number, scores?: Record<string, number>): number {
  let total = 0;
  const first5 = pySplit(text).slice(0, 5).join(" ");
  if (!(has(first5.toLowerCase(), HOOK_PHRASES) || first5.includes("?"))) total += PENALTY_CONDITIONS.slow_opening;
  if (pySplit(text).length < 8 && !has(text.toLowerCase(), [...HOOK_PHRASES, ...KEYWORD_TRIGGERS])) {
    total += PENALTY_CONDITIONS.too_generic;
  }
  if (scores) {
    if ((scores.pauseStructure ?? 1.0) < 0.3) total += PENALTY_CONDITIONS.too_much_silence;
    if ((scores.facePresence ?? 1.0) <= 0.0) total += PENALTY_CONDITIONS.no_face;
  }
  return pyRound(total, 2);
}

// ---- context signals ----

export interface TranscriptSegment {
  start?: number;
  end?: number;
}

/** Share of [start, end] with no speech, from transcript segment gaps; null when unknown. */
export function silenceRatio(segments: TranscriptSegment[] | null, start: number, end: number): number | null {
  if (!segments || segments.length === 0) return null;
  const inRange = segments.filter((s) => (s.end ?? 0) > start && (s.start ?? 0) < end)
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  if (inRange.length < 2) return null;
  let silence = 0;
  for (let i = 1; i < inRange.length; i++) {
    const gap = (inRange[i]!.start ?? 0) - (inRange[i - 1]!.end ?? 0);
    if (gap > 0) silence += gap;
  }
  return end - start > 0 ? silence / (end - start) : null;
}

export function pauseStructure(text: string, duration: number, ratio: number | null = null): number {
  if (ratio !== null) return ratio < 0.1 ? 0.9 : ratio < 0.25 ? 0.7 : ratio < 0.4 ? 0.4 : 0.1;
  const words = pySplit(text).length;
  if (words === 0) return 0.3;
  const wps = words / Math.max(duration, 1);
  if (wps >= 2.0 && wps <= 4.0) return 0.9;
  if (wps >= 1.5 && wps <= 5.0) return 0.7;
  if (wps < 1.5) return 0.4;
  return 0.5;
}

export function topicFit(text: string, niche: string[] | null): number {
  if (!niche || niche.length === 0) return 0.5;
  const ratio = count(text.toLowerCase(), niche) / niche.length;
  return ratio > 0.3 ? 1.0 : ratio > 0.1 ? 0.7 : 0.3;
}

/** Mean viral score of the 3 past clips sharing the most words (≥ 3); 0.5 without history. */
export function historyScore(history: Array<{ text: string; viralScore: number | null }>, text: string): number {
  if (!history.length || !text) return 0.5;
  const words = new Set(pySplit(text.toLowerCase()));
  const scored = history
    .filter((r) => r.viralScore !== null)
    .map((r) => ({
      overlap: [...new Set(pySplit(r.text.toLowerCase()))].filter((w) => words.has(w)).length,
      score: r.viralScore as number,
    }))
    .filter((r) => r.overlap >= 3);
  if (!scored.length) return 0.5;
  const top = scored.sort((a, b) => b.overlap - a.overlap).slice(0, 3);
  return pyRound(top.reduce((s, r) => s + r.score, 0) / top.length, 4);
}

// ---- post copy (templates) ----

export function selectHashtags(text: string, tier: string, n = 5): string[] {
  const lower = text.toLowerCase();
  const matched: string[] = [];
  for (const [kw, tags] of Object.entries(HASHTAG_MAP)) if (lower.includes(kw)) matched.push(...tags);
  const combined = [...new Set(matched)];
  combined.push(...GENERIC_HASHTAGS.filter((t) => !combined.includes(t)));
  if (tier === "PRIMARY" && !combined.includes("#viral")) combined.unshift("#viral");
  return combined.slice(0, n);
}

export function clipTitle(text: string, tier: string): string {
  let title = "";
  const sentences = text.split(/[.?!,]/);
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (cpSlice(text, 0, cpLen(s) + 1).includes("?")) {
      title = s.endsWith("?") ? s : `${s}?`;
      break;
    }
    if (has(s.toLowerCase(), HOOK_PHRASES)) {
      title = s;
      break;
    }
  }
  if (!title) title = sentences.map((s) => s.trim()).find(Boolean) ?? text.trim();
  if (cpLen(title) > 80) title = `${cpSlice(title, 0, 77)}...`;
  const tags = selectHashtags(text, tier, 2);
  if (tags.length) title = `${title} ${tags.join(" ")}`;
  if (cpLen(title) > 100) title = `${cpSlice(title, 0, 97)}...`;
  return title;
}

function hookLine(text: string, tier: string): string | null {
  const lower = text.toLowerCase();
  if (firstSentence(text).includes("?")) return null;
  if (has(lower, ["rahasia", "penting", "wajib"])) return "Rahasia yang wajib kamu tahu!";
  if (has(lower, ["ternyata", "faktanya", "nyatanya"])) return "Ternyata faktanya begini!";
  if (has(lower, ["trik", "hack", "tip", "solusi"])) return "Trik yang harus kamu coba!";
  return tier === "PRIMARY" ? "Wajib tahu ini!" : null;
}

/** Stable call-to-action pick (Python used `hash(text)`, which changes every run). */
export function ctaFor(text: string): string {
  let h = 0;
  for (const c of text) h = (h * 31 + (c.codePointAt(0) as number)) >>> 0;
  return CTA_PHRASES[h % CTA_PHRASES.length] as string;
}

export function clipDescription(text: string, tier: string): string {
  const lines: string[] = [];
  const hook = hookLine(text, tier);
  if (hook) lines.push(hook);
  const clean = text.trim();
  lines.push(cpLen(clean) > 150 ? `${cpSlice(clean, 0, 147)}...` : clean);
  const tags = selectHashtags(text, tier, 7);
  if (tags.length) lines.push(tags.join(" "));
  lines.push(ctaFor(text));
  return lines.join("\n");
}
