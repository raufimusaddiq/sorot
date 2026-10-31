import type { Store } from "../../store";
import type { GenProject, GenVersion } from "../../types";
import type { DirectorLog } from "../events";
import type { Recipe, RecipeStep } from "../recipe";

/** What a step receives. `version` is set only for steps of the build segment (author ... export). */
export interface StepContext {
  project: GenProject;
  version: GenVersion | null;
  recipe: Recipe;
  step: RecipeStep;
  /** The step's `with`, over its defaults. */
  settings: Record<string, unknown>;
  store: Store;
  log: DirectorLog;
  signal?: AbortSignal;
  /** Percent done of this step (shown on the version while it builds). */
  progress: (percent: number, label?: string) => void;
}

export type StepStatus = "done" | "waiting" | "skipped";

export interface StepResult {
  status: StepStatus;
  /** Why it waited, was skipped, or what the director decided (logged in step_state). */
  reason?: string;
  /** A short pointer to what the step produced (row id, file name); the data itself lives in its own table / file. */
  outputRef?: string;
}

export type RunFn = (ctx: StepContext) => Promise<StepResult>;

/** A step type whose module has not been written yet fails loudly instead of doing nothing. */
export const notImplemented = (type: string): RunFn => async () => {
  throw new Error(`The ${type} step is not implemented yet`);
};
