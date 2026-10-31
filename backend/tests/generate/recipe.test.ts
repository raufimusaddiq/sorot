import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/db";
import { freezeRecipe, loadExampleRecipes, RecipeError, seedRecipes, validateRecipe, type Recipe, type RecipeStep } from "../../src/generate/recipe";
import { Store } from "../../src/store";
import { quickRecipe as quick } from "../helpers";

type Mutate = (r: Recipe) => unknown;
const withSteps = (f: (steps: RecipeStep[]) => RecipeStep[]): Mutate => (r) => ({ ...r, steps: f(r.steps) });
const without = (use: string): Mutate => withSteps((s) => s.filter((x) => x.use !== use));
const setStep = (use: string, patch: Partial<RecipeStep>): Mutate => withSteps((s) => s.map((x) => (x.use === use ? { ...x, ...patch } : x)));
const move = (use: string, toIndex: number): Mutate => withSteps((s) => {
  const rest = s.filter((x) => x.use !== use);
  rest.splice(toIndex, 0, s.find((x) => x.use === use) as RecipeStep);
  return rest;
});

describe("recipe validation", () => {
  test("the quick example is valid and an unattended-ready voice recipe too", () => {
    expect(validateRecipe(quick())).toEqual({ ok: true, errors: [], warnings: [] });
    const narrated = withSteps((s) => {
      const steps: RecipeStep[] = [
        { use: "facts", with: { mode: "verify" } }, { use: "script", with: { spellNumbers: true } },
        { use: "voice", with: { failClosed: true } }, { use: "align" }, { use: "concept", with: { novelty: { lastN: 30 } } },
        ...s.filter((x) => x.use !== "storylines").map((x): RecipeStep => (x.use === "plan" ? { ...x, gate: "director", with: { numeric: true, timingFrom: "voice" } } : x)),
      ];
      return steps;
    })(quick());
    expect(validateRecipe(narrated).errors).toEqual([]);
  });

  test.each<[string, Mutate, string]>([
    // shape and ranges
    ["not an object", () => 7, "must be an object"],
    ["unknown top-level key", (r) => ({ ...r, speed: 1 }), "recipe.speed: unknown key"],
    ["bad id", (r) => ({ ...r, id: "My Recipe" }), "recipe.id"],
    ["empty name", (r) => ({ ...r, name: " " }), "recipe.name"],
    ["bad language", (r) => ({ ...r, language: "fr" }), "recipe.language"],
    ["fps too high", (r) => ({ ...r, output: { ...r.output, fps: 120 } }), "recipe.output.fps: must be between 12 and 60"],
    ["width too small", (r) => ({ ...r, output: { ...r.output, width: 100 } }), "recipe.output.width"],
    ["min above max", (r) => ({ ...r, output: { ...r.output, minSec: 80, maxSec: 20 } }), "minSec can't be above maxSec"],
    ["length over 90 s", (r) => ({ ...r, output: { ...r.output, maxSec: 120 } }), "recipe.output.maxSec"],
    ["no output", (r) => ({ ...r, output: undefined }), "recipe.output: required"],
    ["no steps", (r) => ({ ...r, steps: [] }), "needs at least one step"],
    ["31 steps", withSteps((s) => [...s, ...Array.from({ length: 23 }, (_, i) => ({ use: "command" as const, id: `c${i}`, with: { name: "x" } }))]), "at most 30 steps"],
    ["unknown step type", withSteps((s) => [...s, { use: "dance" as never }]), 'unknown step type "dance"'],
    ["step without use", withSteps((s) => [...s, {} as never]), 'must be an object with "use"'],
    ["unknown step key", setStep("author", { color: "red" } as never), "author"],
    ["unknown setting", setStep("author", { with: { speed: 3 } }), 'step "author" (#3).with.speed: unknown setting'],
    ["setting out of range", setStep("author", { with: { repairRounds: 9 } }), "repairRounds: must be between 0 and 5"],
    ["setting of the wrong type", setStep("check", { with: { warnings: "maybe" } }), "must be one of fix, fix-or-hold, report"],
    ["with is not an object", setStep("author", { with: [] as never }), ".with: must be an object"],
    ["gate not allowed", setStep("author", { gate: "owner" }), "author allows none"],
    ["prompt too long", setStep("storylines", { prompt: { mode: "append", text: "x".repeat(4001) } }), "at most 4000 characters"],
    ["prompt without mode", setStep("storylines", { prompt: { text: "x" } as never }), "needs mode"],
    ["when is not a connection", setStep("storylines", { when: "now" }), ".when"],
    ["bad step id", setStep("storylines", { id: "A B" }), ".id: must be a slug"],
    ["repeated step without id", withSteps((s) => [...s, { use: "command", with: { name: "a" } }, { use: "command", with: { name: "b" } }]), "give repeated steps an id"],
    ["command without a name", withSteps((s) => [...s.slice(0, 5), { use: "command" }, ...s.slice(5)]), "name required"],
    ["9 creative criteria", setStep("creative", { with: { criteria: Array.from({ length: 9 }, (_, i) => ({ id: `q${i}`, question: "q" })) } }), "at most 8 items"],
    ["criterion without a question", setStep("creative", { with: { criteria: [{ id: "a" }] } }), "criteria[0].question: is required"],
    ["21 audit items", (r) => ({ ...r, rules: { defaultsAudit: Array.from({ length: 21 }, () => "x") } }), "at most 20 items"],
    ["21 content rules", (r) => ({ ...r, rules: { content: Array.from({ length: 21 }, (_, i) => ({ id: `r${i}`, question: "q" })) } }), "at most 20 items"],
    ["unknown rules key", (r) => ({ ...r, rules: { colour: 1 } }), "recipe.rules.colour: unknown setting"],
    // the two fixed rules
    ["no plan", without("plan"), "needs a plan step"],
    ["plan without a gate", setStep("plan", { gate: undefined }), ").gate: must be owner or director"],
    ["plan gate none", setStep("plan", { gate: "none" }), "plan allows owner, director"],
    ["plan after author", move("plan", 3), "must come before author"],
    ["no author", without("author"), "needs a author step"],
    ["two renders", withSteps((s) => [...s, { use: "render", id: "again" }]), "only one render step"],
    ["technical before render", move("technical", 3), "technical"],
    ["creative before render", move("creative", 2), "must come after render"],
    ["no creative", without("creative"), "needs a creative step"],
    ["export not last", move("export", 3), "must be the last step"],
    ["verdict after export", withSteps((s) => [...s.filter((x) => x.use !== "technical"), { use: "technical" }]), "export"],
    ["check after render", move("check", 6), "must come before render"],
    ["look before check", withSteps((s) => [...s.slice(0, 3), { use: "look" }, ...s.slice(3)]), "check"],
    // always-on measures
    ["an always-on measure turned off", setStep("technical", { with: { measures: { firstFrame: false } } }), "firstFrame: is always on and can't be turned off"],
    ["a measure number out of range", setStep("technical", { with: { measures: { speechMatch: { maxWordErrorRate: 3 } } } }), "maxWordErrorRate"],
    ["a measure of the wrong kind", setStep("technical", { with: { measures: { voiceRoute: "yes" } } }), "must be true or false"],
    ["a measure object without fields", setStep("technical", { with: { measures: { audio: 7 } } }), "must be true, false or an object"],
    // dependencies
    ["concept before storylines", withSteps((s) => [{ use: "concept" }, ...s]), "must come after storylines"],
    ["concept after plan", withSteps((s) => [...s.slice(0, 2), { use: "concept" }, ...s.slice(2)]), "must come before plan"],
    ["voice without script", withSteps((s) => [{ use: "voice" }, ...s]), "needs a script step earlier"],
    ["align without voice", withSteps((s) => [{ use: "align" }, ...s]), "needs a voice step earlier"],
    ["plan timed from voice without align", setStep("plan", { with: { timingFrom: "voice" } }), "needs an align step earlier"],
    ["speechMatch without voice", setStep("technical", { with: { measures: { speechMatch: true } } }), "speechMatch: needs a voice step"],
    ["sourcedNumbers without facts", setStep("technical", { with: { measures: { sourcedNumbers: true } } }), "sourcedNumbers: needs a facts step"],
    ["export copy of a draft", setStep("export", { with: { mode: "copy" } }), "copy needs render quality delivery"],
  ])("refuses: %s", (_name, mutate, message) => {
    const check = validateRecipe(mutate(quick()));
    expect(check.ok).toBe(false);
    expect(check.errors.join("\n")).toContain(message);
  });

  test.each<[string, Mutate]>([
    ["export copy of a delivery render", withSteps((s) => s.map((x) => (x.use === "render" ? { ...x, with: { quality: "delivery" } } : x.use === "export" ? { ...x, with: { mode: "copy" } } : x)))],
    ["optional measures with numbers", setStep("technical", { with: { measures: { audio: { minMeanVolumeDb: -30 }, deadStretchSec: 4, readability: true } } })],
    ["a repeated step with ids", withSteps((s) => [...s.slice(0, 3), { use: "command", id: "a", with: { name: "x" } }, { use: "command", id: "b", with: { name: "y" } }, ...s.slice(3)])],
    ["rules and a prompt", (r) => ({ ...r, rules: { layout: { safeTopPx: 168 }, defaultsAudit: ["everything centred"], content: [{ id: "a", question: "q", blocking: true }] },
      steps: r.steps.map((x) => (x.use === "storylines" ? { ...x, prompt: { mode: "replace", text: "go" }, when: "connection:llm" } : x)) })],
  ])("accepts: %s", (_name, mutate) => {
    expect(validateRecipe(mutate(quick())).errors).toEqual([]);
  });

  test("questions people write are linted against the design rules, as warnings: criteria and content rules", () => {
    const check = validateRecipe({
      ...(setStep("creative", { with: { criteria: [{ id: "good", question: "Does `opening` hold the eye?" }, { id: "vague", question: "Is it good?" }, { id: "timed", question: "Is `shots` longer than 30 seconds?" }] } })(quick()) as object),
      rules: { content: [{ id: "tone", question: "Is the tone pushy" }] },
    });
    expect(check.ok).toBe(true);
    expect(check.warnings).toEqual([
      'step "creative" criterion "vague": name the thing it reads in backticks, for example `shots`, `opening` or `message`',
      'step "creative" criterion "timed": leave counting and timing to the checks: ask about what can be seen, not how many or how long',
      'content rule "tone": name the thing it reads in backticks, for example `shots`, `opening` or `message`',
      'content rule "tone": end it with a question mark',
    ]);
    expect(validateRecipe(quick()).warnings).toEqual([]);
  });

  test("a creative step without criteria only warns, and the errors name the step", () => {
    const check = validateRecipe(setStep("creative", { with: {} })(quick()));
    expect(check).toMatchObject({ ok: true, errors: [] });
    expect(check.warnings[0]).toContain('step "creative" (#7)');
    expect(validateRecipe(setStep("author", { with: { repairRounds: 9 } })(quick())).errors[0]).toContain('step "author" (#3)');
  });
});

describe("example recipes", () => {
  const GENERATOR_RECIPES = join(import.meta.dir, "..", "..", "..", "generator", "recipes");
  const withDir = (files: Record<string, unknown>, fn: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "vc-recipes-"));
    try {
      for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), typeof body === "string" ? body : JSON.stringify(body));
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("every shipped example is valid and has a neutral shape", () => {
    const examples = loadExampleRecipes(GENERATOR_RECIPES);
    expect(examples.map((r) => r.id)).toContain("quick");
    for (const r of examples) expect(validateRecipe(r)).toEqual({ ok: true, errors: [], warnings: [] });
    expect(JSON.stringify(examples)).not.toMatch(/api[_-]?key|elevenlabs|voice id/i);
  });

  test("a missing folder has no examples; an invalid one is a loud error", () => {
    expect(loadExampleRecipes(join(tmpdir(), "no-such-folder-xyz"))).toEqual([]);
    withDir({ "bad.json": { ...quick(), steps: [] }, "note.txt": "ignored" }, (dir) => {
      expect(() => loadExampleRecipes(dir)).toThrow(/Example recipe bad.json is invalid/);
    });
  });

  test("seeding stores examples read-only, keeps user recipes, and only replaces older versions", () => {
    const store = new Store(openDatabase(":memory:"));
    withDir({ "quick.json": { ...quick(), version: 2, builtIn: undefined } }, (dir) => {
      expect(seedRecipes(store, dir)).toBe(1);
      expect(store.getGenRecipe("quick")).toMatchObject({ builtIn: 1, version: 2, name: "Quick" });
      expect(JSON.parse(store.getGenRecipe("quick")!.recipe)).toMatchObject({ builtIn: true, version: 2 });
      expect(seedRecipes(store, dir)).toBe(0);    // same version: untouched

      store.updateGenRecipe("quick", { ideaCursor: "IDEA-3" });
      writeFileSync(join(dir, "quick.json"), JSON.stringify({ ...quick(), version: 3 }));
      expect(seedRecipes(store, dir)).toBe(1);     // newer example replaces the stored one, cursor kept
      expect(store.getGenRecipe("quick")).toMatchObject({ version: 3, ideaCursor: "IDEA-3" });

      store.saveGenRecipe({ id: "quick", name: "Mine", version: 1, builtIn: 0, description: null, recipe: "{}", ideaCursor: null, createdAt: "t", updatedAt: "t" });
      writeFileSync(join(dir, "quick.json"), JSON.stringify({ ...quick(), version: 9 }));
      expect(seedRecipes(store, dir)).toBe(0);     // a user's recipe with the same id is never overwritten
      expect(store.getGenRecipe("quick")!.name).toBe("Mine");
    });
  });

  test("a project's frozen copy does not follow later edits or deletes", () => {
    const store = new Store(openDatabase(":memory:"));
    withDir({ "quick.json": quick() }, (dir) => seedRecipes(store, dir));
    const frozen = freezeRecipe(store, "quick");
    expect(JSON.parse(frozen.json)).toMatchObject({ id: "quick", version: 1 });
    store.updateGenRecipe("quick", { recipe: JSON.stringify({ ...quick(), name: "Changed" }), version: 2 });
    store.deleteGenRecipe("quick");
    expect(JSON.parse(frozen.json).name).toBe("Quick");
    expect(() => freezeRecipe(store, "quick")).toThrow(RecipeError);
  });
});
