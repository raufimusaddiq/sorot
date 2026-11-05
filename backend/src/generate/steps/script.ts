import { requiresSourcedNumbers, unsourcedIn } from "../facts";
import { forbiddenIn } from "../technical";
import type { RecipeStep } from "../recipe";
import type { RunFn, StepContext } from "./types";

/** What the voice measured when it ran past the film: the script is written again to fit. */
export interface Overrun { spokenSec: number; filmSec: number; lines: Array<{ id: string; text: string; sec: number }> }

/** The director writes the script (again, told the measured overrun) and the project keeps it. */
export async function writeScript(ctx: StepContext, step: RecipeStep, settings: StepContext["settings"], overrun?: Overrun) {
  const { project } = ctx;
  const factual = requiresSourcedNumbers(ctx.recipe);
  const flag = project.briefFlags ? (JSON.parse(project.briefFlags) as Record<string, unknown>).forbiddenNumbers : undefined;
  const unsourced = (texts: string[]) => unsourcedIn(texts, project.brief, ctx.store.genFactsForProject(project.id));
  // A factual recipe, or a brief that rules numbers out: such a number goes back to the director to repair first.
  const check = (texts: string[]) => [...new Set([...(factual ? unsourced(texts) : []), ...forbiddenIn(texts, flag, project.brief)])];
  const lines = await ctx.director.script({ project, step, settings, assets: ctx.store.genAssetsForProject(project.id), ...(factual || flag ? { unsourced: check } : {}), ...(overrun ? { overrun } : {}) });
  if (factual) {
    const bad = unsourced(lines.map((l) => l.text));
    if (bad.length) throw new Error(`The script says numbers without a verified fact: ${bad.join(", ")}. Add them as facts with a source and verify them, or take them out.`);
  }
  ctx.store.updateGenProject(project.id, { narrationScript: JSON.stringify({ lines }) });
  return lines;
}

/** The narration, written before the plan so the plan can be built around what is said. */
export const run: RunFn = async (ctx) => {
  if (ctx.project.narration !== 1) return { status: "skipped", reason: "narration is off for this video" };
  await writeScript(ctx, ctx.step, ctx.settings);
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
