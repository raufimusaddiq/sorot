import type { GenPlan, GenProject } from "../types";

// API shapes: the rows with their JSON columns parsed, so the UI and the CLI never parse twice.
// Keys stay the camelCase of the columns (constitution V).

const parse = <T>(json: string | null): T | null => (json ? (JSON.parse(json) as T) : null);

export function projectView(p: GenProject, opts: { recipe?: boolean } = {}) {
  const { recipe, storylines, stepState, briefFlags, narrationScript, ...rest } = p;
  return {
    ...rest,
    storylines: parse<unknown[]>(storylines),
    stepState: parse<Record<string, unknown>>(stepState),
    briefFlags: parse<Record<string, unknown>>(briefFlags),
    narrationScript: parse<unknown>(narrationScript),
    ...(opts.recipe ? { recipe: JSON.parse(recipe) as unknown } : {}),
  };
}

export function planView(row: GenPlan) {
  return { ...row, plan: JSON.parse(row.plan) as unknown };
}
