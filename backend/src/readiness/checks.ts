import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { AppConfig } from "../config";
import type { ExecFn } from "../runner";
import manifestJson from "./manifest.json";

export interface ToolBuild { url: string; sha256: string; dir: string; bins: string[] }
export interface WhisperFile { url: string; name: string; sha256: string }
export interface Manifest {
  ffmpeg: Record<string, ToolBuild>;
  uv: Record<string, ToolBuild>;
  python: string;
  cudaWheels: string[];
  whisper: { name: string; approxBytes: number; files: WhisperFile[] };
}
export const manifest = manifestJson as Manifest;

export interface Progress { percent: number; label: string }
export interface ReadinessItem {
  id: string; required: boolean; ok: boolean; fixable: boolean; detail: string;
  progress?: Progress; error?: string;
}

/** Everything the checks and fixes touch outside the process: tests inject fakes, nothing real is downloaded. */
export interface ReadinessDeps {
  exec: ExecFn;
  exists(path: string): boolean;
  remove(path: string): void;
  mkdirp(path: string): void;
  rename(from: string, to: string): void;
  /** Saves `url` to `dest`, reporting 0-100, and returns the file's SHA-256. Rejects with "offline" when the network is down. */
  download(url: string, dest: string, onPercent: (p: number) => void): Promise<string>;
  platform: { os: string; arch: string };
  manifest: Manifest;
  home: string;
}

export function defaultReadinessDeps(exec: ExecFn, httpFetch: typeof fetch = globalThis.fetch): ReadinessDeps {
  return {
    exec,
    exists: existsSync,
    remove: (p) => rmSync(p, { recursive: true, force: true }),
    mkdirp: (p) => { mkdirSync(p, { recursive: true }); },
    rename: renameSync,
    async download(url, dest, onPercent) {
      let res: Response;
      try { res = await httpFetch(url); } catch { throw new Error("offline"); }
      if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status})`);
      mkdirSync(dirname(dest), { recursive: true });
      const total = Number(res.headers.get("content-length")) || 0;
      const hash = createHash("sha256");
      const file = createWriteStream(dest);
      let got = 0;
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          hash.update(chunk);
          if (!file.write(chunk)) await new Promise((r) => file.once("drain", r));
          got += chunk.length;
          if (total) onPercent(Math.floor((got / total) * 100));
        }
      } catch { throw new Error("offline"); } finally {
        await new Promise((r) => file.end(r));
      }
      return hash.digest("hex");
    },
    platform: { os: process.platform, arch: process.arch },
    manifest,
    home: process.env.HOME || process.env.USERPROFILE || "",
  };
}

export const platformKey = (d: ReadinessDeps) => `${d.platform.os}-${d.platform.arch}`;
const exe = (d: ReadinessDeps, name: string) => (d.platform.os === "win32" ? `${name}.exe` : name);
export const toolsDir = (c: AppConfig) => `${c.dataDir}/tools`;
export const venvPython = (c: AppConfig, d: ReadinessDeps) =>
  `${c.dataDir}/venv/${d.platform.os === "win32" ? "Scripts/python.exe" : "bin/python"}`;
export const modelDir = (c: AppConfig) => `${c.dataDir}/models/${manifest.whisper.name}`;
export const localUv = (c: AppConfig, d: ReadinessDeps) => `${toolsDir(c)}/${exe(d, "uv")}`;

const works = async (d: ReadinessDeps, cmd: string, args: string[]) => {
  try { return (await d.exec(cmd, args, { timeoutMs: 60_000 })).exitCode === 0; } catch { return false; }
};
const stdoutOf = async (d: ReadinessDeps, cmd: string, args: string[]) => {
  try {
    const r = await d.exec(cmd, args, { timeoutMs: 60_000 });
    return r.exitCode === 0 ? r.stdout.trim() : null;
  } catch { return null; }
};

export async function nvidiaGpu(d: ReadinessDeps): Promise<string | null> {
  const name = await stdoutOf(d, "nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"]);
  return name ? (name.split("\n")[0] as string).trim() : null;
}

const PACKAGES = "import faster_whisper, cv2, numpy, yt_dlp, lightgbm, sys; print('%d.%d' % sys.version_info[:2])";

function whisperPresent(c: AppConfig, d: ReadinessDeps): boolean {
  const name = c.whisperModel;
  if (/[\\/]/.test(name)) return d.exists(`${name}/model.bin`);
  return d.exists(`${modelDir(c)}/model.bin`)
    || d.exists(`${d.home}/.cache/huggingface/hub/models--Systran--faster-whisper-${name}`);
}

/** The first-run checklist the desktop app shows. Run on every GET: it is cheap and always current. */
export async function readinessItems(c: AppConfig, d: ReadinessDeps): Promise<ReadinessItem[]> {
  const ffmpegOk = (await works(d, c.ffmpegPath, ["-version"])) || (await works(d, `${toolsDir(c)}/${exe(d, "ffmpeg")}`, ["-version"]));
  const pyVersion = await stdoutOf(d, c.pythonPath, ["-c", PACKAGES]);
  const gpu = await nvidiaGpu(d);
  const whisper = whisperPresent(c, d);
  const browser = await works(d, c.nodePath, [c.hyperframesBin, "browser", "path"]);
  const key = platformKey(d);
  return [
    { id: "ffmpeg", required: true, ok: ffmpegOk, fixable: key in d.manifest.ffmpeg,
      detail: ffmpegOk ? "ffmpeg found" : `ffmpeg not found at ${c.ffmpegPath}` },
    { id: "python", required: true, ok: pyVersion !== null, fixable: key in d.manifest.uv,
      detail: pyVersion !== null ? `Python ${pyVersion}, packages up to date` : `Python with the pipeline packages not found at ${c.pythonPath}` },
    { id: "whisperModel", required: true, ok: whisper, fixable: true,
      detail: whisper ? `${d.manifest.whisper.name} ready` : `${d.manifest.whisper.name} not downloaded (${(d.manifest.whisper.approxBytes / 1e9).toFixed(1)} GB)` },
    { id: "gpu", required: false, ok: gpu !== null, fixable: false, detail: gpu ?? "No NVIDIA GPU found; clipping runs on the CPU" },
    { id: "generateBrowser", required: false, ok: browser, fixable: true,
      detail: browser ? "Chrome for Generate found" : "needed for Generate only" },
  ];
}
