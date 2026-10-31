import { existsSync } from "node:fs";
import { now } from "../../store";
import { readFindings, saveFindings, type NewFinding } from "../findings";
import {
  audioFindings, outputFindings, parseProbe, parseVolume, planHasSound, readabilityFindings, verdictOf, type Probe, type Volume,
} from "../technical";
import { sizeFor } from "../composer";
import { buildTarget } from "./build";
import type { RunFn, StepContext } from "./types";

// The TECHNICAL verdict: the measures run on the rendered video and the plan, plus what the build
// steps found (author, check). Every number comes from the recipe; the always-on measures can be
// tuned but not switched off (the recipe validator enforces that).

/** ffprobe sits next to ffmpeg. */
const probeBinary = (ffmpegPath: string) => ffmpegPath.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");

const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

async function probe(ctx: StepContext, file: string): Promise<Probe | null> {
  const res = await ctx.exec(probeBinary(ctx.config.ffmpegPath), ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file], { signal: ctx.signal, timeoutMs: 60_000 });
  return res.exitCode === 0 ? parseProbe(res.stdout) : null;
}

async function volume(ctx: StepContext, file: string): Promise<Volume | null> {
  const res = await ctx.exec(ctx.config.ffmpegPath, ["-v", "info", "-i", file, "-vn", "-af", "volumedetect", "-f", "null", "-"], { signal: ctx.signal, timeoutMs: 120_000 });
  return res.exitCode === 0 ? parseVolume(res.stderr) : null;
}

export const run: RunFn = async (ctx) => {
  const { dir, plan } = buildTarget(ctx);
  const version = ctx.version!;
  const measures = obj(ctx.settings.measures);
  const rules = obj(ctx.recipe.rules);
  const readability = obj(rules.readability);
  const output = obj(measures.output);
  const audio = obj(measures.audio);
  const own: NewFinding[] = [];

  const file = version.draftPath;
  const rendered = !!file && existsSync(file);
  const media = rendered ? await probe(ctx, file as string) : null;
  const size = sizeFor(ctx.project.format, ctx.recipe.output);
  if (!rendered) {
    own.push({ severity: "must-fix", shotId: null, code: "output_unplayable", description: "No video was rendered, so there is nothing to judge.", state: "open", rule: "technical" });
  } else {
    own.push(...outputFindings(media, {
      ...size, fps: Number(ctx.settings.fps ?? ctx.recipe.output.fps), durationSec: plan.totalSec, minSec: ctx.recipe.output.minSec, maxSec: ctx.recipe.output.maxSec,
    }, { fpsTolerance: num(output.fpsTolerance, 0.5), lengthToleranceSec: num(output.lengthToleranceSec, 0.1) }));
  }

  own.push(...readabilityFindings(plan, { holdBaseSec: num(readability.holdBaseSec, 0.5), holdPerWordSec: num(readability.holdPerWordSec, 0.25) }));
  if (planHasSound(plan) && media) {
    const level = media.streams.some((s) => s.codec_type === "audio") ? await volume(ctx, file as string) : null;
    own.push(...audioFindings(media, level, { minMeanVolumeDb: num(audio.minMeanVolumeDb, -40), maxTruePeakDb: num(audio.maxTruePeakDb, -1) }));
  }

  saveFindings(dir, "technical", own);
  // the creative judge's findings belong to the other verdict
  const all = readFindings(dir).filter((f) => f.source !== "creative");
  const status = verdictOf(all);
  ctx.store.saveGenVerdict({
    id: crypto.randomUUID(), versionId: version.id, kind: "TECHNICAL", status, findings: JSON.stringify(all), judgedBy: "code",
    inputs: JSON.stringify({
      render: { kind: version.renderKind, path: file }, sources: [...new Set(all.map((f) => f.source))], shots: plan.shots.length,
      measures: ["output", "planText", "layout", "readability", "firstFrame", ...(planHasSound(plan) ? ["audio"] : [])],
    }),
    createdAt: now(),
  });
  return { status: "done", outputRef: status };
};
