import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildTarget } from "./build";
import type { RunFn } from "./types";

/**
 * Renders the version's HyperFrames project to the video the verdicts judge. `draft` is the quick
 * preview; `delivery` is the final quality, so the export can copy it (render_kind `final`). The
 * GPU encoder is used when the install has a GPU.
 */
export const run: RunFn = async (ctx) => {
  const { dir, plan } = buildTarget(ctx);
  const version = ctx.version!;
  const quality = String(ctx.settings.quality);
  const fps = Number(ctx.settings.fps ?? ctx.recipe.output.fps);
  const output = join(dir, quality === "delivery" ? "final.mp4" : "draft.mp4");

  await ctx.hyperframes.render(dir, {
    output, quality, fps, durationSec: plan.totalSec, workers: Number(ctx.settings.workers), gpu: ctx.config.whisperDevice !== "cpu",
  }, { signal: ctx.signal, onProgress: (p) => ctx.progress(p, "render") });

  if (!existsSync(output) || statSync(output).size === 0) throw new Error("The render finished but left no video");
  ctx.store.updateGenVersion(version.id, {
    renderKind: quality === "delivery" ? "final" : "draft", draftPath: output, hyperframesVersion: ctx.hyperframes.version,
  });
  return { status: "done", outputRef: output };
};
