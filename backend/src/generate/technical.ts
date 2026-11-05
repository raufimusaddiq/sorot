import type { Finding, NewFinding } from "./findings";
import type { Plan } from "./planSchema";
import { numbersOf, sameNumber, unmatchedNumbers } from "./numbers";
import { speechWords, wordErrorRate } from "./voice";

// The TECHNICAL verdict (research R6): computed in code only, so it can't flip between runs.
// These are its measures, as pure functions over what ffprobe, ffmpeg and the plan say; the step
// (steps/technical.ts) gathers the inputs. FAIL with any must-fix, REVIEW with should-fix only,
// PASS otherwise; a warning kept on purpose stays visible and doesn't count.

export type VerdictStatus = "PASS" | "REVIEW" | "FAIL";

export function verdictOf(findings: Array<Pick<Finding, "severity" | "state">>): VerdictStatus {
  const live = findings.filter((f) => f.state !== "kept" && f.state !== "fixed");
  if (live.some((f) => f.severity === "must-fix")) return "FAIL";
  return live.some((f) => f.severity === "should-fix") ? "REVIEW" : "PASS";
}

export interface ProbeStream { codec_type?: string; width?: number; height?: number; r_frame_rate?: string; avg_frame_rate?: string; duration?: string }
export interface Probe { streams: ProbeStream[]; format: { duration?: string } }

/** ffprobe's JSON, or null when it isn't any. */
export function parseProbe(stdout: string): Probe | null {
  try {
    const p = JSON.parse(stdout) as Partial<Probe>;
    return p && Array.isArray(p.streams) ? { streams: p.streams, format: p.format ?? {} } : null;
  } catch {
    return null;
  }
}

/** 30/1 -> 30; 30000/1001 -> 29.97. */
export function fpsOf(rate: string | undefined): number {
  const [n, d] = (rate ?? "").split("/").map(Number);
  return n && d ? n / d : Number.NaN;
}

const must = (code: string, description: string, suggestedFix?: string, extra: Partial<NewFinding> = {}): NewFinding => ({
  severity: "must-fix", shotId: null, code, description, ...(suggestedFix ? { suggestedFix } : {}), state: "open", rule: "technical", ...extra,
});

export interface OutputSpec { width: number; height: number; fps: number; durationSec: number; minSec: number; maxSec: number }
export interface OutputTolerance { fpsTolerance: number; lengthToleranceSec: number }

/** The video exists, plays, and is the size, frame rate and length the plan and the recipe say. */
export function outputFindings(probe: Probe | null, want: OutputSpec, tol: OutputTolerance): NewFinding[] {
  const video = probe?.streams.find((s) => s.codec_type === "video");
  if (!probe || !video) return [must("output_unplayable", "The rendered file has no video stream, so it can't be played.", "Render again; if it keeps failing, look at the check findings.")];
  const found: NewFinding[] = [];
  if (video.width !== want.width || video.height !== want.height) {
    found.push(must("output_size", `The video is ${video.width}x${video.height}; it should be ${want.width}x${want.height}.`, "Render at the recipe's size."));
  }
  const fps = fpsOf(video.avg_frame_rate ?? video.r_frame_rate);
  if (!Number.isFinite(fps) || Math.abs(fps - want.fps) > tol.fpsTolerance) {
    found.push(must("output_fps", `The video runs at ${Number.isFinite(fps) ? fps.toFixed(2) : "an unknown rate"} fps; it should be ${want.fps}.`, "Render at the recipe's frame rate."));
  }
  const duration = Number(probe.format.duration ?? video.duration);
  if (!Number.isFinite(duration) || Math.abs(duration - want.durationSec) > tol.lengthToleranceSec) {
    found.push(must("output_length", `The video is ${Number.isFinite(duration) ? duration.toFixed(2) : "?"} s long; the plan adds up to ${want.durationSec} s.`, "Check that every shot has its planned length."));
  }
  if (want.durationSec < want.minSec || want.durationSec > want.maxSec) {
    found.push(must("output_window", `The plan is ${want.durationSec} s; the recipe allows ${want.minSec} to ${want.maxSec} s.`, "Change the plan's length."));
  }
  return found;
}

/** What makes a film more than cuts between flat cards: installed blocks, seams that aren't cuts, and shots with light, blur, depth or glow. */
export function effectsUsed(plan: Plan): { blocks: number; transitions: number; looks: number; total: number } {
  const blocks = new Set([...plan.blocks, ...plan.shots.flatMap((s) => (s.visual.block ? [s.visual.block] : []))]).size;
  const transitions = plan.shots.filter((s, i) => i > 0 && s.transition !== "cut").length;
  const looks = plan.shots.filter((s) => s.effects).length;
  return { blocks, transitions, looks, total: blocks + transitions + looks };
}

/** The plan step's `minEffects`, else 3 for a film of 15 s or longer (a shorter one may be plain). */
export const minEffectsFor = (plan: Plan, setting: unknown): number =>
  typeof setting === "number" ? setting : plan.totalSec >= 15 ? 3 : 0;

/** A film with fewer effects than the recipe asks for looks flat: a should-fix, never a block. */
export function effectFindings(plan: Plan, min: number): NewFinding[] {
  const used = effectsUsed(plan);
  if (used.total >= min) return [];
  return [{
    severity: "should-fix", shotId: null, code: "effects_few", state: "open", rule: "technical",
    description: `The film uses ${used.total} effect${used.total === 1 ? "" : "s"} (${used.blocks} blocks, ${used.transitions} transitions, ${used.looks} shots with light, blur, depth or glow); the recipe asks for at least ${min}.`,
    suggestedFix: "Give a few seams a transition with a cause, or a shot its light, blur or depth.",
  }];
}

export interface ReadabilityRule { holdBaseSec: number; holdPerWordSec: number }

/** Words, not symbols: "=", "→" or "&" between words are not read as one. */
const words = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/** Text is read at a pace: a shot must show its words for the base time plus a little per word. */
export function readabilityFindings(plan: Plan, rule: ReadabilityRule): NewFinding[] {
  return plan.shots.flatMap((shot) => {
    const n = shot.text.reduce((sum, t) => sum + words(t.value), 0);
    const needed = Math.round((rule.holdBaseSec + rule.holdPerWordSec * n) * 100) / 100;
    return n > 0 && shot.durationSec < needed
      ? [must("readability_hold", `Shot ${shot.id} has ${n} words on screen for ${shot.durationSec} s; a viewer needs ${needed} s.`,
        "Give the shot more time or cut the words.", { shotId: shot.id, fromSec: 0, toSec: shot.durationSec })]
      : [];
  });
}

export interface Volume { mean: number; max: number }

/** ffmpeg's volumedetect lines (they come on stderr). */
export function parseVolume(stderr: string): Volume | null {
  const mean = /mean_volume:\s*(-?[\d.]+)\s*dB/.exec(stderr)?.[1];
  const max = /max_volume:\s*(-?[\d.]+)\s*dB/.exec(stderr)?.[1];
  return mean !== undefined && max !== undefined ? { mean: Number(mean), max: Number(max) } : null;
}

export const planHasSound = (plan: Plan): boolean => plan.sound.narration || (plan.sound.music !== "" && plan.sound.music !== "none");

/** When the plan has sound, the video has an audio track, it can be heard and it doesn't clip. */
export function audioFindings(probe: Probe | null, volume: Volume | null, limits: { minMeanVolumeDb: number; maxTruePeakDb: number }): NewFinding[] {
  if (!probe?.streams.some((s) => s.codec_type === "audio")) {
    return [must("audio_missing", "The plan has sound but the video has no audio track.", "Check that the music or voiceover file is in the project and on the root composition.")];
  }
  if (!volume) return [];
  const found: NewFinding[] = [];
  if (volume.mean < limits.minMeanVolumeDb) {
    found.push({ ...must("audio_too_quiet", `The audio averages ${volume.mean} dB; it should be above ${limits.minMeanVolumeDb} dB.`, "Raise the volume of the track."), severity: "should-fix" });
  }
  if (volume.max > limits.maxTruePeakDb) {
    found.push({ ...must("audio_clipping", `The audio peaks at ${volume.max} dB; it should stay under ${limits.maxTruePeakDb} dB.`, "Lower the volume of the track."), severity: "should-fix" });
  }
  return found;
}

// ---- the voice (FR-018) --------------------------------------------------------------

export interface SpokenLine { id: string; text: string; start: number; durationSec: number; /** When its first word should be heard, if the voice was timed. */ firstWordAt: number | null }
export interface HeardWord { text: string; start: number; end: number }

const DRIFT_SEC = 0.3;
const LINE_WINDOW_SEC = 0.6;

/**
 * `speechMatch`: Whisper listened to the rendered film (local, never a paid service); every line
 * the script says should be heard where it was placed. A film whose overall word error rate is
 * above the step's limit fails, and each line that was missed is named with its time. Captions
 * that start more than 0.3 s from the spoken word are reported as drift.
 */
export function speechFindings(lines: SpokenLine[], heard: HeardWord[], limit: number): NewFinding[] {
  const found: NewFinding[] = [];
  const total = wordErrorRate(lines.flatMap((l) => speechWords(l.text)), speechWords(heard.map((w) => w.text).join(" ")));
  const missed: SpokenLine[] = [];
  for (const line of lines) {
    const inside = heard.filter((w) => w.start >= line.start - LINE_WINDOW_SEC && w.start < line.start + line.durationSec + LINE_WINDOW_SEC);
    const rate = wordErrorRate(speechWords(line.text), speechWords(inside.map((w) => w.text).join(" ")));
    if (rate > 0.5) missed.push(line);
    else if (line.firstWordAt !== null && inside[0] && Math.abs(inside[0].start - line.firstWordAt) > DRIFT_SEC) {
      found.push({
        severity: "should-fix", shotId: null, code: "caption_drift", state: "open", rule: "technical",
        description: `The captions of line ${line.id} start ${Math.abs(Math.round((inside[0].start - line.firstWordAt) * 100) / 100)} s away from the spoken words (at ${Math.round(line.firstWordAt * 10) / 10} s).`,
        suggestedFix: "Time the voice again (the align step) so the captions follow the words.", fromSec: line.firstWordAt, toSec: line.firstWordAt + line.durationSec,
      });
    }
  }
  if (total > limit || missed.length) {
    found.push(must(
      "speech_mismatch",
      `The voice in the film doesn't match the script (word error rate ${Math.round(total * 100)}%, at most ${Math.round(limit * 100)}%)${missed.length ? `; not heard: ${missed.map((l) => `${l.id} at ${Math.round(l.start * 10) / 10} s ("${l.text.slice(0, 40)}")`).join(", ")}` : ""}.`,
      "Check that the voice track is on the root composition at the lines' start times and isn't covered by the music.",
      { fromSec: missed[0]?.start },
    ));
  }
  return found;
}

/** `voiceRoute`: every recorded line ends inside the film, so none is cut off. */
export function voiceRouteFindings(lines: Array<{ id: string; start: number; durationSec: number }>, filmSec: number): NewFinding[] {
  return lines.filter((l) => l.start + l.durationSec > filmSec + 0.05).map((l) => must(
    "voice_cut_off", `Line ${l.id} runs to ${Math.round((l.start + l.durationSec) * 10) / 10} s but the film ends at ${filmSec} s.`,
    "Give the shot that narrates it more time, or shorten the script.", { fromSec: l.start, toSec: filmSec },
  ));
}

// ---- numbers and content rules (FR-026, FR-027) -----------------------------------------

/** Every text the film shows or says, with the shot it belongs to. */
const shownTexts = (plan: Plan): Array<{ shotId: string; text: string }> =>
  plan.shots.map((s) => ({ shotId: s.id, text: [...s.text.map((t) => t.value), s.narration ?? ""].join(" . ") }));

/**
 * `sourcedNumbers`: every number the film shows or says is one the brief gave or a verified (or
 * corrected) fact states. `allowed` is those texts; "1,5%" and "satu koma lima persen" are one number.
 */
export function sourcedNumberFindings(plan: Plan, allowed: string[]): NewFinding[] {
  return shownTexts(plan).flatMap(({ shotId, text }) => unmatchedNumbers(text, allowed).map((n) => must(
    "number_unsourced", `Shot ${shotId} shows "${n.raw}", which no verified fact states.`,
    "Take the number out, or add a fact with its source and verify it.", { shotId },
  )));
}

/** The numbers in `text` the brief's `forbiddenNumbers` flag rules out (none without the flag). */
function forbiddenHits(text: string, flag: unknown, brief: string) {
  if (flag === undefined || flag === false || flag === null) return [];
  const forbidden = Array.isArray(flag) ? numbersOf(flag.filter((x): x is string => typeof x === "string").join(" . ")) : null;
  // "no numbers beyond the brief's" is about figures: a small count in words ("satu kunjungan", one visit) is language, not data
  return forbidden ? numbersOf(text).filter((n) => forbidden.some((f) => sameNumber(n, f))) : unmatchedNumbers(text, [brief]).filter((n) => /\d/.test(n.raw) || n.percent || n.value >= 10);
}

/** The same rule for the plan and script steps, so a number the brief rules out goes back to the director before anything is built. */
export const forbiddenIn = (texts: string[], flag: unknown, brief: string): string[] => [...new Set(forbiddenHits(texts.join(" . "), flag, brief).map((n) => n.raw))];

/**
 * `forbiddenNumbers`, whenever the brief has the flag: `true` means no number but the brief's own
 * (for example "no market data"); a list names numbers that must not appear at all.
 */
export function forbiddenNumberFindings(plan: Plan, flag: unknown, brief: string): NewFinding[] {
  if (flag === undefined || flag === false || flag === null) return [];
  const forbidden = Array.isArray(flag);
  const found = shownTexts(plan).flatMap(({ shotId, text }) => {
    const hits = forbiddenHits(text, flag, brief);
    return hits.map((n) => must(
      "number_forbidden", forbidden ? `Shot ${shotId} shows "${n.raw}", a number the brief says must not appear.` : `Shot ${shotId} shows "${n.raw}": the brief asks for no numbers beyond its own.`,
      "Remove the number.", { shotId },
    ));
  });
  return [...new Map(found.map((f) => [f.description, f])).values()];   // the same number in a shot's title and on-screen text is one finding
}

export interface ContentAnswer { id: string; question: string; flagged: boolean; reason?: string; shotId?: string; suggestedFix?: string }

/** A blocking content rule that is flagged blocks the export: the owner decided it matters that much. */
export function contentFindings(answers: ContentAnswer[]): NewFinding[] {
  return answers.filter((a) => a.flagged).map((a) => must(
    `content.${a.id}`, a.reason || `A content rule is broken: ${a.question.replace(/`/g, "")}`, a.suggestedFix ?? "Change the film so this no longer applies.",
    { rule: a.id, ...(a.shotId ? { shotId: a.shotId } : {}) },
  ));
}
