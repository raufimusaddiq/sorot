import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { HttpError } from "../../http";
import { now } from "../../store";
import { buildTarget } from "./build";
import type { RunFn } from "./types";

/**
 * The finished video the owner takes away: a copy of the version's delivery render, or a fresh render at
 * the recipe's quality. It is refused while TECHNICAL fails (FR-014). The title and description come
 * from the owner (`settings.title` / `settings.description`), else from the director's copy call.
 */
export const run: RunFn = async (ctx) => {
  const { dir, plan } = buildTarget(ctx);
  const version = ctx.version!;
  const technical = ctx.store.genVerdictsForVersion(version.id).find((v) => v.kind === "TECHNICAL");
  if (!technical) throw new HttpError(409, "This build has no TECHNICAL verdict yet");
  if (technical.status === "FAIL") throw new HttpError(409, "TECHNICAL failed: fix the must-fix findings before exporting");

  const path = join(ctx.config.genDir, ctx.project.id, "exports", `${version.id}.mp4`);
  mkdirSync(dirname(path), { recursive: true });
  const copyIt = ctx.settings.mode === "copy" && version.renderKind === "final" && !!version.draftPath && existsSync(version.draftPath);
  if (copyIt) {
    copyFileSync(version.draftPath as string, path);
  } else {
    await ctx.hyperframes.render(dir, {
      output: path, quality: String(ctx.settings.quality), fps: Number(ctx.settings.fps ?? ctx.recipe.output.fps), durationSec: plan.totalSec,
      workers: Number(ctx.settings.workers ?? 2), gpu: ctx.config.whisperDevice !== "cpu",
    }, { signal: ctx.signal, onProgress: (p) => ctx.progress(p, "export") });
  }
  if (!existsSync(path) || statSync(path).size === 0) throw new Error("The export finished but left no video");

  const text = (key: string) => (typeof ctx.settings[key] === "string" ? (ctx.settings[key] as string).trim() : "");
  const written = text("title") && text("description") ? null : await ctx.director.copy({ project: ctx.project, step: ctx.step, plan }).catch(() => null);
  const row = ctx.store.getGenExportForVersion(version.id);
  const exported = {
    id: row?.id ?? crypto.randomUUID(), projectId: ctx.project.id, versionId: version.id, path, format: ctx.project.format, durationSec: plan.totalSec,
    title: text("title") || written?.title || plan.title, description: text("description") || written?.description || plan.message, createdAt: row?.createdAt ?? now(),
  };
  ctx.store.saveGenExport(exported);
  return { status: "done", outputRef: exported.id };
};
