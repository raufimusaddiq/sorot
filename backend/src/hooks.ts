// The hook line of a clip, decided in Bun: Jev's decision (Jev first) or the
// LLM director's pick when one was made, else the rules' strongest stand-alone
// line. render.py and subtitle.py only replay what they are given
// (`hookStart`/`hookEnd` on the segment; null = no replay). Port of ai-pipeline/captions.py words_for_clip
// + find_hook (tests/fixtures/hooks.json is generated from the Python).

import { hookStrength } from "./textRules";

export interface Word {
  text: string;
  start: number;
  end: number;
}

export interface TranscriptSeg {
  start?: number;
  end?: number;
  text?: string;
  words?: Array<{ text?: string; word?: string; start?: number; end?: number }>;
}

export const HOOK_MIN_SEC = 1.2;
export const HOOK_MAX_SEC = 6.0;
export const HOOK_MIN_SCORE = 0.7;
/** A hook already in the first seconds needs no replay. */
export const HOOK_SKIP_LEAD_SEC = 3.0;
const MIN_WORD_SEC = 0.05;
const SENTENCE_GAP_SEC = 0.6;

const TERMINAL = /[.?!…]["'”’)\]]*$/;
const PUNCT_ONLY = /^[.,?!;:\-–—…"'“”‘’()[\]]+$/;

/** Legacy transcripts (no per-word timing): words spread evenly over the segment. */
function evenSplit(seg: TranscriptSeg): Word[] {
  const tokens = (seg.text ?? "").trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const start = Number(seg.start ?? 0);
  const step = (Number(seg.end ?? 0) - start) / tokens.length;
  return tokens.map((t, i) => ({ text: t, start: start + i * step, end: start + (i + 1) * step }));
}

/** Strip, fold standalone punctuation and "-reduplication" into the previous word, monotonic timings. */
export function sanitizeWords(words: Word[]): Word[] {
  const out: Word[] = [];
  for (const w of words) {
    const text = String(w.text ?? "").trim().replace(/[{}\\]/g, "");
    if (!text) continue;
    let start = Number(w.start);
    const end = Number(w.end);
    const prev = out.at(-1);
    const rejoin = text.startsWith("-") && text.length > 1 && !!prev && start - prev.end < 0.3;
    if (PUNCT_ONLY.test(text) || rejoin) {
      if (prev) {
        prev.text += text;
        prev.end = Math.max(prev.end, end);
      }
      continue;
    }
    if (prev) start = Math.max(start, prev.start);
    out.push({ text, start, end: Math.max(end, start + MIN_WORD_SEC) });
  }
  return out;
}

/** Words overlapping [clipStart, clipEnd], clip-relative and sanitized. */
export function wordsForClip(segments: TranscriptSeg[], clipStart: number, clipEnd: number): Word[] {
  const out: Word[] = [];
  for (const seg of segments) {
    if (Number(seg.end ?? 0) < clipStart || Number(seg.start ?? 0) > clipEnd) continue;
    const raw = seg.words?.length ? seg.words : evenSplit(seg);
    for (const w of raw) {
      const ws = Number(w.start ?? 0);
      const we = Number(w.end ?? 0);
      if (we <= clipStart || ws >= clipEnd) continue;
      out.push({ text: String((w as { text?: string }).text ?? (w as { word?: string }).word ?? ""),
        start: Math.max(ws, clipStart) - clipStart, end: Math.min(we, clipEnd) - clipStart });
    }
  }
  return sanitizeWords(out);
}

/** Sentences: split at terminal punctuation or a pause. */
export function sentences(words: Word[], gap = SENTENCE_GAP_SEC): Word[][] {
  const out: Word[][] = [];
  let cur: Word[] = [];
  for (const w of words) {
    const last = cur.at(-1);
    if (last && (w.start - last.end > gap || TERMINAL.test(last.text))) {
      out.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** The strongest stand-alone line after the opening seconds (clip-relative [start, end]), or null. */
export function findHook(words: Word[]): [number, number] | null {
  let best: [score: number, start: number, end: number] | null = null;
  for (const sent of sentences(words)) {
    const start = sent[0]!.start;
    const end = sent.at(-1)!.end;
    if (start < HOOK_SKIP_LEAD_SEC || end - start < HOOK_MIN_SEC || end - start > HOOK_MAX_SEC) continue;
    const score = hookStrength(sent.map((w) => w.text).join(" "));
    if (score >= HOOK_MIN_SCORE && (best === null || score > best[0])) best = [score, start, end];
  }
  return best ? [best[1], best[2]] : null;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** The rules' hook as absolute source seconds (what segments carry), or null for none. */
export function ruleHook(segments: TranscriptSeg[], clipStart: number, clipEnd: number): { hookStart: number; hookEnd: number } | null {
  const hook = findHook(wordsForClip(segments, clipStart, clipEnd));
  return hook ? { hookStart: round3(clipStart + hook[0]), hookEnd: round3(clipStart + hook[1]) } : null;
}
