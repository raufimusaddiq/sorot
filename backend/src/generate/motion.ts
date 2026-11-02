import type { NewFinding } from "./findings";
import type { Plan } from "./planSchema";
import { shotStarts } from "./composer";

// The `motion` measure (research R28, FR-040): whether things move smoothly, from the rendered video,
// in code. ffmpeg gives the mean luma difference between each frame and the next (tblend difference +
// signalstats YAVG). Inside each shot (the frames next to a seam left out):
// - a jump is a frame whose change is far above its neighbours' (an element teleporting for a frame);
// - a stall is a moving shot that freezes for a while and then moves again.
// ffmpeg's own scene score and freezedetect were tried first: both round a small element's motion to
// zero, so a smooth slow move read as a freeze (spike S7, 2026-11-02).

export interface MotionSettings {
  /** A jump: a frame's change at least this many times its neighbours' median. */
  jumpRatio: number;
  /** ...and at least this much change (mean luma levels, 0 to 255): noise never counts. */
  minJump: number;
  /** A stall: at least this many still frames between movements. */
  stallFrames: number;
  /** A frame changing less than this is still. */
  still: number;
}

/**
 * Defaults from spike S7 (2026-11-02): a planted one-frame 400 px jump of a 240 px box measured 45×
 * its neighbours; the smooth renders (fast expo.out 2D moves, a Three.js orbit, a slow constant move)
 * stayed at or under 2×. A jump or stall twice the threshold is a must-fix.
 */
export const MOTION_DEFAULTS: MotionSettings = { jumpRatio: 6, minJump: 1, stallFrames: 8, still: 0.03 };
const NEIGHBOURS = 4;
const SEAM_FRAMES = 2;

/** The ffmpeg arguments that print one YAVG per frame pair. */
export const frameDiffArgs = (file: string) => [
  "-v", "error", "-i", file, "-an", "-vf", "tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-", "-f", "null", "-",
];

/** YAVG per frame pair: entry i is the change from frame i to frame i + 1. */
export function parseFrameDiffs(out: string): number[] {
  return [...out.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Jumps and stalls in each shot, as findings with the shot and the moment. */
export function motionFindings(diffs: number[], plan: Plan, fps: number, settings: Partial<MotionSettings> = {}): NewFinding[] {
  const s = { ...MOTION_DEFAULTS, ...settings };
  const starts = shotStarts(plan);
  const found: NewFinding[] = [];
  plan.shots.forEach((shot, k) => {
    // pair i is the change into frame i + 1, at (i + 1) / fps
    const from = Math.round(starts[k]! * fps) + SEAM_FRAMES;
    const to = Math.min(diffs.length, Math.round((starts[k]! + shot.durationSec) * fps) - 1 - SEAM_FRAMES);
    if (to - from < 3) return;
    const at = (i: number) => round2((i + 1) / fps);

    // jumps: a spike over its neighbours inside the shot; an out-and-back teleport is one jump
    let i = from;
    while (i < to) {
      const nb: number[] = [];
      for (let j = Math.max(from, i - NEIGHBOURS); j <= Math.min(to - 1, i + NEIGHBOURS); j++) if (j !== i) nb.push(diffs[j]!);
      const ratio = diffs[i]! / Math.max(median(nb), s.still);
      if (diffs[i]! >= s.minJump && ratio >= s.jumpRatio) {
        let end = i;
        while (end + 1 < to && diffs[end + 1]! >= s.minJump && diffs[end + 1]! / Math.max(median(nb), s.still) >= s.jumpRatio) end++;
        found.push({
          severity: ratio >= s.jumpRatio * 2 ? "must-fix" : "should-fix", shotId: shot.id, code: "motion_jump", fromSec: at(i), toSec: at(end), state: "open", rule: "motion",
          description: `${shot.id} jumps at ${at(i)} s: one frame changes ${Math.round(ratio)}× more than the frames around it.`,
          suggestedFix: "Move it with one eased tween instead of setting a new position; check for a set() or a timeline gap at that moment.",
        });
        i = end + 1;
      } else i++;
    }

    // stalls: a shot that moves, stops for a while, and moves again (a hold shot is meant to stand still)
    if (shot.hold) return;
    const moving = diffs.slice(from, to).filter((d) => d > s.still).length;
    if (moving < (to - from) * 0.25) return;
    let run = -1;
    for (let j = from; j <= to; j++) {
      const still = j < to && diffs[j]! <= s.still;
      if (still && run < 0) run = j;
      if (!still && run >= 0) {
        const length = j - run;
        // only a pause with movement on both sides inside the shot
        if (length >= s.stallFrames && run > from && j < to) {
          found.push({
            severity: length >= s.stallFrames * 2 ? "must-fix" : "should-fix", shotId: shot.id, code: "motion_stall", fromSec: at(run - 1), toSec: at(j - 1), state: "open", rule: "motion",
            description: `${shot.id} stops for ${round2(length / fps)} s at ${at(run - 1)} s and then moves again.`,
            suggestedFix: "Overlap the moves (start the next one before the last settles), or mark the stillness as deliberate with data-hold.",
          });
        }
        run = -1;
      }
    }
  });
  return found;
}
