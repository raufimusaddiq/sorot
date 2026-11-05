// `sorot gen`: 2D videos from a brief (Generate). Same API as the studio's Generate window.
// Every command takes --json, so outside agents and schedulers can drive it.

import { basename, join, resolve } from "node:path";
import type { Json } from "./api";
import { has, num, str, UsageError, type Args } from "./args";
import { json, need, type Deps } from "./commands";
import { short, table, truncate, when } from "./format";
import { zipStored } from "./zip";

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

/** The project's current plan (a restore makes an older revision current), else the newest. */
const currentPlan = (detail: Json): Json | undefined => (detail.plans as Json[]).find((p) => p.id === detail.project.currentPlanId) ?? (detail.plans as Json[])[0];

function printPlan(d: Deps, detail: Json): void {
  const current = currentPlan(detail) as Json;
  const plan = current.plan as Json;
  d.out(`${plan.title} — revision ${current.revision}, ${current.approvedAt ? "approved" : "not approved yet"}`);
  d.out(`${plan.message}`);
  d.out(shotTable(plan));
  d.out(`Total ${plan.totalSec} s of ${detail.project.targetSec} s`);
  for (const note of plan.assumptions as string[]) d.out(`Assumed: ${note}`);
  for (const note of (plan.effectNotes ?? []) as string[]) d.out(`Effect: ${note}`);
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
  if (has(a, "no-narration")) body.narration = false;   // neither: a recipe with a voice step speaks
  if (has(a, "no-stop")) body.buildWithoutStopping = true;
  if (has(a, "no-numbers")) body.forbiddenNumbers = true;
  if (str(a, "facts")) body.facts = readFactsFile(d, str(a, "facts") as string);
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
  const current = currentPlan(detail);
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
  const current = currentPlan(detail);
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
      d.out(`  ${String(f.severity).padEnd(10)} ${where(f)}${where(f) ? "  " : ""}${f.code}  ${f.description}${Number(f.count) > 1 ? ` (x${f.count})` : ""}`);
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

/** Follows a queued version to its end (or returns at once with --no-watch) and prints both verdicts. */
async function watchBuild(d: Deps, a: Args, id: string, version: Json): Promise<number> {
  if (has(a, "no-watch")) {
    if (!json(d, a, version)) d.out(`Queued version ${version.number}: ${version.id}. Follow it with: sorot gen verdicts ${short(id)}`);
    return 0;
  }
  const done = await followBuild(d, version.id);
  if (json(d, a, done)) return done.version.status === "BUILT" ? 0 : 1;
  const v = done.version as Json;
  if (v.status === "FAILED") {
    d.err(`The build failed: ${v.errorMessage}. The scenes already written are kept; go on from the failed step with: sorot gen resume <project>`);
    return 1;
  }
  if (v.status === "CANCELLED") {
    d.err("The build was cancelled.");
    return 1;
  }
  d.out(`Built version ${v.number} (${v.id}) in ${Math.round(Number(v.buildMs ?? 0) / 1000)} s.`);
  printVerdicts(d, done.verdicts as Json[]);
  d.out(`Accept it with: sorot gen accept ${short(id)}  ·  fix what is left: sorot gen fix ${short(id)}`);
  return 0;
}

async function buildCmd(d: Deps, a: Args): Promise<number> {
  const id = await projectId(d, need(a, 2, "project"));
  const { version } = await d.api.post(`${BASE}/${id}/versions`);
  return watchBuild(d, a, id, version);
}

/** A new version that fixes findings (the open must-fix ones, or --finding ids) or follows a --note, optionally on one --shot. */
async function fixCmd(d: Deps, a: Args): Promise<number> {
  const vid = await versionId(d, need(a, 2, "version or project"));
  const body: Json = {};
  if (str(a, "finding")) body.findingIds = str(a, "finding")!.split(",").filter(Boolean);
  if (str(a, "note")) body.note = str(a, "note");
  if (str(a, "shot")) body.shotId = str(a, "shot");
  const r = await d.api.post(`${VERSIONS}/${vid}/fix`, body);
  if (r.needsApproval) {
    if (!json(d, a, r)) {
      d.out(`${r.summary}`);
      d.out(`The plan's words or timing changed, so it needs your approval before anything is built: sorot gen plan ${short(r.plan.projectId)}  ·  approve: sorot gen approve ${short(r.plan.projectId)}`);
    }
    return 0;
  }
  if (!has(a, "json")) d.out(`${r.summary}`);
  return watchBuild(d, a, r.version.projectId, r.version);
}

/** The finished video of a version: rendered at full quality into the Library, and saved to --out when given. */
async function exportCmd(d: Deps, a: Args): Promise<number> {
  const vid = await versionId(d, need(a, 2, "version or project"));
  const body: Json = {};
  if (str(a, "title")) body.title = str(a, "title");
  if (str(a, "description")) body.description = str(a, "description");
  const { export: made } = await d.api.post(`${VERSIONS}/${vid}/export`, body);
  const dir = str(a, "out") ? resolve(d.cwd, str(a, "out")!) : null;
  let saved: string | null = null;
  if (dir) {
    d.fs.mkdir(dir);
    saved = join(dir, `${short(made.id)}.mp4`);
    await d.fs.write(saved, await d.api.raw(`/api/generate/exports/${made.id}/file?download=1`));
  }
  if (json(d, a, { ...made, ...(saved ? { savedTo: saved } : {}) })) return 0;
  d.out(`Exported "${made.title}" (${made.durationSec} s, ${made.format}): ${made.id}`);
  if (saved) d.out(saved);
  d.out(`Post it with: sorot publish --generated ${made.id} --to <accounts>`);
  return 0;
}

/** Makes the plan a version was built from the current plan again. */
async function restoreCmd(d: Deps, a: Args): Promise<number> {
  const r = await d.api.post(`${VERSIONS}/${await versionId(d, need(a, 2, "version or project"))}/restore`);
  if (!json(d, a, r)) d.out(`Restored. Build again with: sorot gen build ${short(r.project.id)}`);
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

/** A failed build goes on from its failed step (same version; finished steps and shots are kept). */
async function resumeCmd(d: Deps, a: Args): Promise<number> {
  const vid = await versionId(d, need(a, 2, "version or project"));
  const { version } = await d.api.post(`${VERSIONS}/${vid}/retry`);
  return watchBuild(d, a, String(version.projectId), version);
}

async function acceptCmd(d: Deps, a: Args): Promise<number> {
  const r = await d.api.post(`${VERSIONS}/${await versionId(d, need(a, 2, "version or project"))}/accept`);
  if (!json(d, a, r)) d.out(`Accepted. The project is now ${r.project.status}.`);
  return 0;
}

// ---- facts -------------------------------------------------------------------------

/** One fact per line: `claim | value | https://address` (the value is optional). Headings and blank lines are skipped; a leading "- " is fine. */
export function parseFacts(text: string, from: string): Json[] {
  return text.split("\n").map((l) => l.trim().replace(/^[-*]\s+/, "")).filter((l) => l && !l.startsWith("#")).map((line) => {
    const parts = line.split("|").map((x) => x.trim());
    const sourceUrl = parts.at(-1) ?? "";
    if (parts.length < 2 || !parts[0] || !/^https?:\/\//i.test(sourceUrl)) throw new UsageError(`${from}: "${line.slice(0, 50)}" is not  claim | value | https://address`);
    return { claim: parts[0], ...(parts.length > 2 && parts[1] ? { value: parts[1] } : {}), sourceUrl };
  });
}

function readFactsFile(d: Deps, file: string): Json[] {
  const path = resolve(d.cwd, file);
  if (!d.fs.exists(path)) throw new UsageError(`No such file: ${file}`);
  return parseFacts(d.fs.readText(path), file);
}

function printFacts(d: Deps, facts: Json[]): void {
  if (!facts.length) return d.out("No facts yet. Add one: sorot gen facts add <project> \"claim\" --source https://…");
  d.out(table(["ID", "STATUS", "CLAIM", "VALUE", "SOURCE"], facts.map((f) => [short(f.id), f.status, truncate(f.claim, 44), f.value ?? "-", truncate(f.sourceUrl ?? "-", 40)])));
  for (const f of facts.filter((x) => x.originalValue)) d.out(`  ${short(f.id)} was ${f.originalValue}: ${f.evidence ?? ""}`);
  for (const f of facts.filter((x) => x.status === "unverifiable" && x.evidence)) d.out(`  ${short(f.id)} not verifiable: ${f.evidence}`);
}

/** A fact by the start of its id, in this project. */
async function factId(d: Deps, project: string, ref: string): Promise<string> {
  const { facts } = await d.api.get(`${BASE}/${project}/facts`);
  const hits = (facts as Json[]).filter((f) => String(f.id).startsWith(ref));
  if (hits.length !== 1) throw new UsageError(hits.length ? `More than one fact starts with ${ref}` : `No fact starts with ${ref} (sorot gen facts <project>)`);
  return hits[0]!.id;
}

/** sorot gen facts <project> | add <project> "claim" --source URL [--value V] | rm <project> <fact> | verify <project> */
async function factsCmd(d: Deps, a: Args): Promise<number> {
  const sub = a.positionals[2];
  const known = sub === "add" || sub === "rm" || sub === "verify";
  const project = await projectId(d, need(a, known ? 3 : 2, "project"));
  if (sub === "verify") {
    d.out("Checking the facts against their sources…");
    const { facts } = await d.api.post(`${BASE}/${project}/facts/verify`);
    if (!json(d, a, facts)) printFacts(d, facts as Json[]);
    return (facts as Json[]).some((f) => f.status === "unverifiable") ? 1 : 0;
  }
  if (sub === "add") {
    const source = str(a, "source");
    if (!source) throw new UsageError("Give the page that states it: --source https://…");
    const { fact } = await d.api.post(`${BASE}/${project}/facts`, { claim: need(a, 4, "claim"), sourceUrl: source, ...(str(a, "value") ? { value: str(a, "value") } : {}) });
    if (!json(d, a, fact)) d.out(`Added ${short(fact.id)}. Check it with: sorot gen facts verify ${short(project)}`);
    return 0;
  }
  if (sub === "rm") {
    await d.api.delete(`/api/generate/facts/${await factId(d, project, need(a, 4, "fact"))}`);
    if (!json(d, a, { deleted: true })) d.out("Deleted.");
    return 0;
  }
  const { facts } = await d.api.get(`${BASE}/${project}/facts`);
  if (!json(d, a, facts)) printFacts(d, facts as Json[]);
  return 0;
}

// ---- ideas, unattended runs, files, past work -----------------------------------------

const IDEAS = "/api/generate/ideas";

function printIdeas(d: Deps, ideas: Json[]): void {
  if (!ideas.length) return d.out("No ideas yet. Add one: sorot gen idea add BRIEF.md");
  d.out(table(["ID", "STATUS", "SLUG", "BRIEF"], ideas.map((i) => [truncate(i.id, 14), i.status, truncate(i.slug, 24), truncate(String(i.brief).replace(/\s+/g, " "), 50)])));
}

async function ideasCmd(d: Deps, a: Args): Promise<number> {
  const { ideas } = await d.api.get(`${IDEAS}${str(a, "status") ? `?status=${str(a, "status")}` : ""}`);
  if (!json(d, a, ideas)) printIdeas(d, ideas as Json[]);
  return 0;
}

/** sorot gen idea add BRIEF.md [--id IDEA-042] [--slug s] [--facts facts.md] [--length S --lang L --format F --preset P --narration|--no-narration --no-numbers] | show <id> */
async function ideaCmd(d: Deps, a: Args): Promise<number> {
  const sub = a.positionals[2];
  if (sub === "show") {
    const got = await d.api.get(`${IDEAS}/${need(a, 3, "idea id")}`);
    if (json(d, a, got)) return 0;
    const i = got.idea as Json;
    d.out(`${i.slug} (${i.id}): ${i.status}${i.projectId ? ` · video ${short(i.projectId)}` : ""}`);
    d.out(String(i.brief));
    if (i.flags) d.out(`Flags: ${JSON.stringify(i.flags)}`);
    for (const f of got.facts as Json[]) d.out(`Fact: ${f.claim}${f.value ? ` (${f.value})` : ""} — ${f.sourceUrl}`);
    return 0;
  }
  if (sub !== "add") throw new UsageError("Use: sorot gen idea add BRIEF.md | idea show <id>   (list them with: sorot gen ideas)");
  const file = need(a, 3, "BRIEF.md");
  const path = resolve(d.cwd, file);
  if (!d.fs.exists(path)) throw new UsageError(`No such file: ${file}`);
  const slug = str(a, "slug") ?? basename(file).replace(/\.[^.]*$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const body: Json = { slug, brief: d.fs.readText(path).trim() };
  if (str(a, "id")) body.id = str(a, "id");
  if (str(a, "facts")) body.facts = readFactsFile(d, str(a, "facts") as string);
  // the same choices as gen new, kept on the idea for the run that takes it
  const flags: Json = {};
  if (num(a, "length") !== undefined) flags.targetSec = num(a, "length");
  if (str(a, "lang")) flags.language = str(a, "lang");
  if (str(a, "format")) flags.format = str(a, "format");
  if (str(a, "preset")) flags.preset = str(a, "preset");
  if (has(a, "narration")) flags.narration = true;
  if (has(a, "no-narration")) flags.narration = false;
  if (has(a, "no-numbers")) flags.market_data = false;
  if (Object.keys(flags).length) body.flags = flags;
  const { idea } = await d.api.post(IDEAS, body);
  if (!json(d, a, idea)) d.out(`Added ${idea.slug} (${idea.id}). Run it with: sorot gen run --recipe <id> --idea ${idea.id}`);
  return 0;
}

const RUN_END = ["EXPORTED", "FAILED", "WAITING"];

/**
 * sorot gen run --recipe <id> [--idea ID] [--json]: an unattended run. Without --idea it takes the
 * recipe's next new idea (and moves the cursor); with one, that idea is started or resumed. It waits
 * for the end and exits 0 only when a video was exported.
 */
async function runCmd(d: Deps, a: Args): Promise<number> {
  const { project } = await d.api.post("/api/generate/run", { recipeId: str(a, "recipe") ?? "quick", ...(str(a, "idea") ? { ideaId: str(a, "idea") } : {}) });
  if (has(a, "no-wait")) {
    if (!json(d, a, project)) d.out(`Started ${project.id}. Follow it with: sorot gen show ${short(project.id)}`);
    return 0;
  }
  const deadline = Date.now() + WAIT_MS * 2;
  let detail: Json;
  for (;;) {
    detail = await d.api.get(`${BASE}/${project.id}`);
    const newest = (detail.versions as Json[])[0];
    const technicalFailed = !!newest && newest.status === "BUILT" && detail.verdictStatuses?.[newest.id]?.TECHNICAL === "FAIL";
    if (RUN_END.includes(detail.project.status) || technicalFailed || Date.now() > deadline) break;
    await d.sleep(d.pollMs);
  }
  const p = detail.project as Json;
  const exported = (detail.exports as Json[])[0];
  if (json(d, a, detail)) return p.status === "EXPORTED" ? 0 : 1;
  if (p.status === "EXPORTED" && exported) {
    d.out(`Exported "${exported.title}": ${exported.id}\nPost it with: sorot publish --generated ${exported.id} --to <accounts>`);
    return 0;
  }
  if (p.status === "FAILED") d.err(`The run failed: ${p.errorMessage}. Run it again to retry: sorot gen run --recipe ${str(a, "recipe") ?? "quick"} --idea ${p.ideaId ?? "<ID>"}`);
  else if (p.status === "WAITING") d.err(`The run is waiting for you at a gate. Pass it in the window or: sorot gen approve-step ${short(p.id)} <step>`);
  else d.err(`The run stopped with the video ${p.status}. See: sorot gen verdicts ${short(p.id)}`);
  return 1;
}

/** sorot gen files <project> [<name>]: the mirrored files, listed or printed. */
async function filesCmd(d: Deps, a: Args): Promise<number> {
  const id = await projectId(d, need(a, 2, "project"));
  const name = a.positionals[3];
  if (name) {
    d.out((await (await d.api.raw(`${BASE}/${id}/files/${name}`)).text()).trimEnd());
    return 0;
  }
  const { files } = await d.api.get(`${BASE}/${id}/files`);
  if (!json(d, a, files)) for (const f of files as string[]) d.out(f);
  return 0;
}

/** sorot gen import-history <file.json>: past concepts and ideas (see docs/generate.md for the shape). */
async function importHistoryCmd(d: Deps, a: Args): Promise<number> {
  const file = need(a, 2, "file.json");
  const path = resolve(d.cwd, file);
  if (!d.fs.exists(path)) throw new UsageError(`No such file: ${file}`);
  let body: unknown;
  try {
    body = JSON.parse(d.fs.readText(path));
  } catch (e) {
    throw new UsageError(`${file} is not valid JSON: ${(e as Error).message}`);
  }
  const r = await d.api.post("/api/generate/import-history", body);
  if (!json(d, a, r)) d.out(`Imported ${r.concepts} concept${r.concepts === 1 ? "" : "s"} and ${r.ideas} idea${r.ideas === 1 ? "" : "s"}; ${r.skipped} already there.`);
  return 0;
}

// ---- recipes -----------------------------------------------------------------------

const RECIPES = "/api/generate/recipes";

async function stepsCmd(d: Deps, a: Args): Promise<number> {
  const { steps } = await d.api.get("/api/generate/steps");
  if (json(d, a, steps)) return 0;
  d.out(table(["STEP", "GATES", "SETTINGS"], (steps as Json[]).map((s) => [s.type, (s.gates as string[]).join(", "), Object.keys(s.fields).join(", ") || "-"])));
  return 0;
}

async function recipesCmd(d: Deps, a: Args): Promise<number> {
  const { recipes } = await d.api.get(RECIPES);
  if (json(d, a, recipes)) return 0;
  d.out(table(["ID", "NAME", "VER", "KIND", "RUNS HERE"], (recipes as Json[]).map((r) => [
    r.id, r.name, r.version, r.builtIn ? "example" : "yours", r.available ? "yes" : `no: ${(r.reasons as string[])[0]}`,
  ])));
  return 0;
}

/** A recipe from a .json file or, otherwise, by its id. */
async function recipeFrom(d: Deps, ref: string): Promise<Json> {
  if (ref.endsWith(".json") || d.fs.exists(ref)) {
    try {
      return JSON.parse(d.fs.readText(resolve(d.cwd, ref)));
    } catch (e) {
      throw new UsageError(`${ref} is not valid JSON: ${(e as Error).message}`);
    }
  }
  return (await d.api.get(`${RECIPES}/${ref}`)).recipe.recipe;
}

function printProblems(d: Deps, r: Json): void {
  for (const e of r.errors as string[]) d.out(`✗ ${e}`);
  for (const w of r.warnings as string[]) d.out(`⚠ ${w}`);
  if (r.ok) d.out("The recipe is valid.");
}

/** sorot gen recipe show|new|copy|edit|validate|export|import|delete */
async function recipeCmd(d: Deps, a: Args): Promise<number> {
  const sub = a.positionals[2];
  const arg = (n: number, what: string) => need(a, n, what);
  switch (sub) {
    case "show": {
      const r = (await d.api.get(`${RECIPES}/${arg(3, "recipe id")}`)).recipe;
      if (!json(d, a, r)) d.out(JSON.stringify(r.recipe, null, 2));
      return 0;
    }
    case "new":
    case "copy": {
      const from = sub === "new" ? (str(a, "from") ?? "quick") : arg(3, "recipe to copy");
      const id = arg(sub === "new" ? 3 : 4, "id for the new recipe");
      const { recipe } = await d.api.post(RECIPES, { fromId: from, id, name: str(a, "name") ?? id });
      if (!json(d, a, recipe)) d.out(`Created ${recipe.id} from ${from}. Change it with: sorot gen recipe edit ${recipe.id}`);
      return 0;
    }
    case "edit": {
      const id = arg(3, "recipe id");
      const current = (await d.api.get(`${RECIPES}/${id}`)).recipe;
      if (current.builtIn) throw new UsageError("An example can't be edited: copy it first (sorot gen recipe copy)");
      if (!d.editor) throw new UsageError("Set $EDITOR (or $VISUAL) to edit the recipe");
      const file = d.fs.tempPath(`recipe-${id}.json`);
      d.fs.writeText(file, `${JSON.stringify(current.recipe, null, 2)}
`);
      const code = await d.run([d.editor, file]);
      if (code !== 0) throw new UsageError(`The editor exited with code ${code}; nothing was saved`);
      let edited: unknown;
      try {
        edited = JSON.parse(d.fs.readText(file));
      } catch (e) {
        throw new UsageError(`The edited recipe is not valid JSON: ${(e as Error).message}`);
      }
      if (JSON.stringify(edited) === JSON.stringify(current.recipe)) {
        d.out("No changes.");
        return 0;
      }
      const saved = (await d.api.put(`${RECIPES}/${id}`, { recipe: edited })).recipe;
      if (!json(d, a, saved)) d.out(`Saved ${id} as version ${saved.version}.`);
      return 0;
    }
    case "validate": {
      const r = await d.api.post(`${RECIPES}/validate`, { recipe: await recipeFrom(d, arg(3, "recipe id or .json file")) });
      if (!json(d, a, r)) printProblems(d, r);
      return r.ok ? 0 : 1;
    }
    case "export": {
      const id = arg(3, "recipe id");
      const text = await (await d.api.raw(`${RECIPES}/${id}/export`)).text();
      const out = str(a, "out");
      if (!out) {
        d.out(text);
        return 0;
      }
      d.fs.writeText(resolve(d.cwd, out), `${text}
`);
      d.out(`Saved ${out}`);
      return 0;
    }
    case "import": {
      const { recipe } = await d.api.post(`${RECIPES}/import`, { recipe: await recipeFrom(d, arg(3, ".json file")) });
      if (!json(d, a, recipe)) d.out(`Imported ${recipe.id}. A command or connection it names must be set up in Settings first (sorot gen recipes shows if it runs here).`);
      return 0;
    }
    case "delete": {
      const id = arg(3, "recipe id");
      await d.api.delete(`${RECIPES}/${id}`);
      if (!json(d, a, { deleted: true })) d.out(`Deleted ${id}. Videos already started keep their copy.`);
      return 0;
    }
    default:
      throw new UsageError("Use: sorot gen recipe show|new|copy|edit|validate|export|import|delete");
  }
}

// ---- the kit -----------------------------------------------------------------------

const KIT = "/api/generate/kit";

/** A part folder as a .zip (the folder at the top), or the bytes of a .zip as given. */
function partZip(d: Deps, ref: string): { name: string; bytes: Uint8Array } {
  const path = resolve(d.cwd, ref);
  const files = d.fs.list(path);
  if (files) {
    if (!files.includes("part.json")) throw new UsageError(`${ref} has no part.json: is it a kit part folder?`);
    const top = basename(path);
    return { name: `${top}.zip`, bytes: zipStored(files.map((f) => ({ path: `${top}/${f}`, data: d.fs.read(join(path, f)) }))) };
  }
  if (!d.fs.exists(path)) throw new UsageError(`Not found: ${ref}`);
  if (!/\.zip$/i.test(ref)) throw new UsageError("Give a part folder or a .zip of one");
  return { name: basename(ref), bytes: d.fs.read(path) };
}

const printPart = (d: Deps, p: Json) => {
  d.out(`${p.name} ${p.version} (${p.source === "builtIn" ? "built in" : "yours"}, ${p.manifest.runtime}${p.manifest.needs.gpu === "no" ? "" : `, GPU ${p.manifest.needs.gpu}`})`);
  d.out(`  ${p.manifest.does}`);
  d.out(`  Example: ${p.manifest.example}`);
  const settings = Object.entries(p.manifest.settings as Record<string, Json>);
  if (!settings.length) return;
  d.out("  Settings:");
  for (const [k, f] of settings) {
    const range = f.t === "enum" ? (f.values as string[]).join(" | ") : f.t === "int" || f.t === "num" ? `${f.min} to ${f.max}` : f.t;
    const def = p.manifest.defaults[k];
    d.out(`    ${k}: ${range}${def === undefined ? "" : ` (default ${JSON.stringify(def)})`}`);
  }
};

/** The kit parts: list, show, add (validated and rendered twice by the server), export, remove. */
async function kitCmd(d: Deps, a: Args): Promise<number> {
  const action = a.positionals[2] ?? "list";
  const arg = (i: number, what: string) => need(a, i, what);
  switch (action) {
    case "list": {
      const { parts } = await d.api.get(KIT);
      if (json(d, a, parts)) return 0;
      d.out(table(["PART", "VER", "RUNTIME", "KIND", "DOES"], (parts as Json[]).map((p) => [
        p.name, p.version, p.manifest.runtime, p.source === "builtIn" ? "built in" : "yours", truncate(p.manifest.does, 60),
      ])));
      return 0;
    }
    case "show": {
      const { part } = await d.api.get(`${KIT}/${arg(3, "part name")}`);
      if (!json(d, a, part)) printPart(d, part);
      return 0;
    }
    case "add": {
      const zip = partZip(d, arg(3, "part folder or .zip"));
      const form = new FormData();
      form.set("file", new File([zip.bytes], zip.name, { type: "application/zip" }));
      if (!a.flags.json) d.out("Checking the part: its example renders twice and must come out the same...");
      const { part } = await d.api.upload(KIT, form);
      if (!json(d, a, part)) d.out(`Added ${part.name} ${part.version}. Directors are offered it from their next call.`);
      return 0;
    }
    case "export": {
      const name = arg(3, "part name");
      const out = resolve(d.cwd, str(a, "out") ?? `${name}.zip`);
      const bytes = await d.fs.write(out, await d.api.raw(`${KIT}/${name}/export`));
      if (!json(d, a, { path: out, bytes })) d.out(`Saved ${out}`);
      return 0;
    }
    case "remove": {
      const name = arg(3, "part name");
      await d.api.delete(`${KIT}/${name}`);
      if (!json(d, a, { deleted: true })) d.out(`Removed ${name}. A recipe that names it shows as unavailable until it is added again.`);
      return 0;
    }
    default:
      throw new UsageError("Use: sorot gen kit [list] | show <name> | add <folder|.zip> | export <name> [-o file.zip] | remove <name>");
  }
}

/** What a director call is told on this install (the kit, the level, the renderer, the connections). */
async function capabilitiesCmd(d: Deps, a: Args): Promise<number> {
  const level = str(a, "level") ?? "compose";
  const { capabilities: c } = await d.api.get(`/api/generate/capabilities?level=${encodeURIComponent(level)}`);
  if (json(d, a, c)) return 0;
  d.out(`Level ${c.level}: ${c.levelMeans}`);
  d.out(`Renderer: HyperFrames ${c.renderer.hyperframes} · draws ${(c.renderer.runtimes as string[]).join(", ")} · ${c.renderer.gpu ? "GPU" : "CPU"} · frame budget ${c.renderer.frameBudgetMs} ms`);
  d.out(`Connections: image ${onOff(c.connections.image)} · voice ${onOff(c.connections.voice)} · vision ${onOff(c.connections.vision)}`);
  d.out(`Seams: ${(c.seams as string[]).join(", ")}`);
  d.out(`Kit (${(c.kit as Json[]).length} parts at this level):`);
  for (const p of c.kit as Json[]) d.out(`  ${p.name} (${p.runtime}): ${p.does}`);
  return 0;
}

// ---- models and levels -------------------------------------------------------------

const MODELS = "/api/generate/models";
const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "-");

/** Each model's record per level and the level `auto` gives it; `pin <model> <level|auto>` pins one. */
async function modelsCmd(d: Deps, a: Args): Promise<number> {
  if (a.positionals[2] === "pin") {
    const model = need(a, 3, "model");
    const level = need(a, 4, "level (kit, compose, free or auto)");
    if (!["kit", "compose", "free", "auto"].includes(level)) throw new UsageError("The level is kit, compose, free or auto");
    const r = await d.api.put(`${MODELS}/${encodeURIComponent(model)}/level`, { level: level === "auto" ? null : level });
    if (!json(d, a, r)) d.out(level === "auto" ? `${model} is back on auto (${r.model.auto} now).` : `${model} is pinned to ${level}.`);
    return 0;
  }
  const r = await d.api.get(MODELS);
  if (json(d, a, r)) return 0;
  const rows = (r.models as Json[]).flatMap((m) => (m.records.length ? m.records : [{ level: "-", asked: 0, firstPass: 0, repaired: 0, dropped: 0, malformed: 0 }]).map((x: Json) => [
    `${m.model}${m.model === r.current ? " *" : ""}`, m.pin ?? `auto: ${m.auto}`, x.level, x.asked, pct(x.firstPass, x.asked), pct(x.repaired, x.asked), x.dropped, x.malformed, x.calibratedAt ? when(x.calibratedAt) : "",
  ]));
  d.out(table(["MODEL", "LEVEL", "AT", "ASKED", "FIRST PASS", "REPAIRED", "DROPPED", "MALFORMED", "CALIBRATED"], rows));
  d.out("* the connected model. Shots start at the auto level (the director is never held back); a failing shot falls back a level. Pin a weak model lower if you want.");
  return 0;
}

/** Measures the connected model at each level (three sample shots each) and waits for the result. */
async function calibrateCmd(d: Deps, a: Args): Promise<number> {
  const { run } = await d.api.post(`${MODELS}/calibrate`, str(a, "model") ? { model: str(a, "model") } : {});
  if (!a.flags.json) d.out(`Calibrating ${run.model}: three sample shots at each level (a few minutes)...`);
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const { calibration: c } = await d.api.get(MODELS);
    if (c?.done || Date.now() > deadline) {
      if (json(d, a, c)) return c?.error ? 1 : 0;
      if (c?.error) {
        d.err(`Calibration failed: ${c.error}`);
        return 1;
      }
      for (const [level, t] of Object.entries((c?.result ?? {}) as Record<string, Json>)) d.out(`  ${level}: ${t.firstPass} first time, ${t.repaired} after a repair, ${t.failed} failed (of ${t.asked})`);
      return 0;
    }
    await d.sleep(d.pollMs);
  }
}

/** Passes a step that waits for you (a gate set to "owner"). */
async function approveStepCmd(d: Deps, a: Args): Promise<number> {
  const id = await projectId(d, need(a, 2, "project"));
  const step = need(a, 3, "step id");
  const r = await d.api.post(`${BASE}/${id}/steps/${step}/approve`);
  if (!json(d, a, r)) d.out(`Passed ${step}. The project is ${r.project.status}.`);
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
  resume: resumeCmd,
  accept: acceptCmd,
  fix: fixCmd,
  restore: restoreCmd,
  export: exportCmd,
  facts: factsCmd,
  ideas: ideasCmd,
  idea: ideaCmd,
  run: runCmd,
  files: filesCmd,
  "import-history": importHistoryCmd,
  steps: stepsCmd,
  recipes: recipesCmd,
  recipe: recipeCmd,
  "approve-step": approveStepCmd,
  kit: kitCmd,
  capabilities: capabilitiesCmd,
  models: modelsCmd,
  calibrate: calibrateCmd,
};

export async function genCmd(d: Deps, a: Args): Promise<number> {
  const sub = a.positionals[1];
  const run = sub ? SUBCOMMANDS[sub] : undefined;
  if (!run) throw new UsageError(sub ? `Unknown gen command: ${sub}` : `Missing gen command (${Object.keys(SUBCOMMANDS).join(", ")})`);
  return run(d, a);
}
