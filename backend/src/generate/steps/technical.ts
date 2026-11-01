import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { now } from "../../store";
import { isCreative, readFindings, saveFindings, type NewFinding } from "../findings";
import {
  audioFindings, outputFindings, parseProbe, parseVolume, planHasSound, readabilityFindings, speechFindings, verdictOf, voiceRouteFindings, type HeardWord, type Probe, type SpokenLine, type Volume,
} from "../technical";
import { sizeFor } from "../composer";
import { placeLines, readVoice } from "../voice";
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

/** The words Whisper hears in the rendered film (mono 16 kHz, on this machine). */
async function listen(ctx: StepContext, file: string, dir: string): Promise<HeardWord[]> {
  mkdirSync(join(dir, "checks"), { recursive: true });
  const wav = join(dir, "checks", "speech.wav");
  const res = await ctx.exec(ctx.config.ffmpegPath, ["-y", "-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", "16000", wav], { signal: ctx.signal, timeoutMs: 120_000 });
  if (res.exitCode !== 0) return [];
  const result = await (ctx.runScript as NonNullable<StepContext["runScript"]>)("transcribe.py", [
    "--audio", wav, "--language", ctx.project.language, "--model", ctx.config.whisperModel, "--device", ctx.config.whisperDevice,
  ], { signal: ctx.signal, timeoutMinutes: 10 });
  const segments = (Array.isArray(result.segments) ? result.segments : []) as Array<{ words?: HeardWord[] }>;
  return segments.flatMap((s) => (s.words ?? []).map((w) => ({ text: w.text, start: w.start, end: w.end })));
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

  // The voice: it is where the script placed it, and the captions follow it.
  const flag = (v: unknown) => v === true || (typeof v === "object" && v !== null);
  const voice = plan.sound.narration ? readVoice(ctx.config, ctx.project.id) : null;
  const placed = voice ? placeLines(plan, voice.lines) : [];
  if (voice && rendered && flag(measures.voiceRoute)) own.push(...voiceRouteFindings(placed.map((p) => ({ id: p.line.id, start: p.start, durationSec: p.line.durationSec })), plan.totalSec));
  if (voice && rendered && flag(measures.speechMatch) && ctx.runScript && media?.streams.some((s) => s.codec_type === "audio")) {
    const sp = obj(measures.speechMatch);
    const heard = await listen(ctx, file as string, dir);
    const lines: SpokenLine[] = placed.map((p) => ({
      id: p.line.id, text: p.line.text, start: p.start, durationSec: p.line.durationSec, firstWordAt: p.line.words?.[0] ? p.start + p.line.words[0].start : null,
    }));
    own.push(...speechFindings(lines, heard, num(sp.maxWordErrorRate, 0.25)));
  }

  saveFindings(dir, "technical", own);
  // the creative judge's findings belong to the other verdict
  const all = readFindings(dir).filter((f) => !isCreative(f));
  const status = verdictOf(all);
  ctx.store.saveGenVerdict({
    id: crypto.randomUUID(), versionId: version.id, kind: "TECHNICAL", status, findings: JSON.stringify(all), judgedBy: "code",
    inputs: JSON.stringify({
      render: { kind: version.renderKind, path: file }, sources: [...new Set(all.map((f) => f.source))], shots: plan.shots.length,
      measures: ["output", "planText", "layout", "readability", "firstFrame", ...(planHasSound(plan) ? ["audio"] : []), ...(voice && flag(measures.voiceRoute) ? ["voiceRoute"] : []), ...(voice && flag(measures.speechMatch) ? ["speechMatch"] : [])],
    }),
    createdAt: now(),
  });
  return { status: "done", outputRef: status };
};
