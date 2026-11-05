import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { tool, type ToolDef } from "../llm";
import { checkScene, shotFile, type SceneIssue } from "./composer";
import type { Plan, Shot } from "./planSchema";
import type { Hyperframes, HfFinding } from "./hyperframes";
import type { StrangerRead } from "./look";
import type { SceneKit } from "./composer";
import { shotMotionFindings } from "./motion";
import { PROBE_PREFIX, probeConfig, probeFindings, readProbe, withProbe } from "./sceneProbe";

// The tools a director may use inside one shot's turn (docs/director-loop.md, FR-049): find a
// registry block, install it, check its own draft. Each returns plain JSON for the model; a tool
// never throws into the build (a failure is `{ error }` so the director can carry on).

export interface CatalogEntry {
  name: string;
  tags: string[];
  type?: string;
  title?: string;
  description?: string;
  width?: number;
  height?: number;
  duration?: number;
}

/** What a tool gives back: the JSON for the tool result, and pictures to show the model after it. */
export interface ToolOutcome { result: unknown; images?: string[] }
export type ToolArgs = Record<string, unknown>;

export interface SceneTool {
  def: ToolDef;
  /** How many calls one turn may make. */
  limit: number;
  run: (args: ToolArgs) => Promise<ToolOutcome>;
}

/** The tools of one shot's turn: `steps` tool steps before the answer is forced. */
export interface SceneTools { steps: number; tools: Record<string, SceneTool> }

/** Fixed order, so every turn of a session offers the same list (the provider caches the prefix). */
export const TOOL_ORDER = ["search_blocks", "use_block", "look", "check"] as const;
/** The text a call past its limit gets back. */
export const LIMIT_REACHED = { error: "limit reached: submit now" };
/** What the first submit gets back when the turn can look and hasn't. */
export const LOOK_FIRST = "look at your draft first: call look with this html (and 1 to 3 moments of the shot), see what a stranger sees, fix what they can't name, then submit again";

const MAX_QUERY = 120;
const MAX_MATCHES = 8;
const DEFAULT_MATCHES = 5;
/** The most of a block's source a result carries (the rest is cut, with a note). */
export const BLOCK_SOURCE_CHARS = 24 * 1024;

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2);

/**
 * The registry items that fit a request, best first. Words and tags only: 448 short descriptions
 * don't need embeddings (spike S8 checks that). A word in the name or a tag counts most, then the
 * title, then the description.
 */
export function searchBlocks(catalog: CatalogEntry[], args: ToolArgs): ToolOutcome {
  const query = typeof args.query === "string" ? args.query.slice(0, MAX_QUERY) : "";
  const type = args.type === "block" || args.type === "component" ? args.type : null;
  const limit = Math.max(1, Math.min(MAX_MATCHES, Number.isInteger(args.limit) ? (args.limit as number) : DEFAULT_MATCHES));
  const wanted = [...new Set(words(query))];
  if (!wanted.length) return { result: { error: "query: say what you are looking for in a few words" } };
  const scored = catalog.filter((c) => !type || c.type === type).map((c) => {
    const name = c.name.toLowerCase();
    const tags = (c.tags ?? []).map((t) => t.toLowerCase());
    const title = (c.title ?? "").toLowerCase();
    const about = (c.description ?? "").toLowerCase();
    let score = 0;
    for (const w of wanted) {
      if (name.includes(w)) score += 3;
      if (tags.some((t) => t === w || t.includes(w))) score += 3;
      if (title.includes(w)) score += 2;
      if (about.includes(w)) score += 1;
    }
    return { c, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name));
  return {
    result: {
      matches: scored.slice(0, limit).map(({ c }) => ({
        name: c.name, type: c.type ?? null, title: c.title ?? null, description: (c.description ?? "").slice(0, 200), tags: c.tags ?? [],
        width: c.width ?? null, height: c.height ?? null, duration: c.duration ?? null,
      })),
    },
  };
}

export interface ToolEnv {
  /** The version's HyperFrames project. */
  dir: string;
  hyperframes: Pick<Hyperframes, "add" | "lint" | "snapshot" | "check" | "render">;
  catalog: () => Promise<CatalogEntry[]>;
  /** The recipe's plan step allows registry blocks. */
  blocksAllowed: boolean;
  shot: Shot;
  /** The film's plan and frame rate: with them `check` and `look` also run the scene probe on the draft. */
  plan?: Plan;
  fps?: number;
  /** The change from each frame of a rendered clip to the next (motion.ts): with it, `check` and `look` also measure the draft's motion. */
  frameDiffs?: (file: string) => Promise<number[]>;
  /** 0-based position of the shot in the plan. */
  index: number;
  /** Where the shot starts in the film, seconds (frames are taken at film time). */
  startSec: number;
  /** The rules a scene is held to at this shot's level (`sceneRules`). */
  rules: { assets: string[]; kit?: SceneKit };
  signal?: AbortSignal;
}

/**
 * The files a block installed, relative to the project: from what `hyperframes add` reports as written
 * (a block lands flat, `compositions/<name>.html`, or in its own folder, `compositions/<name>/…`), or,
 * when the report names none, the two flat places a block may sit.
 */
export function blockFiles(dir: string, name: string, added: Record<string, unknown>): string[] {
  const written = (Array.isArray(added.written) ? added.written : []).filter((p): p is string => typeof p === "string").map((p) => relative(dir, p));
  const mine = written.filter((rel) => rel.split("/").some((part) => part === name || part === `${name}.html`));
  return (mine.length ? mine : [`compositions/${name}.html`, `compositions/components/${name}.html`]).filter((rel) => existsSync(join(dir, rel)));
}

/** A block's source as the director reads it: its HTML, cut, and a note when it loads anything from the web (a Sorot scene loads nothing). */
export function blockSource(dir: string, files: string[], max: number): { source: string; cut: boolean; external: string[] } {
  const full = files.filter((f) => f.endsWith(".html")).map((f) => readFileSync(join(dir, f), "utf-8")).join("\n");
  const external = [...new Set([...full.matchAll(/\b(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)["']/gi)].map((m) => m[1] as string))].slice(0, 6);
  return { source: full.slice(0, max), cut: full.length > max, external };
}

/** Installs a registry block into the project and hands its source over to adapt. */
export async function useBlock(env: ToolEnv, args: ToolArgs): Promise<ToolOutcome> {
  if (!env.blocksAllowed) return { result: { error: "this recipe doesn't allow registry blocks: draw it yourself" } };
  const name = typeof args.name === "string" ? args.name.trim() : "";
  const catalog = await env.catalog();
  if (!name || !catalog.some((c) => c.name === name)) return { result: { error: `no block named "${name}": use search_blocks to find one` } };
  const added = await env.hyperframes.add(env.dir, [name], { signal: env.signal });
  const files = blockFiles(env.dir, name, added);
  const { source, cut, external } = blockSource(env.dir, files, BLOCK_SOURCE_CHARS);
  return {
    result: {
      name, files, source, cut,
      ...(external.length ? { external, note: "this block loads scripts, fonts or files from the web; a scene here loads nothing from the web (the root provides GSAP and the kit): take them out or replace them" } : {}),
    },
  };
}

export interface DraftFinding { code: string; severity: string; message: string; hint?: string }

const fromIssue = (i: SceneIssue): DraftFinding => ({ code: i.code, severity: "error", message: i.message, hint: i.hint });
const fromLint = (f: HfFinding): DraftFinding => ({ code: f.code, severity: f.severity, message: f.message, ...(f.fixHint ? { hint: f.fixHint } : {}) });

/** Writes a draft into the project as this shot's file, ready for a check or a look. */
export function writeDraft(env: ToolEnv, html: string): void {
  mkdirSync(join(env.dir, "compositions"), { recursive: true });
  writeFileSync(join(env.dir, shotFile(env.index)), html);
}

/** A project's shot file that doesn't exist yet: HyperFrames' check refuses a root whose hosts point at nothing. */
const stub = (id: string, w: number, h: number) =>
  `<!doctype html><html><body><div data-composition-id="${id}" data-width="${w}" data-height="${h}"><script>window.__timelines = window.__timelines || {}; window.__timelines["${id}"] = gsap.timeline({ paused: true });</script></div></body></html>`;

type Evaluated = { code: string; severity: string; message: string; hint?: string };

/**
 * What the build's own checks would say about the draft, while the director can still change it: the scene probe
 * (sceneProbe.ts: text sitting on a drawing, a title missing on the first frame, two moves fighting over one
 * property, a hard swap) and the motion measure (motion.ts: a frame that jumps, a shot that freezes and moves
 * again) on a draft render of just this shot. Both need the whole film to load, and the shots after this one
 * aren't written yet, so they run on a scratch copy of the project (the root, the shots so far, a placeholder
 * for each missing one, the assets linked) and never touch the version's own folder. About 20 s together
 * (5 s the probe, 13 s the render of a 3.5 s shot on this CPU); a measure that can't run adds nothing (the
 * check step runs the same ones after the build).
 */
export async function evaluateDraft(env: ToolEnv): Promise<Evaluated[]> {
  if (!env.plan) return [];
  const plan = env.plan;
  const fps = env.fps ?? 30;
  const copy = mkdtempSync(join(tmpdir(), "sorot-probe-"));
  try {
    for (const f of ["index.html", "hyperframes.json", "package.json", "meta.json"]) if (existsSync(join(env.dir, f))) cpSync(join(env.dir, f), join(copy, f));
    mkdirSync(join(copy, "assets"));
    if (existsSync(join(env.dir, "assets"))) for (const name of readdirSync(join(env.dir, "assets"))) symlinkSync(join(env.dir, "assets", name), join(copy, "assets", name));
    mkdirSync(join(copy, "compositions"));
    const root = existsSync(join(copy, "index.html")) ? readFileSync(join(copy, "index.html"), "utf-8") : "";
    plan.shots.forEach((_, i) => {
      const file = shotFile(i);
      if (existsSync(join(env.dir, file))) cpSync(join(env.dir, file), join(copy, file));
      else {
        const size = new RegExp(`data-composition-id="shot-0*${i + 1}"[^>]*data-width="(\\d+)"[^>]*data-height="(\\d+)"`).exec(root);
        writeFileSync(join(copy, file), stub(`shot-${String(i + 1).padStart(2, "0")}`, Number(size?.[1] ?? 1080), Number(size?.[2] ?? 1920)));
      }
    });
    const found: Evaluated[] = [];
    try {
      const result = await withProbe(copy, probeConfig(plan, fps), () => env.hyperframes.check(copy, { signal: env.signal }));
      const messages = Object.values(result).flatMap((v) => (v && typeof v === "object" && Array.isArray((v as { findings?: unknown }).findings) ? (v as { findings: HfFinding[] }).findings : [])).map((f) => f.message).filter((m) => m.startsWith(PROBE_PREFIX));
      const data = readProbe(messages);
      if (data) found.push(...probeFindings(data, plan).filter((f) => f.shot === env.index).map((f) => ({ code: f.code, severity: f.severity, message: f.message, hint: f.hint })));
    } catch { /* no probe this time */ }
    if (env.frameDiffs) {
      try {
        const clip = join(copy, "motion.mp4");
        await env.hyperframes.render(copy, { output: clip, quality: "draft", fps, durationSec: env.shot.durationSec, span: { start: env.startSec, end: env.startSec + env.shot.durationSec } }, { signal: env.signal });
        const diffs = await env.frameDiffs(clip);
        if (diffs.length) found.push(...shotMotionFindings(diffs, plan, env.index, fps).map((f) => ({ code: f.code, severity: f.severity, message: f.description, hint: f.suggestedFix })));
      } catch { /* no render this time */ }
    }
    return found;
  } catch {
    return [];
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

/** Holds a draft to Sorot's scene rules and HyperFrames' lint, before it is handed in. */
export async function checkDraft(env: ToolEnv, args: ToolArgs): Promise<ToolOutcome> {
  const html = typeof args.html === "string" ? args.html : "";
  if (!html.trim()) return { result: { error: "html: the draft is empty" } };
  writeDraft(env, html);
  const rules = checkScene(html, env.shot, env.index, env.rules).map(fromIssue);
  const lint = await env.hyperframes.lint(env.dir, { signal: env.signal });
  const mine = shotFile(env.index);
  const own = lint.findings.filter((f) => `${f.file ?? ""} ${f.sourceFile ?? ""} ${f.selector ?? ""}`.includes(mine) || (!f.file && !f.sourceFile)).map(fromLint);
  return { result: { findings: [...rules, ...own, ...(await evaluateDraft(env))] } };
}

/** The tool definitions the model sees (all of them, so the list never changes between turns). */
export const TOOL_DEFS: Record<(typeof TOOL_ORDER)[number], ToolDef> = {
  search_blocks: tool("search_blocks", "Search the HyperFrames registry (blocks and components: charts, maps, 3D, characters, kinetic type, overlays) for something this shot needs.", {
    query: { type: "string", description: `what you are looking for, in a few words (at most ${MAX_QUERY} characters)` },
    type: { type: "string", enum: ["block", "component"], description: "only blocks, or only components" },
    limit: { type: "integer", description: `how many matches, 1 to ${MAX_MATCHES} (default ${DEFAULT_MATCHES})` },
  }, ["query"]),
  use_block: tool("use_block", "Install a registry block or component into this project and read its source, to adapt it to the shot (its size, colours and timing).", {
    name: { type: "string", description: "a name from search_blocks" },
  }),
  look: tool("look", "Render frames of your draft and see them, with how a stranger who doesn't know the plan reads them (what is there, what can't be told apart).", {
    html: { type: "string", description: "the complete draft of compositions/shot-NN.html" },
    times: { type: "array", items: { type: "number" }, description: "1 to 3 moments, in seconds from the start of this shot, spread from early in it to near its end: the stranger reads them as one shot, so the move you drew can show across them" },
  }),
  check: tool("check", "Check your draft against the scene rules and HyperFrames' lint, before you submit it.", {
    html: { type: "string", description: "the complete draft of compositions/shot-NN.html" },
  }),
};

const MIME: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png" };

/** Frames of the project at film times, as data URLs in the order asked (the nearest frame HyperFrames made for each). */
export async function framesAt(hf: Pick<Hyperframes, "snapshot">, dir: string, times: number[], signal?: AbortSignal): Promise<string[]> {
  const shots = await hf.snapshot(dir, { at: times }, { signal });
  const byTime = [...shots.frames].sort((a, b) => a.time - b.time);
  return times.map((t, i) => {
    const frame = byTime.reduce((best, f) => (Math.abs(f.time - t) < Math.abs(best.time - t) ? f : best), byTime[i] ?? byTime[0]!);
    return `data:${MIME[frame.path.split(".").pop()?.toLowerCase() ?? ""] ?? "image/png"};base64,${readFileSync(frame.path).toString("base64")}`;
  });
}

const LOOKED = "looked.json";
const hashOf = (html: string) => createHash("sha1").update(html).digest("hex").slice(0, 16);

/** Remembers that a draft of this shot was looked at, by the hash of the file that was looked at. */
export function markLooked(dir: string, shotId: string, html: string): void {
  const file = join(dir, LOOKED);
  const now = existsSync(file) ? (JSON.parse(readFileSync(file, "utf-8")) as Record<string, string>) : {};
  writeFileSync(file, JSON.stringify({ ...now, [shotId]: hashOf(html) }));
}

/** Was every shot looked at in its own turn, and is each scene file still the one that was looked at? */
export function lookedInLoop(dir: string, plan: Plan, sceneOf: (index: number) => string | null): boolean {
  const file = join(dir, LOOKED);
  if (!existsSync(file)) return false;
  const looked = JSON.parse(readFileSync(file, "utf-8")) as Record<string, string>;
  return plan.shots.every((s, i) => { const html = sceneOf(i); return html !== null && looked[s.id] === hashOf(html); });
}

/** The most seconds of a shot one look takes frames at. */
const MAX_LOOK_TIMES = 3;

/**
 * Renders frames of a draft and returns them with a stranger's read of them: the director sees its own
 * drawing and what a viewer who doesn't know the plan would make of it.
 */
export async function lookAtDraft(env: ToolEnv, read: (images: string[]) => Promise<StrangerRead>, args: ToolArgs): Promise<ToolOutcome> {
  const html = typeof args.html === "string" ? args.html : "";
  if (!html.trim()) return { result: { error: "html: the draft is empty" } };
  const asked = (Array.isArray(args.times) ? args.times : []).filter((t): t is number => typeof t === "number" && Number.isFinite(t)).slice(0, MAX_LOOK_TIMES);
  const last = Math.max(0, env.shot.durationSec - 0.05);
  const inShot = (asked.length ? asked : [env.shot.durationSec / 2]).map((t) => Math.round(Math.min(Math.max(t, 0), last) * 100) / 100).sort((x, y) => x - y);   // the stranger reads them early to late
  writeDraft(env, html);
  const images = await framesAt(env.hyperframes, env.dir, inShot.map((t) => Math.round((env.startSec + t) * 100) / 100), env.signal);
  const { findings, seen } = await read(images);
  markLooked(env.dir, env.shot.id, html);
  return {
    result: { frames: inShot, seen, findings: [...findings.map((f) => ({ code: f.code, severity: f.severity, message: f.description, hint: f.suggestedFix })), ...(await evaluateDraft(env))] },
    images,
  };
}

/** The most one turn may use of each tool (the recipe sets `toolSteps` and `looks`). */
const LIMITS = { search_blocks: 4, use_block: 2, check: 3 };

/**
 * One shot's tools for a turn, or null when the recipe turns the loop off (`toolSteps` 0: one forced
 * call, as before). `look` is added by the caller when a model can see (`looks` > 0).
 */
export function sceneTools(
  env: ToolEnv, opts: { steps: number; looks: number; look?: (env: ToolEnv, args: ToolArgs) => Promise<ToolOutcome> },
): SceneTools | null {
  if (!(opts.steps > 0)) return null;
  const tools: Record<string, SceneTool> = {
    search_blocks: { def: TOOL_DEFS.search_blocks, limit: LIMITS.search_blocks, run: async (a) => searchBlocks(await env.catalog(), a) },
    ...(env.blocksAllowed ? { use_block: { def: TOOL_DEFS.use_block, limit: LIMITS.use_block, run: (a: ToolArgs) => useBlock(env, a) } } : {}),
    ...(opts.look && opts.looks > 0 ? { look: { def: TOOL_DEFS.look, limit: opts.looks, run: (a: ToolArgs) => (opts.look as NonNullable<typeof opts.look>)(env, a) } } : {}),
    check: { def: TOOL_DEFS.check, limit: LIMITS.check, run: (a) => checkDraft(env, a) },
  };
  return { steps: Math.min(16, Math.floor(opts.steps)), tools };
}
