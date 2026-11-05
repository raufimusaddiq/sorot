import type { AppConfig } from "../config";
import type { Recipe } from "./recipe";
import { renderTimeoutBudget } from "./hyperframes";
import type { KitManifest, KitRuntime } from "./kit";
import { checkPartSettings } from "./kit";
import { TRANSITION_NAMES } from "./transitions";

// The capability description (research R27, FR-047): what a director call may use on this install,
// generated per call from what is installed and connected, never written by hand. Plan calls get the
// parts in one line each; scene and kit-level calls also get the full settings of the parts the shot
// uses, so a small model's context stays small. Answers are checked against the same description.

export const LEVELS = ["kit", "compose", "free"] as const;
export type Level = (typeof LEVELS)[number];

export const LEVEL_MEANS: Record<Level, string> = {
  kit: "fill in kit parts, their settings and their times for the shot (submit_shot_kit); Sorot writes the scene from them",
  compose: "write the scene HTML; use kit parts by mounting them with SorotKitRuntime.mount(name, host, settings, {tl, duration}); add your own GSAP and 2D canvas; no WebGL of your own",
  free: "write the scene HTML with any drawing the contract allows: kit parts, your own canvas or WebGL, or Three.js through SorotKit.three.setup",
};

/**
 * The highest level a CPU install offers by default. Spike S7 (2026-11-02, 4-core Xeon, no GPU, draft,
 * 2 workers, 10 s at 1080x1920): six lit Three.js coins in software WebGL rendered at 2.3 s per second
 * of video and plain 2D movers at 1.0 s, both far inside the render's 15 s planning figure, so a CPU
 * install keeps `free`; a shot that draws too slowly is caught by the frame budget and dropped a level.
 */
export const CPU_MAX_LEVEL: Level = "free";

const isLevel = (v: unknown): v is Level => typeof v === "string" && (LEVELS as readonly string[]).includes(v);

/** The highest level a recipe allows (`author.maxLevel`, default free). */
export const recipeMaxLevel = (recipe: Pick<Recipe, "steps">): Level => {
  const v = recipe.steps.find((s) => s.use === "author")?.with?.maxLevel;
  return isLevel(v) ? v : "free";
};
/** A recipe's pinned level (`author.level`), or auto. */
export const recipeLevel = (recipe: Pick<Recipe, "steps">): Level | "auto" => {
  const v = recipe.steps.find((s) => s.use === "author")?.with?.level;
  return isLevel(v) ? v : "auto";
};
export { isLevel };

/** The level order, lowest first: a shot that fails drops one step toward `kit`. */
export const levelBelow = (level: Level): Level | null => (level === "free" ? "compose" : level === "compose" ? "kit" : null);
export const atMost = (level: Level, max: Level): Level => (LEVELS.indexOf(level) <= LEVELS.indexOf(max) ? level : max);

export interface Capabilities {
  level: Level;
  levelMeans: string;
  kit: Array<{ name: string; does: string; runtime: KitRuntime }>;
  kitDetail?: Record<string, { settings: KitManifest["settings"]; defaults: Record<string, unknown>; example: string }>;
  seams: string[];
  renderer: { hyperframes: string; runtimes: KitRuntime[]; gpu: boolean; frameBudgetMs: number };
  connections: { image: boolean; voice: boolean; vision: boolean };
}

export interface CapabilityInput {
  level: Level;
  /** Parts whose full settings this call gets (the shot's parts); none for plan calls. */
  parts?: string[];
  kit: KitManifest[];
  config: Pick<AppConfig, "whisperDevice" | "hyperframesVersion">;
  /** Is this connection set up (image, voice, vision)? */
  connected: (connection: string) => boolean;
  /** The highest level the recipe or the machine allows; WebGL on a CPU only when it is `free`. */
  maxLevel?: Level;
  /** The render's Chrome workers, for the frame budget. */
  workers?: number;
}

/**
 * How long one frame may take to draw before the render risks its time limit: the render's planning
 * figure (seconds of render per second of video at 30 fps; the limit grows with the frame rate, so the
 * figure per frame doesn't change), with each Chrome worker drawing its own share of the frames.
 */
export const frameBudgetMs = (workers: number) => Math.round((renderTimeoutBudget() * 1000 / 30) * Math.max(1, workers));

/** What this machine can draw: the DOM and 2D canvas always; WebGL with a GPU, or in software when the level allows `free`. */
export function runtimesFor(gpu: boolean, maxLevel: Level): KitRuntime[] {
  return gpu || maxLevel === "free" ? ["dom", "canvas", "webgl"] : ["dom", "canvas"];
}

/**
 * Which parts a call may use: every part the machine can draw, at any level. A WebGL part is Sorot's own
 * tested code (rendered twice the same before it is offered), so it is safe below `free`; what stays a
 * `free`-only thing is the model writing its own WebGL (checkScene). Owner's decision, 2026-11-02: the
 * isometric `iso` part should reach kit-level films.
 */
export function partsFor(_level: Level, kit: KitManifest[], runtimes: KitRuntime[]): KitManifest[] {
  return kit.filter((p) => runtimes.includes(p.runtime));
}

export function capabilitiesFor(input: CapabilityInput): Capabilities {
  const gpu = input.config.whisperDevice !== "cpu";
  const max = input.maxLevel ?? "free";
  const level = atMost(input.level, max);
  const runtimes = runtimesFor(gpu, max);
  const usable = partsFor(level, input.kit, runtimes).sort((a, b) => a.name.localeCompare(b.name));
  const detail = usable.filter((p) => input.parts?.includes(p.name));
  return {
    level,
    levelMeans: LEVEL_MEANS[level],
    kit: usable.map((p) => ({ name: p.name, does: p.does, runtime: p.runtime })),
    ...(input.parts ? { kitDetail: Object.fromEntries(detail.map((p) => [p.name, { settings: p.settings, defaults: p.defaults, example: p.example }])) } : {}),
    seams: [...TRANSITION_NAMES],
    renderer: { hyperframes: input.config.hyperframesVersion, runtimes, gpu, frameBudgetMs: frameBudgetMs(input.workers ?? 2) },
    connections: { image: input.connected("image"), voice: input.connected("voice"), vision: input.connected("vision") },
  };
}

export interface KitProblem { code: "kit_unknown_part" | "kit_bad_setting" | "kit_not_allowed"; message: string }

/** Checks part references (`{part, settings}`) against what the description allows; one problem each. */
export function checkPartRefs(refs: Array<{ part: string; settings?: unknown }>, caps: Capabilities, kit: KitManifest[], path: string): KitProblem[] {
  const problems: KitProblem[] = [];
  const allowed = new Set(caps.kit.map((p) => p.name));
  refs.forEach((r, i) => {
    const m = kit.find((p) => p.name === r.part);
    if (!m) problems.push({ code: "kit_unknown_part", message: `${path}[${i}]: "${r.part}" isn't an installed kit part (installed: ${caps.kit.map((p) => p.name).join(", ") || "none"})` });
    else if (!allowed.has(r.part)) problems.push({ code: "kit_not_allowed", message: `${path}[${i}]: "${r.part}" (${m.runtime}) isn't allowed at the ${caps.level} level on this machine` });
    else for (const e of checkPartSettings(m, r.settings ?? {}, `${path}[${i}].settings`)) problems.push({ code: "kit_bad_setting", message: e });
  });
  return problems;
}
