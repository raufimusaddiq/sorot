import type { AppConfig } from "../config";
import type { Jev } from "../jev";
import type { Llm } from "../llm";
import type { Store } from "../store";
import { DirectorLog } from "./events";
import { Hyperframes, requiredOk } from "./hyperframes";
import { seedRecipes, type Recipe, type RecipeStep } from "./recipe";
import { Runner } from "./runner";

// Entry point of Generate for the routes: availability now; projects, versions and exports as the
// stories land. Generate is an AI-only mode (constitution IV): without an LLM it shows as
// unavailable with the reason, and clipping never depends on it.

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

const DOCTOR_TTL_MS = 30_000;

export class GenerateService {
  readonly log: DirectorLog;
  readonly runner: Runner;
  private doctorCache: { at: number; result: { ok: boolean; reason?: string } } | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
    readonly hyperframes: Hyperframes,
    private readonly llm: Llm,
    private readonly jev: Jev,
  ) {
    this.log = new DirectorLog(store);
    this.runner = new Runner(store, this.log, {
      connected: (c) => this.connected(c),
      directorGate: async () => { throw new Error("The director gate isn't wired yet"); },
    });
  }

  /** Startup: example recipes into the database; what was running when the server stopped is marked interrupted. */
  start() {
    seedRecipes(this.store, `${this.config.generatorDir}/recipes`);
    this.runner.recoverInterrupted();
  }

  get compute(): "cpu" | "gpu" { return this.config.whisperDevice === "cpu" ? "cpu" : "gpu"; }

  /** What is set up right now. Image, voice, vision, data and command connections arrive with their steps. */
  connections(): ConnectionState {
    return { llm: this.llm.enabled, jev: this.jev.enabled, image: false, vision: false, voiceEngines: [], dataSources: [], commands: [] };
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
}
