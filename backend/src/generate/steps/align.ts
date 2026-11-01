import { alignWords, readVoice, wordsOf, writeVoice, type VoiceLine } from "../voice";
import type { SpokenWord } from "../narration";
import type { RunFn, StepContext } from "./types";

export const inputKey = (ctx: StepContext) => String(ctx.project.narrationScript ?? "") + String(ctx.settings.source);

/** The words Whisper heard in one line's audio, with their times inside the line. */
async function hear(ctx: StepContext, line: VoiceLine, index: number): Promise<SpokenWord[]> {
  if (!ctx.runScript) throw new Error("Whisper isn't available to time the voice");
  const result = await ctx.runScript("transcribe.py", [
    "--audio", line.file, "--language", ctx.project.language, "--model", String(ctx.settings.model || ctx.config.whisperModel), "--device", ctx.config.whisperDevice,
  ], { signal: ctx.signal, timeoutMinutes: 10 });
  const segments = (Array.isArray(result.segments) ? result.segments : []) as Array<{ words?: Array<{ text: string; start: number; end: number }> }>;
  ctx.progress((index + 1) * 10);
  return segments.flatMap((s) => (s.words ?? []).map((w) => ({ text: w.text, start: w.start, end: w.end })));
}

/**
 * When every word is spoken. `engine` keeps the engine's own times (ElevenLabs gives them), `whisper`
 * listens to each line with Whisper and maps its words onto the script's, `auto` uses the engine's
 * times when all lines have them and Whisper otherwise.
 */
export const run: RunFn = async (ctx) => {
  const voice = readVoice(ctx.config, ctx.project.id);
  if (!voice) return { status: "skipped", reason: "there is no voiceover to time" };
  const source = String(ctx.settings.source);
  const engineHasAll = voice.lines.every((l) => l.words?.length);
  if (source === "engine" && !engineHasAll) throw new Error("This voice engine doesn't give word times: use source auto or whisper");
  if (source === "engine" || (source === "auto" && engineHasAll)) {
    writeVoice(ctx.config, ctx.project.id, { ...voice, aligned: "engine" });
    return { status: "done", outputRef: "engine" };
  }
  const lines: VoiceLine[] = [];
  for (const [i, line] of voice.lines.entries()) {
    lines.push({ ...line, words: alignWords(wordsOf(line.text), await hear(ctx, line, i)) });
  }
  writeVoice(ctx.config, ctx.project.id, { ...voice, lines, aligned: "whisper" });
  return { status: "done", outputRef: "whisper" };
};
