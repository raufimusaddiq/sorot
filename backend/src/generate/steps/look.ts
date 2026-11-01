import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkScene, shotFile, sizeFor } from "../composer";
import { saveFindings, type NewFinding } from "../findings";
import { beatTimes, expectations, lookFindings } from "../look";
import { buildTarget, readScene, sceneAssets } from "./build";
import type { RunFn, StepContext } from "./types";

const MIME: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png" };

/** One picture per shot (a little after it starts), as data URLs in shot order. */
async function frames(ctx: StepContext, dir: string, times: number[]): Promise<string[]> {
  const shots = await ctx.hyperframes.snapshot(dir, { at: times }, { signal: ctx.signal });
  const byTime = [...shots.frames].sort((a, b) => a.time - b.time);
  return times.map((t, i) => {
    const frame = byTime.reduce((best, f) => (Math.abs(f.time - t) < Math.abs(best.time - t) ? f : best), byTime[i] ?? byTime[0]!);
    return `data:${MIME[frame.path.split(".").pop()?.toLowerCase() ?? ""] ?? "image/png"};base64,${readFileSync(frame.path).toString("base64")}`;
  });
}

/**
 * The vision self-review: frames at each beat, described by a stranger, compared with what the plan
 * meant. Objects nobody can explain are must-fix. Up to `rounds` times a shot with must-fix
 * findings has its scene rewritten and is looked at again; whatever is left stays a finding.
 */
export const run: RunFn = async (ctx) => {
  const { dir, plan } = buildTarget(ctx);
  if (!ctx.director.visionModel) throw new Error("The look step needs a vision model: set one up in Settings, or give the step `when: connection:vision`");
  const rounds = Number(ctx.settings.rounds);
  const audit = ctx.settings.audit !== false;
  const defaults = ((ctx.recipe.rules?.defaultsAudit as string[] | undefined) ?? []).slice(0, 20);
  const times = beatTimes(plan, Number(ctx.settings.beatOffsetSec));
  const size = sizeFor(ctx.project.format, ctx.recipe.output);
  const assets = sceneAssets(ctx);

  let found: NewFinding[] = [];
  for (let round = 0; ; round++) {
    const answer = await ctx.director.look({ project: ctx.project, step: ctx.step, expected: expectations(plan), audit: audit ? defaults : [], images: await frames(ctx, dir, times) });
    found = lookFindings(answer, plan, times, audit);
    ctx.progress(Math.min(95, ((round + 1) / (rounds + 1)) * 100));
    const broken = [...new Set(found.filter((f) => f.severity === "must-fix" && f.shotId).map((f) => f.shotId as string))];
    if (round >= rounds || !broken.length) break;
    // fix the scenes of the shots with something unexplained, then look again
    for (const id of broken) {
      const index = plan.shots.findIndex((s) => s.id === id);
      const html = readScene(dir, index);
      if (html === null) continue;
      const fixed = await ctx.director.repair({
        project: ctx.project, step: ctx.step, plan, index, ...size, assets, html,
        findings: found.filter((f) => f.shotId === id).map((f) => ({ code: f.code, message: f.description, hint: f.suggestedFix })),
      });
      if (checkScene(fixed.html, plan.shots[index]!, index, { assets }).length === 0) writeFileSync(join(dir, shotFile(index)), fixed.html);
    }
  }
  saveFindings(dir, "look", found);
  return { status: "done", outputRef: `${found.length} findings` };
};
