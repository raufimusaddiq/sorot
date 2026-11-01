import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { buildRoot, bundledFontFaces, checkScene, GSAP_FILE, shotFile, sizeFor, type FontFace, type SceneIssue } from "../composer";
import { editApplied, markEditApplied, readFix } from "../fixes";
import { saveFindings, type NewFinding } from "../findings";
import { mapPool } from "../../pool";
import { LlmError } from "../../llm";
import { BUNDLED_FONTS } from "../planContext";
import type { Plan } from "../planSchema";
import { placeLines, readVoice } from "../voice";
import { buildTarget, readScene, sceneAssets } from "./build";
import { readImageFailures } from "./images";
import { gainOf, readMusic } from "./music";
import type { RunFn, StepContext } from "./types";

const BLOCK_SNIPPET_CHARS = 6000;
const MUSIC_VOLUME = 0.12;

/** Lays out the version's HyperFrames project: folder, local GSAP, fonts, the owner's files, blocks, and the root composition. */
export async function prepareProject(ctx: StepContext, dir: string, plan: Plan): Promise<{ blocks: Record<string, string> }> {
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
  writeFileSync(join(dir, "index.html"), buildRoot({
    plan, ...size, fonts: [...bundled, ...uploaded], music: track ? { path: track.path, volume: Math.round((config.bgmVolume ?? MUSIC_VOLUME) * duck * 1000) / 1000 } : null, voice,
  }));
  return { blocks };
}

/** The checks' leftovers as findings: a plan rule a scene still breaks is must-fix. */
export const sceneFindings = (plan: Plan, shotIndex: number, issues: SceneIssue[]): NewFinding[] =>
  issues.map((i) => ({
    severity: "must-fix", shotId: plan.shots[shotIndex]!.id, code: i.code, description: i.message, suggestedFix: i.hint, state: "open", rule: "plan-lock",
  }));

/**
 * Writes the version's project and one scene per shot, shot by shot (a small model only ever holds
 * one shot). A scene that breaks the plan or the determinism rules goes back with its own findings,
 * up to `repairRounds` times; what is still wrong after that stays as a finding.
 */
export const run: RunFn = async (ctx) => {
  const { dir, plan } = buildTarget(ctx);
  const rounds = Number(ctx.settings.repairRounds);
  const { blocks } = await prepareProject(ctx, dir, plan);
  const size = sizeFor(ctx.project.format, ctx.recipe.output);
  const assets = sceneAssets(ctx);
  let written = 0;
  const edits = new Map((readFix(dir)?.edits ?? []).map((e) => [e.shotId, e]));

  const writeShot = async ({ shot, i }: { shot: Plan["shots"][number]; i: number }): Promise<NewFinding[]> => {
    const input = {
      project: ctx.project, step: ctx.step, plan, index: i, ...size, assets,
      blocks: shot.visual.block && blocks[shot.visual.block] ? { [shot.visual.block]: blocks[shot.visual.block] as string } : {},
    };
    let html = readScene(dir, i);
    let issues = html === null ? [] : checkScene(html, shot, i, { assets });
    // a fix round: this shot's scene (copied from the version being fixed) changes as the edit says
    const edit = edits.get(shot.id);
    const fixing = html !== null && edit !== undefined && !editApplied(dir, shot.id);
    if (html === null || issues.length || fixing) {
      // a clean scene from an earlier try of this version is kept; anything else is written afresh
      if (fixing && edit) {
        html = (await ctx.director.repair({
          ...input, html: html as string, findings: [{ code: "fix_request", message: edit.instruction }, ...(edit.findings ?? []), ...issues],
        })).html;
      } else html = await ctx.director.scene(input);
      issues = checkScene(html, shot, i, { assets });
      for (let n = 0; issues.length && n < rounds; n++) {
        html = (await ctx.director.repair({ ...input, html, findings: issues })).html;
        issues = checkScene(html, shot, i, { assets });
      }
      writeFileSync(join(dir, shotFile(i)), html);
      if (fixing) markEditApplied(dir, shot.id);
    }
    ctx.progress((++written / plan.shots.length) * 100);
    return sceneFindings(plan, i, issues);
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
  saveFindings(dir, "author", left);
  return { status: "done", outputRef: dir };
};
