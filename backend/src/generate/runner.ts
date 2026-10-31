import type { Store } from "../store";
import type { GenProject, GenVersion } from "../types";
import type { DirectorLog } from "./events";
import type { Recipe, RecipeStep } from "./recipe";
import { STEPS, settingsOf, type StepModule } from "./steps";
import type { StepType } from "./steps/schema";
import type { StepContext, StepResult } from "./steps/types";

// The runner walks a project's FROZEN recipe in order (data-model.md, "Project state machine"):
// a project segment (the steps before `author`) and a build segment (`author` ... `export`) per
// gen_version. Gates stop for the owner or log the director's decision. Each step's result is
// cached by an input hash, so a re-run only redoes what changed. A failure keeps all work.

export type StepStateStatus = "done" | "waiting" | "failed" | "skipped";

export interface StepState {
  status: StepStateStatus;
  /** Hash of everything this step's output depends on (including the steps before it). */
  inputHash: string;
  outputRef?: string;
  /** A director gate's decision, why a step waited or was skipped, or the failure. */
  reason?: string;
}

export type StepStates = Record<string, StepState>;

export interface GateDecision { approve: boolean; reason: string }
/** Asks the director whether a `gate: director` step's output may go on (storylines: which one; plan: approve). */
export type DirectorGate = (ctx: StepContext, result: StepResult) => Promise<GateDecision>;

export interface RunnerDeps {
  /** Is this connection (llm, jev, image, voice, vision) set up? Steps with `when: "connection:x"` are skipped without it. */
  connected: (connection: string) => boolean;
  directorGate: DirectorGate;
  /** The step library; tests pass stubs. */
  steps?: Record<StepType, StepModule>;
}

export class RunnerError extends Error {}

export const stepId = (s: RecipeStep) => s.id ?? s.use;

const hash = (value: unknown): string => {
  const h = new Bun.CryptoHasher("sha256");
  h.update(JSON.stringify(value));
  return h.digest("hex").slice(0, 16);
};

export const parseRecipe = (p: GenProject) => JSON.parse(p.recipe) as Recipe;
export const parseStates = (json: string | null): StepStates => (json ? (JSON.parse(json) as StepStates) : {});

/** Index of `author`: the steps before it are the project segment, the rest the build segment. */
export function authorIndex(recipe: Recipe): number {
  return recipe.steps.findIndex((s) => s.use === "author");
}

export class Runner {
  private readonly steps: Record<StepType, StepModule>;

  constructor(private readonly store: Store, private readonly log: DirectorLog, private readonly deps: RunnerDeps) {
    this.steps = deps.steps ?? STEPS;
  }

  // ---- project segment ------------------------------------------------------------

  /** Runs the project's steps from where it stopped until a gate, a failure, or the start of the build. */
  async runProject(projectId: string, signal?: AbortSignal): Promise<GenProject> {
    const project = this.mustProject(projectId);
    const recipe = parseRecipe(project);
    const states = parseStates(project.stepState);
    const end = authorIndex(recipe);
    this.store.updateGenProject(projectId, { status: "RUNNING", errorMessage: null });
    let prev = this.projectBase(project);

    for (let i = 0; i < end; i++) {
      const step = recipe.steps[i] as RecipeStep;
      const id = stepId(step);
      const fresh = this.mustProject(projectId);
      const ctx = this.context(fresh, null, recipe, step, signal);
      const key = this.inputHash(prev, ctx);
      const known = states[id];

      if (known && known.inputHash === key && (known.status === "done" || known.status === "skipped")) {
        prev = key;
        continue;
      }
      if (known && known.inputHash === key && known.status === "waiting") return this.stop(projectId, i, states, "WAITING");

      const outcome = await this.runStep(ctx, key, states, (s) => this.saveProjectStates(projectId, i, s));
      if (outcome.stop) return this.stop(projectId, i, states, outcome.stop === "failed" ? "FAILED" : "WAITING", outcome.error);
      prev = key;
    }
    // Everything before the build is done: the project waits for the user to start it.
    this.store.updateGenProject(projectId, { status: "WAITING", stepIndex: end, stepState: JSON.stringify(states) });
    return this.mustProject(projectId);
  }

  /** The owner approved a waiting step (a plan, a pick): mark it done and go on. */
  async approveStep(projectId: string, id: string, signal?: AbortSignal): Promise<GenProject> {
    const project = this.mustProject(projectId);
    const states = parseStates(project.stepState);
    const state = states[id];
    if (!state || state.status !== "waiting") throw new RunnerError(`Step "${id}" isn't waiting for approval`);
    states[id] = { ...state, status: "done", reason: state.reason ?? "approved by the owner" };
    this.store.updateGenProject(projectId, { stepState: JSON.stringify(states) });
    return this.runProject(projectId, signal);
  }

  /** Forgets the result of a step and everything after it (a revision, a new pick), so they run again. */
  resetFrom(projectId: string, id: string): GenProject {
    const project = this.mustProject(projectId);
    const recipe = parseRecipe(project);
    const from = recipe.steps.findIndex((s) => stepId(s) === id);
    if (from < 0) throw new RunnerError(`The recipe has no step "${id}"`);
    const states = parseStates(project.stepState);
    for (const s of recipe.steps.slice(from)) delete states[stepId(s)];
    this.store.updateGenProject(projectId, { stepState: JSON.stringify(states), stepIndex: from, status: "WAITING" });
    return this.mustProject(projectId);
  }

  /** Retry after a failure: the failed step runs again, finished steps are reused. */
  retry(projectId: string, signal?: AbortSignal): Promise<GenProject> {
    return this.runProject(projectId, signal);
  }

  // ---- build segment --------------------------------------------------------------

  /** Runs `author` ... `export` for one version. Cancelling (`signal`) ends it as CANCELLED. */
  async runBuild(versionId: string, signal?: AbortSignal): Promise<GenVersion> {
    const version = this.mustVersion(versionId);
    const project = this.mustProject(version.projectId);
    const recipe = parseRecipe(project);
    const planState = parseStates(project.stepState)[stepId(recipe.steps.find((s) => s.use === "plan") as RecipeStep)];
    if (!planState || planState.status !== "done") throw new RunnerError("The plan isn't approved yet, so nothing can be built");

    const start = authorIndex(recipe);
    const steps = recipe.steps.slice(start);
    const states = parseStates(version.stepState);
    const startedAt = Date.now();
    this.store.updateGenVersion(versionId, { status: "BUILDING", errorMessage: null });
    this.store.updateGenProject(project.id, { status: "BUILDING", errorMessage: null });
    let prev = hash([version.planId, this.projectBase(project)]);

    try {
      for (const [n, step] of steps.entries()) {
        const id = stepId(step);
        const ctx = this.context(this.mustProject(project.id), this.mustVersion(versionId), recipe, step, signal);
        const key = this.inputHash(prev, ctx);
        const known = states[id];
        this.store.updateGenVersion(versionId, { step: id, progress: Math.round((n / steps.length) * 100) });

        if (known && known.inputHash === key && (known.status === "done" || known.status === "skipped")) {
          prev = key;
          continue;
        }
        const outcome = await this.runStep(ctx, key, states, (s) => this.store.updateGenVersion(versionId, { stepState: JSON.stringify(s) }));
        if (outcome.stop === "failed") throw new RunnerError(outcome.error ?? "step failed");
        if (outcome.stop === "waiting") {
          // An export gate (owner): the version is built, the export waits for the owner.
          this.store.updateGenVersion(versionId, { status: "BUILT", progress: 100 });
          this.store.updateGenProject(project.id, { status: "BUILT" });
          return this.mustVersion(versionId);
        }
        prev = key;
      }
      this.store.updateGenVersion(versionId, { status: "BUILT", step: null, progress: 100, buildMs: Date.now() - startedAt });
      this.store.updateGenProject(project.id, { status: "BUILT" });
    } catch (e) {
      if (signal?.aborted) {
        this.store.updateGenVersion(versionId, { status: "CANCELLED", errorMessage: null });
        const built = this.store.genVersionsForProject(project.id).some((v) => v.status === "BUILT");
        this.store.updateGenProject(project.id, { status: built ? "BUILT" : "WAITING" });
      } else {
        const message = (e as Error).message;
        this.store.updateGenVersion(versionId, { status: "FAILED", errorMessage: message });
        this.store.updateGenProject(project.id, { status: "FAILED", errorMessage: message });
      }
    }
    return this.mustVersion(versionId);
  }

  // ---- restart --------------------------------------------------------------------

  /** After a restart nothing is running: what was in flight failed ("interrupted"), with its work kept. */
  recoverInterrupted(): { projects: number; versions: number } {
    const versions = this.store.genVersionsByStatus("BUILDING");
    for (const v of versions) this.store.updateGenVersion(v.id, { status: "FAILED", errorMessage: "interrupted" });
    const projects = this.store.listGenProjects().filter((p) => p.status === "RUNNING" || p.status === "BUILDING");
    for (const p of projects) this.store.updateGenProject(p.id, { status: "FAILED", errorMessage: "interrupted" });
    return { projects: projects.length, versions: versions.length };
  }

  // ---- internals ------------------------------------------------------------------

  private async runStep(
    ctx: StepContext, key: string, states: StepStates, save: (s: StepStates) => void,
  ): Promise<{ stop?: "waiting" | "failed"; error?: string }> {
    const step = ctx.step;
    const id = stepId(step);
    const when = step.when?.match(/^connection:(.+)$/)?.[1];
    if (when && !this.deps.connected(when)) {
      states[id] = { status: "skipped", inputHash: key, reason: `connection ${when} isn't set up` };
      save(states);
      return {};
    }
    try {
      const result = await this.steps[step.use].run(ctx);
      if (result.status === "skipped") {
        states[id] = { status: "skipped", inputHash: key, reason: result.reason };
        save(states);
        return {};
      }
      if (result.status === "waiting") {
        states[id] = { status: "waiting", inputHash: key, reason: result.reason, outputRef: result.outputRef };
        save(states);
        return { stop: "waiting" };
      }
      const gate = step.gate ?? "none";
      if (gate === "owner") {
        states[id] = { status: "waiting", inputHash: key, reason: "waiting for the owner", outputRef: result.outputRef };
        save(states);
        return { stop: "waiting" };
      }
      if (gate === "director") {
        const decision = await this.deps.directorGate(ctx, result);
        states[id] = { status: decision.approve ? "done" : "waiting", inputHash: key, reason: decision.reason, outputRef: result.outputRef };
        save(states);
        return decision.approve ? {} : { stop: "waiting" };
      }
      states[id] = { status: "done", inputHash: key, outputRef: result.outputRef, reason: result.reason };
      save(states);
      return {};
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      const error = (e as Error).message;
      states[id] = { status: "failed", inputHash: key, reason: error };
      save(states);
      return { stop: "failed", error };
    }
  }

  private context(project: GenProject, version: GenVersion | null, recipe: Recipe, step: RecipeStep, signal?: AbortSignal): StepContext {
    return {
      project, version, recipe, step, signal, store: this.store, log: this.log,
      settings: settingsOf(step.use, step.with),
      progress: (percent) => { if (version) this.store.updateGenVersion(version.id, { progress: Math.max(0, Math.min(100, Math.round(percent))) }); },
    };
  }

  /** Everything the first step depends on: the brief and the choices made with it. */
  private projectBase(p: GenProject): string {
    return hash([p.brief, p.format, p.targetSec, p.language, p.styleNotes, p.preset, p.narration, p.briefFlags]);
  }

  private inputHash(prev: string, ctx: StepContext): string {
    const { step } = ctx;
    return hash([prev, step.use, ctx.settings, step.prompt ?? null, step.gate ?? null, this.steps[step.use].inputKey?.(ctx) ?? null]);
  }

  private saveProjectStates(projectId: string, index: number, states: StepStates) {
    this.store.updateGenProject(projectId, { stepState: JSON.stringify(states), stepIndex: index });
  }

  private stop(projectId: string, index: number, states: StepStates, status: "WAITING" | "FAILED", error?: string): GenProject {
    this.store.updateGenProject(projectId, {
      status, stepIndex: index, stepState: JSON.stringify(states), errorMessage: status === "FAILED" ? (error ?? null) : null,
    });
    return this.mustProject(projectId);
  }

  private mustProject(id: string): GenProject {
    const p = this.store.getGenProject(id);
    if (!p) throw new RunnerError(`Project not found: ${id}`);
    return p;
  }

  private mustVersion(id: string): GenVersion {
    const v = this.store.getGenVersion(id);
    if (!v) throw new RunnerError(`Version not found: ${id}`);
    return v;
  }
}
