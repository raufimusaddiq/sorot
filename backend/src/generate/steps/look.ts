import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkScene, shotFile, sizeFor } from "../composer";
import { saveFindings, type NewFinding } from "../findings";
import { framesAt, lookedInLoop } from "../directorTools";
import { expectations, lookFindings, lookTimes } from "../look";
import { buildTarget, levelOfShot, readScene, sceneAssets, sceneRules } from "./build";
import type { RunFn, StepContext } from "./types";

/**
 * The vision self-review: three pictures of each shot (early, middle, settled), described by a stranger
 * shot by shot, compared with what the plan meant. Objects nobody can explain are must-fix. Up to `rounds` times a shot with must-fix
 * findings has its scene rewritten and is looked at again; whatever is left stays a finding.
 */
export const run: RunFn = async (ctx) => {
  const { dir, plan } = buildTarget(ctx);
  if (!ctx.director.canSee) throw new Error("The look step needs the LLM (its model looks at the frames): connect it in Settings, or give the step `when: connection:vision`");
  // the director looked at every shot in its own turn, and the scenes are the ones it looked at: nothing left to look at
  if (lookedInLoop(dir, plan, (i) => readScene(dir, i))) {
    saveFindings(dir, "look", []);
    return { status: "done", outputRef: "looked in the loop" };
  }
  const rounds = Number(ctx.settings.rounds);
  const audit = ctx.settings.audit !== false;
  const defaults = ((ctx.recipe.rules?.defaultsAudit as string[] | undefined) ?? []).slice(0, 20);
  const moments = lookTimes(plan);   // three pictures of each shot, early to late
  const times = moments.map((m) => m[m.length - 1]!);
  const size = sizeFor(ctx.project.format, ctx.recipe.output);
  const assets = sceneAssets(ctx);

  let found: NewFinding[] = [];
  for (let round = 0; ; round++) {
    ctx.signal?.throwIfAborted();
    const answer = await ctx.director.look({ project: ctx.project, step: ctx.step, expected: expectations(plan, moments[0]?.length ?? 1), audit: audit ? defaults : [], images: await framesAt(ctx.hyperframes, dir, moments.flat(), ctx.signal) });
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
        project: ctx.project, step: ctx.step, plan, index, ...size, assets, html, signal: ctx.signal, ...(ctx.version ? { session: ctx.version.id } : {}),
        findings: found.filter((f) => f.shotId === id).map((f) => ({ code: f.code, message: f.description, hint: f.suggestedFix })),
      });
      if (checkScene(fixed.html, plan.shots[index]!, index, sceneRules(ctx, levelOfShot(ctx, plan, index))).length === 0) writeFileSync(join(dir, shotFile(index)), fixed.html);
    }
  }
  saveFindings(dir, "look", found);
  return { status: "done", outputRef: `${found.length} findings` };
};
