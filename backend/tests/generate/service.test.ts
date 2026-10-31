import { afterEach, describe, expect, test } from "bun:test";
import type { Recipe } from "../../src/generate/recipe";
import { hfFixture, makeEnv, procOk, quickRecipe, type TestEnv } from "../helpers";

const LLM = { llmBaseUrl: "http://llm/v1", llmModel: "m" };
let env: TestEnv;
afterEach(() => env?.cleanup());

const withStep = (step: Recipe["steps"][number]): Recipe => {
  const r = quickRecipe();
  r.steps.splice(2, 0, step);
  return r;
};

describe("GenerateService availability", () => {
  test("available with an LLM and a working HyperFrames; optional tools missing in doctor don't matter", async () => {
    env = makeEnv(LLM);
    const status = await env.app.generate.status();
    expect(status).toMatchObject({
      available: true, reasons: [], hyperframes: { ok: true, version: env.config.hyperframesVersion },
      llm: { configured: true }, jev: { configured: false }, image: { configured: false }, compute: "gpu",
      voice: { engines: [], localAvailable: true }, presets: [],
    });
    expect(JSON.parse(hfFixture("doctor")).ok).toBe(false);
  });

  test("without an LLM Generate is unavailable and says what to do", async () => {
    env = makeEnv();
    const status = await env.app.generate.status();
    expect(status.available).toBe(false);
    expect(status.reasons.join(" ")).toContain("Connect an LLM in Settings");
  });

  test.each([
    ["a required check fails", () => procOk(JSON.stringify({ ...JSON.parse(hfFixture("doctor")), checks: [{ name: "Chrome", ok: false, detail: "not found" }] })), "needs Node.js"],
    ["the CLI can't run", () => ({ exitCode: 2, stdout: "", stderr: "no node", timedOut: false, aborted: false }), "HyperFrames can't run"],
  ])("HyperFrames: %s", async (_name, doctor, reason) => {
    env = makeEnv(LLM);
    env.hfHandlers.doctor = doctor;
    const status = await env.app.generate.status();
    expect(status).toMatchObject({ available: false, hyperframes: { ok: false } });
    expect(status.reasons.join(" ")).toContain(reason);
  });

  test("the doctor result is cached for a short time", async () => {
    env = makeEnv(LLM);
    await env.app.generate.status();
    await env.app.generate.status();
    expect(env.execCalls.filter((c) => c.args.includes("doctor"))).toHaveLength(1);
  });

  test("a CPU install says the local voice needs a GPU", async () => {
    env = makeEnv({ ...LLM, whisperDevice: "cpu" });
    const status = await env.app.generate.status();
    expect(status).toMatchObject({ compute: "cpu", voice: { localAvailable: false, localReason: "the local voice needs a GPU install" } });
  });

  test("connections follow the LLM and Jev switches", () => {
    env = makeEnv({ ...LLM, jevApiKey: "k" });
    expect(env.app.generate.connected("llm")).toBe(true);
    expect(env.app.generate.connected("jev")).toBe(true);
    expect(["image", "vision", "voice", "other"].map((c) => env.app.generate.connected(c))).toEqual([false, false, false, false]);
  });

  test("the quick recipe is available; recipes that need a missing connection say why", () => {
    env = makeEnv(LLM);
    const availability = (r: Recipe) => env.app.generate.recipeAvailability(r);
    expect(availability(quickRecipe())).toEqual({ available: true, reasons: [] });

    expect(availability(withStep({ use: "images" })).reasons).toEqual(["images: needs the image connection in Settings"]);
    expect(availability(withStep({ use: "images", when: "connection:image" })).available).toBe(true);
    expect(availability(withStep({ use: "look" })).reasons[0]).toContain("vision-capable model");
    expect(availability(withStep({ use: "command", with: { name: "lint-brand" } })).reasons[0]).toContain('"lint-brand" isn\'t registered');
    expect(availability(withStep({ use: "facts", with: { mode: "research", sources: ["prices"] } })).reasons[0]).toContain('data source "prices"');
    expect(availability(withStep({ use: "voice" })).reasons[0]).toContain("no voice engine");
    const creative = quickRecipe();
    creative.steps.find((s) => s.use === "creative")!.with = { vision: "on" };
    expect(availability(creative).reasons[0]).toContain("vision-capable");
  });

  test("a recipe pinning the local voice is unavailable on a CPU install, never swapped", () => {
    env = makeEnv({ ...LLM, whisperDevice: "cpu" });
    const check = env.app.generate.recipeAvailability(withStep({ use: "voice", with: { engine: "local" } }));
    expect(check.reasons).toEqual(["voice: the local voice needs a GPU install"]);
  });

  test("starting seeds the example recipes and marks interrupted work failed", () => {
    env = makeEnv(LLM);
    env.app.start();
    expect(env.app.store.getGenRecipe("quick")).toMatchObject({ builtIn: 1, version: 1 });
    const t = "2026-01-01T00:00:00.000Z";
    env.app.store.saveGenProject({
      id: "p", title: null, brief: "b", format: "9:16", targetSec: 30, language: "id", styleNotes: null, preset: null, recipeId: "quick",
      recipe: "{}", ideaId: null, briefFlags: null, narrationScript: null, concept: null, stepIndex: 0, stepState: null, narration: 0,
      storylines: null, pickedStoryline: null, status: "RUNNING", currentPlanId: null, acceptedVersionId: null, errorMessage: null, createdAt: t, updatedAt: t,
    });
    env.app.generate.start();
    expect(env.app.store.getGenProject("p")).toMatchObject({ status: "FAILED", errorMessage: "interrupted" });
  });
});
