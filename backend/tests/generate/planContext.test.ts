import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db";
import { Director } from "../../src/generate/director";
import { DirectorLog } from "../../src/generate/events";
import { availableFonts, BUNDLED_FONTS, planContext } from "../../src/generate/planContext";
import { Store } from "../../src/store";
import type { GenAsset, GenProject } from "../../src/types";
import { fakeLlm, quickRecipe, samplePlan } from "../helpers";

const font = (path: string, meta: string | null): GenAsset => ({
  id: path, projectId: "p", kind: "font", origin: "upload", path, shotId: null, promptHash: null, meta, createdAt: "t",
});
const project = { brief: "b", targetSec: 30, format: "9:16", language: "id", narration: 1 } as GenProject;

describe("plan context", () => {
  test("fonts are the bundled ones plus uploaded fonts by family, else by file name", () => {
    expect(availableFonts([])).toEqual(BUNDLED_FONTS);
    const fonts = availableFonts([font("assets/ab-Mine.ttf", JSON.stringify({ family: "Mine Display" })), font("assets/cd-Other.otf", null), { ...font("assets/x.png", null), kind: "logo" }]);
    expect(fonts).toEqual([...BUNDLED_FONTS, "Mine Display", "cd-Other"]);
  });

  test("limits and switches come from the recipe's plan step and what is connected", () => {
    const recipe = quickRecipe();
    recipe.steps.find((s) => s.use === "plan")!.with = { blocks: false, maxShots: 6 };
    const ctx = planContext({ project, recipe, assets: [], connected: (c) => c === "image" || c === "voice", catalog: [] });
    expect(ctx).toMatchObject({ blocksAllowed: false, blocks: null, imageConnected: true, narration: true, limits: { maxShots: 6 } });
    const off = planContext({ project: { ...project, narration: 0 }, recipe: quickRecipe(), assets: [], connected: () => false, catalog: ["data-chart"] });
    expect(off).toMatchObject({ blocksAllowed: true, blocks: ["data-chart"], imageConnected: false, narration: false, limits: { maxShots: 20 } });
  });
});

describe("director guidance", () => {
  test("without generator/prompts/story.md the director still works, with Sorot's own instructions", async () => {
    const store = new Store(openDatabase(":memory:"));
    const { llm, requests } = fakeLlm([JSON.stringify({ decision: "approve", reason: "siap" })]);
    const director = new Director(llm, new DirectorLog(store), "/no/such/folder");
    await director.gate({ project: { id: "p", brief: "b" } as GenProject, step: { use: "plan" }, kind: "plan", output: samplePlan() });
    expect(requests[0]!.messages[0]!.content).toContain("deciding for the owner");
    expect(requests[0]!.messages[0]!.content).not.toContain("hook frame");
  });
});
