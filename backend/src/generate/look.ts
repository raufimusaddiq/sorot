import type { NewFinding } from "./findings";
import { shotStarts } from "./composer";
import type { Plan } from "./planSchema";
import type { Director } from "./director";
import type { RecipeStep } from "./recipe";
import type { GenProject } from "../types";

// The look step: a vision model looks at the frames of a build as a stranger would, and says what
// it sees. Code compares that with what the plan meant. This module holds the parts that are pure:
// where to look, and what the answers mean.

/** Where in a shot its pictures are taken, as shares of its length: coming in, in the middle of the move, settled. */
export const LOOK_MOMENTS = [0.2, 0.55, 0.9];

/** The film times of each shot's pictures, early to late: one move may only be visible later than the shot's first moment. */
export function lookTimes(plan: Plan): number[][] {
  const starts = shotStarts(plan);
  return plan.shots.map((shot, i) => LOOK_MOMENTS.map((m) => Math.round(((starts[i] as number) + Math.min(shot.durationSec * m, Math.max(0, shot.durationSec - 0.1))) * 100) / 100));
}

export interface LookFrame {
  shotId: string;
  /** What a stranger sees, in a sentence or two. */
  description: string;
  /** The things on screen. */
  objects: string[];
  /** The ones the stranger cannot tell the purpose of. */
  unexplained: string[];
  /** Does the frame read as the shot is meant to (`reads`)? */
  matches: boolean;
  /** Is the shot's hero move (the thing that moves most) visible in the frame? */
  heroVisible: boolean;
}

export interface LookAnswer { frames: LookFrame[]; defaultsSeen: string[] }

/** What the plan meant by each shot, to compare with what was seen; `pictures` is how many pictures of it come, early to late. */
export function expectations(plan: Plan, pictures = 1): Array<{ shotId: string; reads: string; heroMove: string; pictures: number }> {
  return plan.shots.map((s) => ({ shotId: s.id, reads: s.reads ?? s.visual.description, heroMove: s.heroMove ?? s.motion, pictures }));
}

const find = (shotId: string | null, code: string, description: string, suggestedFix: string, severity: NewFinding["severity"], at?: number): NewFinding => ({
  severity, shotId, code, description, suggestedFix, state: "open", rule: "look", ...(at !== undefined ? { fromSec: at } : {}),
});

/**
 * An object nobody can explain is must-fix (the viewer will wonder what it is); a shot that doesn't
 * read as planned by its last picture, a hero move that can't be seen across its pictures, and any of the
 * recipe's audited defaults showing, are should-fix. `times` is the moment each shot was last looked at.
 */
export function lookFindings(answer: LookAnswer, plan: Plan, times: number[], audit: boolean): NewFinding[] {
  const found: NewFinding[] = [];
  for (const f of answer.frames) {
    const at = times[plan.shots.findIndex((s) => s.id === f.shotId)];
    const shot = plan.shots.find((s) => s.id === f.shotId);
    if (!shot) continue;
    for (const object of f.unexplained) {
      found.push(find(f.shotId, "look_unexplained", `A stranger can't tell what "${object}" is for in ${f.shotId}, where it is still on screen at the end.`, `Remove "${object}", or label it or make its purpose clear from what is around it.`, "must-fix", at));
    }
    if (!f.matches) {
      found.push(find(f.shotId, "look_mismatch", `${f.shotId} ends up looking like "${f.description}", but it should read as "${shot.reads ?? shot.visual.description}".`, "Redraw the shot so its main idea is the first thing seen.", "should-fix", at));
    }
    if (!f.heroVisible) {
      found.push(find(f.shotId, "look_hero_hidden", `The main move of ${f.shotId} (${shot.heroMove ?? shot.motion}) can't be seen in its frame.`, "Make the hero move bigger or earlier, or move other things out of its way.", "should-fix", at));
    }
  }
  if (audit) {
    for (const item of answer.defaultsSeen) {
      found.push(find(null, "look_default", `A default shows: ${item}.`, "Replace it with something chosen for this topic.", "should-fix"));
    }
  }
  return found;
}

export interface StrangerRead {
  findings: NewFinding[];
  /** What the stranger saw, for the director to read as well. */
  seen: { description: string; objects: string[]; unexplained: string[] };
}

/**
 * A stranger's read of one shot's frames, in the director's own turn (docs/director-loop.md): a fresh
 * call with only the pictures (no conversation, no plan intent beyond `meant`) describes them; the
 * look findings come from the same code as the look step. The pictures are one shot's moments, early to
 * late, and the stranger answers once for the shot.
 */
export async function strangerRead(
  director: Pick<Director, "look">, input: { project: GenProject; step: RecipeStep; plan: Plan; index: number; images: string[] },
): Promise<StrangerRead> {
  const meant = expectations(input.plan)[input.index]!;
  const answer = await director.look({ project: input.project, step: input.step, expected: [{ ...meant, pictures: input.images.length }], audit: [], images: input.images });
  const seen = new Set<string>();
  const findings = lookFindings(answer, input.plan, [], false).filter((f) => !seen.has(`${f.code} ${f.description}`) && !!seen.add(`${f.code} ${f.description}`));
  const first = answer.frames[0];
  return {
    findings,
    seen: { description: first?.description ?? "", objects: [...new Set(answer.frames.flatMap((f) => f.objects))], unexplained: [...new Set(answer.frames.flatMap((f) => f.unexplained))] },
  };
}
