import { Narrator, VoiceUnavailable } from "../narration";
import { audioSeconds, voiceDir, writeVoice, type VoiceLine } from "../voice";
import { scriptLines, writeScript } from "./script";
import { settingsOf } from "./index";
import type { RunFn, StepContext } from "./types";

/** The same script, voice and engine speak the same way: speech is cached, so this only re-runs when one of them changes. */
export const inputKey = (ctx: StepContext) =>
  JSON.stringify([ctx.project.narrationScript, ctx.config.voiceEngine, ctx.config.voiceModel, ctx.settings.voice ?? ctx.config.voiceVoices[ctx.project.language] ?? "", ctx.settings.speed]);

/**
 * Speaks every line of the script with the engine set up in Settings. When the engine can't speak
 * (no account balance, no engine) the step fails if `failClosed`, else the video goes on without
 * narration.
 */
export const run: RunFn = async (ctx) => {
  const { project, settings } = ctx;
  if (project.narration !== 1) return { status: "skipped", reason: "narration is off for this video" };
  const lines = scriptLines(project.narrationScript);
  if (!lines.length) throw new Error("There is no script to speak: the script step has to run first");
  const narrator = ctx.narrator ?? new Narrator(ctx.config, undefined, ctx.runScript);
  const failClosed = settings.failClosed !== false;
  const stop = (reason: string) => {
    if (failClosed) throw new Error(reason);
    ctx.store.updateGenProject(project.id, { narration: 0 });
    return { status: "skipped" as const, reason: `${reason}; the video goes on without narration` };
  };
  if (!narrator.engines.length) return stop("No voice engine is set up in Settings");

  // How long the speech takes against the film: a real voice speaks at its own pace, so this is measured, not guessed.
  const GAP = 0.15, SLACK = 0.5;
  const speechSec = (spoken: VoiceLine[]) => Math.round((spoken.reduce((n, l) => n + l.durationSec, 0) + GAP * Math.max(0, spoken.length - 1)) * 10) / 10;
  let spoken: VoiceLine[] = [];
  const speakAll = async (script: Array<{ id: string; text: string }>) => {
    spoken = [];
    for (const [i, line] of script.entries()) {
      const speech = await narrator.speak({
        text: line.text, language: project.language, dir: voiceDir(ctx.config, project.id), speed: Number(settings.speed) || 1,
        ...(typeof settings.voice === "string" && settings.voice ? { voice: settings.voice } : {}), signal: ctx.signal,
      });
      spoken.push({ id: line.id, text: line.text, file: speech.path, durationSec: await audioSeconds(ctx.exec, ctx.config.ffmpegPath, speech.path, ctx.signal), words: speech.words });
      ctx.progress(((i + 1) / script.length) * 100, "voice");
    }
  };
  try {
    await speakAll(lines);
    // Past the film: the director writes the script again once, told how long it took to speak (the voice is cheap to run again).
    const scriptStep = ctx.recipe.steps.find((s) => s.use === "script");
    if (scriptStep && speechSec(spoken) > project.targetSec + SLACK) {
      const words = lines.reduce((n, l) => n + l.text.split(/\s+/).length, 0);
      const shorter = await writeScript(ctx, scriptStep, settingsOf("script", scriptStep.with), { spokenSec: speechSec(spoken), filmSec: project.targetSec, words });
      await speakAll(shorter);
    }
    if (speechSec(spoken) > project.targetSec + SLACK) throw new Error(`The voice takes ${speechSec(spoken)} s and the video is ${project.targetSec} s: shorten the script (sorot gen revise) or make the video longer`);
  } catch (e) {
    if (e instanceof VoiceUnavailable) return stop(e.message);
    throw e;
  }
  writeVoice(ctx.config, project.id, {
    engine: ctx.config.voiceEngine, voice: narrator.voiceFor(project.language, typeof settings.voice === "string" ? settings.voice : undefined),
    lines: spoken, aligned: spoken.every((l) => l.words) ? "engine" : null,
  });
  return { status: "done", outputRef: "voice" };
};
