import type { AppConfig } from "../config";
import {
  localUv, modelDir, nvidiaGpu, platformKey, readinessItems, toolsDir, venvPython,
  type Progress, type ReadinessDeps, type ReadinessItem, type ToolBuild,
} from "./checks";

interface FixState { running: boolean; progress?: Progress; error?: string; done?: Promise<void> }
type Report = (percent: number, label: string) => void;

/** Where a fix's result is remembered across restarts: the `setting` table. */
export interface Persist { get(key: string): string | undefined; set(key: string, value: string): void }

/** Separator-agnostic: a Windows path is not bare on a POSIX engine and the other way round. */
const SEP = /[\\/]/;
const bare = (p: string) => !SEP.test(p);
const parent = (p: string) => p.replace(/[\\/][^\\/]*$/, "");
const leaf = (p: string) => p.split(SEP).pop() as string;
const KEYS = { ffmpeg: "readiness.ffmpegPath", python: "readiness.pythonPath", whisper: "readiness.whisperModel" } as const;

export class UnknownItem extends Error {}
export class FixRunning extends Error {}
export class NotFixable extends Error {}

const OFFLINE = /dns error|error sending request|ENOTFOUND|ECONN|network|offline|fetch failed/i;

/** Background installs behind POST /api/readiness/:id/fix; one per item at a time. */
export class ReadinessService {
  private state = new Map<string, FixState>();
  private seq = 0;

  constructor(private readonly config: AppConfig, private readonly deps: ReadinessDeps, private readonly persist?: Persist) {
    this.restore();
  }

  /** After a restart the env still names the bare defaults; an installed result found in the settings replaces them (only while its file is there). */
  private restore() {
    const { config: c, deps: d, persist } = this;
    const saved = (key: string, file: (v: string) => string) => {
      const v = persist?.get(key);
      return v && d.exists(file(v)) ? v : undefined;
    };
    const ffmpeg = bare(c.ffmpegPath) ? saved(KEYS.ffmpeg, (v) => v) : undefined;
    if (ffmpeg) c.ffmpegPath = ffmpeg;
    const python = bare(c.pythonPath) ? saved(KEYS.python, (v) => v) : undefined;
    if (python) c.pythonPath = python;
    const model = bare(c.whisperModel) ? saved(KEYS.whisper, (v) => `${v}/model.bin`) : undefined;
    if (model) c.whisperModel = model;
  }

  async items(): Promise<ReadinessItem[]> {
    const items = await readinessItems(this.config, this.deps);
    return items.map((i) => {
      const s = this.state.get(i.id);
      if (!s) return i;
      return { ...i, ...(s.running && s.progress ? { progress: s.progress } : {}), ...(!s.running && s.error ? { error: s.error } : {}) };
    });
  }

  /** Starts the fix and returns its task id; the work goes on after this returns. */
  async start(id: string): Promise<string> {
    const item = (await readinessItems(this.config, this.deps)).find((i) => i.id === id);
    if (!item) throw new UnknownItem(id);
    if (this.state.get(id)?.running) throw new FixRunning(id);
    if (!item.fixable) throw new NotFixable(id);
    const st: FixState = { running: true, progress: { percent: 0, label: "Starting" } };
    this.state.set(id, st);
    const report: Report = (percent, label) => { st.progress = { percent: Math.max(0, Math.min(100, Math.round(percent))), label }; };
    st.done = this.fixers[id]!(report).then(
      () => { st.error = undefined; },
      (e) => { st.error = (e as Error).message || "fix failed"; },
    ).finally(() => { st.running = false; });
    return `fix-${id}-${++this.seq}`;
  }

  /** Resolves when the fix of `id` has finished (tests; the app polls). */
  async settled(id: string) { await this.state.get(id)?.done; }

  private fixers: Record<string, (report: Report) => Promise<void>> = {
    ffmpeg: async (report) => {
      const c = this.config;
      // Where the configured path points; the bare default has no folder of its own.
      const dir = bare(c.ffmpegPath) ? toolsDir(c) : parent(c.ffmpegPath);
      const bins = await this.install("ffmpeg", this.deps.manifest.ffmpeg, report, 0, 100, dir);
      c.ffmpegPath = bins[0] as string;
      this.persist?.set(KEYS.ffmpeg, c.ffmpegPath);
    },
    python: (report) => this.fixPython(report),
    whisperModel: (report) => this.fixWhisper(report),
    generateBrowser: async (report) => {
      report(5, "Downloading Chrome");
      const r = await this.deps.exec(this.config.nodePath, [this.config.hyperframesBin, "browser", "ensure"], { timeoutMs: 15 * 60_000 });
      if (r.exitCode !== 0) throw new Error(OFFLINE.test(r.stderr + r.stdout) ? "offline" : `Chrome install failed: ${r.stderr.trim().slice(-200)}`);
    },
  };

  /** Downloads a pinned archive, checks its SHA-256 (a mismatch deletes it), unpacks it into the tools folder; returns the installed binaries. */
  private async install(label: string, builds: Record<string, ToolBuild>, report: Report, from: number, to: number, dir = toolsDir(this.config)): Promise<string[]> {
    const d = this.deps;
    const build = builds[platformKey(d)];
    if (!build) throw new Error(`no ${label} build for ${platformKey(d)}`);
    if (!build.sha256) throw new Error(`no pinned checksum for ${label}`);
    const tools = dir;
    const archive = `${tools}/${label}-${build.url.split("/").pop()}`;
    const unpack = `${tools}/${label}-unpack`;
    const span = (to - from) * 0.9;
    report(from, `Downloading ${label}`);
    const sha = await d.download(build.url, archive, (p) => report(from + (p / 100) * span, `Downloading ${label}`));
    if (sha !== build.sha256) {
      d.remove(archive);
      throw new Error("checksum mismatch");
    }
    report(from + span, `Unpacking ${label}`);
    d.remove(unpack);
    d.mkdirp(unpack);
    const r = await d.exec("tar", ["-xf", archive, "-C", unpack], { timeoutMs: 10 * 60_000 });
    d.remove(archive);
    if (r.exitCode !== 0) {
      d.remove(unpack);
      throw new Error(`unpack failed: ${r.stderr.trim().slice(-200)}`);
    }
    const placed = build.bins.map((b) => {
      const dest = `${tools}/${b}`;
      d.remove(dest);
      d.rename(`${unpack}/${build.dir ? `${build.dir}/` : ""}${b}`, dest);
      return dest;
    });
    d.remove(unpack);
    report(to, `${label} installed`);
    return placed;
  }

  /** The venv the configured python lives in; the bare default, or an interpreter that is not a venv's, gets DATA_DIR/venv. */
  private venv(): { py: string; root: string } {
    const { config: c, deps: d } = this;
    const p = c.pythonPath;
    const root = parent(parent(p));
    const inVenv = !bare(p) && /^(bin|Scripts)$/.test(leaf(parent(p))) && (d.exists(`${root}/pyvenv.cfg`) || !d.exists(p));
    return inVenv ? { py: p, root } : { py: venvPython(c, d), root: `${c.dataDir}/venv` };
  }

  private async fixPython(report: Report) {
    const { config: c, deps: d } = this;
    let uv = "uv";
    const onPath = await d.exec("uv", ["--version"], { timeoutMs: 30_000 }).then((r) => r.exitCode === 0, () => false);
    if (!onPath) uv = d.exists(localUv(c, d)) ? localUv(c, d) : (await this.install("uv", d.manifest.uv, report, 0, 20))[0] as string;
    const { py, root } = this.venv();
    const run = async (label: string, percent: number, args: string[]) => {
      report(percent, label);
      const r = await d.exec(uv, args, { timeoutMs: 30 * 60_000 });
      if (r.exitCode !== 0) {
        const msg = r.stderr.trim();
        throw new Error(OFFLINE.test(msg) ? "offline" : `${label} failed: ${msg.slice(-300)}`);
      }
    };
    if (!d.exists(py)) await run(`Creating Python ${d.manifest.python}`, 25, ["venv", "--python", d.manifest.python, root]);
    await run("Installing packages", 40, ["pip", "install", "--python", py, "-r", `${c.pipelineDir}/requirements.txt`]);
    if (await nvidiaGpu(d)) await run("Installing CUDA libraries", 80, ["pip", "install", "--python", py, ...d.manifest.cudaWheels]);
    if (c.pythonPath !== py) {
      c.pythonPath = py;
      this.persist?.set(KEYS.python, py);
    }
    report(100, "Python ready");
  }

  private async fixWhisper(report: Report) {
    const { config: c, deps: d } = this;
    const files = d.manifest.whisper.files;
    const dir = modelDir(c);
    for (const [i, f] of files.entries()) {
      if (!f.sha256) throw new Error(`no pinned checksum for ${f.name}`);
      const dest = `${dir}/${f.name}`;
      const sha = await d.download(f.url, `${dest}.part`, (p) => report(((i + p / 100) / files.length) * 100, `Downloading ${f.name}`));
      if (sha !== f.sha256) {
        d.remove(`${dest}.part`);
        throw new Error("checksum mismatch");
      }
      d.remove(dest);
      d.rename(`${dest}.part`, dest);
    }
    c.whisperModel = dir;
    this.persist?.set(KEYS.whisper, dir);
    report(100, "Model ready");
  }
}
