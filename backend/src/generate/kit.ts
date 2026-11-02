import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { AppConfig } from "../config";
import { HttpError } from "../http";
import type { ExecFn } from "../runner";
import { now, type Store } from "../store";
import type { GenKitPart } from "../types";
import { GSAP_FILE, nondeterministicIn } from "./composer";
import type { Hyperframes } from "./hyperframes";
import { checkField, checkFieldSpec, isObject, type Field } from "./steps/schema";
import { readZip, writeZip, ZipError, type ZipEntry } from "./zip";

// The kit (research R22, R23, contracts/kit.md): drawing and motion parts as browser scripts with a
// manifest, loaded by the root composition. Built-in parts ship in generator/kit/; the owner adds
// their own to data/kit/. A user part is proven before a director may use it: its manifest
// validates, its script uses no clock, network or unseeded randomness, and its example renders
// twice with the same frames.

export const KIT_RUNTIMES = ["dom", "canvas", "webgl"] as const;
export type KitRuntime = (typeof KIT_RUNTIMES)[number];
export const GPU_NEEDS = ["no", "preferred", "required"] as const;
export const PART_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** The browser runtime every root loads before its parts (ctx, seeded random, mount with defaults). */
export const KIT_RUNTIME_FILE = "assets/kit/_runtime.js";
const PART_FILES = ["part.json", "part.js", "example.json"];
/** The vendored Three.js every WebGL part may use. */
export const THREE_LIB = "assets/kit/three/three.min.js";
/** How a recipe's `author.require` names a kit part (other entries are free-form hints). */
export const KIT_PREFIX = "kit:";

/** The kit parts `require` names with `kit:<name>`. */
export const requiredParts = (require: unknown): string[] =>
  Array.isArray(require)
    ? [...new Set(require.filter((r): r is string => typeof r === "string" && r.startsWith(KIT_PREFIX)).map((r) => r.slice(KIT_PREFIX.length)).filter((n) => PART_NAME.test(n)))]
    : [];
const MAX_LINE = 200;
const EXAMPLE_SIZE = { width: 1080, height: 1920 };
/** Seconds of the example a user part renders (twice) before it is accepted. */
export const EXAMPLE_RENDER_SEC = 1;
const EXAMPLE_FPS = 30;

export interface KitManifest {
  name: string;
  version: string;
  does: string;
  runtime: KitRuntime;
  needs: { gpu: (typeof GPU_NEEDS)[number] };
  settings: Record<string, Field>;
  defaults: Record<string, unknown>;
  example: string;
}

export interface KitExample { durationSec: number; settings: Record<string, unknown>; markup: string }

/** What the API and CLI show for one part. */
export interface KitPartView {
  name: string;
  source: "builtIn" | "user";
  version: string;
  manifest: KitManifest;
  checkedAt: string | null;
}

const line = (v: unknown) => typeof v === "string" && v.trim().length > 0 && v.length <= MAX_LINE && !/\n/.test(v);

/** Validates a part.json; `errors` says what is wrong, one message per problem. */
export function parseManifest(raw: unknown): { manifest: KitManifest | null; errors: string[] } {
  const errors: string[] = [];
  if (!isObject(raw)) return { manifest: null, errors: ["part.json must be a JSON object"] };
  const known = ["name", "version", "does", "runtime", "needs", "settings", "defaults", "example"];
  for (const k of Object.keys(raw)) if (!known.includes(k)) errors.push(`part.json: unknown key "${k}"`);
  if (typeof raw.name !== "string" || !PART_NAME.test(raw.name)) errors.push("name: a lowercase slug (a-z, 0-9, -), at most 40 characters");
  if (typeof raw.version !== "string" || !/^\d+\.\d+\.\d+([-+][\w.]+)?$/.test(raw.version)) errors.push("version: like 1.0.0");
  if (!line(raw.does)) errors.push(`does: one line, at most ${MAX_LINE} characters`);
  if (!line(raw.example)) errors.push(`example: one line, at most ${MAX_LINE} characters`);
  if (!KIT_RUNTIMES.includes(raw.runtime as KitRuntime)) errors.push(`runtime: one of ${KIT_RUNTIMES.join(", ")}`);
  const gpu = isObject(raw.needs) ? raw.needs.gpu : undefined;
  if (!isObject(raw.needs) || !GPU_NEEDS.includes(gpu as never) || Object.keys(raw.needs).some((k) => k !== "gpu")) errors.push(`needs: {"gpu": ${GPU_NEEDS.map((g) => `"${g}"`).join(" | ")}}`);
  const settings = isObject(raw.settings) ? raw.settings : null;
  if (!settings) errors.push("settings: an object of field definitions (it may be empty)");
  else for (const [k, f] of Object.entries(settings)) {
    if (!/^[a-zA-Z][a-zA-Z0-9]{0,39}$/.test(k)) errors.push(`settings.${k}: names are letters and digits`);
    checkFieldSpec(f, `settings.${k}`, errors);
  }
  if (!isObject(raw.defaults)) errors.push("defaults: an object (it may be empty)");
  else if (settings && errors.length === 0) {
    for (const [k, v] of Object.entries(raw.defaults)) {
      const f = settings[k] as Field | undefined;
      if (!f) errors.push(`defaults.${k}: not one of the settings`);
      else checkField(f, v, `defaults.${k}`, errors);
    }
  }
  return { manifest: errors.length ? null : (raw as unknown as KitManifest), errors };
}

/** Checks `settings` against a part's manifest: unknown names and bad values, one message each. */
export function checkPartSettings(manifest: KitManifest, settings: unknown, path: string): string[] {
  const errors: string[] = [];
  if (!isObject(settings)) return [`${path}: settings must be an object`];
  for (const [k, v] of Object.entries(settings)) {
    const f = manifest.settings[k];
    if (!f) errors.push(`${path}.${k}: ${manifest.name} has no setting "${k}" (it has ${Object.keys(manifest.settings).join(", ") || "none"})`);
    else checkField(f, v, `${path}.${k}`, errors);
  }
  return errors;
}

/** Every file under `dir`, as paths relative to it; a link, or a path leaving the folder, is an error. */
function filesIn(dir: string): { files: string[]; errors: string[] } {
  const files: string[] = [];
  const errors: string[] = [];
  const root = realpathSync(dir);
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      const st = lstatSync(full);
      const rel = relative(dir, full).split(sep).join("/");
      if (st.isSymbolicLink()) errors.push(`${rel}: links aren't allowed in a part`);
      else if (st.isDirectory()) walk(full);
      else if (!realpathSync(full).startsWith(root)) errors.push(`${rel}: outside the part's folder`);
      else files.push(rel);
    }
  };
  walk(dir);
  return { files: files.sort(), errors };
}

/** Reads and checks the part in `dir` without running it. */
export function readPart(dir: string): { manifest: KitManifest | null; example: KitExample | null; errors: string[] } {
  const errors: string[] = [];
  if (!existsSync(dir)) return { manifest: null, example: null, errors: [`${dir} doesn't exist`] };
  const { files, errors: fileErrors } = filesIn(dir);
  errors.push(...fileErrors);
  for (const f of PART_FILES) if (!files.includes(f)) errors.push(`${f} is missing`);
  if (errors.length) return { manifest: null, example: null, errors };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, "part.json"), "utf-8"));
  } catch (e) {
    return { manifest: null, example: null, errors: [`part.json isn't valid JSON: ${(e as Error).message}`] };
  }
  const { manifest, errors: manifestErrors } = parseManifest(raw);
  errors.push(...manifestErrors);
  const js = readFileSync(join(dir, "part.js"), "utf-8");
  for (const label of nondeterministicIn(js)) errors.push(`part.js uses ${label}: a render must be the same every time (use ctx.rand, ctx.tl or render(t))`);
  if (/\bimport\s*\(|\bimportScripts\s*\(|\bWebSocket\b|\bEventSource\b|\bnavigator\.sendBeacon\b/.test(js)) errors.push("part.js reaches the network: renders are offline");
  if (manifest && !new RegExp(`SorotKit\\s*\\[\\s*["']${manifest.name}["']\\s*\\]\\s*=`).test(js)) errors.push(`part.js must register window.SorotKit["${manifest.name}"] = { mount(host, settings, ctx) { ... } }`);
  let example: KitExample | null = null;
  try {
    const ex = JSON.parse(readFileSync(join(dir, "example.json"), "utf-8")) as Record<string, unknown>;
    const durationSec = ex.durationSec ?? 2;
    if (typeof durationSec !== "number" || durationSec < EXAMPLE_RENDER_SEC || durationSec > 10) errors.push(`example.json: durationSec between ${EXAMPLE_RENDER_SEC} and 10`);
    if (ex.markup !== undefined && typeof ex.markup !== "string") errors.push("example.json: markup must be text");
    if (manifest) errors.push(...checkPartSettings(manifest, ex.settings ?? {}, "example.json settings"));
    example = { durationSec: durationSec as number, settings: (ex.settings ?? {}) as Record<string, unknown>, markup: (ex.markup as string | undefined) ?? "" };
  } catch (e) {
    errors.push(`example.json isn't valid JSON: ${(e as Error).message}`);
  }
  return { manifest: errors.length ? null : manifest, example: errors.length ? null : example, errors };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** JSON safe to put inside a <script> element. */
export const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

export interface KitLook { palette: string[]; keyLightDeg: number }

/**
 * The root's <script> lines for a set of parts: the film's look and each part's defaults, the
 * runtime, then the parts in name order (each is `assets/kit/<name>/part.js`; three also loads its
 * library first).
 */
export function kitScripts(parts: KitManifest[], look: KitLook, size: { width: number; height: number }, fps: number): string[] {
  if (!parts.length) return [];
  const sorted = [...parts].sort((a, b) => a.name.localeCompare(b.name));
  const defaults = Object.fromEntries(sorted.map((p) => [p.name, p.defaults]));
  return [
    `<script>window.SorotKitLook = ${scriptJson({ ...look, size, fps })}; window.SorotKitDefaults = ${scriptJson(defaults)};</script>`,
    `<script src="${KIT_RUNTIME_FILE}"></script>`,
    // Three.js (vendored with the `three` part) once, before any WebGL part
    ...(sorted.some((p) => p.runtime === "webgl") ? [`<script src="${THREE_LIB}"></script>`] : []),
    ...sorted.map((p) => `<script src="assets/kit/${esc(p.name)}/part.js"></script>`),
  ];
}

/** A one-shot root that mounts one part with its example, for the render check. */
export function exampleRoot(manifest: KitManifest, example: KitExample): string {
  const { width, height } = EXAMPLE_SIZE;
  const d = example.durationSec;
  const look: KitLook = { palette: ["#14213d", "#f5f5f5", "#fca311"], keyLightDeg: 315 };
  return `<!doctype html>
<html lang="en" data-resolution="portrait">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${width}, height=${height}" />
    <script src="${GSAP_FILE}"></script>
    ${kitScripts([manifest], look, EXAMPLE_SIZE, EXAMPLE_FPS).join("\n    ")}
    <style>* { margin: 0; padding: 0; box-sizing: border-box; } html, body { width: ${width}px; height: ${height}px; overflow: hidden; background: ${look.palette[0]}; }</style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${EXAMPLE_RENDER_SEC}" data-width="${width}" data-height="${height}">
      <div id="stage" class="clip" data-start="0" data-duration="${EXAMPLE_RENDER_SEC}" data-track-index="0" style="position:absolute;left:0;top:0;width:${width}px;height:${height}px">${example.markup}</div>
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      window.__timelines["main"] = tl;
      SorotKitRuntime.mount(${scriptJson(manifest.name)}, document.getElementById("stage"), ${scriptJson(example.settings)}, { tl, duration: ${d}, seed: "example" });
      tl.seek(0);
    </script>
  </body>
</html>
`;
}

export class KitError extends HttpError {
  constructor(status: number, message: string, readonly findings: string[] = []) {
    super(status, findings.length ? `${message}: ${findings.join("; ")}` : message);
  }
}

/** The installed kit: built-in parts synced from generator/kit/, user parts in data/kit/. */
export class Kit {
  constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
    private readonly hyperframes: Hyperframes,
    private readonly exec: ExecFn,
  ) {}

  get builtInDir() { return join(this.config.generatorDir, "kit"); }
  get userDir() { return join(this.config.dataDir, "kit"); }

  /**
   * Brings the built-in rows in line with generator/kit/: new and changed parts are saved, removed
   * ones dropped. A built-in that doesn't validate is skipped with a log line (it's a release bug,
   * not the owner's). Returns the names synced.
   */
  syncBuiltIns(): string[] {
    const synced: string[] = [];
    const dir = this.builtInDir;
    const names = existsSync(dir) ? readdirSync(dir).filter((n) => PART_NAME.test(n) && lstatSync(join(dir, n)).isDirectory()) : [];
    for (const name of names) {
      const { manifest, errors } = readPart(join(dir, name));
      if (!manifest || manifest.name !== name) {
        console.error(`Kit: built-in part ${name} skipped: ${manifest ? `its manifest says "${manifest.name}"` : errors.join("; ")}`);
        continue;
      }
      const row = this.store.getGenKitPart(name);
      if (row && row.source === "user") {
        console.error(`Kit: built-in part ${name} skipped: a user part already has that name`);
        continue;
      }
      const json = JSON.stringify(manifest);
      if (!row || row.manifest !== json || row.path !== join(dir, name)) {
        this.store.saveGenKitPart({
          name, source: "builtIn", version: manifest.version, manifest: json, path: join(dir, name), checkedAt: row?.checkedAt ?? null,
          createdAt: row?.createdAt ?? now(), updatedAt: now(),
        });
      }
      synced.push(name);
    }
    for (const row of this.store.listGenKitParts()) if (row.source === "builtIn" && !synced.includes(row.name)) this.store.deleteGenKitPart(row.name);
    return synced;
  }

  list(): KitPartView[] { return this.store.listGenKitParts().map(view); }

  /** The part's manifest, or a 404. */
  get(name: string): KitPartView {
    const row = this.store.getGenKitPart(name);
    if (!row) throw new HttpError(404, `Kit part "${name}" isn't installed`);
    return view(row);
  }

  /** Manifests of every installed part (what a director call may be told about). */
  manifests(): KitManifest[] { return this.store.listGenKitParts().map((r) => JSON.parse(r.manifest) as KitManifest); }

  /** Copies the parts named, and the runtime, into a project's assets/kit/. */
  copyInto(projectDir: string, names: string[]): KitManifest[] {
    const out: KitManifest[] = [];
    const target = join(projectDir, "assets", "kit");
    if (names.length) {
      mkdirSync(target, { recursive: true });
      cpSync(join(this.builtInDir, "_runtime.js"), join(projectDir, KIT_RUNTIME_FILE));
    }
    for (const name of [...new Set(names)].sort()) {
      const row = this.store.getGenKitPart(name);
      if (!row) throw new HttpError(409, `Kit part "${name}" isn't installed`);
      rmSync(join(target, name), { recursive: true, force: true });
      cpSync(row.path, join(target, name), { recursive: true });
      out.push(JSON.parse(row.manifest) as KitManifest);
    }
    // a WebGL part draws with the vendored Three.js, which lives with the `three` part
    if (out.some((m) => m.runtime === "webgl") && !existsSync(join(projectDir, THREE_LIB))) {
      mkdirSync(join(target, "three"), { recursive: true });
      cpSync(join(this.builtInDir, "three", "three.min.js"), join(projectDir, THREE_LIB));
    }
    return out;
  }

  /**
   * Adds the owner's part from a .zip (one part folder, at the top or inside one folder) or a folder
   * on this machine. It is validated and its example rendered twice; on any problem nothing is kept
   * and the error lists the findings. Adding a part again replaces the owner's earlier copy.
   */
  async add(input: { zip?: Uint8Array; folder?: string }, signal?: AbortSignal): Promise<KitPartView> {
    const staging = join(this.userDir, `.staging-${crypto.randomUUID()}`);
    try {
      mkdirSync(staging, { recursive: true });
      let source: string;
      if (input.zip) {
        let entries: ZipEntry[];
        try {
          entries = readZip(input.zip);
        } catch (e) {
          throw new KitError(400, e instanceof ZipError ? e.message : `The .zip couldn't be read: ${(e as Error).message}`);
        }
        const tops = new Set(entries.map((e) => e.path.split("/")[0]));
        const nested = !entries.some((e) => e.path === "part.json") && tops.size === 1 && entries.some((e) => e.path === `${[...tops][0]}/part.json`);
        for (const e of entries) {
          const rel = nested ? e.path.slice(e.path.indexOf("/") + 1) : e.path;
          if (!rel) continue;
          mkdirSync(join(staging, rel, ".."), { recursive: true });
          writeFileSync(join(staging, rel), e.data);
        }
        source = staging;
      } else if (input.folder) {
        source = input.folder;
      } else throw new KitError(400, "Send a part as a .zip or a folder");

      const { manifest, example, errors } = readPart(source);
      if (!manifest || !example) throw new KitError(400, "The part isn't valid", errors);
      const existing = this.store.getGenKitPart(manifest.name);
      if (existing?.source === "builtIn") throw new KitError(409, `"${manifest.name}" is a built-in part's name: give yours another name`);
      if (source !== staging) cpSync(source, staging, { recursive: true });

      const findings = await this.checkExample(staging, manifest, example, signal);
      if (findings.length) throw new KitError(400, `The part's example didn't pass`, findings);

      const dest = join(this.userDir, manifest.name);
      rmSync(dest, { recursive: true, force: true });
      cpSync(staging, dest, { recursive: true });
      const at = now();
      this.store.saveGenKitPart({
        name: manifest.name, source: "user", version: manifest.version, manifest: JSON.stringify(manifest), path: dest, checkedAt: at,
        createdAt: existing?.createdAt ?? at, updatedAt: at,
      });
      return this.get(manifest.name);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  /** Removes one of the owner's parts; built-ins can't be removed. */
  remove(name: string): void {
    const row = this.store.getGenKitPart(name);
    if (!row) throw new HttpError(404, `Kit part "${name}" isn't installed`);
    if (row.source === "builtIn") throw new HttpError(409, `"${name}" is built in and can't be removed`);
    rmSync(row.path, { recursive: true, force: true });
    this.store.deleteGenKitPart(name);
  }

  /** The part's folder as a .zip with the folder at the top (`<name>/part.json`, ...). */
  export(name: string): Uint8Array {
    const row = this.store.getGenKitPart(name);
    if (!row) throw new HttpError(404, `Kit part "${name}" isn't installed`);
    const { files } = filesIn(row.path);
    return writeZip(files.map((f) => ({ path: `${name}/${f}`, data: new Uint8Array(readFileSync(join(row.path, f))) })));
  }

  /**
   * Renders the example in a throwaway project: `lint` and `check` must report no errors, and two
   * renders of the first second must give the same frames. Returns what failed (empty = passed).
   */
  async checkExample(partDir: string, manifest: KitManifest, example: KitExample, signal?: AbortSignal): Promise<string[]> {
    const dir = join(this.config.genDir, ".kit-check", `${manifest.name}-${crypto.randomUUID()}`);
    try {
      mkdirSync(join(dir, ".."), { recursive: true });
      await this.hyperframes.init(dir, "9:16", { signal });
      mkdirSync(join(dir, "assets", "kit"), { recursive: true });
      cpSync(this.config.gsapFile, join(dir, GSAP_FILE));
      cpSync(join(this.builtInDir, "_runtime.js"), join(dir, KIT_RUNTIME_FILE));
      cpSync(partDir, join(dir, "assets", "kit", manifest.name), { recursive: true });
      if (manifest.runtime === "webgl" && !existsSync(join(dir, THREE_LIB))) {
        // a WebGL part (built in or yours) draws with the vendored Three.js
        mkdirSync(join(dir, "assets", "kit", "three"), { recursive: true });
        cpSync(join(this.builtInDir, "three", "three.min.js"), join(dir, THREE_LIB));
      }
      writeFileSync(join(dir, "index.html"), exampleRoot(manifest, example));

      const findings: string[] = [];
      const lint = await this.hyperframes.lint(dir, { signal });
      const check = await this.hyperframes.check(dir, { signal });
      for (const f of [...lint.findings, ...(["lint", "runtime", "layout"] as const).flatMap((k) => check[k]?.findings ?? [])]) {
        if (f.severity === "error") findings.push(`${f.code}: ${f.message}`);
      }
      if (findings.length) return [...new Set(findings)];

      const hashes: string[][] = [];
      for (const n of [1, 2]) {
        const output = join(dir, `example-${n}.mp4`);
        await this.hyperframes.render(dir, { output, quality: "draft", fps: EXAMPLE_FPS, durationSec: EXAMPLE_RENDER_SEC, workers: 1 }, { signal });
        hashes.push(await this.frameHashes(output, signal));
      }
      const [a, b] = hashes as [string[], string[]];
      if (!a.length) return ["the example rendered no frames"];
      const differ = a.findIndex((h, i) => h !== b[i]);
      if (differ >= 0 || a.length !== b.length) {
        return [`two renders of the example differ (first at frame ${differ >= 0 ? differ : Math.min(a.length, b.length)}): the part isn't deterministic`];
      }
      return [];
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** One md5 per decoded frame (ffmpeg's framemd5 muxer). */
  private async frameHashes(file: string, signal?: AbortSignal): Promise<string[]> {
    const res = await this.exec(this.config.ffmpegPath, ["-v", "error", "-i", file, "-map", "0:v:0", "-f", "framemd5", "-"], { signal, timeoutMs: 120_000 });
    if (res.exitCode !== 0) throw new KitError(500, `ffmpeg couldn't read the example render: ${res.stderr.trim().slice(-300)}`);
    return res.stdout.split("\n").filter((l) => l.trim() && !l.startsWith("#")).map((l) => l.split(",").pop()!.trim());
  }
}

const view = (row: GenKitPart): KitPartView => ({
  name: row.name, source: row.source, version: row.version, manifest: JSON.parse(row.manifest) as KitManifest, checkedAt: row.checkedAt,
});
