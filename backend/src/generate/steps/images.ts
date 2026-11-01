import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { now } from "../../store";
import { Assets } from "../assets";
import { ImageClient } from "../images";
import type { Plan } from "../planSchema";
import type { RunFn, StepContext } from "./types";

/** What the author step reads: the shots whose image could not be made, drawn from their fallback instead. */
export interface ImageFailure { shotId: string; reason: string }

export const imagesFile = (genDir: string, projectId: string) => join(genDir, projectId, "images.json");

export const inputKey = (ctx: StepContext) => `${ctx.project.currentPlanId ?? ""}|${JSON.stringify([ctx.settings.style, ctx.settings.size])}`;

/**
 * Makes the images the plan asks for (`visual.generatedImage`), once per prompt. An image the owner
 * uploaded for a shot wins; one that can't be made leaves the shot on its fallback visual.
 */
export const run: RunFn = async (ctx) => {
  const { project, store, config } = ctx;
  const row = project.currentPlanId ? store.getGenPlan(project.currentPlanId) : null;
  const plan = row ? (JSON.parse(row.plan) as Plan) : null;
  const wanted = (plan?.shots ?? []).filter((s) => s.visual.generatedImage);
  const failures: ImageFailure[] = [];
  const client = ctx.images ?? new ImageClient(config);
  const assets = new Assets(config, store);
  mkdirSync(join(config.genDir, project.id), { recursive: true });
  if (!wanted.length) {
    writeFileSync(imagesFile(config.genDir, project.id), "[]");
    return { status: "skipped", reason: "no shot asks for a generated image" };
  }

  let made = 0;
  for (const [i, shot] of wanted.entries()) {
    const ask = shot.visual.generatedImage as { prompt: string; style?: string };
    const style = ask.style || String(ctx.settings.style || config.imageStyle || "");
    const size = String(ctx.settings.size || config.imageSize);
    const hash = createHash("sha256").update(JSON.stringify([ask.prompt, style, size, config.imageModel])).digest("hex").slice(0, 16);
    const mine = store.genAssetsForProject(project.id).filter((a) => a.kind === "image" && a.shotId === shot.id);
    if (mine.some((a) => a.origin === "upload")) continue;
    if (mine.some((a) => a.origin === "generated" && a.promptHash === hash && existsSync(join(config.genDir, project.id, a.path)))) continue;
    for (const old of mine) assets.remove(old.id);
    try {
      const bytes = await client.generate({ prompt: ask.prompt, style, size, signal: ctx.signal });
      const path = `assets/gen-${shot.id}-${hash.slice(0, 8)}.png`;
      const abs = join(config.genDir, project.id, path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, bytes);
      store.saveGenAsset({ id: crypto.randomUUID(), projectId: project.id, kind: "image", origin: "generated", path, shotId: shot.id, promptHash: hash, meta: null, createdAt: now() });
      made++;
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      failures.push({ shotId: shot.id, reason: (e as Error).message });
    }
    ctx.progress(((i + 1) / wanted.length) * 100, "images");
  }
  writeFileSync(imagesFile(config.genDir, project.id), JSON.stringify(failures));
  return { status: "done", outputRef: `${made} new`, ...(failures.length ? { reason: `${failures.length} shot${failures.length > 1 ? "s" : ""} use the fallback visual` } : {}) };
};

/** The failures the last images step left (none when it never ran). */
export function readImageFailures(ctx: StepContext): ImageFailure[] {
  const path = imagesFile(ctx.config.genDir, ctx.project.id);
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as ImageFailure[]) : [];
  } catch {
    return [];
  }
}
