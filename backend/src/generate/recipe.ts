import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { now, type Store } from "../store";
import type { GenProject } from "../types";
import { lintQuestion } from "./creative";
import { checkObject, isObject, STEP_SPECS, STEP_TYPES, type Field, type Gate, type StepType } from "./steps/schema";

// Recipe validation (contracts/recipe.md). A recipe is the user's pipeline: an ordered list of
// steps from the library. Only two things are fixed: a gated `plan` before `author`, and both
// verdicts after `render`. Everything else is checked for shape, ranges and dependencies.

export interface RecipeStep {
  use: StepType;
  id?: string;
  with?: Record<string, unknown>;
  gate?: Gate;
  prompt?: { mode: "append" | "replace"; text: string };
  when?: string;
}

export interface RecipeOutput { width: number; height: number; fps: number; minSec: number; maxSec: number }

export interface Recipe {
  id: string;
  name: string;
  description?: string;
  version?: number;
  builtIn?: boolean;
  output: RecipeOutput;
  language?: "id" | "en";
  steps: RecipeStep[];
  rules?: Record<string, unknown>;
}

export interface RecipeCheck { ok: boolean; errors: string[]; warnings: string[] }

export const RECIPE_LIMITS = { steps: 30, auditItems: 20, contentRules: 20, criteria: 8, promptChars: 4000 } as const;

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const WHEN = /^connection:(image|vision|voice|llm|jev)$/;

const OUTPUT_FIELDS: Record<string, Field> = {
  width: { t: "int", min: 360, max: 4096 }, height: { t: "int", min: 360, max: 4096 },
  fps: { t: "int", min: 12, max: 60 }, minSec: { t: "int", min: 5, max: 90 }, maxSec: { t: "int", min: 5, max: 90 },
};

const RULES_FIELDS: Record<string, Field> = {
  layout: { t: "obj", fields: {
    safeTopPx: { t: "int", min: 0, max: 4096 }, safeBottomPx: { t: "int", min: 0, max: 4096 },
    belowSafe: { t: "str", max: 60 }, captions: { t: "str", max: 60 }, firstFrame: { t: "str", max: 60 } } },
  readability: { t: "obj", fields: {
    minTextPx: { t: "int", min: 8, max: 400 }, holdBaseSec: { t: "num", min: 0, max: 10 }, holdPerWordSec: { t: "num", min: 0, max: 3 } } },
  defaultsAudit: { t: "strs", maxItems: RECIPE_LIMITS.auditItems, maxLen: 200 },
  content: { t: "list", max: RECIPE_LIMITS.contentRules, item: { t: "obj", required: ["id", "question"], fields: {
    id: { t: "str", max: 40 }, kind: { t: "enum", values: ["judge"] }, blocking: { t: "bool" }, question: { t: "str", max: 500 } } } },
};

/** `plan`'s kind of gate and where each step may sit relative to the others (checked below). */
const stepLabel = (s: RecipeStep, i: number) => `step "${s.id ?? s.use}" (#${i + 1})`;

export function validateRecipe(input: unknown): RecipeCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const err = (m: string) => errors.push(m);

  if (!isObject(input)) return { ok: false, errors: ["recipe: must be an object"], warnings };
  const top = new Set(["id", "name", "description", "version", "builtIn", "output", "language", "steps", "rules"]);
  for (const k of Object.keys(input)) if (!top.has(k)) err(`recipe.${k}: unknown key`);

  if (typeof input.id !== "string" || !SLUG.test(input.id)) err("recipe.id: must be a slug (lowercase letters, digits, dashes; up to 64 characters)");
  if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 80) err("recipe.name: required, at most 80 characters");
  if (input.description !== undefined && (typeof input.description !== "string" || input.description.length > 500)) err("recipe.description: must be text of at most 500 characters");
  if (input.version !== undefined && (!Number.isInteger(input.version) || (input.version as number) < 1)) err("recipe.version: must be a whole number from 1");
  if (input.builtIn !== undefined && typeof input.builtIn !== "boolean") err("recipe.builtIn: must be true or false");
  if (input.language !== undefined && input.language !== "id" && input.language !== "en") err("recipe.language: must be id or en");

  if (!isObject(input.output)) err("recipe.output: required (width, height, fps, minSec, maxSec)");
  else {
    checkObject(OUTPUT_FIELDS, input.output, "recipe.output", errors, Object.keys(OUTPUT_FIELDS));
    const { minSec, maxSec } = input.output;
    if (typeof minSec === "number" && typeof maxSec === "number" && minSec > maxSec) err("recipe.output: minSec can't be above maxSec");
  }

  if (input.rules !== undefined) {
    if (!isObject(input.rules)) err("recipe.rules: must be an object");
    else checkObject(RULES_FIELDS, input.rules, "recipe.rules", errors);
  }

  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    err("recipe.steps: needs at least one step");
    return { ok: false, errors, warnings };
  }
  if (input.steps.length > RECIPE_LIMITS.steps) err(`recipe.steps: at most ${RECIPE_LIMITS.steps} steps`);

  const steps: RecipeStep[] = [];
  const seen = new Map<string, number>();
  input.steps.forEach((raw: unknown, i: number) => {
    if (!isObject(raw) || typeof raw.use !== "string") return err(`step #${i + 1}: must be an object with "use"`);
    if (!(STEP_TYPES as readonly string[]).includes(raw.use)) return err(`step #${i + 1}: unknown step type "${raw.use}"`);
    const step = raw as unknown as RecipeStep;
    const label = stepLabel(step, i);
    for (const k of Object.keys(raw)) if (!["use", "id", "with", "gate", "prompt", "when"].includes(k)) err(`${label}.${k}: unknown key`);
    if (raw.id !== undefined && (typeof raw.id !== "string" || !SLUG.test(raw.id))) err(`${label}.id: must be a slug`);
    const key = step.id ?? step.use;
    if (seen.has(key)) err(`${label}: "${key}" is already used by step #${(seen.get(key) as number) + 1}; give repeated steps an id`);
    else seen.set(key, i);

    const spec = STEP_SPECS[step.use];
    if (raw.with !== undefined) {
      if (!isObject(raw.with)) err(`${label}.with: must be an object`);
      else checkObject(spec.fields, raw.with, `${label}.with`, errors, spec.required);
    } else if (spec.required?.length) err(`${label}.with: ${spec.required.join(", ")} required`);
    if (raw.gate !== undefined && !spec.gates.includes(raw.gate as Gate)) {
      err(`${label}.gate: ${step.use} allows ${spec.gates.join(", ")}`);
    }
    if (raw.prompt !== undefined) {
      const p = raw.prompt;
      if (!isObject(p) || (p.mode !== "append" && p.mode !== "replace") || typeof p.text !== "string") err(`${label}.prompt: needs mode (append or replace) and text`);
      else if (p.text.length > RECIPE_LIMITS.promptChars) err(`${label}.prompt: at most ${RECIPE_LIMITS.promptChars} characters`);
    }
    if (raw.when !== undefined && (typeof raw.when !== "string" || !WHEN.test(raw.when))) err(`${label}.when: must look like connection:image`);
    steps.push(step);
  });
  if (errors.length > 0 && steps.length !== input.steps.length) return { ok: false, errors, warnings };

  checkOrder(steps, err, warnings, input.rules);
  return { ok: errors.length === 0, errors, warnings };
}

function checkOrder(steps: RecipeStep[], err: (m: string) => void, warnings: string[], rules: unknown) {
  const first = (use: StepType) => steps.findIndex((s) => s.use === use);
  const last = (use: StepType) => steps.map((s) => s.use).lastIndexOf(use);
  const count = (use: StepType) => steps.filter((s) => s.use === use).length;
  const get = (use: StepType) => steps[first(use)];
  const label = (use: StepType) => `step "${get(use)?.id ?? use}" (#${first(use) + 1})`;
  const before = (a: StepType, b: StepType, why = "") => {
    if (first(a) >= 0 && first(b) >= 0 && first(a) > first(b)) err(`${label(a)}: must come before ${b}${why}`);
  };

  // The two fixed rules, and the steps they need.
  for (const use of ["plan", "author", "render", "technical", "creative"] as const) {
    if (count(use) === 0) err(`recipe.steps: needs a ${use} step`);
    else if (count(use) > 1) err(`recipe.steps: only one ${use} step is allowed`);
  }
  const plan = get("plan");
  if (plan && plan.gate !== "owner" && plan.gate !== "director") err(`${label("plan")}.gate: must be owner or director (nothing is built from an unapproved plan)`);
  before("plan", "author", " (plan before building)");
  before("author", "check");
  before("author", "look");
  before("author", "render");
  before("check", "look");
  before("look", "render");
  before("check", "render");
  for (const v of ["technical", "creative"] as const) {
    if (first(v) >= 0 && first("render") >= 0 && first(v) < first("render")) err(`${label(v)}: must come after render (both verdicts judge the rendered video)`);
  }
  if (first("export") >= 0 && last("export") !== steps.length - 1) err(`${label("export")}: must be the last step`);
  if (first("export") >= 0) {
    for (const v of ["technical", "creative"] as const) if (first(v) > first("export")) err(`${label(v)}: must come before export`);
  }

  // Concept sits between storylines and plan.
  if (first("concept") >= 0) {
    if (first("storylines") >= 0 && first("concept") < first("storylines")) err(`${label("concept")}: must come after storylines`);
    if (first("plan") >= 0 && first("concept") > first("plan")) err(`${label("concept")}: must come before plan (the plan builds on the recorded concept)`);
  }

  // Voice chain.
  const need = (use: StepType, needed: StepType, extra = "") => {
    if (first(use) >= 0 && (first(needed) < 0 || first(needed) > first(use))) err(`${label(use)}: needs a ${needed} step earlier${extra}`);
  };
  need("voice", "script");
  need("align", "voice");
  const timing = plan?.with?.timingFrom;
  if (timing === "voice" && (first("align") < 0 || first("align") > first("plan"))) err(`${label("plan")}.with.timingFrom: voice needs an align step earlier`);

  const measures = get("technical")?.with?.measures;
  if (isObject(measures)) {
    for (const m of ["speechMatch", "voiceRoute"]) if (measures[m] && first("voice") < 0) err(`${label("technical")}.with.measures.${m}: needs a voice step`);
    if (measures.sourcedNumbers && first("facts") < 0) err(`${label("technical")}.with.measures.sourcedNumbers: needs a facts step`);
  }

  const exp = get("export");
  const render = get("render");
  if (exp && exp.with?.mode === "copy" && render && (render.with?.quality ?? "draft") !== "delivery") {
    err(`${label("export")}.with.mode: copy needs render quality delivery (otherwise use rerender)`);
  }

  // The questions people write are held to the same design rules as Sorot's own: warnings, not errors.
  const questions = [
    ...(((get("creative")?.with?.criteria as Array<{ id: string; question: string }> | undefined) ?? []).map((c) => ["step \"creative\" criterion", c] as const)),
    ...(((rules as { content?: Array<{ id: string; question: string }> } | undefined)?.content ?? []).map((c) => ["content rule", c] as const)),
  ];
  for (const [where, q] of questions) {
    if (typeof q?.question !== "string") continue;   // already an error
    for (const problem of lintQuestion(q.question)) warnings.push(`${where} "${q.id}": ${problem}`);
  }

  const creative = get("creative");
  if (creative && !(isObject(creative.with) && Array.isArray(creative.with.criteria) && creative.with.criteria.length > 0)) {
    warnings.push(`${label("creative")}: no criteria, so only the main-message question is asked`);
  }
}

// ---- examples and frozen copies ---------------------------------------------------

export class RecipeError extends Error {}

/** The recipe a project was started with (its frozen copy). */
export const parseRecipe = (p: GenProject) => JSON.parse(p.recipe) as Recipe;

/** The example recipes shipped in generator/recipes/*.json (read-only; users copy them to edit). */
export function loadExampleRecipes(dir: string): Recipe[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => {
    const recipe = JSON.parse(readFileSync(join(dir, f), "utf-8")) as Recipe;
    const check = validateRecipe(recipe);
    if (!check.ok) throw new RecipeError(`Example recipe ${f} is invalid: ${check.errors.join("; ")}`);
    return recipe;
  });
}

/**
 * Copies the examples into gen_recipe at startup (built_in = 1, never edited by users). A newer
 * version of a shipped example replaces the stored one; user recipes are never touched.
 */
export function seedRecipes(store: Store, dir: string): number {
  let changed = 0;
  for (const recipe of loadExampleRecipes(dir)) {
    const row = store.getGenRecipe(recipe.id);
    if (row && !row.builtIn) continue;
    const version = recipe.version ?? 1;
    if (row && row.version >= version) continue;
    const t = now();
    store.saveGenRecipe({
      id: recipe.id, name: recipe.name, version, builtIn: 1, description: recipe.description ?? null,
      recipe: JSON.stringify({ ...recipe, builtIn: true, version }), ideaCursor: row?.ideaCursor ?? null,
      createdAt: row?.createdAt ?? t, updatedAt: t,
    });
    changed++;
  }
  return changed;
}

/** A project keeps its own copy of the recipe it started with, so later edits or deletes never change it (FR-024). */
export function freezeRecipe(store: Store, recipeId: string): { recipe: Recipe; json: string } {
  const row = store.getGenRecipe(recipeId);
  if (!row) throw new RecipeError(`Recipe not found: ${recipeId}`);
  const recipe = JSON.parse(row.recipe) as Recipe;
  return { recipe, json: JSON.stringify({ ...recipe, version: row.version }) };
}
