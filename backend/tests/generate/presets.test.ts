import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db";
import { Director } from "../../src/generate/director";
import { DirectorLog } from "../../src/generate/events";
import { findPreset, loadPresets, presetBrief } from "../../src/generate/presets";
import type { PlanContext } from "../../src/generate/planSchema";
import { Store } from "../../src/store";
import type { GenProject } from "../../src/types";
import { fakeLlm, makeEnv, samplePlan, scriptLlm, type TestEnv } from "../helpers";

const GENERATOR = "../generator";
const T = "2026-01-01T00:00:00.000Z";
let env: TestEnv | undefined;
let tmp: string | undefined;
afterEach(() => { env?.cleanup(); env = undefined; if (tmp) rmSync(tmp, { recursive: true, force: true }); tmp = undefined; });

describe("presets", () => {
  test("the shipped formats each have a length, pacing, block tags and advice", () => {
    const list = loadPresets(GENERATOR);
    expect(list.map((p) => p.id)).toEqual(["motion-graphic", "story", "explainer", "card", "data", "promo"]);
    for (const p of list) {
      expect(p.label).toBeTruthy();
      expect(p.targetSec).toBeGreaterThanOrEqual(5);
      expect(p.targetSec).toBeLessThanOrEqual(90);
      expect(p.blockTags.length).toBeGreaterThan(0);
      expect(p.hints.length).toBeGreaterThan(40);
    }
    expect(findPreset(GENERATOR, "data")!.hints).toContain("exactly the numbers in the brief");
    expect(findPreset(GENERATOR, "nope")).toBeNull();
    expect(findPreset(GENERATOR, null)).toBeNull();
    expect(presetBrief(findPreset(GENERATOR, "card")!)).toEqual({ name: "card", pacing: "slow and calm", preferBlocksTagged: ["text", "quote"], advice: expect.stringContaining("One sentence only") });
  });

  test("a missing file means no presets, not an error", () => {
    tmp = mkdtempSync(join(tmpdir(), "vc-presets-"));
    expect(loadPresets(tmp)).toEqual([]);
    writeFileSync(join(tmp, "presets.json"), "{}");
    expect(loadPresets(tmp)).toEqual([]);
  });
});

describe("the director is told about the preset", () => {
  const project = (preset: string | null): GenProject => ({
    id: "p1", title: null, brief: "Jelaskan bunga majemuk", format: "9:16", targetSec: 30, language: "id", styleNotes: null, preset, recipeId: "quick", recipe: "{}",
    ideaId: null, briefFlags: null, narrationScript: null, concept: null, stepIndex: 0, stepState: null, narration: 0, storylines: null, pickedStoryline: null,
    status: "RUNNING", currentPlanId: null, acceptedVersionId: null, errorMessage: null, createdAt: T, updatedAt: T,
  });
  const planCtx: PlanContext = { brief: "Jelaskan bunga majemuk", targetSec: 30, format: "9:16", language: "id", fonts: ["Plus Jakarta Sans"], imageConnected: false, narration: false };
  const ask = async (preset: string | null) => {
    const { llm, requests } = fakeLlm([JSON.stringify(samplePlan())]);
    const director = new Director(llm, new DirectorLog(new Store(openDatabase(":memory:"))), GENERATOR);
    await director.plan({ project: project(preset), step: { use: "plan" }, settings: {}, assets: [], storyline: null, planCtx, catalog: [] });
    return JSON.parse(requests[0]!.messages[1]!.content);
  };

  test("the plan call carries the preset's pacing, preferred block tags and advice", async () => {
    const sent = await ask("data");
    expect(sent.preset).toMatchObject({ name: "data", pacing: expect.stringContaining("brisk"), preferBlocksTagged: ["chart", "data", "text"], advice: expect.stringContaining("chart shot") });
  });

  test("a video with no preset sends none; one the file no longer lists keeps its name", async () => {
    expect((await ask(null)).preset).toBeNull();
    expect((await ask("retired")).preset).toBe("retired");
  });
});

describe("starting a video from a preset", () => {
  const post = (body: object) => env!.json("POST", "/api/generate/projects", { brief: "Jelaskan bunga majemuk", ...body });
  const start = () => {
    env = makeEnv({ llmBaseUrl: "http://llm/v1", llmModel: "m" });
    env.app.start();
    scriptLlm(env, []);
  };

  test("the preset sets the length unless the owner gave one, and is kept on the project", async () => {
    start();
    const card = await post({ preset: "card" });
    expect(card.status).toBe(201);
    expect(card.body.data.project).toMatchObject({ preset: "card", targetSec: 10 });
    expect((await post({ preset: "story" })).body.data.project.targetSec).toBe(45);
    expect((await post({ preset: "story", targetSec: 60 })).body.data.project.targetSec).toBe(60);
    expect((await post({})).body.data.project).toMatchObject({ preset: null, targetSec: 30 });
    await env!.app.generate.whenIdle();
  });

  test("an unknown preset is refused and names the real ones", async () => {
    start();
    const r = await post({ preset: "cinema" });
    expect([r.status, r.body.error]).toEqual([400, expect.stringContaining("Unknown preset \"cinema\" (motion-graphic, story, explainer, card, data, promo)")]);
    expect(env!.app.store.listGenProjects()).toHaveLength(0);
  });
});
