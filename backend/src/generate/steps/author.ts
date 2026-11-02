import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { buildRoot, bundledFontFaces, checkScene, GSAP_FILE, kitLookOf, shotFile, sizeFor, type ComposeInput, type FontFace, type SceneIssue } from "../composer";
import { kitScripts, PART_NAME, requiredParts, type KitManifest } from "../kit";
import { editApplied, markEditApplied, readFix } from "../fixes";
import { saveFindings, type NewFinding } from "../findings";
import { mapPool } from "../../pool";
import { LlmError } from "../../llm";
import { BUNDLED_FONTS } from "../planContext";
import type { Plan, Shot } from "../planSchema";
import { placeLines, readVoice } from "../voice";
import { settingsOf } from "./index";
import { buildTarget, levelOfShot, plannedLevel, readScene, readShotLevels, sceneAssets, sceneRules, type ShotLevels } from "./build";
import { levelBelow, type Level } from "../capabilities";
import { DirectorError, type SceneInput } from "../director";
import { writeKitScene } from "../kitScene";
import { recordAnswer, type Outcome } from "../levels";
import { readImageFailures } from "./images";
import { gainOf, readMusic } from "./music";
import type { RunFn, StepContext } from "./types";

const BLOCK_SNIPPET_CHARS = 6000;
const MUSIC_VOLUME = 0.12;

const KIT_CALL = /SorotKit(?:Runtime\s*\.\s*mount\s*\(\s*|\s*\[\s*)["']([a-z0-9][a-z0-9-]{0,39})["']/g;

/** The kit parts a scene mounts (`SorotKitRuntime.mount("x", ...)` or `SorotKit["x"]`). */
export const partsInScene = (html: string): string[] => [...new Set([...html.matchAll(KIT_CALL)].map((m) => m[1] as string))].sort();

/**
 * The kit parts the plan and the recipe name: `kit:<name>` (or an installed part's own name) in the
 * author step's `require`, and each shot's look.
 */
export function plannedParts(plan: Plan, required: unknown, installed: Set<string>): string[] {
  const plain = Array.isArray(required) ? required.filter((r): r is string => typeof r === "string" && PART_NAME.test(r) && installed.has(r)) : [];
  const named = [...requiredParts(required), ...plain, ...plan.shots.flatMap((s) => (s.look?.parts ?? []).map((p) => p.part))];
  return [...new Set(named)].sort();
}

export interface Prepared {
  blocks: Record<string, string>;
  /** Rewrites the root with these kit parts loaded (copied into assets/kit/); returns their manifests. */
  writeRoot: (parts: string[]) => KitManifest[];
  /** The installed parts the plan and the recipe name, loaded by the root as first written. */
  planned: string[];
}

/** Lays out the version's HyperFrames project: folder, local GSAP, fonts, the owner's files, blocks, the kit parts, and the root composition. */
export async function prepareProject(ctx: StepContext, dir: string, plan: Plan): Promise<Prepared> {
  const { config, project, store } = ctx;
  if (!existsSync(join(dir, "hyperframes.json"))) {
    mkdirSync(dirname(dir), { recursive: true });
    await ctx.hyperframes.init(dir, project.format, { signal: ctx.signal });
  }
  mkdirSync(join(dir, "assets", "fonts"), { recursive: true });
  mkdirSync(join(dir, "compositions"), { recursive: true });

  if (!existsSync(config.gsapFile)) throw new Error(`The GSAP file isn't at ${config.gsapFile}: run bun install, or set GSAP_FILE`);
  cpSync(config.gsapFile, join(dir, GSAP_FILE));

  const assets = store.genAssetsForProject(project.id);
  for (const a of assets) {
    const from = join(config.genDir, project.id, a.path);
    if (existsSync(from)) {
      mkdirSync(dirname(join(dir, a.path)), { recursive: true });
      cpSync(from, join(dir, a.path));
    }
  }

  // Fonts: the bundled files the plan uses, and the owner's uploaded fonts it names.
  const families = plan.look.fonts;
  const bundled = bundledFontFaces(config.generatorDir, families.filter((f) => BUNDLED_FONTS.includes(f)));
  for (const f of bundled) cpSync(join(config.generatorDir, "fonts", f.path.split("/").pop() as string), join(dir, f.path));
  const uploaded: FontFace[] = assets.filter((a) => a.kind === "font").flatMap((a) => {
    const family = a.meta ? (JSON.parse(a.meta) as { family?: string }).family : undefined;
    return family && families.includes(family) ? [{ family, weight: 400, path: a.path }] : [];
  });

  // The plan's own pick wins; else the bed the music step settled on, ducked under the voice when it speaks.
  const bed = readMusic(config, project.id);
  const track = assets.find((a) => a.kind === "music" && a.id === plan.sound.music) ?? (bed ? assets.find((a) => a.id === bed.assetId) : undefined);
  const duck = plan.sound.narration && bed?.duckUnderVoiceDb != null && track?.id === bed.assetId ? gainOf(bed.duckUnderVoiceDb) : 1;
  const planStep = ctx.recipe.steps.find((s) => s.use === "plan");
  const blocksOn = planStep?.with?.blocks !== false && plan.blocks.length > 0;
  if (blocksOn) await ctx.hyperframes.add(dir, plan.blocks, { signal: ctx.signal });
  const blocks: Record<string, string> = {};
  for (const name of blocksOn ? plan.blocks : []) {
    for (const rel of [`compositions/${name}.html`, `compositions/components/${name}.html`]) {
      if (existsSync(join(dir, rel))) blocks[name] = readFileSync(join(dir, rel), "utf-8").slice(0, BLOCK_SNIPPET_CHARS);
    }
  }

  // The recorded voice goes into the project's assets/ and onto its own audio track.
  const recorded = plan.sound.narration ? readVoice(config, project.id) : null;
  const voice = recorded ? placeLines(plan, recorded.lines).flatMap(({ line, start }) => {
    if (!existsSync(line.file)) return [];
    const path = `assets/voice-${line.id}${extname(line.file)}`;
    mkdirSync(join(dir, "assets"), { recursive: true });
    cpSync(line.file, join(dir, path));
    return [{ id: line.id, path, start, duration: line.durationSec }];
  }) : null;

  const size = sizeFor(project.format, ctx.recipe.output);
  const rootInput: ComposeInput = {
    plan, ...size, fonts: [...bundled, ...uploaded], music: track ? { path: track.path, volume: Math.round((config.bgmVolume ?? MUSIC_VOLUME) * duck * 1000) / 1000 } : null, voice,
  };
  const installed = new Set((ctx.kit?.manifests() ?? []).map((m) => m.name));
  const writeRoot = (parts: string[]) => {
    const manifests = ctx.kit && parts.length ? ctx.kit.copyInto(dir, parts) : [];
    writeFileSync(join(dir, "index.html"), buildRoot({ ...rootInput, kit: kitScripts(manifests, kitLookOf(plan), size, ctx.recipe.output.fps) }));
    return manifests;
  };
  const required = ctx.step.use === "author" ? ctx.settings.require : ctx.recipe.steps.find((s) => s.use === "author")?.with?.require;
  const planned = plannedParts(plan, required, installed).filter((n) => installed.has(n));
  writeRoot(planned);
  return { blocks, writeRoot, planned };
}

/** After the scenes are written: the root loads every installed part a scene mounts, and the version records them. */
export function settleKit(ctx: StepContext, dir: string, plan: Plan, prepared: Prepared): string[] {
  const installed = new Set((ctx.kit?.manifests() ?? []).map((m) => m.name));
  const mounted = plan.shots.flatMap((_, i) => partsInScene(readScene(dir, i) ?? ""));
  const used = [...new Set([...prepared.planned, ...mounted])].filter((n) => installed.has(n)).sort();
  const manifests = used.join() === prepared.planned.join() ? null : prepared.writeRoot(used);
  if (ctx.version) {
    const versions = Object.fromEntries((manifests ?? ctx.kit?.manifests().filter((m) => used.includes(m.name)) ?? []).map((m) => [m.name, m.version]));
    ctx.store.updateGenVersion(ctx.version.id, { kit: used.length ? JSON.stringify({ version: KIT_FORMAT, parts: used, partVersions: versions }) : null });
  }
  return used;
}

/** The kit contract the build was written against (contracts/kit.md). */
export const KIT_FORMAT = "1";

/** The checks' leftovers as findings: a plan rule a scene still breaks is must-fix. */
export const sceneFindings = (plan: Plan, shotIndex: number, issues: SceneIssue[]): NewFinding[] =>
  issues.map((i) => ({
    severity: "must-fix", shotId: plan.shots[shotIndex]!.id, code: i.code, description: i.message, suggestedFix: i.hint, state: "open", rule: "plan-lock",
  }));

export interface ShotBuild { html: string; issues: SceneIssue[]; level: Level; findings: NewFinding[] }
type Fix = Array<{ code: string; message: string; hint?: string }>;

/**
 * Builds one shot from `level` down (FR-044): a kit-level answer written by Sorot, or the model's scene
 * with its repair rounds; a level that can't make the shot pass hands it one level down, with a
 * `level_drop` finding. Only a failure at the lowest level fails the build. Every outcome goes into the
 * model's record. `levels` (the version's shotLevels) is kept up to date.
 */
export function shotWriter(ctx: StepContext, dir: string, plan: Plan, blocks: Record<string, string>, levels: ShotLevels) {
  const size = sizeFor(ctx.project.format, ctx.recipe.output);
  const assets = sceneAssets(ctx);
  const rounds = Number((ctx.step.use === "author" ? ctx.settings : settingsOf("author", ctx.recipe.steps.find((s) => s.use === "author")?.with)).repairRounds);
  const kit = ctx.kit?.manifests() ?? [];
  const tally = (level: Level, outcome: Outcome) => recordAnswer(ctx.store, ctx.director.model, level, outcome);
  // a kit-level shot needs parts to build from; without any, compose is the floor
  const kitFloor = !!(ctx.kit && ctx.capabilities?.("kit").kit.length);

  const attempt = async (shot: Shot, i: number, level: Level, fix: Fix | null) => {
    const input: SceneInput = {
      project: ctx.project, step: ctx.step, plan, index: i, ...size, assets, level,
      blocks: shot.visual.block && blocks[shot.visual.block] ? { [shot.visual.block]: blocks[shot.visual.block] as string } : {},
    };
    const rules = sceneRules(ctx, level);
    if (level === "kit") {
      const answer = await ctx.director.kitShot({ ...input, kit, ...(fix ? { findings: fix } : {}) });
      const html = writeKitScene({ plan, index: i, width: size.width, height: size.height, answer, kit });
      return { html, issues: checkScene(html, shot, i, rules), repaired: false };
    }
    let html = fix ? (await ctx.director.repair({ ...input, html: readScene(dir, i) ?? "", findings: fix })).html : await ctx.director.scene(input);
    let issues = checkScene(html, shot, i, rules);
    let repaired = false;
    for (let n = 0; issues.length && n < rounds; n++) {
      html = (await ctx.director.repair({ ...input, html, findings: issues })).html;
      issues = checkScene(html, shot, i, rules);
      repaired = true;
    }
    return { html, issues, repaired };
  };

  return async (shot: Shot, i: number, from: Level, planned: Level, fix: Fix | null): Promise<ShotBuild> => {
    let level = from;
    let html: string | null = null;
    let issues: SceneIssue[] = [];
    const findings: NewFinding[] = [];
    for (;;) {
      let why = "";
      let failure: Error | null = null;
      try {
        const out = await attempt(shot, i, level, fix);
        html = out.html;
        issues = out.issues;
        if (!issues.length) {
          tally(level, out.repaired ? "repaired" : "firstPass");
          break;
        }
        why = issues.map((x) => x.code).join(", ");
      } catch (e) {
        if (!(e instanceof DirectorError)) throw e;
        why = e.message.slice(0, 200);
        failure = e;
      }
      tally(level, "failed");
      const below = levelBelow(level);
      const lower = below === "kit" && !kitFloor ? null : below;
      if (!lower) {
        if (!failure && html !== null && issues.length) break;   // the lowest level's scene stays, with its findings as must-fix
        if (!kitFloor && failure) throw failure;
        throw new Error(`Shot ${shot.id} couldn't be built at any level, not even from kit parts: ${why}`);
      }
      tally(level, "dropped");
      findings.push(levelDrop(shot.id, level, lower, why));
      levels[shot.id] = { planned, built: lower, reason: `${level} didn't pass: ${why}` };
      level = lower;
      fix = null;
    }
    return { html: html as string, issues, level, findings };
  };
}

/** The finding a shot rebuilt one level down leaves behind (should-fix: it still reads, just plainer). */
export const levelDrop = (shotId: string, from: Level, to: Level, why: string, code = "level_drop"): NewFinding => ({
  severity: "should-fix", shotId, code, state: "open", rule: "levels",
  description: `${shotId} was rebuilt at the ${to} level after ${from} didn't pass (${why}).`,
  suggestedFix: "Fine as it is if the shot reads well; a stronger model, or Calibrate, keeps shots at the higher level.",
});

/**
 * Writes the version's project and one scene per shot, shot by shot (a small model only ever holds
 * one shot). A scene that breaks the plan or the determinism rules goes back with its own findings,
 * up to `repairRounds` times; what is still wrong after that stays as a finding.
 */
export const run: RunFn = async (ctx) => {
  const { dir, plan } = buildTarget(ctx);
  const rounds = Number(ctx.settings.repairRounds);
  const prepared = await prepareProject(ctx, dir, plan);
  const { blocks } = prepared;
  const size = sizeFor(ctx.project.format, ctx.recipe.output);
  const assets = sceneAssets(ctx);
  let written = 0;
  const edits = new Map((readFix(dir)?.edits ?? []).map((e) => [e.shotId, e]));

  const levels: ShotLevels = readShotLevels(ctx);
  const build = shotWriter(ctx, dir, plan, blocks, levels);

  const writeShot = async ({ shot, i }: { shot: Plan["shots"][number]; i: number }): Promise<NewFinding[]> => {
    const planned = levels[shot.id]?.planned ?? plannedLevel(ctx, shot);
    let level = levelOfShot(ctx, plan, i, levels);
    let html = readScene(dir, i);
    let issues = html === null ? [] : checkScene(html, shot, i, sceneRules(ctx, level));
    // a fix round: this shot's scene (copied from the version being fixed) changes as the edit says
    const edit = edits.get(shot.id);
    const fixing = html !== null && edit !== undefined && !editApplied(dir, shot.id);
    let extra: NewFinding[] = [];
    if (html === null || issues.length || fixing) {
      // a clean scene from an earlier try of this version is kept; anything else is written afresh
      const fix = fixing && edit ? [{ code: "fix_request", message: edit.instruction }, ...(edit.findings ?? []), ...issues] : null;
      const out = await build(shot, i, level, planned, fix);
      ({ html, issues, level } = out);
      extra = out.findings;
      writeFileSync(join(dir, shotFile(i)), html);
      if (fixing) markEditApplied(dir, shot.id);
    }
    levels[shot.id] = { planned, built: level, ...(levels[shot.id]?.reason && levels[shot.id]?.built === level ? { reason: levels[shot.id]!.reason } : {}) };
    if (ctx.version) ctx.store.updateGenVersion(ctx.version.id, { shotLevels: JSON.stringify(levels) });
    ctx.progress((++written / plan.shots.length) * 100);
    return [...extra, ...sceneFindings(plan, i, issues)];
  };
  // The scenes don't depend on each other, so a few can be written at once (the model is the slow part).
  // A call the LLM drops doesn't stop the others: those shots get one more try, one at a time, once the
  // rest are written (a hosted gateway dropped one long scene call in eight on 2026-11-01).
  const shots = plan.shots.map((shot, i) => ({ shot, i }));
  const firstPass = await mapPool(shots, Math.max(1, Number(ctx.settings.concurrency)), async (s) => {
    try {
      return await writeShot(s);
    } catch (e) {
      // a dropped call or a model that thought past its budget gets one more try; a spent quota won't come back in a minute
      if (e instanceof LlmError && (e.transient || e.budget) && !ctx.signal?.aborted) return null;
      throw e;
    }
  });
  const perShot: NewFinding[][] = [];
  for (const [n, found] of firstPass.entries()) perShot.push(found ?? (await writeShot(shots[n]!)));
  const left: NewFinding[] = perShot.flat();
  // An image that could not be made leaves its shot on the fallback visual: worth a look, not a failure.
  for (const f of readImageFailures(ctx)) {
    left.push({ severity: "polish", shotId: f.shotId, code: "image_fallback", description: `The image for ${f.shotId} could not be made (${f.reason}); the shot uses its fallback visual.`, suggestedFix: "Upload an image for the shot, or try again.", state: "open", rule: "images" });
  }
  settleKit(ctx, dir, plan, prepared);
  saveFindings(dir, "author", left);
  return { status: "done", outputRef: dir };
};
