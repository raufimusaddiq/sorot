import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { PROBE_PREFIX } from "../../src/generate/sceneProbe";
import { BLOCK_SOURCE_CHARS, checkDraft, lookAtDraft, lookedInLoop, sceneTools, searchBlocks, useBlock, type CatalogEntry, type ToolEnv } from "../../src/generate/directorTools";
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
    dir, shot, index: 1, startSec: 3, blocksAllowed: true, rules: { assets: [] }, catalog: async () => CATALOG,
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

  test("a block that installs in its own folder is found from what `add` wrote; its HTML is the source, other files are listed, and what it loads from the web is flagged", async () => {
    const own = env({
      hyperframes: { ...env().hyperframes, add: async (d: string) => {
        mkdirSync(join(d, "compositions/lottie-character-walk/assets"), { recursive: true });
        writeFileSync(join(d, "compositions/lottie-character-walk/lottie-character-walk.html"), '<script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script><div id="lcw-root"></div>');
        writeFileSync(join(d, "compositions/lottie-character-walk/assets/mascot.json"), "{}");
        writeFileSync(join(d, "compositions/other.html"), "<div>another block</div>");
        return { written: [join(d, "compositions/lottie-character-walk/lottie-character-walk.html"), join(d, "compositions/lottie-character-walk/assets/mascot.json")] };
      } } as never,
    });
    const out = (await useBlock(own, { name: "lottie-character-walk" })).result as any;
    expect(out).toMatchObject({ files: ["compositions/lottie-character-walk/lottie-character-walk.html", "compositions/lottie-character-walk/assets/mascot.json"], cut: false, external: ["https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"] });
    expect(out.source).toContain('id="lcw-root"');
    expect(out.source).not.toContain("another block");
    expect(out.note).toContain("loads scripts, fonts or files from the web");
  });

  test("check writes the draft as the shot's file and returns Sorot's rules and this shot's lint only", async () => {
    const out = (await checkDraft(env(), { html: HTML })).result as { findings: Array<{ code: string }> };
    expect(readFileSync(join(dir, "compositions/shot-02.html"), "utf-8")).toBe(HTML);
    expect(out.findings.map((f) => f.code)).toEqual(expect.arrayContaining(["mine"]));
    expect(out.findings.map((f) => f.code)).not.toContain("other");
    expect(((await checkDraft(env(), { html: "  " })).result as any).error).toContain("empty");
  });

  test("check and look also run the scene probe on a scratch copy (placeholders for the shots not written yet, assets linked) and keep only this shot's findings; a probe that can't run adds nothing", async () => {
    const plan = validatePlan(samplePlan(), { brief: "x", targetSec: 30, format: "9:16", language: "id", fonts: ["Plus Jakarta Sans"], imageConnected: false, narration: false }).plan as Plan;
    const moment = (t: number, c: string) => ({ t, c, texts: [{ el: "t", r: [10, 10, 40, 10], o: 1, v: 1 }], objects: [{ el: "svg#hull", r: [0, 0, 40, 40], o: 1 }] });
    const probe = { v: 1, size: [100, 100], labels: {}, tweens: [], fades: [], frames: [moment(4, "shot-02"), moment(5, "shot-02"), moment(1, "shot-01"), moment(2, "shot-01")] };
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "assets/a.png"), "x");
    const seen: string[] = [];
    const check = async (copy: string) => {
      seen.push(copy, readFileSync(join(copy, "compositions/shot-03.html"), "utf-8"), existsSync(join(copy, "assets/a.png")) ? "linked" : "no assets", existsSync(join(copy, "compositions/shot-02.html")) ? "draft" : "no draft");
      return { lint: { findings: [] }, runtime: { findings: [{ code: "console_warning", severity: "warning", message: PROBE_PREFIX + JSON.stringify(probe) }] } };
    };
    const hf = { lint: async () => ({ ok: true, findings: [] }), check } as never;
    const out = (await checkDraft(env({ hyperframes: hf, plan, fps: 30 }), { html: HTML })).result as { findings: Array<{ code: string; message: string }> };
    expect(out.findings.filter((f) => f.code === "text_over_object").map((f) => f.message)).toEqual([expect.stringContaining("svg#hull")]);   // shot 2's, not shot 1's
    expect(seen.slice(1)).toEqual([expect.stringContaining('data-composition-id="shot-03"'), "linked", "draft"]);
    expect(existsSync(seen[0]!)).toBe(false);                                                                                              // the scratch copy is gone
    expect(existsSync(join(dir, "assets/a.png"))).toBe(true);                                                                            // and the version's own files are not
    const broken = { lint: async () => ({ ok: true, findings: [] }), check: async () => { throw new Error("no browser"); } } as never;
    expect(((await checkDraft(env({ hyperframes: broken, plan }), { html: HTML })).result as any).findings.map((f: any) => f.code)).not.toContain("text_over_object");
  });

  test("look renders frames at film time (clamped into the shot, at most three), returns them with the stranger's read, and remembers which file was looked at", async () => {
    const asked: number[][] = [];
    const hf = { snapshot: async (d: string, what: { at: number[] }) => {
      asked.push(what.at);
      return { ok: true, outputDir: d, frames: what.at.map((t, i) => { const path = join(d, `f${i}.png`); writeFileSync(path, `PIC${i}`); return { path, time: t }; }) };
    } } as never;
    const read = async (images: string[]) => ({ findings: [{ code: "look_unexplained", severity: "must-fix", description: "A stranger can't tell what \"dome\" is for in s02.", suggestedFix: "Label it." }], seen: { description: "a dome", objects: ["dome"], unexplained: ["dome"] }, n: images.length } as never);
    const e = env({ hyperframes: { ...env().hyperframes, ...(hf as object) } });
    const out = await lookAtDraft(e, read, { html: HTML, times: [-1, 2, 99, 5] });   // a fourth is dropped; 99 is clamped to the shot's last moment
    expect(asked).toEqual([[3, 5, 3 + (shot.durationSec - 0.05)].map((t) => Math.round(t * 100) / 100)]);
    expect(out.images).toEqual([0, 1, 2].map((i) => `data:image/png;base64,${Buffer.from(`PIC${i}`).toString("base64")}`));
    expect(out.result).toMatchObject({ frames: [0, 2, shot.durationSec - 0.05], findings: [{ code: "look_unexplained", severity: "must-fix", hint: "Label it." }] });
    expect(readFileSync(join(dir, "compositions/shot-02.html"), "utf-8")).toBe(HTML);
    const plan2 = { shots: [{ id: "s02" }] } as unknown as Plan;
    expect([lookedInLoop(dir, plan2, () => HTML), lookedInLoop(dir, plan2, () => HTML + "<!-- changed -->"), lookedInLoop(dir, plan2, () => null)]).toEqual([true, false, false]);
    expect(await lookAtDraft(e, read, { html: "" })).toEqual({ result: { error: "html: the draft is empty" } });
    asked.length = 0;
    await lookAtDraft(e, read, { html: HTML });
    expect(asked[0]).toEqual([3 + shot.durationSec / 2].map((t) => Math.round(t * 100) / 100));   // no moments given: the middle
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
