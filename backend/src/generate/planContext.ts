import type { GenAsset, GenProject } from "../types";
import type { PlanContext } from "./planSchema";
import type { Recipe } from "./recipe";
import { settingsOf } from "./steps";

/** Font families shipped in generator/fonts (all SIL OFL, Latin script covers Indonesian). */
export const BUNDLED_FONTS = ["Plus Jakarta Sans", "Inter", "Bebas Neue", "Lora"];

/** Bundled families plus uploaded font files (`meta.family`, else the file name without extension). */
export function availableFonts(assets: GenAsset[]): string[] {
  const uploaded = assets.filter((a) => a.kind === "font").map((a) => {
    const family = a.meta ? (JSON.parse(a.meta) as { family?: string }).family : undefined;
    return family ?? (a.path.split("/").pop() ?? a.path).replace(/\.[^.]+$/, "");
  });
  return [...BUNDLED_FONTS, ...uploaded];
}

export interface PlanContextInput {
  project: GenProject;
  recipe: Recipe;
  assets: GenAsset[];
  connected: (connection: string) => boolean;
  /** Names in the HyperFrames block catalog; empty = unknown, so any block name is accepted. */
  catalog: string[];
}

/** What a plan is checked against: the project, the recipe's plan settings and what is connected. */
export function planContext({ project, recipe, assets, connected, catalog }: PlanContextInput): PlanContext {
  const planStep = recipe.steps.find((s) => s.use === "plan");
  const settings = settingsOf("plan", planStep?.with);
  return {
    brief: project.brief, targetSec: project.targetSec, format: project.format, language: project.language,
    fonts: availableFonts(assets), imageConnected: connected("image"),
    narration: project.narration === 1 && connected("voice"),
    blocksAllowed: settings.blocks !== false, blocks: catalog.length ? catalog : null,
    limits: { maxShots: Number(settings.maxShots) },
  };
}
