import type { AppConfig } from "../config";
import type { ExecFn, ProcResult } from "../runner";

// All HyperFrames work goes through this wrapper (`exec`, like ffmpeg / yt-dlp): the CLI holds no
// Sorot logic. Output shapes were captured in spike S1 (backend/tests/fixtures/hyperframes/).

export type HfErrorCode = "failed" | "usage" | "timeout" | "cancelled" | "invalid-output";

export class HyperframesError extends Error {
  constructor(message: string, readonly code: HfErrorCode, readonly exitCode: number | null = null) {
    super(message);
  }
}

export interface HfFinding {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  fixHint?: string;
  file?: string;
  sourceFile?: string;
  line?: number;
  selector?: string;
  time?: number;
  occurrences?: number;
}

export interface HfSection { ok: boolean; errorCount: number; warningCount: number; infoCount: number; findings: HfFinding[] }
export interface LintResult extends HfSection { filesScanned?: number }
export interface CheckResult {
  ok: boolean;
  lint: HfSection;
  runtime: HfSection;
  layout: HfSection & { duration?: number };
  [section: string]: unknown;
}
export interface SnapshotFrame { path: string; time: number; role?: string; label?: string }
export interface SnapshotResult { ok: boolean; outputDir: string; frames: SnapshotFrame[] }
export interface DoctorCheck { name: string; ok: boolean; detail: string; hint?: string }
export interface DoctorResult { ok: boolean; platform: string; checks: DoctorCheck[] }
export interface CatalogItem { name: string; type: string; title: string; description: string; tags: string[] }

export interface HfCallOptions {
  signal?: AbortSignal;
  /** Overrides the command's default time limit. */
  timeoutMs?: number;
  onProgress?: (percent: number) => void;
}

/** `standard` is HyperFrames' own `looks`. */
export const RENDER_QUALITY: Record<string, string> = { draft: "draft", standard: "looks", delivery: "delivery" };
export const RESOLUTION: Record<string, string> = { "9:16": "portrait", "16:9": "landscape", "1:1": "square" };

const MINUTE = 60_000;
const DEFAULT_TIMEOUT_MS: Record<string, number> = {
  init: 2 * MINUTE, add: 2 * MINUTE, catalog: MINUTE, lint: 2 * MINUTE, check: 5 * MINUTE,
  snapshot: 5 * MINUTE, doctor: MINUTE,
};
/** Planning figure from the reference runs (R11): ~10 s of render per second of video at 30 fps. */
const RENDER_SEC_PER_VIDEO_SEC = 15;

/** Time limit for a render of `durationSec` seconds at `fps`: scales with length and frame rate, never below 10 min. */
export function renderTimeoutMs(durationSec: number, fps: number): number {
  return Math.max(10 * MINUTE, Math.ceil(durationSec * RENDER_SEC_PER_VIDEO_SEC * (fps / 30)) * 1000);
}

const PERCENT = /(\d{1,3})\s?%/;

export class Hyperframes {
  constructor(private readonly config: AppConfig, private readonly exec: ExecFn) {}

  /** The pinned CLI version, recorded with each build. */
  get version() { return this.config.hyperframesVersion; }

  private async run(command: string, args: string[], opts: HfCallOptions = {}): Promise<ProcResult> {
    const res = await this.exec(this.config.nodePath, [this.config.hyperframesBin, command, ...args], {
      signal: opts.signal,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS[command],
      env: { HYPERFRAMES_AGENT: "1", HYPERFRAMES_SKIP_SKILLS: "1" },
      stdoutTail: 4 * 1024 * 1024,
      stderrTail: 64 * 1024,
      ...(opts.onProgress ? { onStderrLine: (line: string) => {
        const m = PERCENT.exec(line);
        if (m) opts.onProgress?.(Math.min(100, Number(m[1])));
      } } : {}),
    });
    if (res.aborted) throw new HyperframesError(`hyperframes ${command} cancelled`, "cancelled", res.exitCode);
    if (res.timedOut) throw new HyperframesError(`hyperframes ${command} timed out`, "timeout", res.exitCode);
    return res;
  }

  private fail(command: string, res: ProcResult): never {
    const tail = (res.stderr || res.stdout).trim().slice(-600);
    throw new HyperframesError(`hyperframes ${command} failed (exit ${res.exitCode}): ${tail}`, res.exitCode === 2 ? "usage" : "failed", res.exitCode);
  }

  private async json<T>(command: string, args: string[], opts: HfCallOptions, findingsExit1: boolean): Promise<T> {
    const res = await this.run(command, [...args, "--json"], opts);
    // lint / check exit 1 when they found errors: that is a result, not a failure.
    if (res.exitCode !== 0 && !(findingsExit1 && res.exitCode === 1)) this.fail(command, res);
    try {
      return JSON.parse(res.stdout.trim()) as T;
    } catch {
      throw new HyperframesError(`hyperframes ${command} printed no JSON: ${res.stdout.trim().slice(0, 300)}`, "invalid-output", res.exitCode);
    }
  }

  /** Scaffolds `dir` (a blank composition project at the format's size). */
  async init(dir: string, format: string, opts: HfCallOptions = {}) {
    const res = await this.run("init", [dir, "--non-interactive", "--skip-skills", "--resolution", RESOLUTION[format] ?? "portrait", "--example", "blank"], opts);
    if (res.exitCode !== 0) this.fail("init", res);
  }

  /** Installs registry blocks / components into the project; returns what the CLI reports. */
  add(dir: string, names: string[], opts: HfCallOptions = {}) {
    return this.json<Record<string, unknown>>("add", ["--dir", dir, "--no-clipboard", ...names], opts, false);
  }

  catalog(opts: HfCallOptions = {}) { return this.json<CatalogItem[]>("catalog", [], opts, false); }

  lint(dir: string, opts: HfCallOptions = {}) { return this.json<LintResult>("lint", [dir], opts, true); }

  check(dir: string, opts: HfCallOptions = {}) { return this.json<CheckResult>("check", [dir], opts, true); }

  /** `review` = the beat set (each scene at its start and key moments); `at` = chosen seconds. */
  snapshot(dir: string, what: { review: true } | { at: number[] }, opts: HfCallOptions = {}) {
    return this.json<SnapshotResult>("snapshot", [dir, ...("review" in what ? ["--review"] : ["--at", what.at.join(",")])], opts, false);
  }

  /** Renders `dir` to `output`; the time limit follows `durationSec` × `fps`. */
  async render(dir: string, o: {
    output: string; quality: string; fps: number; durationSec: number; workers?: number; gpu?: boolean;
  }, opts: HfCallOptions = {}) {
    const args = [dir, "-o", o.output, "-q", RENDER_QUALITY[o.quality] ?? o.quality, "-f", String(o.fps), "--quiet"];
    if (o.workers) args.push("-w", String(o.workers));
    if (o.gpu) args.push("--gpu");
    const res = await this.run("render", args, { ...opts, timeoutMs: opts.timeoutMs ?? renderTimeoutMs(o.durationSec, o.fps) });
    if (res.exitCode !== 0) this.fail("render", res);
  }

  /** Environment check. Its top-level `ok` is false when optional tools are missing: use `requiredOk`. */
  doctor(opts: HfCallOptions = {}) { return this.json<DoctorResult>("doctor", [], opts, true); }
}

/** The checks Generate cannot run without (the rest of `doctor` is optional: whisper-cpp, Kokoro, MusicGen). */
export const REQUIRED_DOCTOR_CHECKS = ["Node.js", "FFmpeg", "Chrome"];

export function requiredOk(doctor: DoctorResult): { ok: boolean; failed: DoctorCheck[] } {
  const failed = REQUIRED_DOCTOR_CHECKS.map((name) => doctor.checks.find((c) => c.name === name) ?? { name, ok: false, detail: "missing from doctor output" })
    .filter((c) => !c.ok);
  return { ok: failed.length === 0, failed };
}
