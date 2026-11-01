import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/config";
import { openDatabase } from "../../src/db";
import { DirectorLog } from "../../src/generate/events";
import { ImageClient, ImageError } from "../../src/generate/images";
import type { RecipeStep } from "../../src/generate/recipe";
import { STEPS, settingsOf } from "../../src/generate/steps";
import { readImageFailures } from "../../src/generate/steps/images";
import { gainOf, readMusic } from "../../src/generate/steps/music";
import { buildRoot } from "../../src/generate/composer";
import { validatePlan, type Plan } from "../../src/generate/planSchema";
import { Store } from "../../src/store";
import type { GenAsset } from "../../src/types";
import { quickRecipe, samplePlan } from "../helpers";

const T = "2026-01-01T00:00:00.000Z";
const json = JSON.stringify;
let tmp: string;
let rigs = 0;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "vc-media-")); rigs = 0; });
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const PNG = Buffer.from("PNGDATA").toString("base64");
const imageConfig = { imageBaseUrl: "http://img/v1/", imageModel: "flux", imageApiKey: "k", imageSize: "1024x1792", imageStyle: "flat" };

describe("ImageClient", () => {
  const client = (fetchFn: (u: any, i?: any) => Promise<Response>, over: object = {}) =>
    new ImageClient({ ...loadConfig({}), ...imageConfig, ...over } as never, fetchFn as never);

  test("asks /images/generations for one picture and decodes it; the style and size come from Settings unless given", async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const c = client(async (url, init) => { calls.push({ url, init }); return Response.json({ data: [{ b64_json: PNG }] }); });
    expect(Buffer.from(await c.generate({ prompt: "a seed" })).toString()).toBe("PNGDATA");
    expect(calls[0]!.url).toBe("http://img/v1/images/generations");
    expect(calls[0]!.init.headers.Authorization).toBe("Bearer k");
    expect(JSON.parse(calls[0]!.init.body)).toEqual({ model: "flux", prompt: "a seed. Style: flat", size: "1024x1792", n: 1, response_format: "b64_json" });
    await c.generate({ prompt: "p", style: "", size: "512x512" });
    await client(async (_u, init) => { calls.push({ url: "", init }); return Response.json({ data: [{ b64_json: PNG }] }); }, { imageStyle: "" }).generate({ prompt: "plain" });
    expect(JSON.parse(calls.at(-1)!.init.body).prompt).toBe("plain");
  });

  test("a picture given as a URL is downloaded", async () => {
    const c = client(async (url) => (String(url).endsWith("/images/generations") ? Response.json({ data: [{ url: "http://cdn/x.png" }] }) : new Response(new Uint8Array([1, 2]))));
    expect([...(await c.generate({ prompt: "p" }))]).toEqual([1, 2]);
    const gone = client(async (url) => (String(url).endsWith("/images/generations") ? Response.json({ data: [{ url: "http://cdn/x.png" }] }) : new Response("no", { status: 404 })));
    await expect(gone.generate({ prompt: "p" })).rejects.toThrow("HTTP 404");
    const down = client(async (url) => { if (String(url).endsWith("/images/generations")) return Response.json({ data: [{ url: "http://cdn/x.png" }] }); throw new Error("reset"); });
    await expect(down.generate({ prompt: "p" })).rejects.toThrow("can't be downloaded: reset");
  });

  test("failures say what happened", async () => {
    await expect(client(async () => new Response("quota", { status: 429 })).generate({ prompt: "p" })).rejects.toThrow("Image HTTP 429: quota");
    await expect(client(async () => { throw new Error("ECONNRESET"); }).generate({ prompt: "p" })).rejects.toThrow("can't be reached: ECONNRESET");
    await expect(client(async () => Response.json({ data: [] })).generate({ prompt: "p" })).rejects.toThrow("returned no picture");
    await expect(client(async () => new Response("not json")).generate({ prompt: "p" })).rejects.toThrow("returned no picture");
    await expect(client(async () => Response.json({}), { imageApiKey: "" }).generate({ prompt: "p" })).rejects.toBeInstanceOf(ImageError);
    const ctl = new AbortController();
    ctl.abort();
    await expect(client(async () => { throw new DOMException("stop", "AbortError"); }).generate({ prompt: "p", signal: ctl.signal })).rejects.toThrow("stop");
    expect(client(async () => Response.json({})).enabled).toBeTrue();
    expect(client(async () => Response.json({}), { imageEnabled: false }).enabled).toBeFalse();
  });
});

function rig(plan: Record<string, unknown>, images?: Partial<ImageClient>, assets: GenAsset[] = []) {
  const config = { ...loadConfig({}), genDir: join(tmp, `generate${rigs++}`), ...imageConfig };
  const store = new Store(openDatabase(":memory:"));
  const recipe = quickRecipe();
  const valid = validatePlan(plan, { brief: "x", targetSec: 30, format: "9:16", language: "id", fonts: ["Plus Jakarta Sans"], imageConnected: true, narration: false }).plan as Plan;
  store.saveGenProject({
    id: "p1", title: null, brief: "x", format: "9:16", targetSec: 30, language: "id", styleNotes: null, preset: null, recipeId: "quick", recipe: json(recipe),
    ideaId: null, briefFlags: null, narrationScript: null, concept: null, stepIndex: 0, stepState: null, narration: 0, storylines: null, pickedStoryline: null,
    status: "RUNNING", currentPlanId: "pl1", acceptedVersionId: null, errorMessage: null, createdAt: T, updatedAt: T,
  });
  store.saveGenPlan({ id: "pl1", projectId: "p1", revision: 1, plan: json(valid), changeRequest: null, changeSummary: null, approvedAt: T, createdAt: T });
  for (const a of assets) store.saveGenAsset(a);
  const progress: number[] = [];
  const ctxFor = (use: "images" | "music", withSettings: Record<string, unknown> = {}) => {
    const step = { use, with: withSettings } as RecipeStep;
    return {
      project: store.getGenProject("p1")!, version: null, recipe, step, settings: settingsOf(use, step.with), store, log: new DirectorLog(store),
      config: config as never, images: images as never, progress: (p: number) => { progress.push(Math.round(p)); },
    } as any;
  };
  return { config, store, ctxFor, progress, valid };
}

const withImages = (...prompts: Array<string | null>) => samplePlan({
  shots: samplePlan().shots.map((s: any, i: number) => (prompts[i] ? { ...s, visual: { ...s.visual, generatedImage: { prompt: prompts[i] }, fallbackVisual: "flat shapes" } } : s)),
});
const asset = (id: string, over: Partial<GenAsset>): GenAsset => ({ id, projectId: "p1", kind: "image", origin: "upload", path: `assets/${id}.png`, shotId: null, promptHash: null, meta: null, createdAt: T, ...over });

describe("images step", () => {
  const fake = () => {
    const asked: string[] = [];
    return { asked, client: { generate: async (i: { prompt: string }) => { asked.push(i.prompt); return new Uint8Array([7, 7]); } } as unknown as ImageClient };
  };

  test("makes each asked-for image once, as an asset of its shot; asking again with the same prompt makes nothing", async () => {
    const f = fake();
    const r = rig(withImages("a seed", null, "a tree"), f.client);
    expect(await STEPS.images.run(r.ctxFor("images"))).toEqual({ status: "done", outputRef: "2 new" });
    expect(f.asked).toEqual(["a seed", "a tree"]);
    const made = r.store.genAssetsForProject("p1");
    expect(made.map((a) => [a.kind, a.origin, a.shotId])).toEqual([["image", "generated", "s01"], ["image", "generated", "s03"]]);
    expect(made[0]!.path).toMatch(/^assets\/gen-s01-[0-9a-f]{8}\.png$/);
    expect([...readFileSync(join(r.config.genDir, "p1", made[0]!.path))]).toEqual([7, 7]);
    expect(r.progress).toEqual([50, 100]);
    expect(await STEPS.images.run(r.ctxFor("images"))).toEqual({ status: "done", outputRef: "0 new" });
    expect(f.asked).toHaveLength(2);
  });

  test("a changed prompt replaces the old picture; an image you uploaded for the shot wins", async () => {
    const f = fake();
    const r = rig(withImages("a seed"), f.client);
    await STEPS.images.run(r.ctxFor("images"));
    const first = r.store.genAssetsForProject("p1")[0]!;
    r.store.saveGenPlan({ ...r.store.getGenPlan("pl1")!, plan: json({ ...r.valid, shots: r.valid.shots.map((s, i) => (i === 0 ? { ...s, visual: { ...s.visual, generatedImage: { prompt: "a bigger seed" } } } : s)) }) });
    await STEPS.images.run(r.ctxFor("images"));
    const now = r.store.genAssetsForProject("p1");
    expect(now).toHaveLength(1);
    expect(now[0]!.id).not.toBe(first.id);
    expect(existsSync(join(r.config.genDir, "p1", first.path))).toBeFalse();
    expect(f.asked).toEqual(["a seed", "a bigger seed"]);

    const mine = rig(withImages("a seed"), f.client, [asset("u1", { shotId: "s01" })]);
    await STEPS.images.run(mine.ctxFor("images"));
    expect(f.asked).toHaveLength(2);
    expect(mine.store.genAssetsForProject("p1").map((a) => a.id)).toEqual(["u1"]);
    expect(STEPS.images.inputKey!(r.ctxFor("images", { style: "ink" }))).toBe('pl1|["ink",null]');
  });

  test("an image that can't be made leaves the shot on its fallback and is remembered for the build; the rest go on", async () => {
    let n = 0;
    const flaky = { generate: async () => { if (n++ === 0) throw new Error("quota exceeded"); return new Uint8Array([1]); } } as unknown as ImageClient;
    const r = rig(withImages("a seed", "a tree"), flaky);
    const result = await STEPS.images.run(r.ctxFor("images"));
    expect(result).toEqual({ status: "done", outputRef: "1 new", reason: "1 shot use the fallback visual" });
    expect(readImageFailures(r.ctxFor("images"))).toEqual([{ shotId: "s01", reason: "quota exceeded" }]);
    expect(r.store.genAssetsForProject("p1")).toHaveLength(1);
  });

  test("no image asked for is a skip; a cancelled run stops; with no connection every shot falls back", async () => {
    expect(await STEPS.images.run(rig(samplePlan(), fake().client).ctxFor("images"))).toMatchObject({ status: "skipped" });
    const ctl = new AbortController();
    const stopper = { generate: async () => { ctl.abort(); throw new DOMException("stop", "AbortError"); } } as unknown as ImageClient;
    const r = rig(withImages("a seed"), stopper);
    const ctx = r.ctxFor("images");
    ctx.signal = ctl.signal;
    await expect(STEPS.images.run(ctx)).rejects.toThrow("stop");
    const off = rig(withImages("a seed"));
    off.config.imageApiKey = "";
    await STEPS.images.run(off.ctxFor("images"));
    expect(readImageFailures(off.ctxFor("images"))[0]!.reason).toContain("No image connection");
    expect(readImageFailures(rig(samplePlan()).ctxFor("images"))).toEqual([]);
    const bad = rig(samplePlan());
    mkdirSync(join(bad.config.genDir, "p1"), { recursive: true });
    writeFileSync(join(bad.config.genDir, "p1", "images.json"), "{ nope");
    expect(readImageFailures(bad.ctxFor("images"))).toEqual([]);
  });
});

describe("music step", () => {
  const track = (id: string, name: string): GenAsset => asset(id, { kind: "music", path: `assets/${name}` });

  test("takes the track the recipe names (by id or file name), else the newest upload; nothing uploaded is a skip", async () => {
    const r = rig(samplePlan(), undefined, [track("m1", "calm.mp3"), track("m2", "bright.mp3")]);
    expect(await STEPS.music.run(r.ctxFor("music", { track: "calm.mp3", duckUnderVoiceDb: -12 }))).toEqual({ status: "done", outputRef: "m1" });
    expect(readMusic(r.config, "p1")).toEqual({ assetId: "m1", path: "assets/calm.mp3", duckUnderVoiceDb: -12 });
    await STEPS.music.run(r.ctxFor("music", { track: "m2" }));
    expect(readMusic(r.config, "p1")).toMatchObject({ assetId: "m2", duckUnderVoiceDb: null });
    await STEPS.music.run(r.ctxFor("music"));
    expect(readMusic(r.config, "p1")!.assetId).toBe("m2");
    expect(await STEPS.music.run(rig(samplePlan()).ctxFor("music"))).toMatchObject({ status: "skipped" });
    expect(readMusic(rig(samplePlan()).config, "nobody")).toBeNull();
  });

  test("a named track that isn't there is an error that lists what is", async () => {
    await expect(STEPS.music.run(rig(samplePlan()).ctxFor("music", { track: "x.mp3" }))).rejects.toThrow('"x.mp3" isn\'t uploaded');
    await expect(STEPS.music.run(rig(samplePlan(), undefined, [track("m1", "calm.mp3")]).ctxFor("music", { track: "x.mp3" }))).rejects.toThrow("among the uploads (calm.mp3)");
  });

  test("-12 dB is a quarter of the volume", () => {
    expect([gainOf(0), gainOf(-6), gainOf(-12), gainOf(-20)]).toEqual([1, 0.501, 0.251, 0.1]);
    const r = rig(samplePlan());
    mkdirSync(join(r.config.genDir, "p1"), { recursive: true });
    writeFileSync(join(r.config.genDir, "p1", "music.json"), "{ nope");
    expect(readMusic(r.config, "p1")).toBeNull();
  });
});

describe("the root composition with a voice", () => {
  test("each spoken line is an audio clip on its own track, over the music", () => {
    const plan = validatePlan(samplePlan(), { brief: "x", targetSec: 30, format: "9:16", language: "id", fonts: ["Plus Jakarta Sans"], imageConnected: false, narration: false }).plan as Plan;
    const html = buildRoot({
      plan, width: 1080, height: 1920, fonts: [], music: { path: "assets/bed.mp3", volume: 0.03 },
      voice: [{ id: "l1", path: "assets/voice-l1.mp3", start: 0, duration: 3.2 }, { id: "l2", path: "assets/voice-l2.mp3", start: 3.35, duration: 2 }],
    });
    expect(html).toContain('<audio id="music" class="clip" src="assets/bed.mp3" data-start="0" data-duration="30" data-track-index="1" data-volume="0.03">');
    expect(html).toContain('<audio id="voice-l1" class="clip" src="assets/voice-l1.mp3" data-start="0" data-duration="3.2" data-track-index="2" data-volume="1">');
    expect(html).toContain('id="voice-l2" class="clip" src="assets/voice-l2.mp3" data-start="3.35"');
    expect(buildRoot({ plan, width: 1080, height: 1920, fonts: [], voice: [] })).not.toContain("<audio");
  });
});
