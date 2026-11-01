import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config";
import { HttpError } from "../http";
import type { Jev } from "../jev";
import type { Llm } from "../llm";
import type { ExecFn } from "../runner";
import { now, type Store } from "../store";
import type { GenExport, GenPlan, GenProject, GenVerdict, GenVersion } from "../types";
import { Assets, projectDir } from "./assets";
import { Director, changedShots, type GateDecision as DirectorDecision } from "./director";
import { DirectorLog } from "./events";
import { readFindings, type Finding } from "./findings";
import { readFix, writeFix, type FixEdit, type FixFile } from "./fixes";
import { Hyperframes, requiredOk } from "./hyperframes";
import { mirrorProject, mirrorReview, readMirror } from "./mirror";
import { planContext } from "./planContext";
import { validatePlan, type Plan } from "./planSchema";
import { freezeRecipe, parseRecipe, seedRecipes, type Recipe, type RecipeStep } from "./recipe";
import { BuildQueue, clipJobBusy, estimateBuild } from "./queue";
import { Runner, parseStates, stepId, type GateDecision } from "./runner";
import { settingsOf } from "./steps";
import { STORYLINE_NOTE, chosenStoryline, parseStorylines, projectFlags } from "./steps/storylines";

// Entry point of Generate for the routes: availability, projects, the storyline pick and the plan
// (edit, revise, approve). Builds, versions and exports arrive with their stories. Generate is an
// AI-only mode (constitution IV): without an LLM it shows as unavailable with the reason, and
// clipping never depends on it.

export interface ConnectionState {
  llm: boolean;
  jev: boolean;
  image: boolean;
  vision: boolean;
  /** Voice engines with what they need set up (elevenlabs, fish, openai, local). */
  voiceEngines: string[];
  dataSources: string[];
  commands: string[];
}

export interface Availability { available: boolean; reasons: string[] }

export interface GenerateStatus extends Availability {
  hyperframes: { ok: boolean; version: string; reason?: string };
  llm: { configured: boolean };
  jev: { configured: boolean };
  image: { configured: boolean };
  vision: { configured: boolean };
  voice: { engines: string[]; localAvailable: boolean; localReason?: string };
  compute: "cpu" | "gpu";
  presets: string[];
}

export interface CreateProjectInput {
  brief?: unknown;
  recipeId?: string;
  format?: string;
  targetSec?: number;
  language?: string;
  styleNotes?: string;
  preset?: string;
  narration?: boolean;
  buildWithoutStopping?: boolean;
  ideaId?: string;
}

const DOCTOR_TTL_MS = 30_000;
const FORMATS = ["9:16", "16:9", "1:1"];
const MAX_BRIEF = 2000;

export class GenerateService {
  readonly log: DirectorLog;
  readonly director: Director;
  readonly runner: Runner;
  readonly assets: Assets;
  readonly queue: BuildQueue;
  private doctorCache: { at: number; result: { ok: boolean; reason?: string } } | null = null;
  private catalogCache: Array<{ name: string; tags: string[] }> | null = null;
  /** Work running in the background, by project. */
  private readonly running = new Map<string, Promise<unknown>>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
    readonly hyperframes: Hyperframes,
    private readonly llm: Llm,
    private readonly jev: Jev,
    exec: ExecFn,
  ) {
    this.log = new DirectorLog(store);
    this.director = new Director(llm, this.log, config.generatorDir);
    this.assets = new Assets(config, store);
    this.runner = new Runner(store, this.log, {
      connected: (c) => this.connected(c),
      directorGate: (ctx, result) => this.decide(ctx.project, ctx.step, result.outputRef),
      director: this.director,
      hyperframes,
      jev,
      exec,
      config,
      catalog: () => this.catalog(),
    });
    this.queue = new BuildQueue({
      concurrency: config.genConcurrency, pollMs: 5000, blocked: () => clipJobBusy(store),
      run: async (versionId, signal) => {
        try {
          await this.runner.runBuild(versionId, signal);
        } finally {
          mirrorReview(config, store, versionId);
          await this.afterBuild(versionId).catch((e: Error) => console.error(`Generate: after-build work for ${versionId} failed: ${e.message}`));
        }
      },
      cancelQueued: (versionId) => this.endQueued(versionId),
    });
  }

  /** Startup: example recipes into the database; what was running when the server stopped is marked interrupted. */
  start() {
    seedRecipes(this.store, `${this.config.generatorDir}/recipes`);
    this.runner.recoverInterrupted();
    for (const v of this.store.genVersionsByStatus("QUEUED")) this.queue.enqueue(v.id);
  }

  // ---- availability ---------------------------------------------------------

  get compute(): "cpu" | "gpu" { return this.config.whisperDevice === "cpu" ? "cpu" : "gpu"; }

  /** What is set up right now. Image, voice, vision, data and command connections arrive with their steps. */
  connections(): ConnectionState {
    return { llm: this.llm.enabled, jev: this.jev.enabled, image: false, vision: this.llm.visionModel !== null, voiceEngines: [], dataSources: [], commands: [] };
  }

  connected(name: string): boolean {
    const c = this.connections();
    return name === "llm" ? c.llm : name === "jev" ? c.jev : name === "image" ? c.image : name === "vision" ? c.vision
      : name === "voice" ? c.voiceEngines.length > 0 : false;
  }

  private async doctor(): Promise<{ ok: boolean; reason?: string }> {
    const cached = this.doctorCache;
    if (cached && Date.now() - cached.at < DOCTOR_TTL_MS) return cached.result;
    let result: { ok: boolean; reason?: string };
    try {
      const checked = requiredOk(await this.hyperframes.doctor());
      result = checked.ok ? { ok: true } : { ok: false, reason: `HyperFrames needs ${checked.failed.map((c) => `${c.name} (${c.detail})`).join(", ")}` };
    } catch (e) {
      result = { ok: false, reason: `HyperFrames can't run: ${(e as Error).message}` };
    }
    this.doctorCache = { at: Date.now(), result };
    return result;
  }

  async status(): Promise<GenerateStatus> {
    const c = this.connections();
    const doctor = await this.doctor();
    const reasons: string[] = [];
    if (!c.llm) reasons.push("Connect an LLM in Settings: Generate needs one to write storylines and plans");
    if (!doctor.ok) reasons.push(doctor.reason as string);
    return {
      available: reasons.length === 0,
      reasons,
      hyperframes: { ok: doctor.ok, version: this.hyperframes.version, ...(doctor.reason ? { reason: doctor.reason } : {}) },
      llm: { configured: c.llm },
      jev: { configured: c.jev },
      image: { configured: c.image },
      vision: { configured: c.vision },
      voice: {
        engines: c.voiceEngines, localAvailable: this.compute === "gpu",
        ...(this.compute === "gpu" ? {} : { localReason: "the local voice needs a GPU install" }),
      },
      compute: this.compute,
      presets: [],
    };
  }

  /** Why a recipe can't run here (a missing connection it needs), or none. */
  recipeAvailability(recipe: Recipe): Availability {
    const c = this.connections();
    const reasons: string[] = [];
    const needs = (step: RecipeStep, ok: boolean, why: string) => {
      if (!ok && !step.when) reasons.push(`${step.id ?? step.use}: ${why}`);
    };
    for (const step of recipe.steps) {
      const w = step.with ?? {};
      if (step.use === "voice") {
        const engine = w.engine as string | undefined;
        if (engine === "local" && this.compute === "cpu") reasons.push(`${step.id ?? step.use}: the local voice needs a GPU install`);
        else needs(step, engine ? c.voiceEngines.includes(engine) : c.voiceEngines.length > 0, "no voice engine is set up in Settings");
      }
      if (step.use === "images") needs(step, c.image, "needs the image connection in Settings");
      if (step.use === "look" || (step.use === "creative" && w.vision === "on")) needs(step, c.vision, "needs a vision-capable model in Settings");
      if (step.use === "command") needs(step, c.commands.includes(w.name as string), `the command "${String(w.name)}" isn't registered in Settings`);
      if (step.use === "facts" && Array.isArray(w.sources)) {
        for (const s of w.sources as string[]) needs(step, c.dataSources.includes(s), `the data source "${s}" isn't set up in Settings`);
      }
    }
    return { available: reasons.length === 0, reasons };
  }

  /** Names and tags of the HyperFrames registry blocks; empty when the CLI can't list them. */
  private async catalog(): Promise<Array<{ name: string; tags: string[] }>> {
    if (this.catalogCache) return this.catalogCache;
    try {
      this.catalogCache = (await this.hyperframes.catalog()).map((b) => ({ name: b.name, tags: b.tags ?? [] }));
      return this.catalogCache;
    } catch {
      return [];
    }
  }

  // ---- background work ------------------------------------------------------

  /** Runs `work` for a project without blocking the request; whatever it leaves is saved by the runner. */
  private launch(projectId: string, work: () => Promise<unknown>): void {
    const job = work()
      .catch((e: Error) => this.store.updateGenProject(projectId, { status: "FAILED", errorMessage: e.message }))
      .finally(() => {
        this.running.delete(projectId);
        mirrorProject(this.config, this.store, projectId);
      });
    this.running.set(projectId, job);
  }

  /** Resolves when no background work is running (tests, shutdown). */
  async whenIdle(): Promise<void> {
    do {
      while (this.running.size) await Promise.allSettled([...this.running.values()]);
      await this.queue.idle();
    } while (this.running.size);
  }

  private mustProject(id: string): GenProject {
    const p = this.store.getGenProject(id);
    if (!p) throw new HttpError(404, "Project not found");
    return p;
  }

  private idle(id: string): GenProject {
    const p = this.mustProject(id);
    if (this.running.has(id) || p.status === "BUILDING") throw new HttpError(409, "The project is still working: wait for it to stop");
    return p;
  }

  // ---- the director's gate --------------------------------------------------

  /** A `gate: director` step: the director picks a storyline or approves the plan, and says why. */
  private async decide(project: GenProject, step: RecipeStep, outputRef?: string): Promise<GateDecision> {
    const fresh = this.mustProject(project.id);
    if (step.use === "storylines") {
      const d = await this.director.gate({ project: fresh, step, kind: "storylines", output: parseStorylines(fresh), rule: step.with?.pickRule as string | undefined });
      this.store.updateGenProject(project.id, { pickedStoryline: d.index ?? 0 });
      return { approve: true, reason: d.reason };
    }
    if (step.use === "plan") {
      const row = this.store.getGenPlan(outputRef ?? fresh.currentPlanId ?? "");
      const d: DirectorDecision = await this.director.gate({ project: fresh, step, kind: "plan", output: row ? JSON.parse(row.plan) : null });
      if (d.decision === "approve" && row) this.store.updateGenPlan(row.id, { approvedAt: now() });
      return { approve: d.decision === "approve", reason: d.reason };
    }
    return { approve: true, reason: "no director decision is needed for this step" };
  }

  // ---- projects -------------------------------------------------------------

  async createProject(input: CreateProjectInput): Promise<GenProject> {
    const brief = typeof input.brief === "string" ? input.brief.trim() : "";
    if (!brief) throw new HttpError(400, "brief required");
    if (brief.length > MAX_BRIEF) throw new HttpError(400, `The brief can be at most ${MAX_BRIEF} characters`);
    const status = await this.status();
    if (!status.available) throw new HttpError(503, `Generate is unavailable: ${status.reasons.join("; ")}`);

    const recipeId = input.recipeId?.trim() || "quick";
    if (!this.store.getGenRecipe(recipeId)) throw new HttpError(404, `Recipe not found: ${recipeId}`);
    const frozen = freezeRecipe(this.store, recipeId);
    const availability = this.recipeAvailability(frozen.recipe);
    if (!availability.available) throw new HttpError(409, `The recipe ${recipeId} can't run here: ${availability.reasons.join("; ")}`);

    const format = input.format ?? "9:16";
    if (!FORMATS.includes(format)) throw new HttpError(400, `format must be one of ${FORMATS.join(", ")}`);
    const language = input.language ?? frozen.recipe.language ?? "id";
    if (language !== "id" && language !== "en") throw new HttpError(400, "language must be id or en");
    const { minSec, maxSec } = frozen.recipe.output;
    const targetSec = input.targetSec ?? Math.min(Math.max(30, minSec), maxSec);
    if (!Number.isInteger(targetSec) || targetSec < minSec || targetSec > maxSec) {
      throw new HttpError(400, `The length must be a whole number of seconds from ${minSec} to ${maxSec} for this recipe`);
    }

    const t = now();
    const project = this.store.saveGenProject({
      id: crypto.randomUUID(), title: null, brief, format, targetSec, language, styleNotes: input.styleNotes?.trim() || null,
      preset: input.preset ?? null, recipeId, recipe: frozen.json, ideaId: input.ideaId ?? null,
      briefFlags: input.buildWithoutStopping ? JSON.stringify({ buildWithoutStopping: true }) : null,
      narrationScript: null, concept: null, stepIndex: 0, stepState: null, narration: input.narration ? 1 : 0, storylines: null,
      pickedStoryline: null, status: "RUNNING", currentPlanId: null, acceptedVersionId: null, errorMessage: null, createdAt: t, updatedAt: t,
    });
    mirrorProject(this.config, this.store, project.id);
    this.launch(project.id, () => this.runner.runProject(project.id));
    return project;
  }

  listProjects() { return this.store.listGenProjects(); }

  getProject(id: string) {
    const project = this.mustProject(id);
    const versions = this.store.genVersionsForProject(id);
    return {
      project, plans: this.store.genPlansForProject(id), versions, assets: this.store.genAssetsForProject(id), exports: this.store.genExportsForProject(id),
      /** Each version's TECHNICAL and CREATIVE status, for the history list. */
      verdictStatuses: Object.fromEntries(versions.map((v) => [v.id, Object.fromEntries(this.store.genVerdictsForVersion(v.id).map((x) => [x.kind, x.status]))])) as Record<string, Partial<Record<"TECHNICAL" | "CREATIVE", string>>>,
    };
  }

  patchProject(id: string, patch: { title?: unknown; narration?: unknown; styleNotes?: unknown }): GenProject {
    this.mustProject(id);
    const fields: Partial<GenProject> = {};
    if (typeof patch.title === "string") fields.title = patch.title.trim().slice(0, 120) || null;
    if (typeof patch.narration === "boolean") fields.narration = patch.narration ? 1 : 0;
    if (typeof patch.styleNotes === "string") fields.styleNotes = patch.styleNotes.trim().slice(0, 500) || null;
    this.store.updateGenProject(id, fields);
    mirrorProject(this.config, this.store, id);
    return this.mustProject(id);
  }

  deleteProject(id: string): void {
    this.idle(id);
    this.store.deleteGenProject(id);
    rmSync(projectDir(this.config, id), { recursive: true, force: true });
  }

  events(id: string, limit = 200) {
    this.mustProject(id);
    return this.store.genEventsForProject(id, Math.max(1, Math.min(limit, 1000)));
  }

  file(id: string, name: string): string {
    this.mustProject(id);
    const text = readMirror(this.config, id, name);
    if (text === null) throw new HttpError(404, `${name} hasn't been written for this project`);
    return text;
  }

  /** After a failure (FR-016): the failed step runs again; finished steps and all saved work are kept. */
  retry(id: string): GenProject {
    const p = this.idle(id);
    if (p.status !== "FAILED") throw new HttpError(409, "Only a project that failed can be retried");
    this.launch(id, () => this.runner.retry(id));
    return this.mustProject(id);
  }

  // ---- storylines -----------------------------------------------------------

  /** "Show me different ones": the storylines step runs again (with the owner's note), and the plan after it. */
  newStorylines(id: string, note?: string): GenProject {
    const p = this.idle(id);
    const recipe = parseRecipe(p);
    const step = recipe.steps.find((s) => s.use === "storylines");
    if (!step) throw new HttpError(409, "This recipe has no storylines step");
    const flags = projectFlags(p);
    if (note?.trim()) flags[STORYLINE_NOTE] = note.trim().slice(0, 500);
    else delete flags[STORYLINE_NOTE];
    this.store.updateGenProject(id, { briefFlags: Object.keys(flags).length ? JSON.stringify(flags) : null, currentPlanId: null });
    this.runner.resetFrom(id, stepId(step));
    this.launch(id, () => this.runner.runProject(id));
    return this.mustProject(id);
  }

  /** The owner picks a storyline (with an optional note); the plan is written from it. */
  pick(id: string, index: number, note?: string): GenProject {
    const p = this.idle(id);
    const list = parseStorylines(p);
    if (!Number.isInteger(index) || index < 0 || index >= list.length) throw new HttpError(400, `index must be from 0 to ${list.length - 1}`);
    const recipe = parseRecipe(p);
    const storylines = recipe.steps.find((s) => s.use === "storylines") as RecipeStep;
    list[index] = { ...list[index]!, ...(note?.trim() ? { note: note.trim().slice(0, 500) } : {}) };
    this.store.updateGenProject(id, { storylines: JSON.stringify(list), pickedStoryline: index });

    if (parseStates(p.stepState)[stepId(storylines)]?.status === "waiting") this.runner.markApproved(id, stepId(storylines));
    else {
      // picking again after a plan exists: the plan is written again from the new pick
      this.runner.resetFrom(id, stepId(recipe.steps.find((s) => s.use === "plan") as RecipeStep));
      this.store.updateGenProject(id, { currentPlanId: null });
    }
    this.launch(id, () => this.runner.runProject(id));
    return this.mustProject(id);
  }

  // ---- plan -----------------------------------------------------------------

  private planOf(p: GenProject): GenPlan {
    const row = p.currentPlanId ? this.store.getGenPlan(p.currentPlanId) : null;
    if (!row) throw new HttpError(409, "There is no plan yet");
    return row;
  }

  private async checkPlan(p: GenProject, raw: unknown) {
    const catalog = (await this.catalog()).map((b) => b.name);
    const check = validatePlan(raw, planContext({ project: p, recipe: parseRecipe(p), assets: this.store.genAssetsForProject(p.id), connected: (c) => this.connected(c), catalog }));
    if (!check.ok) throw new HttpError(400, `The plan doesn't pass: ${check.errors.join("; ")}`);
    return check.plan as Plan;
  }

  /** Saves a new plan revision and sends it back to the owner for approval. */
  private savePlan(p: GenProject, plan: Plan, change: { request: string | null; summary: string | null }, approved = false): GenPlan {
    const revision = (this.store.genPlansForProject(p.id)[0]?.revision ?? 0) + 1;
    const row = this.store.saveGenPlan({
      id: crypto.randomUUID(), projectId: p.id, revision, plan: JSON.stringify(plan), changeRequest: change.request,
      changeSummary: change.summary, approvedAt: approved ? now() : null, createdAt: now(),
    });
    this.store.updateGenProject(p.id, { currentPlanId: row.id, title: plan.title });
    const planStep = parseRecipe(p).steps.find((s) => s.use === "plan") as RecipeStep;
    if (!approved) this.runner.markWaiting(p.id, stepId(planStep));
    mirrorProject(this.config, this.store, p.id);
    return row;
  }

  /** A direct edit of the plan: validated, saved as a new revision (an approved one is never changed). */
  async putPlan(id: string, raw: unknown): Promise<GenPlan> {
    const p = this.idle(id);
    this.planOf(p);
    return this.savePlan(p, await this.checkPlan(p, raw), { request: null, summary: "Edited by the owner" });
  }

  /** "Ask the director": a plain-words change, applied to the named shots only (FR-005). */
  async revisePlan(id: string, request: unknown): Promise<{ plan: GenPlan; changeSummary: string }> {
    const text = typeof request === "string" ? request.trim() : "";
    if (!text) throw new HttpError(400, "request required");
    const p = this.idle(id);
    const current = this.planOf(p);
    const recipe = parseRecipe(p);
    const planStep = recipe.steps.find((s) => s.use === "plan") as RecipeStep;
    const catalog = (await this.catalog()).map((b) => b.name);
    const planCtx = planContext({ project: p, recipe, assets: this.store.genAssetsForProject(id), connected: (c) => this.connected(c), catalog });
    const out = await this.director.revise({ project: p, step: planStep, current: JSON.parse(current.plan) as Plan, request: text, planCtx });
    return { plan: this.savePlan(p, out.plan, { request: text, summary: out.changeSummary }), changeSummary: out.changeSummary };
  }

  /** The owner approves the current revision (FR-006); the rest of the project's steps then run. */
  approvePlan(id: string, planId: unknown): GenProject {
    const p = this.idle(id);
    const current = this.planOf(p);
    if (planId !== current.id) throw new HttpError(409, "That isn't the current plan: reload and approve the latest revision");
    const planStep = parseRecipe(p).steps.find((s) => s.use === "plan") as RecipeStep;
    if (parseStates(p.stepState)[stepId(planStep)]?.status !== "waiting") throw new HttpError(409, "The plan isn't waiting for approval");
    this.store.updateGenPlan(current.id, { approvedAt: current.approvedAt ?? now() });
    this.runner.markApproved(id, stepId(planStep));
    this.launch(id, () => this.runner.runProject(id));
    return this.mustProject(id);
  }

  /** Nothing is built from an unapproved plan (FR-006). Returns the plan a build would use. */
  assertCanBuild(id: string): GenPlan {
    const p = this.mustProject(id);
    const row = p.currentPlanId ? this.store.getGenPlan(p.currentPlanId) : null;
    const planStep = parseRecipe(p).steps.find((s) => s.use === "plan") as RecipeStep;
    if (!row || !row.approvedAt || parseStates(p.stepState)[stepId(planStep)]?.status !== "done") {
      throw new HttpError(409, "Approve the plan first: nothing is built from an unapproved plan");
    }
    return row;
  }

  // ---- builds ---------------------------------------------------------------

  private mustVersion(id: string): GenVersion {
    const v = this.store.getGenVersion(id);
    if (!v) throw new HttpError(404, "Version not found");
    return v;
  }

  /** Queues a build of the approved plan as a new version; nothing is built from an unapproved plan (FR-006). */
  startBuild(projectId: string): GenVersion {
    const p = this.idle(projectId);
    return this.queueVersion(p, this.assertCanBuild(projectId));
  }

  /**
   * Makes the next version of a project and queues it. A fix round starts from the version it fixes:
   * that version's scenes are copied over, and fix.json says which shots change and how, so only
   * those are written again.
   */
  private queueVersion(p: GenProject, plan: GenPlan, opts: { parent?: GenVersion; fix?: FixFile } = {}): GenVersion {
    const quality = parseRecipe(p).steps.find((s) => s.use === "render")?.with?.quality;
    const number = (this.store.genVersionsForProject(p.id)[0]?.number ?? 0) + 1;
    const dir = `${projectDir(this.config, p.id)}/v${number}`;
    if (opts.parent?.projectDir && opts.fix) {
      mkdirSync(join(dir, "compositions"), { recursive: true });
      for (const f of readdirSync(join(opts.parent.projectDir, "compositions")).filter((x) => x.endsWith(".html"))) {
        cpSync(join(opts.parent.projectDir, "compositions", f), join(dir, "compositions", f));
      }
      writeFix(dir, opts.fix);
    }
    const t = now();
    const version = this.store.saveGenVersion({
      id: crypto.randomUUID(), projectId: p.id, planId: plan.id, number, parentVersionId: opts.parent?.id ?? null, status: "QUEUED", step: null, progress: 0,
      projectDir: dir, renderKind: quality === "delivery" ? "final" : "draft", draftPath: null,
      stepState: null, hyperframesVersion: this.hyperframes.version, buildMs: null, errorMessage: null, createdAt: t, updatedAt: t,
    });
    this.store.updateGenProject(p.id, { status: "BUILDING", errorMessage: null });
    this.queue.enqueue(version.id);
    return version;
  }

  /** A build that never started: the version ends CANCELLED and the project goes back to what it was. */
  private endQueued(versionId: string): void {
    const v = this.mustVersion(versionId);
    this.store.updateGenVersion(versionId, { status: "CANCELLED", errorMessage: null });
    const built = this.store.genVersionsForProject(v.projectId).some((x) => x.status === "BUILT");
    this.store.updateGenProject(v.projectId, { status: built ? "BUILT" : "WAITING" });
  }

  /** Stops a build: one still waiting never starts; a running one is killed with all it started. */
  cancelVersion(versionId: string): GenVersion {
    const v = this.mustVersion(versionId);
    if (!this.queue.cancel(v.id)) throw new HttpError(409, "That build has already finished");
    return this.mustVersion(versionId);
  }

  getVersion(versionId: string): { version: GenVersion; verdicts: GenVerdict[] } {
    return { version: this.mustVersion(versionId), verdicts: this.store.genVerdictsForVersion(versionId) };
  }

  /** The owner accepts a built version. Export is blocked while TECHNICAL is FAIL (FR-014). */
  acceptVersion(versionId: string): GenProject {
    const v = this.mustVersion(versionId);
    if (v.status !== "BUILT") throw new HttpError(409, "Only a finished build can be accepted");
    const technical = this.store.genVerdictsForVersion(versionId).find((x) => x.kind === "TECHNICAL");
    if (!technical) throw new HttpError(409, "This build has no TECHNICAL verdict yet");
    if (technical.status === "FAIL") throw new HttpError(409, "TECHNICAL failed: fix the must-fix findings before accepting");
    this.store.updateGenProject(v.projectId, { acceptedVersionId: v.id, status: "ACCEPTED" });
    return this.mustProject(v.projectId);
  }

  // ---- export ---------------------------------------------------------------

  private exporting = new Map<string, Promise<GenExport>>();

  /**
   * The finished video of a built version (the export step), refused while TECHNICAL fails. It runs
   * inside the request: a second request for the same version waits for the first one.
   */
  exportVersion(versionId: string, input: { title?: string; description?: string } = {}): Promise<GenExport> {
    const v = this.mustVersion(versionId);
    if (v.status !== "BUILT") throw new HttpError(409, "Only a finished build can be exported");
    if (!v.projectDir) throw new HttpError(409, "The files of that version were removed to save space: build again, or export a newer version");
    const running = this.exporting.get(versionId);
    if (running) return running;
    const work = this.runner.exportVersion(versionId, input).finally(() => this.exporting.delete(versionId));
    this.exporting.set(versionId, work);
    return work;
  }

  /** Every export, newest first, with the title of its project (the Library's "Generated" group). */
  listExports(): Array<GenExport & { projectTitle: string }> {
    return this.store.listGenExports().map((e) => {
      const p = this.store.getGenProject(e.projectId);
      return { ...e, projectTitle: p?.title ?? p?.brief.slice(0, 60) ?? "" };
    });
  }

  /** The exported video. */
  exportFile(exportId: string): string {
    const row = this.store.getGenExport(exportId);
    if (!row || !existsSync(row.path)) throw new HttpError(404, "Export not found");
    return row.path;
  }

  // ---- fix rounds, history -------------------------------------------------

  private async planContextOf(p: GenProject) {
    const catalog = (await this.catalog()).map((b) => b.name);
    return planContext({ project: p, recipe: parseRecipe(p), assets: this.store.genAssetsForProject(p.id), connected: (c) => this.connected(c), catalog });
  }

  /**
   * A fix round (FR-015): the chosen findings (by default every open must-fix one) and the owner's
   * note go to the director. Scene edits start a new version that rewrites only those shots and
   * re-runs both verdicts. If the director has to change the plan's words or timing, nothing is
   * built: the new plan revision waits for the owner's approval (`needsApproval`).
   */
  async fixVersion(versionId: string, input: { findingIds?: string[]; note?: string; shotId?: string } = {}, auto?: { depth: number }):
    Promise<{ version: GenVersion | null; plan: GenPlan | null; needsApproval: boolean; summary: string }> {
    const v = this.mustVersion(versionId);
    const p = this.idle(v.projectId);
    if (v.status !== "BUILT") throw new HttpError(409, "Only a finished build can be fixed");
    if (!v.projectDir) throw new HttpError(409, "The files of that version were removed to save space: build again, or fix a newer version");
    const all = readFindings(v.projectDir);
    const wanted = input.findingIds ?? [];
    const unknown = wanted.filter((id) => !all.some((f) => f.id === id));
    if (unknown.length) throw new HttpError(400, `No such finding: ${unknown.join(", ")}`);
    const chosen = wanted.length ? all.filter((f) => wanted.includes(f.id)) : all.filter((f) => f.severity === "must-fix" && f.state === "open");
    const note = input.note?.trim() || undefined;
    if (!chosen.length && !note) throw new HttpError(409, "There is nothing to fix: no must-fix findings are open. Choose findings or give a note.");
    const oldRow = this.store.getGenPlan(v.planId);
    if (!oldRow) throw new HttpError(409, "The plan of that version is missing");
    const plan = JSON.parse(oldRow.plan) as Plan;
    if (input.shotId && !plan.shots.some((x) => x.id === input.shotId)) throw new HttpError(400, `The plan has no shot ${input.shotId}`);

    const recipe = parseRecipe(p);
    const authorStep = recipe.steps.find((x) => x.use === "author") as RecipeStep;
    const answer = await this.director.fix({
      project: p, step: authorStep, plan, planCtx: await this.planContextOf(p), note, shotId: input.shotId,
      findings: chosen.map((f) => ({ id: f.id, severity: f.severity, shotId: f.shotId, fromSec: f.fromSec, toSec: f.toSec, code: f.code, description: f.description, suggestedFix: f.suggestedFix })),
    });

    let row = oldRow;
    if (answer.plan) {
      row = this.savePlan(p, answer.plan, { request: note ?? `Fix: ${chosen.map((f) => f.code).join(", ")}`, summary: answer.summary }, !answer.needsApproval);
      if (answer.needsApproval) return { version: null, plan: row, needsApproval: true, summary: answer.summary };
    }

    const forShot = (shotId: string) => chosen.filter((f) => f.shotId === shotId).map((f) => ({ code: f.code, message: f.description, hint: f.suggestedFix }));
    const edits = new Map<string, FixEdit>();
    for (const e of answer.sceneEdits) {
      const had = edits.get(e.shotId);
      edits.set(e.shotId, { shotId: e.shotId, instruction: had ? `${had.instruction} ${e.instruction}` : e.instruction, findings: forShot(e.shotId) });
    }
    if (answer.plan) {
      for (const id of changedShots(plan, answer.plan)) {
        if (!edits.has(id)) edits.set(id, { shotId: id, instruction: "The plan for this shot changed: update the scene to match it.", findings: forShot(id) });
      }
    }
    const version = this.queueVersion(this.mustProject(p.id), row, {
      parent: v, fix: { parentVersionId: v.id, summary: answer.summary, edits: [...edits.values()], auto: !!auto, depth: auto?.depth ?? 0 },
    });
    return { version, plan: answer.plan ? row : null, needsApproval: false, summary: answer.summary };
  }

  /** Makes the plan a version was built from the project's current plan again (an older version can be rebuilt or edited from). */
  restoreVersion(versionId: string): GenProject {
    const v = this.mustVersion(versionId);
    const p = this.idle(v.projectId);
    const row = this.store.getGenPlan(v.planId);
    if (!row) throw new HttpError(409, "The plan of that version is missing");
    this.store.updateGenProject(p.id, { currentPlanId: row.id, title: (JSON.parse(row.plan) as Plan).title });
    mirrorProject(this.config, this.store, p.id);
    return this.mustProject(p.id);
  }

  /** After a build ends: automatic fix rounds the recipe asks for, then the pruning of old versions. */
  private async afterBuild(versionId: string): Promise<void> {
    const v = this.mustVersion(versionId);
    try {
      if (v.status === "BUILT" && v.projectDir) await this.autoFix(v);
    } finally {
      this.prune(v.projectId);
    }
  }

  /** `autoFixRounds` on the technical and creative steps: a FAIL goes back to the director by itself, up to that many times. */
  private async autoFix(v: GenVersion): Promise<void> {
    const p = this.mustProject(v.projectId);
    const recipe = parseRecipe(p);
    const rounds = (use: "technical" | "creative") => Number(settingsOf(use, recipe.steps.find((s) => s.use === use)?.with).autoFixRounds);
    const depth = readFix(v.projectDir as string)?.depth ?? 0;
    const verdicts = this.store.genVerdictsForVersion(v.id);
    const failed = (kind: string) => verdicts.some((x) => x.kind === kind && x.status === "FAIL");
    const open = (f: Finding) => f.state === "open";
    const findings = readFindings(v.projectDir as string);
    const pick = failed("TECHNICAL") && depth < rounds("technical") ? findings.filter((f) => f.source !== "creative" && f.severity === "must-fix" && open(f))
      : failed("CREATIVE") && depth < rounds("creative") ? findings.filter((f) => f.source === "creative" && open(f)) : [];
    if (pick.length) await this.fixVersion(v.id, { findingIds: pick.map((f) => f.id) }, { depth: depth + 1 });
  }

  /** Old drafts are removed beyond GEN_KEEP_VERSIONS (the accepted one and any running build stay); the rows, plans and exports stay. */
  private prune(projectId: string): void {
    const p = this.store.getGenProject(projectId);
    if (!p) return;
    for (const v of this.store.genVersionsForProject(projectId).slice(this.config.genKeepVersions)) {
      if (!v.projectDir || v.id === p.acceptedVersionId || v.status === "QUEUED" || v.status === "BUILDING") continue;
      rmSync(v.projectDir, { recursive: true, force: true });
      this.store.updateGenVersion(v.id, { projectDir: null, draftPath: null });
    }
  }

  /** What a build and an export will take, from the builds so far. */
  estimate(projectId: string) { return estimateBuild(this.store, this.mustProject(projectId).targetSec); }

  /** The rendered video of a version (the draft the verdicts judged), for the player. */
  draftFile(versionId: string): string {
    const path = this.mustVersion(versionId).draftPath;
    if (!path) throw new HttpError(404, "This version has no video yet");
    return path;
  }

  /** A review sheet (review-beats, review-phone) the CREATIVE judge looked at. */
  sheetFile(versionId: string, name: string): string {
    const v = this.mustVersion(versionId);
    if (!["review-beats", "review-phone"].includes(name) || !v.projectDir) throw new HttpError(404, `No sheet called ${name}`);
    return `${v.projectDir}/sheets/${name}.jpg`;
  }

  /** The storyline the plan was built from (for the UI). */
  storyline(id: string) { return chosenStoryline(this.mustProject(id)); }
}
