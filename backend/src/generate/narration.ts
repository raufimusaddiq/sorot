import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AppConfig } from "../config";
import type { ScriptRunner } from "../runner";

// Narration: text to a voiceover file through the one voice engine set up in Settings. The three
// APIs differ only in their request shapes; `local` runs ai-pipeline/tts.py and exists on GPU
// installs only. Results are cached by hash(script, engine, voice, model), so rebuilding a video
// never pays for the same speech twice.

export const VOICE_ENGINES = ["elevenlabs", "fish", "openai", "local"] as const;
export type VoiceEngine = (typeof VOICE_ENGINES)[number];

export interface SpokenWord { text: string; start: number; end: number }

export interface Speech {
  path: string;
  engine: string;
  /** Word timings, when the engine gives them (ElevenLabs); otherwise the align step finds them. */
  words: SpokenWord[] | null;
  cached: boolean;
}

/** The engine can't speak right now but nothing is wrong with the request (a spent balance). */
export class VoiceUnavailable extends Error {}
export class VoiceError extends Error {}

const DEFAULT_BASE: Record<string, string> = { elevenlabs: "https://api.elevenlabs.io", fish: "https://api.fish.audio", openai: "https://api.openai.com/v1" };
const DEFAULT_MODEL: Record<string, string> = { elevenlabs: "eleven_multilingual_v2", fish: "s1", openai: "tts-1" };

const hashOf = (parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24);

/** ElevenLabs gives a time per character: words are the runs between spaces. */
export function wordsFromCharacters(chars: string[], starts: number[], ends: number[]): SpokenWord[] {
  const words: SpokenWord[] = [];
  let text = "";
  let start = 0;
  let end = 0;
  const flush = () => {
    if (text) words.push({ text, start, end });
    text = "";
  };
  chars.forEach((c, i) => {
    if (/\s/.test(c)) return flush();
    if (!text) start = starts[i] ?? end;
    text += c;
    end = ends[i] ?? end;
  });
  flush();
  return words;
}

export class Narrator {
  constructor(
    private readonly config: AppConfig,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly runScript?: ScriptRunner,
  ) {}

  /** Engines that are set up: the one chosen in Settings, when it has what it needs. */
  get engines(): string[] {
    const c = this.config;
    if (!c.voiceEnabled || !c.voiceEngine) return [];
    if (c.voiceEngine === "local") return c.whisperDevice === "cpu" || !this.runScript ? [] : ["local"];
    return c.voiceApiKey || c.voiceBaseUrl ? [c.voiceEngine] : [];
  }

  voiceFor(language: string, override?: string): string {
    return override?.trim() || this.config.voiceVoices[language] || this.config.voiceVoices.default || "";
  }

  /**
   * Speaks `text` into `dir`. Throws VoiceUnavailable for a spent balance (the step decides whether
   * that stops the run) and VoiceError for anything else.
   */
  async speak(input: { text: string; language: string; dir: string; voice?: string; speed?: number; signal?: AbortSignal; onProgress?: (p: number) => void }): Promise<Speech> {
    const c = this.config;
    const engine = c.voiceEngine;
    if (!this.engines.includes(engine)) throw new VoiceError("No voice engine is set up: add one in Settings");
    const voice = this.voiceFor(input.language, input.voice);
    const model = c.voiceModel || DEFAULT_MODEL[engine] || "";
    const key = hashOf([input.text, engine, voice, model, input.speed ?? 1]);
    const path = join(input.dir, `${key}.${engine === "local" ? "wav" : "mp3"}`);
    const wordsPath = `${path}.words.json`;
    if (existsSync(path) && statSync(path).size > 0) {
      let words: SpokenWord[] | null = null;
      try {
        words = existsSync(wordsPath) ? (JSON.parse(readFileSync(wordsPath, "utf-8")) as SpokenWord[]) : null;
      } catch { /* unreadable → the align step finds them */ }
      return { path, engine, words, cached: true };
    }
    mkdirSync(dirname(path), { recursive: true });

    let words: SpokenWord[] | null = null;
    if (engine === "local") {
      const r = await (this.runScript as ScriptRunner)("tts.py", ["--text", input.text, "--language", input.language, "--output", path, ...(voice ? ["--voice", voice] : [])], {
        signal: input.signal, onProgress: input.onProgress,
      });
      if (r.success === false) throw new VoiceError(String(r.error ?? "the local voice failed"));
    } else {
      const { bytes, timings } = await this.remote(engine, { text: input.text, voice, model, speed: input.speed, signal: input.signal });
      writeFileSync(path, bytes);
      words = timings;
    }
    if (!existsSync(path) || statSync(path).size === 0) throw new VoiceError("The voice engine returned no audio");
    if (words) writeFileSync(wordsPath, JSON.stringify(words));
    return { path, engine, words, cached: false };
  }

  private async remote(engine: string, o: { text: string; voice: string; model: string; speed?: number; signal?: AbortSignal }): Promise<{ bytes: Uint8Array; timings: SpokenWord[] | null }> {
    const c = this.config;
    const base = (c.voiceBaseUrl || DEFAULT_BASE[engine] || "").replace(/\/+$/, "");
    if (!o.voice && engine !== "fish") throw new VoiceError("Set a voice id for this language in Settings");   // Fish speaks with its default voice without one
    let url: string;
    let headers: Record<string, string>;
    let body: Record<string, unknown>;
    if (engine === "elevenlabs") {
      url = `${base}/v1/text-to-speech/${encodeURIComponent(o.voice)}/with-timestamps`;
      headers = { "xi-api-key": c.voiceApiKey, "Content-Type": "application/json" };
      body = { text: o.text, model_id: o.model, ...(o.speed ? { voice_settings: { speed: o.speed } } : {}) };
    } else if (engine === "fish") {
      url = `${base}/v1/tts`;
      headers = { Authorization: `Bearer ${c.voiceApiKey}`, "Content-Type": "application/json", model: o.model };   // Fish takes the model as a header
      body = { text: o.text, ...(o.voice ? { reference_id: o.voice } : {}), format: "mp3", ...(o.speed ? { prosody: { speed: o.speed } } : {}) };
    } else {
      url = `${base}/audio/speech`;
      headers = { Authorization: `Bearer ${c.voiceApiKey}`, "Content-Type": "application/json" };
      body = { model: o.model, input: o.text, voice: o.voice, response_format: "mp3", ...(o.speed ? { speed: o.speed } : {}) };
    }
    let res: Response;
    try {
      res = await this.fetchFn(url, { method: "POST", headers, body: JSON.stringify(body), signal: o.signal });
    } catch (e) {
      if (o.signal?.aborted) throw e;
      throw new VoiceError(`The ${engine} voice can't be reached: ${(e as Error).message}`);
    }
    if (res.status === 402) throw new VoiceUnavailable(`The ${engine} account has no balance left`);
    if (!res.ok) throw new VoiceError(`${engine} voice HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    if (engine === "elevenlabs") {
      const j = (await res.json()) as { audio_base64?: string; alignment?: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] } };
      if (!j.audio_base64) throw new VoiceError("ElevenLabs returned no audio");
      const a = j.alignment;
      return { bytes: new Uint8Array(Buffer.from(j.audio_base64, "base64")), timings: a ? wordsFromCharacters(a.characters, a.character_start_times_seconds, a.character_end_times_seconds) : null };
    }
    return { bytes: new Uint8Array(await res.arrayBuffer()), timings: null };
  }

  /** A short real call, for the Settings "test" button. */
  async ping(dir: string): Promise<string> {
    const s = await this.speak({ text: "Tes suara.", language: "id", dir });
    return `${s.engine} spoke ${s.cached ? "(cached)" : "a test line"}`;
  }
}
