import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BLOCK_SOURCE_CHARS, checkDraft, sceneTools, searchBlocks, useBlock, type CatalogEntry, type ToolEnv } from "../../src/generate/directorTools";
import { validatePlan, type Plan } from "../../src/generate/planSchema";
import { samplePlan } from "../helpers";

const CATALOG: CatalogEntry[] = [
  { name: "lottie-character-walk", type: "block", title: "Lottie Character Walk", description: "A jointed flat character walks in, stops and points at a card", tags: ["character", "walk-cycle", "mascot"], duration: 7.5, width: 1920, height: 1080 },
  { name: "bar-chart-race", type: "component", title: "Bar chart race", description: "Bars climb in a chart", tags: ["chart", "data"] },
  { name: "product-turntable", type: "block", title: "Product Turntable", description: "A product turns on a plinth", tags: ["3d-object", "three-js"] },
];
const shot = (validatePlan(samplePlan(), { brief: "x", targetSec: 30, format: "9:16", language: "id", fonts: ["Plus Jakarta Sans"], imageConnected: false, narration: false }).plan as Plan).shots[1]!;
const HTML = '<div data-composition-id="shot-02" data-width="1080" data-height="1920"><script>window.__timelines = window.__timelines || {}; window.__timelines["shot-02"] = gsap.timeline({ paused: true });</script></div>';

describe("search_blocks", () => {
  test.each<[string, Record<string, unknown>, string[]]>([
    ["a word in a tag and the name", { query: "walking character" }, ["lottie-character-walk"]],
    ["a word in the description", { query: "plinth" }, ["product-turntable"]],
    ["only components", { query: "chart bars", type: "component" }, ["bar-chart-race"]],
    ["the type filter drops other kinds", { query: "chart", type: "block" }, []],
    ["nothing fits", { query: "zebra" }, []],
    ["the limit keeps the best", { query: "character walk chart plinth", limit: 1 }, ["lottie-character-walk"]],
    ["best first: the name and tags outrank the description", { query: "3d turntable" }, ["product-turntable"]],
  ])("%s", (_name, args, names) => {
    const out = searchBlocks(CATALOG, args).result as { matches: Array<{ name: string }> };
    expect(out.matches.map((m) => m.name)).toEqual(names);
  });

  test("an empty query says what to do; a match carries what the director needs to choose", () => {
    expect(searchBlocks(CATALOG, { query: " " }).result).toEqual({ error: "query: say what you are looking for in a few words" });
    expect((searchBlocks(CATALOG, { query: "character" }).result as any).matches[0]).toEqual({
      name: "lottie-character-walk", type: "block", title: "Lottie Character Walk", description: "A jointed flat character walks in, stops and points at a card",
      tags: ["character", "walk-cycle", "mascot"], width: 1920, height: 1080, duration: 7.5,
    });
  });
});

describe("tools on a version's project", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "vc-tools-")); mkdirSync(join(dir, "compositions"), { recursive: true }); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const env = (over: Partial<ToolEnv> = {}): ToolEnv => ({
    dir, shot, index: 1, blocksAllowed: true, rules: { assets: [] }, catalog: async () => CATALOG,
    hyperframes: {
      add: async (d: string, names: string[]) => { writeFileSync(join(d, "compositions", `${names[0]}.html`), "<div>" + "x".repeat(BLOCK_SOURCE_CHARS + 100) + "</div>"); return {}; },
      lint: async () => ({ ok: true, errorCount: 0, warningCount: 1, infoCount: 0, findings: [{ code: "mine", severity: "warning", message: "m", file: "compositions/shot-02.html" }, { code: "other", severity: "error", message: "o", file: "compositions/shot-05.html" }] }),
    } as never,
    ...over,
  });

  test("use_block installs the block and returns its source, cut at the limit; it says why when it can't", async () => {
    const ok = (await useBlock(env(), { name: "lottie-character-walk" })).result as any;
    expect(ok).toMatchObject({ name: "lottie-character-walk", files: ["compositions/lottie-character-walk.html"], cut: true });
    expect(ok.source).toHaveLength(BLOCK_SOURCE_CHARS);
    expect(((await useBlock(env({ blocksAllowed: false }), { name: "x" })).result as any).error).toContain("doesn't allow registry blocks");
    expect(((await useBlock(env(), { name: "no-such" })).result as any).error).toContain("use search_blocks");
  });

  test("check writes the draft as the shot's file and returns Sorot's rules and this shot's lint only", async () => {
    const out = (await checkDraft(env(), { html: HTML })).result as { findings: Array<{ code: string }> };
    expect(readFileSync(join(dir, "compositions/shot-02.html"), "utf-8")).toBe(HTML);
    expect(out.findings.map((f) => f.code)).toEqual(expect.arrayContaining(["mine"]));
    expect(out.findings.map((f) => f.code)).not.toContain("other");
    expect(((await checkDraft(env(), { html: "  " })).result as any).error).toContain("empty");
  });

  test("a turn's tools: none when the recipe sets 0 steps, use_block only where blocks are allowed, look only with looks", async () => {
    expect(sceneTools(env(), { steps: 0, looks: 2 })).toBeNull();
    expect(Object.keys(sceneTools(env(), { steps: 8, looks: 2 })!.tools)).toEqual(["search_blocks", "use_block", "check"]);
    expect(Object.keys(sceneTools(env({ blocksAllowed: false }), { steps: 99, looks: 0, look: async () => ({ result: {} }) })!.tools)).toEqual(["search_blocks", "check"]);
    const withLook = sceneTools(env(), { steps: 99, looks: 2, look: async () => ({ result: {} }) })!;
    expect([withLook.steps, withLook.tools.look!.limit]).toEqual([16, 2]);
    // each tool runs on this project
    const run = async (name: string, args: Record<string, unknown>) => (await withLook.tools[name]!.run(args)).result as any;
    expect([(await run("search_blocks", { query: "chart" })).matches.length, (await run("use_block", { name: "bar-chart-race" })).name, (await run("check", { html: HTML })).findings.length > 0, await run("look", {})]).toEqual([1, "bar-chart-race", true, {}]);
  });
});
