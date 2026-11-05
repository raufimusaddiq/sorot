import { describe, expect, test } from "bun:test";
import { harness } from "./helpers";

const status = (over: Record<string, unknown> = {}) => ({
  available: true, reasons: [], hyperframes: { ok: true, version: "0.8.223" }, llm: { configured: true }, jev: { configured: false },
  image: { configured: false }, vision: { configured: false }, voice: { engines: [], localAvailable: true }, compute: "gpu", presets: [], ...over,
});

describe("sorot gen status", () => {
  test("available: a summary of what is connected, exit 0", async () => {
    const h = harness({ "GET /api/generate/status": status({ voice: { engines: ["elevenlabs", "local"], localAvailable: true } }) });
    expect(await h.run("gen", "status")).toBe(0);
    expect(h.out).toEqual([
      "Generate: available",
      "  HyperFrames 0.8.223: ok · renders on the GPU",
      "  LLM connected · Jev off · images off · vision off",
      "  Voice engines: elevenlabs, local",
    ]);
  });

  test("unavailable: the reasons are listed and the exit code is 1", async () => {
    const h = harness({ "GET /api/generate/status": status({
      available: false, llm: { configured: false }, compute: "cpu", hyperframes: { ok: false, version: "0.8.223" },
      voice: { engines: [], localAvailable: false, localReason: "the local voice needs a GPU install" },
      reasons: ["Connect an LLM in Settings: Generate needs one"],
    }) });
    expect(await h.run("gen", "status")).toBe(1);
    expect(h.text()).toContain("Generate: unavailable");
    expect(h.text()).toContain("not working · renders on the CPU");
    expect(h.text()).toContain("Voice engines: none (the local voice needs a GPU install)");
    expect(h.text()).toContain("  - Connect an LLM in Settings");
  });

  test("--json prints the status as is and keeps the exit code", async () => {
    const h = harness({ "GET /api/generate/status": status({ available: false, reasons: ["x"] }) });
    expect(await h.run("gen", "status", "--json")).toBe(1);
    expect(JSON.parse(h.out[0]!)).toMatchObject({ available: false, reasons: ["x"] });
  });

  test("a missing or unknown gen command is a usage error", async () => {
    const h = harness();
    expect(await h.run("gen")).toBe(2);
    expect(h.err[0]).toContain("Missing gen command (status, new,");
    expect(await h.run("gen", "dance")).toBe(2);
    expect(h.err.at(-1)).toContain("Unknown gen command: dance");
  });
});

describe("sorot gen kit", () => {
  const part = (name: string, source = "builtIn", over: Record<string, unknown> = {}) => ({
    name, source, version: "1.0.0", checkedAt: null,
    manifest: { name, runtime: "dom", needs: { gpu: "no" }, does: `${name} does things`, example: `${name} example`, settings: { strength: { t: "num", min: 0, max: 1 }, kind: { t: "enum", values: ["soft", "hard"] } }, defaults: { strength: 0.6 }, ...over },
  });

  test("lists the parts, and shows one with its settings and defaults", async () => {
    const h = harness({ "GET /api/generate/kit": { parts: [part("shade"), part("three", "user", { runtime: "webgl", needs: { gpu: "preferred" } })] }, "GET /api/generate/kit/three": { part: part("three", "user", { runtime: "webgl", needs: { gpu: "preferred" } }) } });
    expect(await h.run("gen", "kit")).toBe(0);
    expect(h.out[0]!.split("\n").slice(1).map((l) => l.split(/\s{2,}/).slice(0, 4))).toEqual([["shade", "1.0.0", "dom", "built in"], ["three", "1.0.0", "webgl", "yours"]]);
    expect(await h.run("gen", "kit", "show", "three")).toBe(0);
    expect(h.out.slice(1)).toEqual([
      "three 1.0.0 (yours, webgl, GPU preferred)", "  three does things", "  Example: three example", "  Settings:",
      "    strength: 0 to 1 (default 0.6)", "    kind: soft | hard",
    ]);
  });

  test("add sends a folder as a zip with the folder at the top, or a .zip as it is; a folder without part.json is refused", async () => {
    const h = harness({ "POST /api/generate/kit": { part: part("glow", "user") } });
    h.dirs.set("/home/u/glow", ["example.json", "part.js", "part.json"]);
    for (const f of ["example.json", "part.js", "part.json"]) h.bytesOf.set(`/home/u/glow/${f}`, new TextEncoder().encode("{}"));
    expect(await h.run("gen", "kit", "add", "glow")).toBe(0);
    expect(h.requests.at(-1)!.body.file).toBe("glow.zip");
    expect(h.out.at(-1)).toBe("Added glow 1.0.0. Directors are offered it from their next call.");
    h.existing.add("/home/u/g.zip");
    h.bytesOf.set("/home/u/g.zip", new Uint8Array(5));
    expect(await h.run("gen", "kit", "add", "g.zip")).toBe(0);
    expect(h.requests.at(-1)!.body).toMatchObject({ file: "g.zip", size: 5 });
    h.dirs.set("/home/u/empty", ["readme.md"]);
    expect(await h.run("gen", "kit", "add", "empty")).toBe(2);
    expect(h.err.at(-1)).toContain("empty has no part.json");
  });

  test("export saves the zip; remove deletes yours", async () => {
    const h = harness({ "GET /api/generate/kit/glow/export": new Response(new Uint8Array(12)), "DELETE /api/generate/kit/glow": { deleted: true } });
    expect(await h.run("gen", "kit", "export", "glow", "-o", "out/g.zip")).toBe(0);
    expect(h.files.get("/home/u/out/g.zip")).toBe(12);
    expect(await h.run("gen", "kit", "remove", "glow")).toBe(0);
    expect(h.out.at(-1)).toContain("Removed glow.");
  });
});

describe("sorot gen capabilities", () => {
  test("prints the level, renderer, connections, seams and the parts at that level; --level is passed on", async () => {
    const caps = {
      level: "kit", levelMeans: "fill in kit parts", seams: ["cut", "fade"], connections: { image: false, voice: true, vision: false },
      renderer: { hyperframes: "0.8.223", runtimes: ["dom", "canvas"], gpu: false, frameBudgetMs: 1000 }, kit: [{ name: "shade", runtime: "dom", does: "lights shapes" }],
    };
    const h = harness({ "GET /api/generate/capabilities": (_b: unknown, url: URL) => ({ capabilities: { ...caps, level: url.searchParams.get("level") } }) });
    expect(await h.run("gen", "capabilities", "--level", "kit")).toBe(0);
    expect(h.out).toEqual([
      "Level kit: fill in kit parts", "Renderer: HyperFrames 0.8.223 · draws dom, canvas · CPU · frame budget 1000 ms",
      "Connections: image off · voice connected · vision off", "Seams: cut, fade", "Kit (1 parts at this level):", "  shade (dom): lights shapes",
    ]);
  });
});

describe("sorot gen models and calibrate", () => {
  const rec = (level: string, asked: number, firstPass: number) => ({ level, asked, firstPass, repaired: 1, dropped: 0, malformed: 0, calibratedAt: null });

  test("lists each model's record per level with its auto level; pin sets and auto clears", async () => {
    const h = harness({
      "GET /api/generate/models": { current: "m1", calibration: null, models: [{ model: "m1", pin: null, auto: "compose", records: [rec("compose", 10, 8)] }, { model: "m2", pin: "kit", auto: "kit", records: [] }] },
      "PUT /api/generate/models/m2/level": (b: any) => ({ model: { model: "m2", pin: b.level, auto: "kit", records: [] } }),
    });
    expect(await h.run("gen", "models")).toBe(0);
    expect(h.out[0]!.split("\n").slice(1).map((l) => l.split(/\s{2,}/).slice(0, 5))).toEqual([["m1 *", "auto: compose", "compose", "10", "80%"], ["m2", "kit", "-", "0", "-"]]);
    expect(await h.run("gen", "models", "pin", "m2", "free")).toBe(0);
    expect([h.requests.at(-1)!.body, h.out.at(-1)]).toEqual([{ level: "free" }, "m2 is pinned to free."]);
    expect(await h.run("gen", "models", "pin", "m2", "auto")).toBe(0);
    expect(h.requests.at(-1)!.body).toEqual({ level: null });
    expect(await h.run("gen", "models", "pin", "m2", "max")).toBe(2);
  });

  test("calibrate waits for the run and prints each level; a failed run exits 1", async () => {
    let polls = 0;
    const result = { kit: { asked: 3, firstPass: 3, repaired: 0, failed: 0 }, compose: { asked: 3, firstPass: 1, repaired: 1, failed: 1 } };
    const h = harness({
      "POST /api/generate/models/calibrate": { run: { model: "m1" } },
      "GET /api/generate/models": () => ({ calibration: ++polls < 2 ? { done: false } : { done: true, result } }),
    });
    expect(await h.run("gen", "calibrate")).toBe(0);
    expect(h.out).toEqual([
      "Calibrating m1: three sample shots at each level (a few minutes)...",
      "  kit: 3 first time, 0 after a repair, 0 failed (of 3)", "  compose: 1 first time, 1 after a repair, 1 failed (of 3)",
    ]);
    const bad = harness({ "POST /api/generate/models/calibrate": { run: { model: "m1" } }, "GET /api/generate/models": { calibration: { done: true, error: "LLM down" } } });
    expect(await bad.run("gen", "calibrate")).toBe(1);
    expect(bad.err.at(-1)).toBe("Calibration failed: LLM down");
  });
});
