import type { AppConfig } from "./config";
import type { Json } from "./types";

export interface ProcResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

export interface SpawnOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: Record<string, string>;
  /** Keep only the last N chars of stdout (default: keep all). */
  stdoutTail?: number;
  /** Keep only the last N chars of stderr — a rogue tqdm stream can't OOM us. */
  stderrTail?: number;
}

/** Runs an external command (ffmpeg, yt-dlp). Injectable for tests. */
export type ExecFn = (cmd: string, args: string[], opts?: SpawnOptions) => Promise<ProcResult>;

export interface ScriptOptions {
  signal?: AbortSignal;
  timeoutMinutes?: number;
}

/** Runs an ai-pipeline script and returns its `data` envelope field. */
export type ScriptRunner = (script: string, args: string[], opts?: ScriptOptions) => Promise<Json>;

const STDERR_TAIL = 64 * 1024;
// Grace period for pipe drains after the child exits. A killed Python parent
// can leave an ffmpeg grandchild holding the pipes open.
const DRAIN_GRACE_MS = 5_000;

export const SCRIPT_TIMEOUT_MINUTES: Record<string, number> = {
  "transcribe.py": 20,
  "score.py": 10,
  "render.py": 30,
  "subtitle.py": 10,
  "variation.py": 10,
  "analytics.py": 5,
  "segment.py": 2,
  "discover.py": 5,
};
const DEFAULT_TIMEOUT_MINUTES = 15;

async function drain(stream: ReadableStream<Uint8Array>, tail?: number): Promise<string> {
  const decoder = new TextDecoder();
  let buf = "";
  let truncated = false;
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    if (tail !== undefined && buf.length > tail * 2) {
      buf = buf.slice(-tail);
      truncated = true;
    }
  }
  buf += decoder.decode();
  if (tail !== undefined && buf.length > tail) {
    buf = buf.slice(-tail);
    truncated = true;
  }
  return truncated ? `…[truncated]…\n${buf}` : buf;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const spawnCapture: ExecFn = async (cmd, args, opts = {}) => {
  const proc = Bun.spawn({
    cmd: [cmd, ...args],
    env: { ...process.env, ...opts.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  let aborted = false;
  const kill = () => { try { proc.kill("SIGKILL"); } catch { /* already gone */ } };
  const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs) : null;
  const onAbort = () => { aborted = true; kill(); };
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener("abort", onAbort, { once: true });

  let stdout = "";
  let stderr = "";
  const drains = Promise.all([
    drain(proc.stdout, opts.stdoutTail).then((s) => { stdout = s; }),
    drain(proc.stderr, opts.stderrTail ?? STDERR_TAIL).then((s) => { stderr = s; }),
  ]);
  try {
    const exitCode = await proc.exited;
    await Promise.race([drains, sleep(DRAIN_GRACE_MS)]);
    return { exitCode, stdout, stderr, timedOut, aborted };
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
};

/** Parse stdout as JSON; tolerate log noise by falling back to the last line. */
export function parseEnvelope(stdout: string): Json {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed) as Json;
  } catch {
    const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
    const last = lines.at(-1);
    if (last) {
      try { return JSON.parse(last) as Json; } catch { /* fall through */ }
    }
    throw new Error(`invalid JSON on stdout: ${trimmed.slice(0, 300)}`);
  }
}

export function createPythonRunner(config: AppConfig, exec: ExecFn = spawnCapture): ScriptRunner {
  return async (script, args, opts = {}) => {
    const minutes = opts.timeoutMinutes ?? SCRIPT_TIMEOUT_MINUTES[script] ?? DEFAULT_TIMEOUT_MINUTES;
    const scriptPath = `${config.pipelineDir}/${script}`;
    console.info(`Running Python script: ${config.pythonPath} ${scriptPath} ${args.join(" ")}`);

    const res = await exec(config.pythonPath, [scriptPath, ...args], {
      signal: opts.signal,
      timeoutMs: minutes * 60_000,
      env: { PYTHONIOENCODING: "utf-8" },
    });

    if (res.stderr.trim()) console.info(`Python stderr [${script}]: ${res.stderr.trim()}`);
    if (res.aborted) throw new Error("Job cancelled by user");
    if (res.timedOut) {
      throw new Error(
        `Python script ${script} exceeded ${minutes} min wall-clock budget; killed. stderr tail: ${res.stderr}`,
      );
    }
    if (res.exitCode !== 0) {
      throw new Error(`Python script ${script} failed (exit=${res.exitCode}): ${res.stderr}`);
    }

    let envelope: Json;
    try {
      envelope = parseEnvelope(res.stdout);
    } catch (e) {
      throw new Error(`Python script ${script} returned ${(e as Error).message}`);
    }
    if (envelope.success !== true) {
      const err = typeof envelope.error === "string" ? envelope.error : "Unknown error";
      throw new Error(`Python script ${script} error: ${err}`);
    }
    const data = envelope.data;
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Json) : {};
  };
}
