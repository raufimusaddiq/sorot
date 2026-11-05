import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { checkPartSettings, exampleRoot, kitScripts, parseManifest, readPart, requiredParts, type KitManifest } from "../../src/generate/kit";
import { readZip, safeEntryPath, writeZip } from "../../src/generate/zip";
import { makeEnv, procOk, quickRecipe, type TestEnv } from "../helpers";

let env: TestEnv | undefined;
let tmp: string | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

const BUILT_INS = ["camera", "depth", "image-place", "iso", "motion", "particles", "shade", "shadow", "shape", "text-reveal", "three"];
const manifest = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "glow-ring", version: "1.0.0", does: "A ring of light.", runtime: "dom", needs: { gpu: "no" },
  settings: { size: { t: "num", min: 0, max: 1 }, kind: { t: "enum", values: ["soft", "hard"] } }, defaults: { size: 0.5 }, example: "A soft ring.", ...over,
});
const partJs = (name = "glow-ring", body = "") => `window.SorotKit = window.SorotKit || {};\nwindow.SorotKit["${name}"] = { mount(host, s, ctx) { ${body} } };\n`;
const partFiles = (over: { manifest?: Record<string, unknown>; js?: string; example?: unknown } = {}) => {
  const m = over.manifest ?? manifest();
  return [
    { path: "part.json", data: new TextEncoder().encode(JSON.stringify(m)) },
    { path: "part.js", data: new TextEncoder().encode(over.js ?? partJs(String(m.name))) },
    { path: "example.json", data: new TextEncoder().encode(JSON.stringify(over.example ?? { durationSec: 2, settings: { size: 0.4 }, markup: "<div></div>" })) },
  ];
};
const folder = (files: Array<{ path: string; data: Uint8Array }>) => {
  tmp ??= mkdtempSync(join(tmpdir(), "vc-kit-"));
  const dir = join(tmp, `part-${readdirSync(tmp).length}`);
  for (const f of files) {
    mkdirSync(join(dir, f.path, ".."), { recursive: true });
    writeFileSync(join(dir, f.path), f.data);
  }
  return dir;
};

describe("part manifest", () => {
  test("a valid manifest passes; its settings check values like a recipe does", () => {
    const { manifest: m, errors } = parseManifest(manifest());
    expect(errors).toEqual([]);
    expect(checkPartSettings(m!, { size: 2, kind: "soft", glow: 1 }, "s")).toEqual([
      "s.size: must be between 0 and 1", 's.glow: glow-ring has no setting "glow" (it has size, kind)',
    ]);
  });

  test.each([
    ["name", { name: "Glow Ring" }, "name: a lowercase slug"],
    ["name too long", { name: "a".repeat(41) }, "name: a lowercase slug"],
    ["version", { version: "one" }, "version: like 1.0.0"],
    ["does", { does: "a".repeat(201) }, "does: one line"],
    ["example", { example: "two\nlines" }, "example: one line"],
    ["runtime", { runtime: "svg" }, "runtime: one of dom, canvas, webgl"],
    ["needs", { needs: { gpu: "maybe" } }, 'needs: {"gpu"'],
    ["settings field", { settings: { size: { t: "num", min: 1 } } }, "settings.size: needs numbers min ≤ max"],
    ["settings type", { settings: { size: { t: "flag" } } }, 'settings.size: "t" must be one of'],
    ["default not a setting", { defaults: { glow: 1 } }, "defaults.glow: not one of the settings"],
    ["default out of range", { defaults: { size: 3 } }, "defaults.size: must be between 0 and 1"],
    ["unknown key", { author: "me" }, 'part.json: unknown key "author"'],
  ])("%s is refused", (_label, over, message) => {
    const { manifest: m, errors } = parseManifest(manifest(over));
    expect(m).toBeNull();
    expect(errors.join("\n")).toContain(message);
  });
});

describe("part folder", () => {
  test("every built-in part reads clean", () => {
    for (const name of BUILT_INS) expect(readPart(join("../generator/kit", name)).errors).toEqual([]);
  });

  test.each([
    ["a clock or unseeded random number", { js: partJs("glow-ring", "host.style.opacity = Math.random();") }, "part.js uses Math.random()"],
    ["the network", { js: partJs("glow-ring", "import('https://x.y/z.js');") }, "part.js reaches the network"],
    ["no registration under its name", { js: partJs("other") }, 'must register window.SorotKit["glow-ring"]'],
    ["example settings the part doesn't have", { example: { settings: { glow: 1 } } }, 'example.json settings.glow: glow-ring has no setting "glow"'],
    ["an example too long to check", { example: { durationSec: 30, settings: {} } }, "durationSec between 1 and 10"],
  ])("%s is refused", (_label, over, message) => {
    expect(readPart(folder(partFiles(over))).errors.join("\n")).toContain(message);
  });

  test("a missing file, or a link out of the folder, is refused", () => {
    expect(readPart(folder(partFiles().slice(0, 2))).errors).toEqual(["example.json is missing"]);
    const dir = folder(partFiles());
    symlinkSync("/etc/hostname", join(dir, "host.txt"));
    expect(readPart(dir).errors).toEqual(["host.txt: links aren't allowed in a part"]);
  });
});

describe("zip", () => {
  test("what is written reads back; a path out of the folder or a file that isn't a zip is refused", () => {
    const files = [{ path: "a/part.json", data: new TextEncoder().encode("{}") }, { path: "a/b/c.bin", data: new Uint8Array(3000).fill(7) }];
    expect(readZip(writeZip(files))).toEqual(files);
    expect(["../x", "/etc/x", "C:/x", "a\\b", "a/./b", "a/b"].map(safeEntryPath)).toEqual([false, false, false, false, false, true]);
    expect(() => readZip(new TextEncoder().encode("not a zip"))).toThrow("This isn't a zip file");
  });
});

/** Mounts built-in parts in a DOM with a GSAP that records: `set` merges into `el.gsapSet`, the timeline keeps its tweens. */
// required, not imported: jsdom's types bring in the DOM lib, which clashes with Bun's types
const { JSDOM } = require("jsdom") as { JSDOM: new (html: string, options: object) => { window: unknown } };
const inDom = (markup: string, parts: string[]) => {
  const dom = new JSDOM(`<div id="stage">${markup}</div>`, { runScripts: "outside-only" });
  const w = dom.window as any;
  w.gsap = { set: (el: any, v: object) => { el.gsapSet = { ...el.gsapSet, ...v }; } };
  for (const p of parts) w.eval(readFileSync(join(import.meta.dir, "../../../generator/kit", p, "part.js"), "utf8"));
  const tweens: unknown[][] = [];
  const ctx = { tl: { fromTo: (...a: unknown[]) => tweens.push(a) }, start: 0, duration: 2, size: { width: 1080, height: 1920 } };
  return { w, stage: w.document.getElementById("stage"), tweens, mount: (name: string, s: object) => w.SorotKit[name].mount(w.document.getElementById("stage"), s, ctx) };
};

describe("parts in a DOM", () => {
  test.each(["word", "char", "line"])("text-reveal keeps every space as plain text between its boxes, so none collapses: by %s", (by) => {
    const { w, stage, tweens, mount } = inDom('<h1>Biarkan <span class="accent">bunga</span> mekar pagi</h1>', ["text-reveal"]);
    mount("text-reveal", { target: "h1", by, style: "fade", at: 0, stagger: 0.1, length: 0.5 });
    const boxes = [...stage.querySelectorAll("span")].filter((el: any) => el.style.display === "inline-block");
    expect([stage.textContent, boxes.some((b: any) => /^\s|\s$/.test(b.textContent)), tweens.length > 0]).toEqual(["Biarkan bunga mekar pagi", false, true]);
    expect(w.document.querySelector(".accent").textContent).toBe("bunga");
  });

  test.each([
    ["flat 2D layers get the tilt", '<div class="city"></div>', 54.7356],
    ["an iso diorama, already isometric, gets only the move", '<canvas data-kit="iso"></canvas>', undefined],
    ["a three scene gets only the move", '<div><canvas data-kit="three"></canvas></div>', undefined],
  ])("camera over %s", (_, markup, tilt) => {
    const { stage, tweens, mount } = inDom(markup, ["camera"]);
    mount("camera", { projection: "isometric", move: "dolly-in", amount: 0.3, ease: "travel", target: "" });
    expect([stage.gsapSet?.rotationX, tweens.length]).toEqual([tilt, 1]);
  });
  test("a 3D part mounted after the camera takes the tilt back off the stages around it", () => {
    const { w, stage, mount } = inDom('<div class="layer"></div>', ["camera"]);
    mount("camera", { projection: "perspective", move: "zoom-in", amount: 0.3, ease: "travel", target: "" });
    const canvas = stage.querySelector(".layer").appendChild(w.document.createElement("canvas"));
    w.SorotKit.camera.unproject(canvas);
    expect([stage.gsapSet.rotationX, stage.gsapSet.transformPerspective, stage.hasAttribute("data-kit-projection")]).toEqual([0, 0, false]);
  });
});

describe("root loading", () => {
  test("the look and defaults come first, then the runtime, Three.js once when a part draws WebGL, then the parts in name order", () => {
    const m = (name: string, runtime = "dom") => ({ ...(manifest({ name, runtime }) as unknown as KitManifest) });
    const lines = kitScripts([m("iso", "webgl"), m("shade"), m("three", "webgl")], { palette: ["#000000"], keyLightDeg: 300 }, { width: 1080, height: 1920 }, 30);
    expect(lines.slice(1)).toEqual([
      '<script src="assets/kit/_runtime.js"></script>',
      '<script src="assets/kit/three/three.min.js"></script>',
      '<script src="assets/kit/iso/part.js"></script>',
      '<script src="assets/kit/shade/part.js"></script>',
      '<script src="assets/kit/three/part.js"></script>',
    ]);
    expect(kitScripts([m("shade")], { palette: [], keyLightDeg: 0 }, { width: 1, height: 1 }, 30).join()).not.toContain("three.min.js");
    expect(lines[0]).toContain('window.SorotKitLook = {"palette":["#000000"],"keyLightDeg":300,"size":{"width":1080,"height":1920},"fps":30}');
    expect(kitScripts([], { palette: [], keyLightDeg: 0 }, { width: 1, height: 1 }, 30)).toEqual([]);
    expect(exampleRoot(m("shade"), { durationSec: 2, settings: { a: "</script>" }, markup: "<b>x</b>" })).toContain('SorotKitRuntime.mount("shade", document.getElementById("stage"), {"a":"\\u003c/script>"}');
  });

  test("a recipe names a part with kit:<name>; other require entries are hints", () => {
    expect(requiredParts(["kit:shade", "typography", "kit:Bad Name", "kit:shade", 3])).toEqual(["shade"]);
  });
});

describe("kit API", () => {
  const base = "/api/generate/kit";
  // two renders: same frames unless `differ`; lint and check as the fake gives them unless overridden
  const rig = (frames: string[][] = [["aa", "bb"], ["aa", "bb"]]) => {
    env = makeEnv();
    env.app.start();
    let render = 0;
    const real = env.execHandler.fn;
    env.execHandler.fn = (cmd, args, signal) => {
      if (cmd === env!.config.ffmpegPath && args.includes("framemd5")) {
        const hashes = frames[Math.min(render++, frames.length - 1)]!;
        return procOk(`#format: frame checksums\n${hashes.map((h, i) => `0, ${i}, ${i}, 1, 100, ${h}`).join("\n")}\n`);
      }
      return real(cmd, args, signal);
    };
    return env;
  };
  const post = (zip: Uint8Array) => {
    const form = new FormData();
    form.append("file", new File([zip], "part.zip", { type: "application/zip" }));
    return env!.app.fetch(new Request(`http://localhost${base}`, { method: "POST", body: form }));
  };
  const body = async (res: Response) => ({ status: res.status, body: await res.json() as any });

  test("the built-in parts are listed from generator/kit and can't be removed", async () => {
    rig();
    const { body: list } = await env!.json("GET", base);
    expect(list.data.parts.map((p: any) => [p.name, p.source])).toEqual(BUILT_INS.map((n) => [n, "builtIn"]));
    expect((await env!.json("GET", `${base}/three`)).body.data.part.manifest.needs).toEqual({ gpu: "preferred" });
    expect((await env!.json("DELETE", `${base}/shade`)).status).toBe(409);
    expect((await env!.json("GET", `${base}/nope`)).status).toBe(404);
  });

  test("a user part is checked (lint, check, two renders), stored, exported, replaced and removed", async () => {
    rig();
    const added = await body(await post(writeZip(partFiles().map((f) => ({ ...f, path: `glow-ring/${f.path}` })))));
    expect(added.status).toBe(201);
    expect(added.body.data.part).toMatchObject({ name: "glow-ring", source: "user", version: "1.0.0" });
    expect(added.body.data.part.checkedAt).toBeString();
    const hf = env!.execCalls.filter((c) => c.cmd === env!.config.nodePath).map((c) => c.args[1]);
    expect(hf).toEqual(["init", "lint", "check", "render", "render"]);

    const exported = await env!.req("GET", `${base}/glow-ring/export`);
    expect(exported.headers.get("content-disposition")).toBe('attachment; filename="glow-ring.zip"');
    expect(readZip(new Uint8Array(await exported.arrayBuffer())).map((e) => e.path)).toEqual(["glow-ring/example.json", "glow-ring/part.js", "glow-ring/part.json"]);

    const v2 = await body(await post(writeZip(partFiles({ manifest: manifest({ version: "1.1.0" }) }))));
    expect([v2.status, v2.body.data.part.version]).toEqual([201, "1.1.0"]);
    expect((await env!.json("DELETE", `${base}/glow-ring`)).status).toBe(200);
    expect((await env!.json("GET", `${base}/glow-ring`)).status).toBe(404);
  });

  test.each([
    ["two renders that differ", { frames: [["aa", "bb"], ["aa", "cc"]] }, 400, "two renders of the example differ (first at frame 1)"],
    ["a part that uses Math.random()", { files: partFiles({ js: partJs("glow-ring", "Math.random();") }) }, 400, "part.js uses Math.random()"],
    ["a built-in's name", { files: partFiles({ manifest: manifest({ name: "shade" }) }) }, 409, "a built-in part's name"],
    ["a path out of the folder", { escape: true }, 400, "a path outside its folder"],
  ])("%s is refused and nothing is kept", async (_label, c: { frames?: string[][]; files?: Array<{ path: string; data: Uint8Array }>; escape?: boolean }, status, message) => {
    rig(c.frames);
    // writeZip refuses such a path, so the bytes are edited after: "xx/" becomes "../" in both headers
    const zip = writeZip(c.escape ? [{ path: "xx/part.json", data: new Uint8Array(1) }] : c.files ?? partFiles());
    if (c.escape) for (let i = 0; i < zip.length - 2; i++) if (zip[i] === 120 && zip[i + 1] === 120 && zip[i + 2] === 47) zip.set([46, 46], i);
    const res = await body(await post(zip));
    expect(res.status).toBe(status);
    expect(res.body.error).toContain(message);
    expect((await env!.json("GET", base)).body.data.parts).toHaveLength(BUILT_INS.length);
  });

  test("a part whose example has a lint error is refused with the finding", async () => {
    rig();
    env!.hfHandlers.lint = () => procOk(JSON.stringify({ ok: false, errorCount: 1, warningCount: 0, infoCount: 0, findings: [{ code: "bad_clip", severity: "error", message: "clip has no start" }] }));
    const res = await body(await post(writeZip(partFiles())));
    expect([res.status, res.body.findings]).toEqual([400, ["bad_clip: clip has no start"]]);
  });

  test("capabilities: what a director call is told now, at the level asked; a level that doesn't exist is a 400", async () => {
    rig();
    const c = (await env!.json("GET", "/api/generate/capabilities?level=kit")).body.data.capabilities;
    expect([c.level, c.kit.map((p: any) => p.name), Object.keys(c.kitDetail)]).toEqual(["kit", BUILT_INS, BUILT_INS]);   // tested WebGL parts too, at the kit level
    expect((await env!.json("GET", "/api/generate/capabilities")).body.data.capabilities.level).toBe("compose");
    expect((await env!.json("GET", "/api/generate/capabilities?level=max")).status).toBe(400);
  });

  test("models: each model's record and auto level; a pin sets and clears; calibration runs in the background and fills the record", async () => {
    rig();
    env!.app.store.addGenModelRecord("m", "compose", { asked: 10, firstPass: 9 });
    const first = (await env!.json("GET", "/api/generate/models")).body.data;
    expect(first.models.find((m: any) => m.model === "m")).toMatchObject({ pin: null, auto: "free", proven: "compose", records: [{ level: "compose", asked: 10 }] });
    expect((await env!.json("PUT", "/api/generate/models/m/level", { level: "kit" })).body.data.model).toMatchObject({ pin: "kit" });
    expect((await env!.json("PUT", "/api/generate/models/m/level", { level: null })).body.data.model.pin).toBeNull();
    expect((await env!.json("PUT", "/api/generate/models/m/level", { level: "max" })).status).toBe(400);
    expect((await env!.json("PUT", "/api/generate/models/a%25b/level", { level: "kit" })).body.data.model).toMatchObject({ model: "a%b", pin: "kit" });   // decoded once
    expect((await env!.json("POST", "/api/generate/models/calibrate", {})).status).toBe(409);   // no LLM connected
  });

  test("a recipe that names a kit part the install lacks is unavailable, with the reason", async () => {
    rig();
    const steps = quickRecipe().steps.map((s) => (s.use === "author" ? { ...s, with: { ...s.with, require: ["kit:shade", "kit:neon-sign", "typography"] } } : s));
    await env!.json("POST", "/api/generate/recipes/import", { recipe: { ...quickRecipe(), id: "mine", name: "Mine", steps } });
    const found = (await env!.json("GET", "/api/generate/recipes")).body.data.recipes.find((r: any) => r.id === "mine");
    expect([found.available, found.reasons]).toEqual([false, ["author: kit part neon-sign isn't installed"]]);
  });
});
