import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkScene, shotFile, shotStarts, sizeFor } from "../composer";
import { readFindings, saveFindings, type NewFinding, type Severity } from "../findings";
import { HyperframesError, type HfFinding } from "../hyperframes";
import { planHasSound } from "../technical";
import { buildTarget, levelOfShot, readScene, readShotLevels, sceneAssets, sceneRules, shotIndexOf } from "./build";
import { levelDrop, partsInScene, shotWriter } from "./author";
import { levelBelow } from "../capabilities";
import { recordAnswer } from "../levels";
import type { KitManifest } from "../kit";
import type { Plan } from "../planSchema";
import type { StepContext } from "./types";

const round3 = (n: number) => Math.round(n * 1000) / 1000;
import { sceneFindings } from "./author";
import type { RunFn } from "./types";

// HyperFrames `lint` and `check` on the version's project, with what they find mapped to shots.
// Errors always go back to the director for a repair; warnings do too (fix) or may be kept on
// purpose with a reason (fix-or-hold) or only be reported (report).

/** Only Studio's editing aids: nothing a render or a viewer sees. */
const IGNORED = new Set(["studio_missing_editable_id"]);
/**
 * Chrome's own notes about reading WebGL pixels back for the frame capture: they come from how
 * HyperFrames captures a canvas, not from anything a scene does, and no repair can remove them.
 */
const CAPTURE_NOISE = /GL Driver Message .*GPU stall due to ReadPixels/;
/** A shot the plan marks as a hold is meant to stand still. */
const HOLD_CODES = new Set(["sweep_static", "dead_stretch"]);
/** HyperFrames says a film has no sound bed; a plan without sound meant that. */
const SILENT_CODE = "film_silent";

interface Found { shot: number | null; code: string; severity: "error" | "warning"; message: string; hint?: string; time?: number; count?: number }

/** The same code, shot and message is one finding with a count (a real build listed one console warning 45 times), at its first moment. */
export function grouped<T extends Found>(found: T[]): T[] {
  const out = new Map<string, T>();
  for (const f of found) {
    const key = JSON.stringify([f.code, f.shot, f.message]);
    const seen = out.get(key);
    if (!seen) out.set(key, { ...f });
    else {
      seen.count = (seen.count ?? 1) + 1;
      if (typeof f.time === "number" && !(typeof seen.time === "number" && seen.time <= f.time)) seen.time = f.time;
    }
  }
  return [...out.values()];
}

/** What a shot draws that may be slow: its own canvas or WebGL, or a kit part that wants a GPU. */
export function isHeavy(html: string, kit: KitManifest[]): boolean {
  if (/getContext\s*\(|\bTHREE\b/.test(html)) return true;
  const gpu = new Set(kit.filter((m) => m.needs.gpu !== "no").map((m) => m.name));
  return partsInScene(html).some((p) => gpu.has(p));
}

/**
 * The time one frame of the shot's middle takes to draw: three snapshots in a row less one (both pay
 * for the browser's start), halved. Snapshots stand in for the render: they seek and draw the same page.
 */
export async function frameCost(ctx: StepContext, dir: string, at: number, fps: number): Promise<number> {
  const clock = ctx.clock ?? (() => performance.now());
  const t0 = clock();
  await ctx.hyperframes.snapshot(dir, { at: [at] }, { signal: ctx.signal });
  const one = clock() - t0;
  const t1 = clock();
  await ctx.hyperframes.snapshot(dir, { at: [at, round3(at + 1 / fps), round3(at + 2 / fps)] }, { signal: ctx.signal });
  return Math.max(0, Math.round((clock() - t1 - one) / 2));
}

/** The registry blocks the shots use, read back from the project (prepareProject installed them). */
function blocksIn(dir: string, plan: Plan): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of plan.blocks) {
    for (const rel of [`compositions/${name}.html`, `compositions/components/${name}.html`]) if (existsSync(join(dir, rel))) out[name] = readFileSync(join(dir, rel), "utf-8").slice(0, 6000);
  }
  return out;
}

/**
 * Shots still failing after the rounds, and heavy shots over the frame budget, are rebuilt one level
 * down (research R26). Returns the findings the drops leave (`level_drop`, `frame_budget`).
 */
async function settleLevels(ctx: StepContext, dir: string, plan: Plan, failing: number[], starts: number[], durations: number[]): Promise<NewFinding[]> {
  const levels = readShotLevels(ctx);
  const kit = ctx.kit?.manifests() ?? [];
  const kitFloor = !!(ctx.kit && ctx.capabilities?.("kit").kit.length);
  const write = shotWriter(ctx, dir, plan, blocksIn(dir, plan), levels);
  const out: NewFinding[] = [];
  const drop = async (i: number, why: string, code: string) => {
    const shot = plan.shots[i]!;
    const level = levelOfShot(ctx, plan, i, levels);
    const lower = levelBelow(level);
    if (!lower || (lower === "kit" && !kitFloor)) return false;
    const planned = levels[shot.id]?.planned ?? level;
    levels[shot.id] = { planned, built: lower, reason: `${code === "frame_budget" ? "too slow to draw" : "still failing"} at ${level}: ${why}` };
    const built = await write(shot, i, lower, planned, null);
    writeFileSync(join(dir, shotFile(i)), built.html);
    levels[shot.id] = { ...levels[shot.id]!, built: built.level };
    recordAnswer(ctx.store, ctx.director.model, level, "dropped");
    out.push(levelDrop(shot.id, level, built.level, why, code), ...built.findings);
    return true;
  };
  const done = new Set<number>();
  for (const i of [...new Set(failing)]) if (await drop(i, "the check's findings remained after its rounds", "level_drop")) done.add(i);
  const fps = ctx.recipe.output.fps;
  for (const [i, shot] of plan.shots.entries()) {
    const html = readScene(dir, i);
    if (done.has(i) || !html || !isHeavy(html, kit) || !ctx.capabilities) continue;
    const budget = ctx.capabilities(levelOfShot(ctx, plan, i, levels)).renderer.frameBudgetMs;
    const cost = await frameCost(ctx, dir, round3(starts[i]! + durations[i]! / 2), fps);
    if (cost > budget && (await drop(i, `one frame took ${cost} ms to draw; the budget here is ${budget} ms`, "frame_budget"))) done.add(i);
    else if (cost > budget) out.push({ severity: "should-fix", shotId: shot.id, code: "frame_budget", state: "open", rule: "levels", description: `${shot.id}: one frame took ${cost} ms to draw; the budget here is ${budget} ms.`, suggestedFix: "Draw less in this shot, or render on a GPU." });
  }
  if (done.size && ctx.version) ctx.store.updateGenVersion(ctx.version.id, { shotLevels: JSON.stringify(levels) });
  return out;
}

/** lint first (cheap); `check` (it opens a browser) only once lint has no errors. */
async function collect(ctx: Parameters<RunFn>[0], dir: string, starts: number[], durations: number[]): Promise<Found[]> {
  const { hyperframes: hf, signal } = ctx;
  const map = (f: HfFinding): Found | null => {
    if (f.severity === "info" || IGNORED.has(f.code) || (f.code === "console_warning" && CAPTURE_NOISE.test(f.message))) return null;
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
    found = grouped(await collect(ctx, dir, starts, durations));
    // the plan's own rules count too: a scene that lost its text is repaired with the lint findings
    const planLock = plan.shots.flatMap((shot, i) => checkScene(readScene(dir, i) ?? "", shot, i, sceneRules(ctx, levelOfShot(ctx, plan, i))).map((c): Found => ({ shot: i, code: c.code, severity: "error", message: c.message, hint: c.hint })));
    const todo = [...repairs(found), ...planLock];
    const shots = [...new Set(todo.map((f) => f.shot as number))].filter((i) => (used.get(i) ?? 0) < rounds);
    if (!shots.length || round >= rounds) break;
    for (const i of shots) {
      const mine = todo.filter((f) => f.shot === i);
      const out = await ctx.director.repair({
        project: ctx.project, step: ctx.step, plan, index: i, ...size, assets, html: readScene(dir, i) ?? "", level: levelOfShot(ctx, plan, i),
        findings: mine.map((f) => ({ code: f.code, message: f.message, hint: f.hint })),
      });
      writeFileSync(join(dir, shotFile(i)), out.html);
      used.set(i, (used.get(i) ?? 0) + 1);
      if (mode === "fix-or-hold") for (const h of out.holds) held.set(`${i}:${h.code}`, h.reason);
    }
    ctx.progress(((round + 1) / rounds) * 100);
  }

  // FR-044: a shot the rounds couldn't fix, or one too heavy to draw in time, is rebuilt one level down
  // (with no rounds the recipe only wants a report: nothing was tried, so nothing drops)
  const dropped = await settleLevels(ctx, dir, plan, rounds === 0 ? [] : [...repairs(found).filter((f) => f.severity === "error"), ...plan.shots.flatMap((shot, i) =>
    checkScene(readScene(dir, i) ?? "", shot, i, sceneRules(ctx, levelOfShot(ctx, plan, i))).map((): Found => ({ shot: i, code: "plan-lock", severity: "error", message: "" })))]
    .map((f) => f.shot).filter((i): i is number => i !== null), starts, durations);
  if (dropped.length) found = grouped(await collect(ctx, dir, starts, durations));

  const severity = (f: Found): Severity => (f.severity === "error" ? "must-fix" : mode === "report" ? "polish" : "should-fix");
  const report: NewFinding[] = found.map((f) => {
    const hold = planned(f) ?? (f.shot !== null ? held.get(`${f.shot}:${f.code}`) : undefined);
    return {
      severity: severity(f), shotId: f.shot === null ? null : plan.shots[f.shot]!.id, ...(typeof f.time === "number" ? { fromSec: f.time } : {}),
      code: f.code, description: f.message, ...(f.count ? { count: f.count } : {}), ...(f.hint ? { suggestedFix: f.hint } : {}), state: hold ? "kept" : "open", ...(hold ? { keptReason: hold } : {}), rule: "check",
    };
  });
  saveFindings(dir, "check", [...report, ...dropped]);
  // what the author step left is only what is still wrong now (and the levels its shots dropped)
  const drops = readFindings(dir).filter((f) => f.source === "author" && f.rule === "levels").map(({ id: _id, source: _source, ...f }) => f);
  saveFindings(dir, "author", [...drops, ...plan.shots.flatMap((shot, i) => sceneFindings(plan, i, checkScene(readScene(dir, i) ?? "", shot, i, sceneRules(ctx, levelOfShot(ctx, plan, i)))))]);
  return { status: "done", outputRef: dir };
};
