// `sorot gen`: 2D videos from a brief (Generate). Same API as the studio's Generate window.
// Every command takes --json, so outside agents and schedulers can drive it.

import { basename } from "node:path";
import type { Json } from "./api";
import { has, num, str, UsageError, type Args } from "./args";
import { json, need, type Deps } from "./commands";
import { short, table, truncate, when } from "./format";

const BASE = "/api/generate/projects";
const WORKING = ["RUNNING", "BUILDING"];
const WAIT_MS = 30 * 60_000;
const KINDS: Record<string, string> = {
  png: "image", jpg: "image", jpeg: "image", webp: "image", svg: "image",
  ttf: "font", otf: "font", woff: "font", woff2: "font", mp3: "music", m4a: "music", wav: "music", ogg: "music",
};

const onOff = (v: unknown) => (v ? "connected" : "off");

/** Whether Generate can run here, and why not. Exit code 1 when it can't, so scripts can branch on it. */
async function statusCmd(d: Deps, a: Args): Promise<number> {
  const s = await d.api.get("/api/generate/status");
  if (json(d, a, s)) return s.available ? 0 : 1;
  d.out(`Generate: ${s.available ? "available" : "unavailable"}`);
  d.out(`  HyperFrames ${s.hyperframes.version}: ${s.hyperframes.ok ? "ok" : "not working"} · renders on the ${String(s.compute).toUpperCase()}`);
  d.out(`  LLM ${onOff(s.llm.configured)} · Jev ${onOff(s.jev.configured)} · images ${onOff(s.image.configured)} · vision ${onOff(s.vision.configured)}`);
  const engines = (s.voice.engines as string[]).join(", ") || "none";
  d.out(`  Voice engines: ${engines}${s.voice.localAvailable ? "" : ` (${s.voice.localReason})`}`);
  for (const reason of s.reasons as string[]) d.out(`  - ${reason}`);
  return s.available ? 0 : 1;
}

// ---- projects ----------------------------------------------------------------------

/** A full id, or the start of one (as `sorot gen list` shows it). */
async function projectId(d: Deps, ref: string): Promise<string> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(ref)) return ref;
  const { projects } = await d.api.get(BASE);
  const hits = (projects as Json[]).filter((p) => String(p.id).startsWith(ref));
  if (hits.length !== 1) throw new UsageError(hits.length ? `More than one project starts with ${ref}: give more of its id` : `No project starts with ${ref} (sorot gen list)`);
  return hits[0]!.id;
}

/** Follows a project until the director stops (a gate, a failure, or the start of the build). */
async function settle(d: Deps, id: string): Promise<Json> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const detail = await d.api.get(`${BASE}/${id}`);
    if (!WORKING.includes(detail.project.status) || Date.now() > deadline) return detail;
    await d.sleep(d.pollMs);
  }
}

const shotTable = (plan: Json) => table(
  ["SHOT", "SEC", "PURPOSE", "TITLE", "VISUAL"],
  (plan.shots as Json[]).map((s) => [
    s.id, s.durationSec, s.purpose, truncate((s.text as Json[]).find((t) => t.role === "title")?.value ?? (s.text as Json[])[0]?.value, 30), truncate(s.visual.description, 50),
  ]),
);

function printPlan(d: Deps, detail: Json): void {
  const current = (detail.plans as Json[])[0] as Json;
  const plan = current.plan as Json;
  d.out(`${plan.title} — revision ${current.revision}, ${current.approvedAt ? "approved" : "not approved yet"}`);
  d.out(`${plan.message}`);
  d.out(shotTable(plan));
  d.out(`Total ${plan.totalSec} s of ${detail.project.targetSec} s`);
  for (const note of plan.assumptions as string[]) d.out(`Assumed: ${note}`);
  if (!current.approvedAt) d.out(`Edit: sorot gen plan ${short(detail.project.id)} --edit   ·   change: sorot gen revise ${short(detail.project.id)} "…"   ·   approve: sorot gen approve ${short(detail.project.id)}`);
}

function printStorylines(d: Deps, detail: Json): void {
  const list = detail.project.storylines as Json[];
  list.forEach((s, i) => {
    d.out(`${i + 1}) ${s.title}${s.recommended ? " (recommended)" : ""}${s.bold ? " (bold)" : ""}${i === detail.project.pickedStoryline ? " ← picked" : ""}`);
    d.out(`   ${s.pitch}`);
    d.out(`   First 2 s: ${s.opening}`);
    d.out(`   Beats: ${(s.beats as string[]).join(" → ")}`);
  });
  d.out(`Pick one: sorot gen pick ${short(detail.project.id)} <1-${list.length}> [--note "…"]   ·   others: sorot gen storylines ${short(detail.project.id)} [--note "…"]`);
}

/** What the project is waiting for, as text; 1 when it failed. */
function report(d: Deps, a: Args, detail: Json): number {
  if (json(d, a, detail)) return detail.project.status === "FAILED" ? 1 : 0;
  const p = detail.project as Json;
  if (p.status === "FAILED") {
    d.err(`Failed: ${p.errorMessage}. Everything saved is kept; run: sorot gen retry ${short(p.id)}`);
    return 1;
  }
  if (WORKING.includes(p.status)) d.out(`Still working (${p.status}). Follow it with: sorot gen show ${short(p.id)}`);
  else if ((detail.plans as Json[]).length) printPlan(d, detail);
  else if (p.storylines) printStorylines(d, detail);
  else d.out(`${short(p.id)}: ${p.status}`);
  return 0;
}

async function newCmd(d: Deps, a: Args): Promise<number> {
  const brief = need(a, 2, 'brief ("what is the video about?")');
  const body: Json = { brief };
  if (str(a, "recipe")) body.recipeId = str(a, "recipe");
  if (str(a, "format")) body.format = str(a, "format");
  if (num(a, "length") !== undefined) body.targetSec = num(a, "length");
  if (str(a, "lang")) body.language = str(a, "lang");
  if (str(a, "style")) body.styleNotes = str(a, "style");
  if (str(a, "preset")) body.preset = str(a, "preset");
  if (has(a, "narration")) body.narration = true;
  if (has(a, "no-stop")) body.buildWithoutStopping = true;
  const { project } = await d.api.post(BASE, body);
  if (has(a, "no-wait")) {
    if (!json(d, a, project)) d.out(`Started ${project.id}. Follow it with: sorot gen show ${short(project.id)}`);
    return 0;
  }
  return report(d, a, await settle(d, project.id));
}

async function listCmd(d: Deps, a: Args): Promise<number> {
  const { projects } = await d.api.get(BASE);
  if (json(d, a, projects)) return 0;
  d.out(table(["ID", "STATUS", "FORMAT", "SEC", "CREATED", "TITLE"], (projects as Json[]).map((p) => [
    short(p.id), p.status, p.format, p.targetSec, when(p.createdAt), truncate(p.title ?? p.brief, 40),
  ])));
  return 0;
}

async function showCmd(d: Deps, a: Args): Promise<number> {
  const detail = await d.api.get(`${BASE}/${await projectId(d, need(a, 2, "project"))}`);
  if (json(d, a, detail)) return 0;
  const p = detail.project as Json;
  d.out(`${p.title ?? truncate(p.brief, 60)}  [${p.status}]  ${p.format} · ${p.targetSec} s · ${p.language} · recipe ${p.recipeId}`);
  const states = (p.stepState ?? {}) as Record<string, Json>;
  for (const step of (p.recipe?.steps ?? []) as Json[]) {
    const s = states[step.id ?? step.use];
    d.out(`  ${s ? s.status.padEnd(8) : "pending "} ${step.id ?? step.use}${s?.reason ? ` — ${s.reason}` : ""}`);
  }
  if (p.errorMessage) d.out(`Error: ${p.errorMessage}`);
  if ((detail.assets as Json[]).length) d.out(`Files: ${(detail.assets as Json[]).map((x) => `${x.kind} ${basename(x.path)}`).join(", ")}`);
  report(d, { positionals: [], flags: {} }, detail);
  return 0;
}

async function retryCmd(d: Deps, a: Args): Promise<number> {
  const id = await projectId(d, need(a, 2, "project"));
  await d.api.post(`${BASE}/${id}/retry`);
  return report(d, a, await settle(d, id));
}

async function storylinesCmd(d: Deps, a: Args): Promise<number> {
  const id = await projectId(d, need(a, 2, "project"));
  await d.api.post(`${BASE}/${id}/storylines`, { note: str(a, "note") });
  return report(d, a, await settle(d, id));
}

async function pickCmd(d: Deps, a: Args): Promise<number> {
  const ref = need(a, 2, "project");
  const n = Number(need(a, 3, "storyline number (1-3)"));
  if (!Number.isInteger(n) || n < 1) throw new UsageError("The storyline number starts at 1");
  const id = await projectId(d, ref);
  await d.api.post(`${BASE}/${id}/storylines/${n - 1}/pick`, { note: str(a, "note") });
  return report(d, a, await settle(d, id));
}

async function planCmd(d: Deps, a: Args): Promise<number> {
  const id = await projectId(d, need(a, 2, "project"));
  const detail = await d.api.get(`${BASE}/${id}`);
  const current = (detail.plans as Json[])[0];
  if (!current) throw new UsageError("This project has no plan yet");
  if (!has(a, "edit")) {
    if (!json(d, a, current)) printPlan(d, detail);
    return 0;
  }
  if (current.approvedAt) throw new UsageError("This plan is approved and locked: ask for a change with sorot gen revise");
  const editor = d.editor;
  if (!editor) throw new UsageError("Set $EDITOR (or $VISUAL) to edit the plan");
  const file = d.fs.tempPath(`plan-${short(id)}.json`);
  d.fs.writeText(file, `${JSON.stringify(current.plan, null, 2)}\n`);
  const code = await d.run([editor, file]);
  if (code !== 0) throw new UsageError(`The editor exited with code ${code}; nothing was saved`);
  let edited: unknown;
  try {
    edited = JSON.parse(d.fs.readText(file));
  } catch (e) {
    throw new UsageError(`The edited plan is not valid JSON: ${(e as Error).message}`);
  }
  if (JSON.stringify(edited) === JSON.stringify(current.plan)) {
    d.out("No changes.");
    return 0;
  }
  const saved = await d.api.put(`${BASE}/${id}/plan`, { plan: edited });
  if (json(d, a, saved)) return 0;
  d.out(`Saved as revision ${saved.plan.revision}. It needs approving: sorot gen approve ${short(id)}`);
  return 0;
}

async function reviseCmd(d: Deps, a: Args): Promise<number> {
  const ref = need(a, 2, "project");
  const request = need(a, 3, 'request ("make shot 2 shorter")');
  const id = await projectId(d, ref);
  const r = await d.api.post(`${BASE}/${id}/plan/revise`, { request });
  if (json(d, a, r)) return 0;
  d.out(`Revision ${r.plan.revision}: ${r.changeSummary || "(no summary)"}`);
  printPlan(d, await d.api.get(`${BASE}/${id}`));
  return 0;
}

async function approveCmd(d: Deps, a: Args): Promise<number> {
  const id = await projectId(d, need(a, 2, "project"));
  const detail = await d.api.get(`${BASE}/${id}`);
  const current = (detail.plans as Json[])[0];
  if (!current) throw new UsageError("This project has no plan yet");
  await d.api.post(`${BASE}/${id}/plan/approve`, { planId: current.id });
  const after = await settle(d, id);
  if (json(d, a, after)) return 0;
  d.out(`Approved revision ${current.revision}. The plan is locked; a change makes a new revision that needs approving again.`);
  return 0;
}

async function assetCmd(d: Deps, a: Args): Promise<number> {
  const ref = need(a, 2, "project");
  const file = need(a, 3, "file");
  const id = await projectId(d, ref);
  const path = file.startsWith("/") || /^[A-Za-z]:/.test(file) ? file : `${d.cwd}/${file}`;
  if (!d.fs.exists(path)) throw new UsageError(`File not found: ${file}`);
  const kind = str(a, "kind") ?? KINDS[file.split(".").pop()?.toLowerCase() ?? ""];
  if (!kind) throw new UsageError("Say what it is: --kind logo|image|font|music");
  const form = new FormData();
  form.set("file", new File([d.fs.read(path)], basename(file)));
  form.set("kind", kind);
  if (str(a, "shot")) form.set("shotId", str(a, "shot") as string);
  const r = await d.api.upload(`${BASE}/${id}/assets`, form);
  if (json(d, a, r)) return 0;
  d.out(`Uploaded ${basename(file)} as ${r.asset.kind}${r.asset.shotId ? ` for ${r.asset.shotId}` : ""}.`);
  return 0;
}

// ---- builds and verdicts ---------------------------------------------------------------

const VERSIONS = "/api/generate/versions";
const BUILD_DONE = ["BUILT", "FAILED", "CANCELLED"];
const STEP: Record<string, string> = {
  author: "Writing the scenes", check: "Checking them", render: "Rendering the video", technical: "Measuring it", creative: "Judging it",
};
const SEVERITY = { "must-fix": 0, "should-fix": 1, polish: 2 } as const;

/** A version id as given, or the newest version of the project the text starts. */
async function versionId(d: Deps, ref: string): Promise<string> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(ref)) return ref;
  const detail = await d.api.get(`${BASE}/${await projectId(d, ref)}`);
  const newest = (detail.versions as Json[])[0];
  if (!newest) throw new UsageError("This project has no build yet: sorot gen build <project>");
  return newest.id;
}

const where = (f: Json) => [f.shotId, f.fromSec === undefined ? "" : f.toSec === undefined ? `${f.fromSec} s` : `${f.fromSec} to ${f.toSec} s`].filter(Boolean).join(" · ");

/** Both verdicts: worst findings first, each with its shot, time and fix; warnings kept on purpose last. */
function printVerdicts(d: Deps, verdicts: Json[]): void {
  for (const kind of ["TECHNICAL", "CREATIVE"]) {
    const v = verdicts.find((x) => x.kind === kind);
    if (!v) {
      d.out(`${kind}: not judged yet`);
      continue;
    }
    const all = v.findings as Json[];
    d.out(`${kind}: ${v.status}  (judged by ${v.judgedBy})`);
    const live = all.filter((f) => f.state !== "kept").sort((a, b) => SEVERITY[a.severity as keyof typeof SEVERITY] - SEVERITY[b.severity as keyof typeof SEVERITY]);
    if (!live.length) d.out("  nothing to fix");
    for (const f of live) {
      d.out(`  ${String(f.severity).padEnd(10)} ${where(f)}${where(f) ? "  " : ""}${f.code}  ${f.description}`);
      if (f.suggestedFix) d.out(`  ${"".padEnd(10)} Fix: ${f.suggestedFix}`);
    }
    for (const f of all.filter((x) => x.state === "kept")) d.out(`  kept       ${f.code}${f.shotId ? ` (${f.shotId})` : ""}: ${f.keptReason ?? "no reason given"}`);
  }
}

/** Follows a build, printing each step as it starts, until it ends. */
async function followBuild(d: Deps, id: string): Promise<Json> {
  let last = "";
  const deadline = Date.now() + WAIT_MS * 2;
  for (;;) {
    const got = await d.api.get(`${VERSIONS}/${id}`);
    const v = got.version as Json;
    const line = v.status === "QUEUED" ? "Waiting in the queue…" : `${STEP[v.step] ?? "Building"}… ${v.progress ?? 0}%`;
    if (!BUILD_DONE.includes(v.status) && line !== last) d.out(line);
    last = line;
    if (BUILD_DONE.includes(v.status) || Date.now() > deadline) return got;
    await d.sleep(d.pollMs);
  }
}

async function buildCmd(d: Deps, a: Args): Promise<number> {
  const id = await projectId(d, need(a, 2, "project"));
  const { version } = await d.api.post(`${BASE}/${id}/versions`);
  if (has(a, "no-watch")) {
    if (!json(d, a, version)) d.out(`Queued version ${version.number}: ${version.id}. Follow it with: sorot gen verdicts ${short(id)}`);
    return 0;
  }
  const done = await followBuild(d, version.id);
  if (json(d, a, done)) return done.version.status === "BUILT" ? 0 : 1;
  const v = done.version as Json;
  if (v.status === "FAILED") {
    d.err(`The build failed: ${v.errorMessage}. The scenes already written are kept; build again to try once more.`);
    return 1;
  }
  if (v.status === "CANCELLED") {
    d.err("The build was cancelled.");
    return 1;
  }
  d.out(`Built version ${v.number} (${v.id}) in ${Math.round(Number(v.buildMs ?? 0) / 1000)} s.`);
  printVerdicts(d, done.verdicts as Json[]);
  d.out(`Accept it with: sorot gen accept ${short(id)}`);
  return 0;
}

async function verdictsCmd(d: Deps, a: Args): Promise<number> {
  const got = await d.api.get(`${VERSIONS}/${await versionId(d, need(a, 2, "version or project"))}`);
  if (json(d, a, got)) return 0;
  d.out(`Version ${got.version.number}: ${got.version.status}`);
  printVerdicts(d, got.verdicts as Json[]);
  return 0;
}

async function cancelCmd(d: Deps, a: Args): Promise<number> {
  const r = await d.api.post(`${VERSIONS}/${await versionId(d, need(a, 2, "version or project"))}/cancel`);
  if (!json(d, a, r)) d.out(`Version ${r.version.number}: ${r.version.status}`);
  return 0;
}

async function acceptCmd(d: Deps, a: Args): Promise<number> {
  const r = await d.api.post(`${VERSIONS}/${await versionId(d, need(a, 2, "version or project"))}/accept`);
  if (!json(d, a, r)) d.out(`Accepted. The project is now ${r.project.status}.`);
  return 0;
}

const SUBCOMMANDS: Record<string, (d: Deps, a: Args) => Promise<number>> = {
  status: statusCmd,
  new: newCmd,
  list: listCmd,
  show: showCmd,
  retry: retryCmd,
  storylines: storylinesCmd,
  pick: pickCmd,
  plan: planCmd,
  revise: reviseCmd,
  approve: approveCmd,
  asset: assetCmd,
  build: buildCmd,
  verdicts: verdictsCmd,
  cancel: cancelCmd,
  accept: acceptCmd,
};

export async function genCmd(d: Deps, a: Args): Promise<number> {
  const sub = a.positionals[1];
  const run = sub ? SUBCOMMANDS[sub] : undefined;
  if (!run) throw new UsageError(sub ? `Unknown gen command: ${sub}` : `Missing gen command (${Object.keys(SUBCOMMANDS).join(", ")})`);
  return run(d, a);
}
