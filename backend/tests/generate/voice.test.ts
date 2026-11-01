import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/config";
import { Narrator, VoiceError, VoiceUnavailable, wordsFromCharacters } from "../../src/generate/narration";
import { makeEnv, type TestEnv } from "../helpers";

let env: TestEnv;
let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "vc-voice-")); });
afterEach(() => { env?.cleanup(); rmSync(tmp, { recursive: true, force: true }); });

const put = (kind: string, body: unknown) => env.json("PUT", `/api/settings/${kind}`, body);

// ---- settings -----------------------------------------------------------------------

describe("voice, image and commands settings", () => {
  test("voice: engine, voices per language, masked key; it is active only when its engine has what it needs", async () => {
    env = makeEnv();
    expect((await env.json("GET", "/api/settings")).body.data.voice).toMatchObject({ active: false, engine: "", voices: {}, localAvailable: true, engines: ["elevenlabs", "fish", "openai", "local"] });
    const saved = await put("voice", { engine: "elevenlabs", apiKey: "xi_secret_1234", voices: { id: "voice-id", en: " voice-en " } });
    expect(saved.body.data.voice).toMatchObject({ active: true, engine: "elevenlabs", apiKeySet: true, apiKey: "••••1234", voices: { id: "voice-id", en: "voice-en" } });
    expect(JSON.stringify(saved.body)).not.toContain("xi_secret");
    expect((await put("voice", { enabled: false })).body.data.voice.active).toBeFalse();
  });

  test.each([
    [{ engine: "siri" }, 400, "one of elevenlabs"],
    [{ voices: ["x"] }, 400, "map a language"],
    [{ voices: { "Indonesian!": "x" } }, 400, "use {"],
    [{ voices: { id: "x".repeat(121) } }, 400, "use {"],
    [{ apiKey: "has space" }, 400, "spaces"],
    [{ speed: 1 }, 400, "no setting"],
  ])("voice %j is refused", async (patch, status, message) => {
    env = makeEnv();
    const r = await put("voice", patch);
    expect([r.status, r.body.error]).toEqual([status, expect.stringContaining(message)]);
  });

  test("the local voice needs a GPU install", async () => {
    env = makeEnv({ whisperDevice: "cpu" });
    const r = await put("voice", { engine: "local" });
    expect([r.status, r.body.error]).toEqual([409, "the local voice needs a GPU install"]);
    expect((await env.json("GET", "/api/settings")).body.data.voice.localAvailable).toBeFalse();
    env.cleanup();
    env = makeEnv({ whisperDevice: "cuda" });
    expect((await put("voice", { engine: "local" })).status).toBe(200);
  });

  test("test voice: not configured, then a real (cached) test line through the engine", async () => {
    env = makeEnv({ dataDir: tmp });
    expect((await env.json("POST", "/api/settings/voice/test")).body.data).toMatchObject({ ok: false, error: expect.stringContaining("Not configured") });
    await put("voice", { engine: "openai", apiKey: "sk-test", voices: { default: "alloy" } });
    env.fetchHandler.fn = async () => new Response(new Uint8Array([1, 2, 3]));
    expect((await env.json("POST", "/api/settings/voice/test")).body.data).toMatchObject({ ok: true, detail: expect.stringContaining("openai spoke a test line") });
    expect((await env.json("POST", "/api/settings/voice/test")).body.data.detail).toContain("(cached)");
    env.fetchHandler.fn = async () => new Response("no", { status: 500 });
    await put("voice", { voices: { default: "alloy2" } });
    expect((await env.json("POST", "/api/settings/voice/test")).body.data).toMatchObject({ ok: false, error: expect.stringContaining("HTTP 500") });
  });

  test("image: a connection of its own; the test reports what is missing", async () => {
    env = makeEnv();
    expect((await env.json("POST", "/api/settings/image/test")).body.data.error).toContain("a base URL, a model, an API key");
    const saved = await put("image", { baseUrl: "http://img/v1", model: "flux", apiKey: "img-key-9999", size: "1024x1792", style: "flat" });
    expect(saved.body.data.image).toMatchObject({ active: true, model: "flux", apiKey: "••••9999", size: "1024x1792" });
    expect((await env.json("POST", "/api/settings/image/test")).body.data).toMatchObject({ ok: true, model: "flux" });
    await put("image", { enabled: false });
    expect((await env.json("POST", "/api/settings/image/test")).body.data.ok).toBeFalse();
  });

  test("commands: a validated list; off on hosted installs; recipes see their names", async () => {
    env = makeEnv();
    expect((await env.json("POST", "/api/settings/commands/test")).body.data.error).toBe("No commands registered");
    const good = { name: "brand-check", cmd: "python", args: ["check.py"], timeoutSec: 30 };
    const saved = await put("commands", { commands: [good, { name: "lint_two", cmd: "node" }] });
    expect(saved.body.data.commands).toMatchObject({ active: true, allowed: true, commands: [good, { name: "lint_two", cmd: "node", args: [], timeoutSec: 60 }] });
    expect((await env.json("POST", "/api/settings/commands/test")).body.data.detail).toBe("2 commands");
    expect(env.app.generate.connections().commands).toEqual(["brand-check", "lint_two"]);
    for (const [bad, message] of [
      [[{ ...good, name: "Bad Name" }], "commands[0].name"],
      [[good, good], "listed twice"],
      [[{ name: "x", cmd: " " }], "cmd"],
      [[{ ...good, args: [1] }], "args"],
      [[{ ...good, timeoutSec: 0 }], "timeoutSec"],
      ["nope", "list of at most 20"],
    ] as const) expect((await put("commands", { commands: bad })).body.error).toContain(message);

    env.cleanup();
    env = makeEnv({ commandsEnabled: false });
    const off = await put("commands", { commands: [good] });
    expect([off.status, off.body.error]).toEqual([409, expect.stringContaining("off on this install")]);
    expect((await env.json("POST", "/api/settings/commands/test")).body.data.error).toContain("off on this install");
    expect(env.app.generate.connections().commands).toEqual([]);
  });

  test("an unknown connection names the known ones", async () => {
    env = makeEnv();
    expect((await put("sms", {})).body.error).toContain("voice");
  });
});

// ---- the engines ----------------------------------------------------------------------

describe("Narrator", () => {
  const rig = (over: object = {}, fetchFn?: (url: any, init?: any) => Promise<Response>, runScript?: any) => {
    const config = { ...loadConfig({}), voiceEngine: "elevenlabs", voiceApiKey: "key", voiceVoices: { id: "v-id", default: "v-default" }, whisperDevice: "cuda", ...over };
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = (fetchFn ?? (async () => new Response(new Uint8Array([1, 2, 3])))) as typeof fetch;
    const wrapped = (async (url: any, init: any) => { calls.push({ url: String(url), init }); return f(url, init); }) as typeof fetch;
    return { narrator: new Narrator(config, wrapped, runScript), calls, config };
  };
  const body = (c: { init: RequestInit }) => JSON.parse(String(c.init.body));
  const headers = (c: { init: RequestInit }) => c.init.headers as Record<string, string>;

  test("ElevenLabs: voice in the path, key and model_id, word times from the character times; cached by script, voice and model", async () => {
    const alignment = { characters: [..."Halo dunia"], character_start_times_seconds: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9], character_end_times_seconds: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1] };
    const r = rig({ voiceModel: "eleven_v3" }, async () => Response.json({ audio_base64: Buffer.from("MP3").toString("base64"), alignment }));
    const s = await r.narrator.speak({ text: "Halo dunia", language: "id", dir: tmp, speed: 1.1 });
    expect(r.calls[0]!.url).toBe("https://api.elevenlabs.io/v1/text-to-speech/v-id/with-timestamps");
    expect(headers(r.calls[0]!)["xi-api-key"]).toBe("key");
    expect(body(r.calls[0]!)).toEqual({ text: "Halo dunia", model_id: "eleven_v3", voice_settings: { speed: 1.1 } });
    expect(s).toMatchObject({ engine: "elevenlabs", cached: false, words: [{ text: "Halo", start: 0, end: 0.4 }, { text: "dunia", start: 0.5, end: 1 }] });
    expect(readFileSync(s.path, "utf-8")).toBe("MP3");

    const again = await r.narrator.speak({ text: "Halo dunia", language: "id", dir: tmp, speed: 1.1 });
    expect(again).toMatchObject({ cached: true, path: s.path, words: [{ text: "Halo" }, { text: "dunia" }] });
    expect(r.calls).toHaveLength(1);
    const other = await r.narrator.speak({ text: "Halo dunia", language: "id", dir: tmp, speed: 1.1, voice: "v-other" });
    expect(other.path).not.toBe(s.path);
    writeFileSync(`${s.path}.words.json`, "{ broken");
    expect((await r.narrator.speak({ text: "Halo dunia", language: "id", dir: tmp, speed: 1.1 })).words).toBeNull();
  });

  test("Fish: the model goes in a header and the voice is the reference id; a spent balance is 'unavailable', not an error", async () => {
    const r = rig({ voiceEngine: "fish", voiceModel: "s1" });
    const s = await r.narrator.speak({ text: "Halo", language: "en", dir: tmp });
    expect(r.calls[0]!.url).toBe("https://api.fish.audio/v1/tts");
    expect(headers(r.calls[0]!)).toMatchObject({ model: "s1", Authorization: "Bearer key" });
    expect(body(r.calls[0]!)).toEqual({ text: "Halo", reference_id: "v-default", format: "mp3" });
    expect(s.words).toBeNull();
    // no voice id: Fish speaks with its default voice, as in the request that worked on the real run (fixture)
    const real = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/voice/fish-tts.json"), "utf-8"));
    const plain = rig({ voiceEngine: "fish", voiceVoices: {}, voiceModel: real.headers.model });
    await plain.narrator.speak({ text: "Halo", language: "id", dir: tmp });
    expect([plain.calls[0]!.url, headers(plain.calls[0]!).model, body(plain.calls[0]!)]).toEqual([real.url, real.headers.model, real.body]);
    const broke = rig({ voiceEngine: "fish" }, async () => new Response("pay", { status: 402 }));
    await expect(broke.narrator.speak({ text: "Halo", language: "id", dir: tmp })).rejects.toBeInstanceOf(VoiceUnavailable);
  });

  test("OpenAI-compatible: /audio/speech under any base URL, with speed", async () => {
    const r = rig({ voiceEngine: "openai", voiceBaseUrl: "http://tts.local/v1/", voiceModel: "" });
    await r.narrator.speak({ text: "Halo", language: "id", dir: tmp, speed: 0.9 });
    expect(r.calls[0]!.url).toBe("http://tts.local/v1/audio/speech");
    expect(body(r.calls[0]!)).toEqual({ model: "tts-1", input: "Halo", voice: "v-id", response_format: "mp3", speed: 0.9 });
  });

  test("local: runs tts.py on a GPU install and reports its progress; a failed run is an error", async () => {
    const seen: string[][] = [];
    const run = async (_script: string, args: string[], opts: any) => {
      seen.push(args);
      opts.onProgress?.(50);
      writeFileSync(args[args.indexOf("--output") + 1]!, "wav");
      return { success: true, data: {} };
    };
    const progress: number[] = [];
    const r = rig({ voiceEngine: "local", voiceApiKey: "" }, undefined, run);
    const s = await r.narrator.speak({ text: "Halo", language: "id", dir: tmp, onProgress: (p) => progress.push(p) });
    expect(s.path.endsWith(".wav")).toBeTrue();
    expect(seen[0]).toEqual(["--text", "Halo", "--language", "id", "--output", s.path, "--voice", "v-id"]);
    expect(progress).toEqual([50]);
    const failing = rig({ voiceEngine: "local" }, undefined, async () => ({ success: false, error: "no model" }));
    await expect(failing.narrator.speak({ text: "Lain", language: "id", dir: tmp })).rejects.toThrow("no model");
    const silent = rig({ voiceEngine: "local" }, undefined, async () => ({ success: true }));
    await expect(silent.narrator.speak({ text: "Sepi", language: "id", dir: tmp })).rejects.toThrow("returned no audio");
  });

  test("which engines are set up; speaking without one, or without a voice, is an error", async () => {
    expect(rig().narrator.engines).toEqual(["elevenlabs"]);
    expect(rig({ voiceApiKey: "", voiceBaseUrl: "http://x" }).narrator.engines).toEqual(["elevenlabs"]);
    expect(rig({ voiceApiKey: "" }).narrator.engines).toEqual([]);
    expect(rig({ voiceEnabled: false }).narrator.engines).toEqual([]);
    expect(rig({ voiceEngine: "" }).narrator.engines).toEqual([]);
    expect(rig({ voiceEngine: "local" }, undefined, undefined).narrator.engines).toEqual([]);
    expect(rig({ voiceEngine: "local", whisperDevice: "cpu" }, undefined, async () => ({})).narrator.engines).toEqual([]);
    await expect(rig({ voiceEngine: "" }).narrator.speak({ text: "x", language: "id", dir: tmp })).rejects.toBeInstanceOf(VoiceError);
    await expect(rig({ voiceVoices: {} }).narrator.speak({ text: "x", language: "id", dir: tmp })).rejects.toThrow("Set a voice id");
    expect(rig().narrator.voiceFor("id", " mine ")).toBe("mine");
    expect(rig().narrator.voiceFor("fr")).toBe("v-default");
  });

  test("network and HTTP failures are voice errors; a cancelled request stays a cancellation", async () => {
    const down = rig({}, async () => { throw new Error("ECONNREFUSED"); });
    await expect(down.narrator.speak({ text: "a", language: "id", dir: tmp })).rejects.toThrow("can't be reached: ECONNREFUSED");
    const bad = rig({}, async () => new Response("denied", { status: 401 }));
    await expect(bad.narrator.speak({ text: "b", language: "id", dir: tmp })).rejects.toThrow("elevenlabs voice HTTP 401: denied");
    const noAudio = rig({}, async () => Response.json({}));
    await expect(noAudio.narrator.speak({ text: "c", language: "id", dir: tmp })).rejects.toThrow("returned no audio");
    const noTimes = rig({}, async () => Response.json({ audio_base64: Buffer.from("x").toString("base64") }));
    expect((await noTimes.narrator.speak({ text: "d", language: "id", dir: tmp })).words).toBeNull();
    const ctl = new AbortController();
    ctl.abort();
    const stopped = rig({}, async () => { throw new DOMException("aborted", "AbortError"); });
    await expect(stopped.narrator.speak({ text: "e", language: "id", dir: tmp, signal: ctl.signal })).rejects.toThrow("aborted");
    expect(existsSync(join(tmp, "nothing"))).toBeFalse();
  });

  test("ElevenLabs character times become words, ignoring runs of spaces", () => {
    expect(wordsFromCharacters([..."a  b"], [0, 1, 2, 3], [1, 2, 3, 4])).toEqual([{ text: "a", start: 0, end: 1 }, { text: "b", start: 3, end: 4 }]);
    expect(wordsFromCharacters([], [], [])).toEqual([]);
    expect(wordsFromCharacters(["x"], [], [])).toEqual([{ text: "x", start: 0, end: 0 }]);
  });
});
