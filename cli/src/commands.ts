import { basename, join, resolve } from "node:path";
import { Api, type Json } from "./api";
import { has, num, str, UsageError, type Args } from "./args";
import type { CliConfig } from "./config";
import { clock, seconds, short, table, truncate, when } from "./format";
import { genCmd } from "./generate";
import { setupCmd } from "./social";

export interface Deps {
  api: Api;
  config: CliConfig;
  out: (line: string) => void;
  err: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  /** Runs a command with the terminal attached; resolves to its exit code. */
  run: (cmd: string[], opts?: { cwd?: string }) => Promise<number>;
  /** Runs a command and captures stdout. */
  capture: (cmd: string[]) => Promise<{ code: number; stdout: string }>;
  /** All of stdin, trimmed (`--key -` reads an API key from it, out of the shell history). */
  readStdin: () => Promise<string>;
  /** stdin and stdout are a terminal, so the CLI may ask instead of failing on a missing flag. */
  isTTY: boolean;
  /** Ask one question on the terminal; `secret` hides what is typed (API keys). */
  ask: (question: string, secret?: boolean) => Promise<string>;
  fs: {
    exists: (path: string) => boolean;
    mkdir: (path: string) => void;
    copy: (from: string, to: string) => void;
    /** Writes a response body to disk; resolves to bytes written. */
    write: (path: string, res: Response) => Promise<number>;
  };
  isRoot: boolean;
  cwd: string;
  pollMs: number;
}

const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
const MARK: Record<string, string> = { COMPLETED: "✓", FAILED: "✗", IN_PROGRESS: "▶", PENDING: "·" };

export function need(a: Args, index: number, what: string): string {
  const v = a.positionals[index];
  if (!v) throw new UsageError(`Missing ${what}`);
  return v;
}

export function json(d: Deps, a: Args, data: unknown): boolean {
  if (!has(a, "json")) return false;
  d.out(JSON.stringify(data, null, 2));
  return true;
}

// ---- import / jobs ----------------------------------------------------------

/** Pipeline options from flags (only the ones given; the rest use server defaults). */
export function pipelineOptions(a: Args): Json {
  const o: Json = {};
  if (str(a, "style")) o.style = str(a, "style");
  if (str(a, "reframe")) o.reframe = str(a, "reframe");
  if (has(a, "trim")) o.silenceTrim = true;
  if (num(a, "gap") !== undefined) o.silenceGapSec = num(a, "gap");
  if (has(a, "hook")) o.hookFirst = true;
  if (has(a, "yt-captions")) o.youtubeCaptions = true;
  if (has(a, "auto-captions")) Object.assign(o, { youtubeCaptions: true, allowAutoCaptions: true });
  if (str(a, "music")) o.bgm = str(a, "music");
  if (num(a, "music-volume") !== undefined) o.bgmVolume = num(a, "music-volume");
  if (str(a, "direction")) o.direction = str(a, "direction");
  return o;
}

/**
 * The backend reads local files itself. Natively it can open the host path;
 * in Docker only data/ is mounted, so the file is copied to data/input first.
 */
export function localSource(d: Deps, path: string): string {
  const abs = resolve(d.cwd, path);
  if (!d.fs.exists(abs)) throw new UsageError(`File not found: ${path}`);
  if (d.config.mode !== "docker") return abs;
  if (!d.config.appDir) throw new UsageError("Docker install has no SOROT_APP_DIR in its config; re-run the installer");
  const name = `${Date.now().toString(36)}-${basename(abs).replace(/[^\w.-]+/g, "_")}`;
  const dir = join(d.config.appDir, "data", "input");
  d.fs.mkdir(dir);
  d.fs.copy(abs, join(dir, name));
  d.out(`Copied ${basename(abs)} into data/input/`);
  return `/app/data/input/${name}`;
}

async function importCmd(d: Deps, a: Args): Promise<number> {
  const src = need(a, 1, "YouTube URL or video file");
  const body: Json = /^https?:\/\//i.test(src) ? { url: src } : { localPath: localSource(d, src) };
  const from = str(a, "from");
  const to = str(a, "to");
  if (!!from !== !!to) throw new UsageError("Give both --from and --to, or neither");
  if (from && to) Object.assign(body, { startTime: from, endTime: to });
  const video = await d.api.post("/api/import", body);
  const job = await d.api.post("/api/process", { videoId: video.videoId, options: pipelineOptions(a) });
  d.out(`Video ${video.videoId}\nJob   ${job.jobId}`);
  if (has(a, "no-wait")) {
    d.out(`Follow it with: sorot watch ${job.jobId}`);
    return 0;
  }
  return watch(d, job.jobId as string, a);
}

/** Polls a job, printing each stage as it starts and finishes; prints the clips at the end. */
export async function watch(d: Deps, jobId: string, a: Args): Promise<number> {
  const seen = new Map<string, string>();
  for (;;) {
    const detail = await d.api.get(`/api/jobs/${jobId}`);
    for (const s of detail.stages as Json[]) {
      if (seen.get(s.stage) === s.status || s.status === "PENDING") continue;
      seen.set(s.stage, s.status);
      const took = s.status === "IN_PROGRESS" ? "" : seconds(s.startedAt, s.completedAt);
      const why = s.status === "FAILED" && s.errorMessage ? `  ${truncate(s.errorMessage, 160)}` : "";
      d.out(`${MARK[s.status] ?? "?"} ${s.stage.padEnd(13)} ${took}${why}`.trimEnd());
    }
    const job = detail.job as Json;
    if (TERMINAL.has(job.status)) {
      if (job.status !== "COMPLETED") {
        d.err(`Job ${job.status}${job.errorMessage ? `: ${job.errorMessage}` : ""}`);
        if (job.status === "FAILED") d.err(`Retry with: sorot retry ${jobId}`);
        return 1;
      }
      d.out("");
      return clipsCmd(d, { ...a, positionals: ["clips", job.videoId] });
    }
    await d.sleep(d.pollMs);
  }
}

async function jobsCmd(d: Deps, a: Args): Promise<number> {
  const { jobs } = await d.api.get("/api/jobs");
  if (json(d, a, jobs)) return 0;
  d.out(table(["JOB", "STATUS", "STAGE", "VIDEO", "CREATED", "ERROR"], (jobs as Json[]).map((j) => [
    short(j.id), j.status, j.currentStage || "-", short(j.videoId), when(j.createdAt), truncate(j.errorMessage, 60),
  ])));
  return 0;
}

async function jobCmd(d: Deps, a: Args): Promise<number> {
  const detail = await d.api.get(`/api/jobs/${need(a, 1, "job id")}`);
  if (json(d, a, detail)) return 0;
  const j = detail.job as Json;
  d.out(`Job ${j.id}  ${j.status}${j.errorMessage ? `  ${j.errorMessage}` : ""}\nVideo ${j.videoId}`);
  d.out(table(["STAGE", "STATUS", "TOOK", "ERROR"], (detail.stages as Json[]).map((s) => [
    s.stage, s.status, seconds(s.startedAt, s.completedAt) || "-", truncate(s.errorMessage, 80),
  ])));
  return 0;
}

async function jobAction(d: Deps, a: Args, action: "retry" | "cancel"): Promise<number> {
  const id = need(a, 1, "job id");
  const r = await d.api.post(`/api/jobs/${id}/${action}`);
  d.out(`Job ${r.jobId}: ${r.status}`);
  return action === "retry" && !has(a, "no-wait") ? watch(d, id, a) : 0;
}

// ---- library ----------------------------------------------------------------

async function videosCmd(d: Deps, a: Args): Promise<number> {
  const { videos } = await d.api.get("/api/videos");
  if (json(d, a, videos)) return 0;
  d.out(table(["VIDEO", "TYPE", "LENGTH", "ADDED", "TITLE"], (videos as Json[]).map((v) => [
    v.id, v.sourceType, clock(v.durationSec), when(v.createdAt), truncate(v.title ?? v.sourceUrl ?? v.filePath, 60),
  ])));
  return 0;
}

async function clipsCmd(d: Deps, a: Args): Promise<number> {
  const videoId = need(a, 1, "video id");
  let { clips } = await d.api.get(`/api/videos/${videoId}/clips`);
  const tiers = str(a, "tier")?.toUpperCase().split(",");
  if (tiers) clips = (clips as Json[]).filter((c) => tiers.includes(c.tier));
  if (json(d, a, clips)) return 0;
  d.out(table(["#", "TIER", "SCORE", "GATE", "RANGE", "LEN", "FILE", "CLIP", "TITLE"], (clips as Json[]).map((c) => [
    c.rankPos, c.tier, typeof c.score === "number" ? c.score.toFixed(2) : "-", c.gateVerdict ?? "-",
    `${clock(c.startTime)}-${clock(c.endTime)}`, `${Math.round(c.durationSec)}s`,
    c.exportStatus === "COMPLETED" ? "ready" : c.renderStatus === "COMPLETED" ? "no subs" : c.renderStatus.toLowerCase(),
    c.id, truncate(c.title, 50),
  ])));
  const ready = (clips as Json[]).filter((c) => c.exportStatus === "COMPLETED").length;
  d.out(`\n${ready} ready. Download: sorot download --video ${videoId} [--tier PRIMARY] [-o DIR]`);
  return 0;
}

async function downloadCmd(d: Deps, a: Args): Promise<number> {
  const outDir = resolve(d.cwd, str(a, "out") ?? ".");
  let clips: Json[];
  const videoId = str(a, "video");
  if (videoId) {
    const tiers = (str(a, "tier") ?? "PRIMARY,BACKUP").toUpperCase().split(",");
    clips = ((await d.api.get(`/api/videos/${videoId}/clips`)).clips as Json[])
      .filter((c) => tiers.includes(c.tier) && c.exportStatus === "COMPLETED");
  } else {
    const ids = a.positionals.slice(1);
    if (ids.length === 0) throw new UsageError("Give clip ids, or --video <id>");
    clips = [];
    for (const id of ids) clips.push((await d.api.get(`/api/clips/${id}`)).clip as Json);
  }
  if (clips.length === 0) {
    d.err("Nothing to download (no finished clips match).");
    return 1;
  }
  d.fs.mkdir(outDir);
  for (const c of clips) {
    const file = join(outDir, `${short(c.videoId)}_${String(c.rankPos ?? 0).padStart(2, "0")}_${c.tier.toLowerCase()}.mp4`);
    const bytes = await d.fs.write(file, await d.api.raw(`/api/clips/${c.id}/export`));
    d.out(`${file}  ${(bytes / 1e6).toFixed(1)} MB`);
  }
  return 0;
}

async function deleteCmd(d: Deps, a: Args): Promise<number> {
  const id = need(a, 1, "video id");
  if (!has(a, "yes")) {
    d.err(`This deletes video ${id}, its clips and files. Re-run with --yes to confirm.`);
    return 1;
  }
  await d.api.delete(`/api/videos/${id}`);
  d.out(`Deleted ${id}`);
  return 0;
}

async function rerenderCmd(d: Deps, a: Args): Promise<number> {
  const body: Json = {};
  if (str(a, "start")) body.startTime = str(a, "start");
  if (str(a, "end")) body.endTime = str(a, "end");
  const options = pipelineOptions(a);
  if (Object.keys(options).length) body.options = options;
  d.out("Re-rendering (about 20-60 s)…");
  const { clip } = await d.api.post(`/api/clips/${need(a, 1, "clip id")}/rerender`, body);
  d.out(`Done: ${clip.exportPath}`);
  return 0;
}

// ---- discovery ----------------------------------------------------------------

function printCandidates(d: Deps, a: Args, data: Json): number {
  if (json(d, a, data)) return 0;
  d.out(table(["ID", "STATUS", "SCORE", "LENGTH", "AGE", "TYPE", "CHANNEL", "TITLE"], (data.videos as Json[]).map((v) => [
    v.id, v.status, (v.predictedScore ?? v.relevanceScore ?? 0).toFixed(2), clock(v.duration),
    typeof v.ageHours === "number" && v.ageHours < 9999 ? `${Math.round(v.ageHours / 24)}d` : "?",
    v.contentType ?? "-", truncate(v.channel, 20), truncate(v.title, 50),
  ])));
  return 0;
}

/** Auto-discover: start a run, follow its tool calls, then list the picks with their reasons. */
async function autoDiscover(d: Deps, a: Args): Promise<number> {
  let run = await d.api.post("/api/discover/auto", { goal: a.positionals.slice(2).join(" "), maxResults: num(a, "max") ?? 10 });
  if (has(a, "no-wait")) {
    d.out(`Auto-discover started: ${run.id} (sorot discover auto-status ${run.id})`);
    return 0;
  }
  const quiet = has(a, "json");
  let shown = 0;
  for (;;) {
    for (const s of (run.steps as Json[]).slice(shown)) {
      const target = String(s.args.query ?? s.args.video_id ?? s.args.channel ?? "");
      if (!quiet) d.out(`  ${s.tool}${target ? ` ${truncate(target, 50)}` : ""} → ${s.result}`);
    }
    shown = run.steps.length;
    if (run.status !== "RUNNING") break;
    await d.sleep(d.pollMs);
    run = await d.api.get(`/api/discover/auto/${run.id}`);
  }
  return printRun(d, a, run);
}

function printRun(d: Deps, a: Args, run: Json): number {
  if (json(d, a, run)) return run.status === "FAILED" ? 1 : 0;
  if (run.status === "RUNNING") {
    d.out(`Running (${run.steps.length} steps so far)`);
    return 0;
  }
  if (run.status === "FAILED") {
    d.err(`Auto-discover failed: ${run.error}`);
    return 1;
  }
  d.out(run.mode === "agent" ? `Picked by ${run.model}` : `Picked by the algorithm${run.llmError ? ` (${run.llmError})` : ""}`);
  if (run.notes) d.out(`Trend: ${run.notes}`);
  printCandidates(d, a, run);
  for (const v of run.videos as Json[]) d.out(`  ${v.id}  ${(v.why as string[]).join(" · ")}`);
  return 0;
}

async function discoverCmd(d: Deps, a: Args): Promise<number> {
  const sub = a.positionals[1] ?? "candidates";
  const max = num(a, "max") ?? 20;
  const durations = { minDuration: num(a, "min-length") ?? 0, maxDuration: num(a, "max-length") ?? 0 };
  switch (sub) {
    case "search":
      return printCandidates(d, a, await d.api.post("/api/discover/search", { query: need(a, 2, "search query"), maxResults: max, ...durations }));
    case "trending":
      return printCandidates(d, a, await d.api.post("/api/discover/trending", { maxResults: max, region: str(a, "region") ?? "ID" }));
    case "auto":
      return autoDiscover(d, a);
    case "auto-status": {
      const id = a.positionals[2];
      return printRun(d, a, await d.api.get(id ? `/api/discover/auto/${id}` : "/api/discover/auto"));
    }
    case "channel":
      return printCandidates(d, a, await d.api.post("/api/discover/channel", { channelUrl: need(a, 2, "channel URL"), maxResults: max, ...durations }));
    case "candidates": {
      const status = str(a, "status");
      return printCandidates(d, a, await d.api.get(`/api/discover/candidates${status ? `?status=${encodeURIComponent(status)}` : ""}`));
    }
    case "queue": {
      const r = await d.api.post("/api/discover/queue", { ids: a.positionals.slice(2) });
      d.out(`Queued ${r.count}`);
      return 0;
    }
    case "skip": {
      for (const id of a.positionals.slice(2)) await d.api.post(`/api/discover/candidates/${id}/status`, { status: "SKIPPED" });
      d.out(`Skipped ${a.positionals.length - 2}`);
      return 0;
    }
    case "drain": {
      const r = await d.api.post("/api/discover/queue/drain");
      for (const s of r.started as Json[]) d.out(`started job ${s.jobId} (video ${s.videoId})`);
      for (const f of r.failed as Json[]) d.err(`failed ${f.discoveredId}: ${f.error}`);
      return (r.failed as Json[]).length ? 1 : 0;
    }
    default:
      throw new UsageError(`Unknown discover command: ${sub}`);
  }
}

async function channelsCmd(d: Deps, a: Args): Promise<number> {
  const sub = a.positionals[1] ?? "list";
  if (sub === "reseed") {
    const r = await d.api.post("/api/discover/channels/reseed");
    d.out(`${r.upserted} new channels, ${r.alreadyKnown} known, ${r.queued} being profiled in the background`);
    return 0;
  }
  if (sub === "refresh") {
    const r = await d.api.post(`/api/discover/channels/${need(a, 2, "channel id")}/refresh`);
    d.out(`${r.channel.channelName}: ${r.channel.status}${r.rejected ? " (rejected)" : ""}`);
    return 0;
  }
  if (sub === "set") {
    const c = await d.api.post(`/api/discover/channels/${need(a, 2, "channel id")}/status`, { status: need(a, 3, "status (ACTIVE, PAUSED, REJECTED)") });
    d.out(`${c.channelName}: ${c.status}`);
    return 0;
  }
  if (sub !== "list") throw new UsageError(`Unknown channels command: ${sub}`);
  const status = str(a, "status");
  const data = await d.api.get(`/api/discover/channels${status ? `?status=${encodeURIComponent(status)}` : ""}`);
  if (json(d, a, data.channels)) return 0;
  d.out(table(["ID", "STATUS", "CATEGORY", "AVG LEN", "MEDIAN VIEWS", "/WEEK", "CHANNEL"], (data.channels as Json[]).map((c) => [
    c.id, c.status, c.primaryCategory, clock(c.avgDurationSec), c.medianViewCount,
    typeof c.uploadsPerWeek === "number" ? c.uploadsPerWeek.toFixed(1) : "-", truncate(c.channelName, 40),
  ])));
  return 0;
}

// ---- connections (LLM, Jev, Tebar) -----------------------------------------------

const CONNECTIONS = ["llm", "jev", "tebar"];
const yesNo = (v: unknown) => (v ? "yes" : "no");

function showConnections(d: Deps, a: Args, s: Json): number {
  if (json(d, a, s)) return 0;
  d.out(table(["CONNECTION", "ACTIVE", "URL", "MODEL", "KEY", "SAVED HERE"], CONNECTIONS.map((k) => {
    const c = s[k] as Json;
    return [k, c.enabled === false ? "off" : yesNo(c.active), c.baseUrl ?? c.url, c.model ?? "-", c.apiKeySet ? c.apiKey : "-",
      (c.saved as string[]).join(",") || "-"];
  })));
  const llm = s.llm as Json;
  const jev = s.jev as Json;
  d.out(`\nJev picks moments, hooks and titles: ${jev.director ? "on" : "off"} (wins over the LLM director when Jev is active)`);
  d.out(`LLM director (brief + own clip picks): ${llm.director ? "on" : "off"}`);
  d.out("Guided: sorot connect setup   ·   change one: sorot connect llm --base-url URL --model M [--key -]   ·   test: sorot connect test llm");
  return 0;
}

/**
 * Show or change the LLM / Jev / Tebar connections. Saved in the app (they
 * win over .env); --reset goes back to the server's env values. `--key -`
 * reads the key from stdin so it stays out of the shell history.
 */
async function connectCmd(d: Deps, a: Args): Promise<number> {
  const sub = a.positionals[1];
  if (!sub || sub === "show") return showConnections(d, a, await d.api.get("/api/settings"));
  if (sub === "setup") return setupCmd(d);
  if (sub === "test") {
    const kind = need(a, 2, "connection (llm, jev or tebar)");
    const r = await d.api.post(`/api/settings/${kind}/test`);
    if (json(d, a, r)) return r.ok ? 0 : 1;
    if (r.ok) d.out(`${kind}: OK in ${r.ms} ms${r.model ? ` (${r.model})` : ""}${r.detail ? ` — ${r.detail}` : ""}`);
    else d.err(`${kind}: ${r.error}`);
    return r.ok ? 0 : 1;
  }
  if (!CONNECTIONS.includes(sub)) throw new UsageError(`Unknown connection: ${sub} (llm, jev or tebar)`);
  const patch: Json = {};
  if (has(a, "reset")) {
    const fields = sub === "llm" ? ["enabled", "baseUrl", "model", "apiKey", "director"]
      : sub === "jev" ? ["enabled", "url", "model", "apiKey", "director"] : ["enabled", "baseUrl", "apiKey"];
    for (const f of fields) patch[f] = null;
  }
  // Not --url: that one is the global "which sorot server" option.
  if (str(a, "base-url") !== undefined) patch[sub === "jev" ? "url" : "baseUrl"] = str(a, "base-url");
  if (str(a, "model") !== undefined) patch.model = str(a, "model");
  const key = str(a, "key");
  if (key !== undefined) patch.apiKey = key === "-" ? await d.readStdin() : key;
  if (has(a, "on") && has(a, "off")) throw new UsageError("Give --on or --off, not both");
  if (has(a, "on")) patch.enabled = true;
  if (has(a, "off")) patch.enabled = false;
  const director = str(a, "director");
  if (director !== undefined) {
    if (sub === "tebar" || !["on", "off"].includes(director)) throw new UsageError("--director takes on or off (llm or jev)");
    patch.director = director === "on";
  }
  if (!Object.keys(patch).length) throw new UsageError("Nothing to change: give --base-url, --model, --key, --on/--off or --reset");
  return showConnections(d, a, await d.api.put(`/api/settings/${sub}`, patch));
}

// ---- misc ---------------------------------------------------------------------

async function optionsCmd(d: Deps, a: Args): Promise<number> {
  const [opts, music] = await Promise.all([d.api.get("/api/options"), d.api.get("/api/music")]);
  if (json(d, a, { ...opts, music: music.tracks })) return 0;
  d.out(`Caption styles  ${(opts.styles as string[]).join(", ")}`);
  d.out(`Framing         ${(opts.reframeModes as string[]).join(", ")}`);
  d.out(`Music           ${(music.tracks as string[]).join(", ") || "(none — put .mp3/.m4a files in data/music)"}`);
  d.out(`Defaults        ${Object.entries(opts.defaults as Json).map(([k, v]) => `${k}=${v === "" ? '""' : v}`).join(" ")}`);
  return 0;
}

export const COMMANDS: Record<string, (d: Deps, a: Args) => Promise<number>> = {
  import: importCmd,
  watch: (d, a) => watch(d, need(a, 1, "job id"), a),
  jobs: jobsCmd,
  job: jobCmd,
  retry: (d, a) => jobAction(d, a, "retry"),
  cancel: (d, a) => jobAction(d, a, "cancel"),
  videos: videosCmd,
  clips: clipsCmd,
  download: downloadCmd,
  delete: deleteCmd,
  rerender: rerenderCmd,
  discover: discoverCmd,
  channels: channelsCmd,
  options: optionsCmd,
  connect: connectCmd,
  gen: genCmd,
};
