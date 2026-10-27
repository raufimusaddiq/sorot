import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createApp, type App } from "../src/app";
import { loadConfig, type AppConfig } from "../src/config";
import { openDatabase } from "../src/db";
import type { ExecFn, ProcResult, ScriptRunner } from "../src/runner";
import type { Json } from "../src/types";

export type ScriptHandler = (args: string[], signal?: AbortSignal) => Json | Promise<Json>;

export interface TestEnv {
  app: App;
  config: AppConfig;
  dir: string;
  calls: Array<{ script: string; args: string[] }>;
  execCalls: Array<{ cmd: string; args: string[] }>;
  scripts: Record<string, ScriptHandler>;
  execHandler: { fn: (cmd: string, args: string[], signal?: AbortSignal) => Promise<ProcResult> | ProcResult };
  req(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  json(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }>;
  cleanup(): void;
}

export const procOk = (stdout = "", stderr = ""): ProcResult =>
  ({ exitCode: 0, stdout, stderr, timedOut: false, aborted: false });

export const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1] as string;

/** Fake ffmpeg / yt-dlp: create the output files the real tools would. */
export function defaultExec(cmd: string, args: string[]): ProcResult {
  if (cmd === "yt-dlp") {
    if (args[0] === "--print") return procOk("Judul Video Test\n");
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

export function scoredSegments(n = 3): Json {
  const tiers = ["PRIMARY", "BACKUP", "SKIP", "SKIP"];
  return {
    videoId: "x",
    scoredSegments: Array.from({ length: n }, (_, i) => ({
      index: i, rank: i + 1, startTime: i * 30, endTime: i * 30 + 25, duration: 25,
      text: `segmen ${i}`, title: `Judul ${i}`, finalScore: 0.9 - i * 0.1, tier: tiers[i] ?? "SKIP",
      scores: { hookStrength: 0.8, keywordTrigger: 0.5, novelty: 0.4, clarity: 0.7, emotionalEnergy: 0.6,
        textSentiment: 0.3, pauseStructure: 0.5, facePresence: 1, sceneChange: 0.2, topicFit: 0.4,
        historyScore: 0.5, boostTotal: 0.05, penaltyTotal: 0.01 },
    })),
  };
}

/** Python fakes that mimic each script's output contract. */
export function defaultScripts(dataDir: string): Record<string, ScriptHandler> {
  const clipFile = (dir: string, rank: number, suffix: string) => {
    const p = join(dir, `clip_${rank}${suffix}.mp4`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(p, "mp4-bytes");
    return p;
  };
  return {
    "transcribe.py": () => ({ videoId: "x", language: "id", segments: [{ index: 0, start: 0, end: 5, text: "halo" }] }),
    "segment.py": () => ({ videoId: "x", segments: [{ startTime: 0, endTime: 25 }] }),
    "score.py": () => scoredSegments(3),
    "render.py": (args) => {
      const rank = Number(argAfter(args, "--clip-index")) + 1;
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
    "youtube_captions.py": () => ({ found: false }),
    "analytics.py": () => ({ summary: { clips: 2 } }),
    "feedback.py": () => ({ viralScore: 0.42 }),
    "learn_weights.py": (args) =>
      argAfter(args, "--action") === "train"
        ? { status: "trained", version: 4, trained_on: 6, weight_changes: { hookStrength: { from: 0.1, to: 0.12 } },
            new_weights: { hookStrength: 0.12 }, message: "ok" }
        : { version: 3, trained_on: 5, last_updated: "2026-10-01", weights: { hookStrength: 0.1 } },
    "discover.py": (args) => {
      if (argAfter(args, "--mode") === "enrich") {
        return { transcriptScore: 0.6, predictedScore: 0.7, transcriptSample: "contoh transkrip" };
      }
      return {
        mode: argAfter(args, "--mode"),
        videos: [
          { videoId: "abcdefghijk", title: "Test", url: "https://youtube.com/watch?v=abcdefghijk", duration: 300,
            channel: "Ch", viewCount: 1000, uploadDate: "20260401", relevanceScore: 0.75, age_hours: 12.5,
            channelId: "UCch", contentType: "PODCAST", isLikelyClipped: false },
          { videoId: "zyxwvutsrqp", title: "Two", url: "https://youtu.be/zyxwvutsrqp", duration: 200,
            channel: "Ch2", viewCount: null, uploadDate: "20260402", relevanceScore: 0.5, isLikelyClipped: true },
          { videoId: "", title: "no id" },
        ],
      };
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

  const runScript: ScriptRunner = async (script, args, opts) => {
    calls.push({ script, args });
    const h = scripts[script];
    if (!h) throw new Error(`no fake for ${script}`);
    return h(args, opts?.signal);
  };
  const exec: ExecFn = async (cmd, args, opts) => {
    execCalls.push({ cmd, args });
    return execHandler.fn(cmd, args, opts?.signal);
  };

  const app = createApp(config, { db: openDatabase(":memory:"), runScript, exec });
  const req = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.fetch(new Request(`http://localhost${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }));
  return {
    app, config, dir, calls, execCalls, scripts, execHandler, req,
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
