// A YouTube video's own captions as a transcript, instead of running Whisper.
// Uploaded (human) captions spell names and slang right, which is exactly
// where Whisper slips; auto-captions are used only when allowed (for
// Indonesian they are usually weaker than Whisper large-v3-turbo). Tracks
// come as YouTube json3: auto-captions carry per-word offsets, uploaded ones
// per-cue timing (captions.py then splits words evenly). Output matches
// transcribe.py so every later stage works unchanged.
// Ported from ai-pipeline/youtube_captions.py (tests/fixtures/youtube-captions.json).

import { pyRound, pySplit } from "./pyCompat";
import type { Json } from "./types";
import type { YouTube } from "./youtube";

export interface CaptionWord {
  text: string;
  start: number;
  end: number;
}

export interface CaptionSegment {
  index: number;
  start: number;
  end: number;
  text: string;
  words?: CaptionWord[];
}

// Non-speech tags in YouTube captions: [tertawa], [Musik], [Applause] …
const ANNOTATION = /\[[^\]]*\]/g;
// A caption event stays on screen long after its last word is spoken; cap the
// last word so it doesn't "last" into the next sentence (or a range window).
const LAST_WORD_MAX_SEC = 1.0;

const num = (v: unknown) => (typeof v === "number" ? v : 0);

/** json3 events → transcript segments (seconds), with per-word timing when the track has word offsets. */
export function parseJson3(data: Json): CaptionSegment[] {
  const segments: CaptionSegment[] = [];
  const events = Array.isArray(data.events) ? (data.events as Json[]) : [];
  for (const ev of events) {
    const segs = Array.isArray(ev.segs) ? (ev.segs as Json[]) : [];
    const start = num(ev.tStartMs) / 1000.0;
    const end = start + num(ev.dDurationMs) / 1000.0;
    const timed = segs.filter((s) => String(s.utf8 ?? "").trim());
    const words: CaptionWord[] = [];
    let text: string;
    if (timed.length > 1 || timed.some((s) => "tOffsetMs" in s)) {
      timed.forEach((s, i) => {
        const wStart = start + num(s.tOffsetMs) / 1000.0;
        const wEnd = i + 1 < timed.length ? start + num(timed[i + 1]!.tOffsetMs) / 1000.0 : Math.min(end, wStart + LAST_WORD_MAX_SEC);
        const t = String(s.utf8).replace(ANNOTATION, "").trim();
        if (t) words.push({ text: t, start: pyRound(wStart, 3), end: pyRound(Math.max(wEnd, wStart + 0.05), 3) });
      });
      if (!words.length) continue;
      text = words.map((w) => w.text).join(" ");
    } else {
      text = pySplit(segs.map((s) => String(s.utf8 ?? "")).join("").replace(ANNOTATION, "").replaceAll("\n", " ")).join(" ");
      if (!text) continue;
    }
    const seg: CaptionSegment = { index: segments.length, start: pyRound(start, 2), end: pyRound(end, 2), text };
    if (words.length) seg.words = words;
    segments.push(seg);
  }
  return segments;
}

/** Keep segments inside [start, end] and shift times so `start` is 0 (matches a section download). */
export function windowSegments(segments: CaptionSegment[], start: number | null = null, end: number | null = null): CaptionSegment[] {
  if (start === null && end === null) return segments;
  const lo = start || 0.0;
  const hi = end ?? Infinity;
  const out: CaptionSegment[] = [];
  for (const seg of segments) {
    if (seg.words) {
      // Word-timed track: keep words *spoken* in the window; the segment is
      // rebuilt from them (event display time overhangs the speech).
      const words = seg.words.filter((w) => lo - 0.05 <= w.start && w.start < hi)
        .map((w) => ({ ...w, start: pyRound(w.start - lo, 3), end: pyRound(Math.min(w.end, hi) - lo, 3) }));
      if (!words.length) continue;
      out.push({ ...seg, index: out.length, start: pyRound(Math.max(words[0]!.start, 0.0), 2),
        end: pyRound(words.at(-1)!.end, 2), text: words.map((w) => w.text).join(" "), words });
      continue;
    }
    if (seg.end <= lo || seg.start >= hi) continue;
    out.push({ ...seg, index: out.length, start: pyRound(Math.max(seg.start, lo) - lo, 2), end: pyRound(Math.min(seg.end, hi) - lo, 2) });
  }
  return out;
}

export interface CaptionTranscriptOptions {
  language: string;
  allowAuto: boolean;
  start?: number | null;
  end?: number | null;
  signal?: AbortSignal;
}

/** Transcript from the video's captions; `found: false` when no usable track exists (→ Whisper). */
export async function captionTranscript(youtube: YouTube, url: string, videoId: string, o: CaptionTranscriptOptions): Promise<Json> {
  const track = await youtube.json3Track(url, o.language, o.allowAuto, o.signal);
  if (!track) return { found: false };
  const segments = windowSegments(parseJson3(track.data), o.start ?? null, o.end ?? null);
  if (!segments.length) return { found: false };
  const source = `youtube-${track.kind}`;
  return { found: true, videoId, language: o.language, model: source, source, segments };
}
