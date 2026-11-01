import { requiresSourcedNumbers, unsourcedIn } from "../facts";
import type { RunFn } from "./types";

/** The narration, written before the plan so the plan can be built around what is said. */
export const run: RunFn = async (ctx) => {
  const { project } = ctx;
  if (project.narration !== 1) return { status: "skipped", reason: "narration is off for this video" };
  const lines = await ctx.director.script({ project, step: ctx.step, settings: ctx.settings, assets: ctx.store.genAssetsForProject(project.id) });
  if (requiresSourcedNumbers(ctx.recipe)) {
    const bad = unsourcedIn(lines.map((l) => l.text), project.brief, ctx.store.genFactsForProject(project.id));
    if (bad.length) throw new Error(`The script says numbers without a verified fact: ${bad.join(", ")}. Add them as facts with a source and verify them, or take them out.`);
  }
  ctx.store.updateGenProject(project.id, { narrationScript: JSON.stringify({ lines }) });
  return { status: "done", outputRef: "script" };
};

/** The script's lines as the project holds them. */
export function scriptLines(narrationScript: string | null): Array<{ id: string; text: string }> {
  if (!narrationScript) return [];
  try {
    const parsed = JSON.parse(narrationScript) as { lines?: Array<{ id: string; text: string }> };
    return Array.isArray(parsed.lines) ? parsed.lines : [];
  } catch {
    return [];
  }
}
