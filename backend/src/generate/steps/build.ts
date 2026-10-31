import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HttpError } from "../../http";
import { shotFile } from "../composer";
import type { Plan } from "../planSchema";
import type { StepContext } from "./types";

// What the steps of a build (author, check, render, the verdicts) share: where the version's
// HyperFrames project is, which plan it was built from, and its scene files.

export interface BuildTarget {
  /** The version's HyperFrames project folder. */
  dir: string;
  plan: Plan;
}

/** The version a build step works on. Build steps always run inside one. */
export function buildTarget(ctx: StepContext): BuildTarget {
  const { version } = ctx;
  if (!version?.projectDir) throw new HttpError(500, `The ${ctx.step.use} step needs a version with a project folder`);
  const row = ctx.store.getGenPlan(version.planId);
  if (!row) throw new HttpError(500, "The version's plan is missing");
  return { dir: version.projectDir, plan: JSON.parse(row.plan) as Plan };
}

export const readScene = (dir: string, index: number): string | null => {
  const path = join(dir, shotFile(index));
  return existsSync(path) ? readFileSync(path, "utf-8") : null;
};

/** Paths the scenes may use: the project's own files (uploads and generated ones). */
export const sceneAssets = (ctx: StepContext): string[] =>
  ctx.store.genAssetsForProject(ctx.project.id).map((a) => a.path).sort();

/** The shot (0-based) a finding belongs to: its file, its selector, or the moment it happens. */
export function shotIndexOf(finding: { file?: string; sourceFile?: string; selector?: string; time?: number }, starts: number[], durations: number[]): number | null {
  const named = /shot-(\d+)\b/.exec(`${finding.file ?? ""} ${finding.sourceFile ?? ""} ${finding.selector ?? ""}`);
  if (named) {
    const i = Number(named[1]) - 1;
    return i >= 0 && i < starts.length ? i : null;
  }
  if (typeof finding.time === "number") {
    const i = starts.findIndex((s, k) => finding.time! >= s && finding.time! < s + (durations[k] ?? 0));
    return i >= 0 ? i : null;
  }
  return null;
}
