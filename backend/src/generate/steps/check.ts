import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkScene, shotFile, shotStarts, sizeFor } from "../composer";
import { saveFindings, type NewFinding, type Severity } from "../findings";
import { HyperframesError, type HfFinding } from "../hyperframes";
import { planHasSound } from "../technical";
import { buildTarget, readScene, sceneAssets, shotIndexOf } from "./build";
import { sceneFindings } from "./author";
import type { RunFn } from "./types";

// HyperFrames `lint` and `check` on the version's project, with what they find mapped to shots.
// Errors always go back to the director for a repair; warnings do too (fix) or may be kept on
// purpose with a reason (fix-or-hold) or only be reported (report).

/** Only Studio's editing aids: nothing a render or a viewer sees. */
const IGNORED = new Set(["studio_missing_editable_id"]);
/** A shot the plan marks as a hold is meant to stand still. */
const HOLD_CODES = new Set(["sweep_static", "dead_stretch"]);
/** HyperFrames says a film has no sound bed; a plan without sound meant that. */
const SILENT_CODE = "film_silent";

interface Found { shot: number | null; code: string; severity: "error" | "warning"; message: string; hint?: string; time?: number }

/** lint first (cheap); `check` (it opens a browser) only once lint has no errors. */
async function collect(ctx: Parameters<RunFn>[0], dir: string, starts: number[], durations: number[]): Promise<Found[]> {
  const { hyperframes: hf, signal } = ctx;
  const map = (f: HfFinding): Found | null => {
    if (f.severity === "info" || IGNORED.has(f.code)) return null;
    return {
      shot: shotIndexOf(f, starts, durations), code: f.code, severity: f.severity, message: f.message, hint: f.fixHint, time: f.time,
    };
  };
  const lint = await hf.lint(dir, { signal });
  const fromLint = lint.findings.map(map).filter((f): f is Found => f !== null);
  if (fromLint.some((f) => f.severity === "error")) return fromLint;
  try {
    const result = await hf.check(dir, { signal });
    const sections = Object.entries(result).filter(([k, v]) => k !== "lint" && typeof v === "object" && v !== null && Array.isArray((v as { findings?: unknown }).findings));
    const fromCheck = sections.flatMap(([, v]) => (v as { findings: HfFinding[] }).findings).map(map).filter((f): f is Found => f !== null);
    return [...fromLint, ...fromCheck];
  } catch (e) {
    if (!(e instanceof HyperframesError) || e.code === "cancelled") throw e;
    return [...fromLint, { shot: null, code: "checker_failed", severity: "error", message: `The check could not run: ${e.message}` }];
  }
}

export const run: RunFn = async (ctx) => {
  const { dir, plan } = buildTarget(ctx);
  const mode = String(ctx.settings.warnings);
  const rounds = Number(ctx.settings.rounds);
  const starts = shotStarts(plan);
  const durations = plan.shots.map((s) => s.durationSec);
  const size = sizeFor(ctx.project.format, ctx.recipe.output);
  const assets = sceneAssets(ctx);
  const held = new Map<string, string>();
  const used = new Map<number, number>();
  /** Why a finding is the plan's own doing and needs no repair, or null. */
  const planned = (f: Found): string | null => {
    if (f.code === SILENT_CODE && !planHasSound(plan)) return "The plan has no sound.";
    return f.shot !== null && plan.shots[f.shot]!.hold && HOLD_CODES.has(f.code) ? "The plan marks this shot as a hold." : null;
  };
  const repairs = (found: Found[]) => found.filter((f) => f.shot !== null && !held.has(`${f.shot}:${f.code}`)
    && (f.severity === "error" || mode !== "report") && !planned(f));

  let found: Found[] = [];
  for (let round = 0; ; round++) {
    found = await collect(ctx, dir, starts, durations);
    // the plan's own rules count too: a scene that lost its text is repaired with the lint findings
    const planLock = plan.shots.flatMap((shot, i) => checkScene(readScene(dir, i) ?? "", shot, i, { assets }).map((c): Found => ({ shot: i, code: c.code, severity: "error", message: c.message, hint: c.hint })));
    const todo = [...repairs(found), ...planLock];
    const shots = [...new Set(todo.map((f) => f.shot as number))].filter((i) => (used.get(i) ?? 0) < rounds);
    if (!shots.length || round >= rounds) break;
    for (const i of shots) {
      const mine = todo.filter((f) => f.shot === i);
      const out = await ctx.director.repair({
        project: ctx.project, step: ctx.step, plan, index: i, ...size, assets, html: readScene(dir, i) ?? "",
        findings: mine.map((f) => ({ code: f.code, message: f.message, hint: f.hint })),
      });
      writeFileSync(join(dir, shotFile(i)), out.html);
      used.set(i, (used.get(i) ?? 0) + 1);
      if (mode === "fix-or-hold") for (const h of out.holds) held.set(`${i}:${h.code}`, h.reason);
    }
    ctx.progress(((round + 1) / rounds) * 100);
  }

  const severity = (f: Found): Severity => (f.severity === "error" ? "must-fix" : mode === "report" ? "polish" : "should-fix");
  const report: NewFinding[] = found.map((f) => {
    const hold = planned(f) ?? (f.shot !== null ? held.get(`${f.shot}:${f.code}`) : undefined);
    return {
      severity: severity(f), shotId: f.shot === null ? null : plan.shots[f.shot]!.id, ...(typeof f.time === "number" ? { fromSec: f.time } : {}),
      code: f.code, description: f.message, ...(f.hint ? { suggestedFix: f.hint } : {}), state: hold ? "kept" : "open", ...(hold ? { keptReason: hold } : {}), rule: "check",
    };
  });
  saveFindings(dir, "check", report);
  // what the author step left is only what is still wrong now
  saveFindings(dir, "author", plan.shots.flatMap((shot, i) => sceneFindings(plan, i, checkScene(readScene(dir, i) ?? "", shot, i, { assets }))));
  return { status: "done", outputRef: dir };
};
