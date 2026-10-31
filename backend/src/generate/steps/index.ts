import { STEP_SPECS, STEP_TYPES, type StepSpec, type StepType } from "./schema";
import type { RunFn, StepContext } from "./types";
import { run as align } from "./align";
import { run as author } from "./author";
import { run as check } from "./check";
import { run as command } from "./command";
import { run as concept } from "./concept";
import { run as creative } from "./creative";
import { run as exportStep } from "./export";
import { run as facts } from "./facts";
import { run as idea } from "./idea";
import { run as images } from "./images";
import { run as look } from "./look";
import { run as music } from "./music";
import { inputKey as planKey, run as plan } from "./plan";
import { run as render } from "./render";
import { run as script } from "./script";
import { run as storylines } from "./storylines";
import { run as technical } from "./technical";
import { run as voice } from "./voice";

export interface StepModule {
  type: StepType;
  spec: StepSpec;
  /** Used where the recipe leaves a setting out. */
  defaults: Record<string, unknown>;
  run: RunFn;
  /** What the output depends on besides the settings and the steps before it (a plan revision, the facts); part of the cache key. */
  inputKey?: (ctx: StepContext) => string;
}

const DEFAULTS: Record<StepType, Record<string, unknown>> = {
  idea: { cursor: true },
  facts: { mode: "verify", sources: [], headlinesAsEvidence: false, maxSteps: 8 },
  script: { spellNumbers: true, maxWords: 160 },
  voice: { failClosed: true, speed: 1 },
  align: { source: "auto" },
  storylines: { count: 3, skipUnderSec: 0, requireBold: false },
  plan: { numeric: false, motionPlan: false, timingFrom: "plan", blocks: true, templates: true, maxShots: 20 },
  concept: { mechanismTest: false, novelty: { lastN: 30 } },
  images: {},
  music: {},
  author: { repairRounds: 3, concurrency: 1 },
  check: { warnings: "fix-or-hold", rounds: 3 },
  look: { rounds: 3, beatOffsetSec: 0.3, audit: true },
  render: { quality: "draft", workers: 2 },
  command: { counts: "technical" },
  technical: { autoFixRounds: 0 },
  creative: { vision: "auto", autoFixRounds: 0 },
  export: { mode: "rerender", quality: "delivery" },
};

const RUNS: Record<StepType, RunFn> = {
  idea, facts, script, voice, align, storylines, plan, concept, images, music,
  author, check, look, render, command, technical, creative, export: exportStep,
};

const INPUT_KEYS: Partial<Record<StepType, (ctx: StepContext) => string>> = { plan: planKey };

export const STEPS: Record<StepType, StepModule> = Object.fromEntries(
  STEP_TYPES.map((type) => [type, { type, spec: STEP_SPECS[type], defaults: DEFAULTS[type], run: RUNS[type], inputKey: INPUT_KEYS[type] }]),
) as Record<StepType, StepModule>;

/** A step's settings: the recipe's `with` over the step type's defaults. */
export function settingsOf(type: StepType, withSettings: Record<string, unknown> | undefined): Record<string, unknown> {
  return { ...STEPS[type].defaults, ...(withSettings ?? {}) };
}
