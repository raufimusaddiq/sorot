import type { Finding, NewFinding } from "./findings";
import type { Plan } from "./planSchema";

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

export interface ReadabilityRule { holdBaseSec: number; holdPerWordSec: number }

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

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
