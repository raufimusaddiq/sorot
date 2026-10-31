import type { GenProject } from "../../types";
import type { Storyline } from "../director";
import type { RunFn } from "./types";

/** The owner's "show me different ones" note, kept with the brief flags so it survives a restart. */
export const STORYLINE_NOTE = "storylineNote";

export function projectFlags(project: GenProject): Record<string, unknown> {
  return project.briefFlags ? (JSON.parse(project.briefFlags) as Record<string, unknown>) : {};
}

export function parseStorylines(project: GenProject): Storyline[] {
  return project.storylines ? (JSON.parse(project.storylines) as Storyline[]) : [];
}

/** The storyline the plan builds on: the one picked, else the recommended one, else none (a short video skips storylines). */
export function chosenStoryline(project: GenProject): Storyline | null {
  const list = parseStorylines(project);
  return list[project.pickedStoryline ?? -1] ?? list.find((s) => s.recommended) ?? null;
}

/** Writes N different storylines. The gate (owner or director) decides which one the plan uses. */
export const run: RunFn = async (ctx) => {
  const { project, settings } = ctx;
  const skipUnder = Number(settings.skipUnderSec);
  if (skipUnder > 0 && project.targetSec <= skipUnder) {
    return { status: "skipped", reason: `a ${project.targetSec} s video goes straight to the plan` };
  }
  const note = projectFlags(project)[STORYLINE_NOTE];
  const list = await ctx.director.storylines({
    project, step: ctx.step, settings, assets: ctx.store.genAssetsForProject(project.id), ...(typeof note === "string" ? { note } : {}),
  });
  ctx.store.updateGenProject(project.id, { storylines: JSON.stringify(list), pickedStoryline: null });
  return { status: "done", outputRef: "storylines" };
};
