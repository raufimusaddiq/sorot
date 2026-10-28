import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createApp, type App } from "../src/app";
import { loadConfig, type AppConfig } from "../src/config";
import { openDatabase } from "../src/db";
import { Jev } from "../src/jev";
import type { ExecFn, ProcResult, ScriptOptions, ScriptRunner } from "../src/runner";
import type { Json } from "../src/types";

export type ScriptHandler = (args: string[], signal?: AbortSignal, opts?: ScriptOptions) => Json | Promise<Json>;

export interface TestEnv {
  app: App;
  config: AppConfig;
  dir: string;
  calls: Array<{ script: string; args: string[]; timeoutMinutes?: number }>;
  execCalls: Array<{ cmd: string; args: string[] }>;
  scripts: Record<string, ScriptHandler>;
  execHandler: { fn: (cmd: string, args: string[], signal?: AbortSignal) => Promise<ProcResult> | ProcResult };
  /** Outbound HTTP (web search, LLM): tests never reach the network. */
  fetchHandler: { fn: (url: string, init?: RequestInit) => Promise<Response> | Response };
  req(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  json(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }>;
  cleanup(): void;
}

export const procOk = (stdout = "", stderr = ""): ProcResult =>
  ({ exitCode: 0, stdout, stderr, timedOut: false, aborted: false });

export const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1] as string;

/** YYYYMMDD `daysAgo` days before now (yt-dlp's upload_date). */
export const ytDate = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10).replaceAll("-", "");

/** yt-dlp --dump-json output: one JSON object per line (plus the junk lines yt-dlp may print). */
export const ytLines = (entries: object[]) => `${entries.map((e) => JSON.stringify(e)).join("\n")}\n\nnot json\n`;

/** What a fake YouTube search / feed returns: two long uploads, a Short and a re-clip (both filtered out). */
export const fakeFeed = () => [
  { id: "abcdefghijk", url: "https://www.youtube.com/watch?v=abcdefghijk", title: "Podcast rahasia sukses", duration: 3600,
    channel: "Ch", channel_id: "UCch", view_count: 1000, upload_date: ytDate(1) },
  { id: "zyxwvutsrqp", url: "https://youtu.be/zyxwvutsrqp", title: "Two", duration: 1200, channel: "Ch2", upload_date: ytDate(10) },
  { id: "SHORTxxxxxx", url: "https://youtube.com/shorts/SHORTxxxxxx", title: "Short", duration: 30, upload_date: ytDate(1) },
  { id: "CLIPxxxxxxx", title: "Best moments compilation", duration: 900, upload_date: ytDate(1) },
];

/** A plain (uploaded-style) VTT: ~90 s of steady talk with a couple of hooks. */
export const FAKE_VTT = `WEBVTT

${[
  "Kenapa rahasia ini penting banget? Ternyata faktanya gila!",
  "Jadi pertama kamu harus tahu, jangan sampai salah langkah.",
  "Banyak orang gagal karena hal sepele yang tidak banyak orang tahu.",
  "Pak Budi kaget dan marah waktu dengar kebenarannya.",
  "Kedua, kamu wajib cek ulang semua keputusan penting.",
  "Hari ini kita bahas pelan-pelan sambil minum teh hangat.",
  "Terakhir, jangan malas dan tetap semangat setiap hari ya.",
  "Itu rahasia sukses yang jarang dibongkar di internet.",
].map((t, i) => `00:00:${String(i * 12).padStart(2, "0")}.000 --> 00:00:${String(i * 12 + 11).padStart(2, "0")}.000\n${t}`).join("\n\n")}
`;

/** Fake ffmpeg / yt-dlp: create the output files the real tools would. */
export function defaultExec(cmd: string, args: string[]): ProcResult {
  if (cmd === "yt-dlp") {
    if (args[0] === "--print") return procOk("Judul Video Test\n");
    if (args.includes("--dump-json")) return procOk(ytLines(fakeFeed()));
    if (args.includes("--sub-format")) {
      // Discovery's VTT fetch finds captions; the transcript's json3 fetch doesn't (→ Whisper).
      if (argAfter(args, "--sub-format") === "vtt") writeFileSync(join(dirname(argAfter(args, "-o")), "abcdefghijk.id.vtt"), FAKE_VTT);
      return procOk();
    }
    const out = argAfter(args, "-o");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, "video-bytes");
    return procOk("[download] 100%");
  }
  if (cmd === "ffmpeg") {
    const out = args.at(-1) as string;
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, "wav-bytes");
    return procOk();
  }
  return { exitCode: 127, stdout: "", stderr: `unknown cmd ${cmd}`, timedOut: false, aborted: false };
}

/** Segment texts + media values that the real Bun scorer puts in PRIMARY, BACKUP and SKIP. */
export const FAKE_SEGMENTS = [
  "Kenapa rahasia ini penting banget? Ternyata faktanya gila, Pak Budi kaget dan marah! Jadi pertama kamu harus tahu.",
  "Ternyata rahasia sukses itu sederhana. Pertama, jangan malas, kan?",
  "Hari ini kita duduk santai di rumah sambil minum teh bersama keluarga besar kami yang datang dari jauh sekali.",
].map((text, i) => ({ index: i, startTime: i * 30, endTime: i * 30 + 25, duration: 25, text }));

export const FAKE_MEDIA = [
  { index: 0, rmsRatio: 2, onsetDensity: 1, facePresence: 1, sceneChange: 1, motion: 1 },
  { index: 1, rmsRatio: 1, onsetDensity: 0.5, facePresence: 0.9, sceneChange: 0.5, motion: 0.5 },
  { index: 2, rmsRatio: 0.3, onsetDensity: 0.2, facePresence: 0, sceneChange: 0.1, motion: 0.2 },
];

/** Python fakes that mimic each script's output contract. */
export function defaultScripts(dataDir: string): Record<string, ScriptHandler> {
  const clipFile = (dir: string, rank: number, suffix: string) => {
    const p = join(dir, `clip_${rank}${suffix}.mp4`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(p, "mp4-bytes");
    return p;
  };
  return {
    // 30 s apart → segmenting turns each line into one FAKE_SEGMENTS clip
    "transcribe.py": (args) => ({ videoId: "x", language: argAfter(args, "--language"), model: argAfter(args, "--model"),
      segments: FAKE_SEGMENTS.map((s) => ({ index: s.index, start: s.startTime, end: s.endTime, text: s.text })) }),
    "media_features.py": () => ({ videoId: "x", segments: FAKE_MEDIA }),
    "predict_supervised.py": () => ({ predictions: { 0: 0.99, 1: null, 2: 0.1 } }),
    "render.py": (args) => {
      const rank = Number(argAfter(args, "--clip-index")) + 1;
      if (args.includes("--export-dir")) {   // one pass: framing + captions → the export file
        return { clips: [{ rank, status: "COMPLETED", captioned: true,
          path: clipFile(argAfter(args, "--export-dir"), rank, "_subtitled") }] };
      }
      return { clips: [{ rank, status: "COMPLETED", path: clipFile(argAfter(args, "--output-dir"), rank, "") }] };
    },
    "subtitle.py": (args) => {
      const rank = Number(argAfter(args, "--clip-index")) + 1;
      return { clips: [{ rank, status: "COMPLETED", path: clipFile(argAfter(args, "--output-dir"), rank, "_subtitled") }] };
    },
    "variation.py": () => ({ variations: [] }),
    "captions.py": (args) => {
      const start = Number(argAfter(args, "--start"));
      return { words: [{ text: "halo", start: start + 0.5, end: start + 1 }, { text: "dunia", start: start + 1.2, end: start + 2 }] };
    },
  };
}

export function makeEnv(overrides: Partial<AppConfig> = {}): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), "vc-backend-"));
  const config: AppConfig = {
    ...loadConfig({}),
    dataDir: join(dir, "data").replaceAll("\\", "/"),
    dbPath: ":memory:",
    staticDir: "",
    ffmpegPath: "ffmpeg",
    ytdlpPath: "yt-dlp",
    orphanSweepMs: 60_000,
    orphanSweepInitialMs: 60_000,
    ...overrides,
  };
  const calls: TestEnv["calls"] = [];
  const execCalls: TestEnv["execCalls"] = [];
  const scripts = defaultScripts(config.dataDir);
  const execHandler: TestEnv["execHandler"] = { fn: defaultExec };
  const fetchHandler: TestEnv["fetchHandler"] = { fn: (url) => { throw new Error(`no network in tests: ${url}`); } };

  const runScript: ScriptRunner = async (script, args, opts) => {
    calls.push({ script, args, timeoutMinutes: opts?.timeoutMinutes });
    const h = scripts[script];
    if (!h) throw new Error(`no fake for ${script}`);
    return h(args, opts?.signal, opts);
  };
  const exec: ExecFn = async (cmd, args, opts) => {
    execCalls.push({ cmd, args });
    return execHandler.fn(cmd, args, opts?.signal);
  };

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => fetchHandler.fn(String(input), init)) as typeof fetch;
  const app = createApp(config, { db: openDatabase(":memory:"), runScript, exec, fetch: fetchFn, retryWaitMs: 0 });
  const req = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.fetch(new Request(`http://localhost${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }));
  return {
    app, config, dir, calls, execCalls, scripts, execHandler, fetchHandler, req,
    async json(method, path, body) {
      const res = await req(method, path, body);
      return { status: res.status, body: await res.json() };
    },
    cleanup() {
      app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---- Jev ------------------------------------------------------------------

export const JEV_ON = { jevUrl: "http://jev/v1/systemone", jevModel: "jev-1.14.0", jevApiKey: "k", jevTimeoutSec: 5 };
export type JevRequest = { state: any; questions: Record<string, any> };
/** Answer for one question id about a state; an Error makes the request fail (HTTP 500). */
export type JevAnswer = (state: any, id: string) => unknown;

export const noulA = (p: number) => ({ type: "noul", noul: p });
export const scoreA = (score: number, confidence = 0.9) => ({ type: "score", score, confidence });

/**
 * Clip answers: good, unless the excerpt is weak ("Halo…", "Hari ini…", "lemah": filler, no hook,
 * no payoff); "korupsi" is a risk, "harga"/"rahasia" fit the direction, a "BOHONG" title over-claims.
 */
export const clipAnswer: JevAnswer = (state, id) => {
  const text = String(state.excerpt ?? "");
  const weak = /^(Halo|Hari ini)|lemah/.test(text);
  if (id === "payoff") return scoreA(weak ? 0.2 : 1.9);
  if (id === "title") return { type: "choice", choice: "S0", confidence: 0.8, probabilities: { S0: 0.8 } };
  if (id === "hook_opening" || id === "ends_complete") return noulA(weak ? 0.1 : 0.9);
  if (id === "mostly_filler") return noulA(weak ? 0.9 : 0.05);
  if (id === "fits_direction") return noulA(/harga|rahasia/i.test(text) ? 0.95 : 0.05);
  if (id === "risk_accusation") return noulA(text.includes("korupsi") ? 0.8 : 0.02);
  if (id === "title_overclaims") return noulA(String(state.title).includes("BOHONG") ? 0.9 : 0.1);
  return noulA(0.05);
};

/** Jev's HTTP reply to a request body, logged in `log`. */
export function jevReply(init: RequestInit | undefined, answer: JevAnswer, log: JevRequest[] = []): Response {
  const { state, questions } = JSON.parse(String(init?.body));
  log.push({ state, questions });
  const answers: Record<string, unknown> = {};
  for (const id of Object.keys(questions)) {
    const a = answer(state, id);
    if (a instanceof Error) return new Response(a.message, { status: 500 });
    answers[id] = a;
  }
  return Response.json({ model: "jev-1.14.0", answers, usage: { input_tokens: 10, output_tokens: 1 } });
}

/** A Jev client over `jevReply`. */
export function fakeJev(answer: JevAnswer = clipAnswer) {
  const requests: JevRequest[] = [];
  const fetchFn = (async (_url: string, init?: RequestInit) => jevReply(init, answer, requests)) as unknown as typeof fetch;
  return { jev: new Jev(JEV_ON, fetchFn, 0), requests };
}

/** Backticked paths in a request's questions that don't exist in its state (TypeSafe: name the field you mean). */
export function unknownFields({ state, questions }: JevRequest): string[] {
  const paths = [...JSON.stringify(questions).matchAll(/`([\w.]+)`/g)].map((m) => m[1]!);
  return paths.filter((p) => p.split(".").reduce((o: any, k) => (o == null ? undefined : o[k]), state) === undefined);
}
