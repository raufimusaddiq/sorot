import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config";
import type { Store } from "../store";
import type { GenVerdict, GenVersion } from "../types";
import type { Finding } from "./findings";
import type { Storyline } from "./director";
import { factsMarkdown } from "./facts";
import type { Plan } from "./planSchema";

// Read-only mirrors of the database, written for people and outside agents into
// data/generate/{projectId}/. The database stays the source of truth; a file is written only
// when there is something to put in it.

export const MIRROR_FILES = [
  "BRIEF.md", "facts.md", "audio_request.json", "voice.json", "STORYLINES.md", "SPEC.md", "MOTION_PLAN.md", "CONCEPT.txt", "MOTION_REVIEW.md",
] as const;

const dir = (config: Pick<AppConfig, "genDir">, projectId: string) => `${config.genDir}/${projectId}`;

function briefMd(p: { title: string | null; brief: string; format: string; targetSec: number; language: string; styleNotes: string | null; recipeId: string }): string {
  return [
    `# ${p.title ?? "Untitled video"}`, "", p.brief, "",
    `- Format: ${p.format}`, `- Length: ${p.targetSec} s`, `- Language: ${p.language}`, `- Recipe: ${p.recipeId}`,
    ...(p.styleNotes ? [`- Style notes: ${p.styleNotes}`] : []), "",
  ].join("\n");
}

function storylinesMd(list: Storyline[], picked: number | null): string {
  return [
    "# Storylines", "",
    ...list.flatMap((s, i) => [
      `## ${i + 1}. ${s.title}${s.recommended ? " (recommended)" : ""}${s.bold ? " (bold)" : ""}${i === picked ? " ← picked" : ""}`, "",
      s.pitch, "", `- Opening: ${s.opening}`, `- Beats: ${s.beats.join(" → ")}`, `- Look: ${s.look}`, `- Sound: ${s.sound}`,
      ...(s.reason ? [`- Why: ${s.reason}`] : []), ...(s.note ? [`- Owner's note: ${s.note}`] : []), "",
    ]),
  ].join("\n");
}

function specMd(plan: Plan, revision: number, approved: boolean): string {
  return [
    `# ${plan.title}`, "", `_Plan revision ${revision}, ${approved ? "approved" : "not approved yet"}._`, "",
    `**Message:** ${plan.message}`, "", `${plan.format} · ${plan.totalSec} s · ${plan.language}`, "",
    `**Look:** ${plan.look.palette.join(" ")} · ${plan.look.fonts.join(", ")} · ${plan.look.pacing}${plan.look.notes ? ` · ${plan.look.notes}` : ""}`, "",
    ...(plan.assumptions.length ? ["**Assumptions:**", ...plan.assumptions.map((a) => `- ${a}`), ""] : []),
    "## Shots", "",
    ...plan.shots.flatMap((s, i) => [
      `${i + 1}. **${s.id}** · ${s.purpose} · ${s.durationSec} s${s.hold ? " · hold" : ""}`,
      ...s.text.map((t) => `   - ${t.role}: ${t.value}`), `   - Visual: ${s.visual.description}`, `   - Motion: ${s.motion}`,
      ...(s.narration ? [`   - Narration: ${s.narration}`] : []),
    ]), "",
  ].join("\n");
}

/** MOTION_PLAN.md: the numeric spec and, per shot, its frames, hero move, what it reads as, the hand-off and what moves when. */
export function motionPlanMd(plan: Plan): string {
  const n = plan.numeric;
  if (!n) return "";
  const kv = (o: Record<string, string | number>) => Object.entries(o).map(([k, v]) => `- ${k}: ${v}`);
  return [
    `# Motion plan: ${plan.title}`, "", `${n.totalFrames} frames at ${n.fps} fps (${plan.totalSec} s).`, "",
    "## Spec", "", `Palette: ${plan.look.palette.join(" ")}`, `Shadow: ${n.shadow}`, "",
    "Type:", ...Object.entries(n.typography).map(([r, t]) => `- ${r}: ${t.font} ${t.weight}, ${t.px} px, tracking ${t.tracking} em`), "",
    "Easing:", ...kv(n.easing), "", "Durations (frames):", ...kv(n.durationsFrames), "", "Staggers (frames):", ...kv(n.staggerFrames), "",
    "## Shots", "",
    ...plan.shots.flatMap((s) => [
      `### ${s.id} · frames ${s.frames?.[0] ?? "?"} to ${s.frames?.[1] ?? "?"}`, "",
      `- Hero move: ${s.heroMove ?? "-"}`, `- Reads as: ${s.reads ?? "-"}`, `- Hands off: ${s.handoff ?? "-"}`,
      ...(s.motionPlan?.length ? ["- Moves:", ...s.motionPlan.map((m) => `  - frames ${m.fromFrame} to ${m.toFrame}: ${m.token}${m.target ? ` on ${m.target}` : ""}`)] : []), "",
    ]),
  ].join("\n");
}

/** Rewrites the mirrors that the project's data supports (BRIEF.md, STORYLINES.md, SPEC.md, MOTION_PLAN.md). */
export function mirrorProject(config: Pick<AppConfig, "genDir">, store: Store, projectId: string): string[] {
  const project = store.getGenProject(projectId);
  if (!project) return [];
  const out = dir(config, projectId);
  mkdirSync(out, { recursive: true });
  const written: string[] = [];
  const put = (name: string, text: string) => { writeFileSync(join(out, name), text); written.push(name); };

  put("BRIEF.md", briefMd(project));
  const facts = store.genFactsForProject(projectId);
  if (facts.length) put("facts.md", factsMarkdown(facts));
  if (project.concept) {
    const c = JSON.parse(project.concept) as { mechanism: string; concept: string };
    put("CONCEPT.txt", `${c.mechanism}\n\n${c.concept}\n`);
  }
  if (project.storylines) put("STORYLINES.md", storylinesMd(JSON.parse(project.storylines) as Storyline[], project.pickedStoryline));
  const current = project.currentPlanId ? store.getGenPlan(project.currentPlanId) : null;
  if (current) {
    const plan = JSON.parse(current.plan) as Plan;
    put("SPEC.md", specMd(plan, current.revision, !!current.approvedAt));
    if (plan.numeric) put("MOTION_PLAN.md", motionPlanMd(plan));
  }
  return written;
}

/** The text of one mirrored file, or null (unknown name, or not written yet). */
export function readMirror(config: Pick<AppConfig, "genDir">, projectId: string, name: string): string | null {
  if (!(MIRROR_FILES as readonly string[]).includes(name)) return null;
  const path = join(dir(config, projectId), name);
  return existsSync(path) ? readFileSync(path, "utf-8") : null;
}

// ---- MOTION_REVIEW.md: both verdicts of a version, for people and outside agents ----------

const bySeverity = { "must-fix": 0, "should-fix": 1, polish: 2 } as const;

function findingLine(f: Finding): string {
  const where = f.shotId ? ` (${f.shotId}${f.fromSec !== undefined ? `, ${f.fromSec}${f.toSec !== undefined ? ` to ${f.toSec}` : ""} s` : ""})` : "";
  return `- **${f.severity}**${where} \`${f.code}\`: ${f.description}${f.suggestedFix ? ` Fix: ${f.suggestedFix}` : ""}`;
}

/** The review as text: each verdict and its findings, worst first, and the warnings kept on purpose with their reasons. */
export function reviewMarkdown(title: string, version: GenVersion, verdicts: GenVerdict[]): string {
  const sections = ["TECHNICAL", "CREATIVE"].map((kind) => {
    const v = verdicts.find((x) => x.kind === kind);
    if (!v) return [`## ${kind}`, "", "_Not judged yet._", ""];
    const all = JSON.parse(v.findings) as Finding[];
    const live = all.filter((f) => f.state !== "kept").sort((a, b) => bySeverity[a.severity] - bySeverity[b.severity]);
    const kept = all.filter((f) => f.state === "kept");
    return [
      `## ${kind}: ${v.status}`, "", `Judged by ${v.judgedBy}.`, "",
      ...(live.length ? live.map(findingLine) : ["Nothing to fix."]), "",
      ...(kept.length ? ["Kept on purpose:", ...kept.map((f) => `- \`${f.code}\`${f.shotId ? ` (${f.shotId})` : ""}: ${f.keptReason ?? "no reason given"}`), ""] : []),
    ];
  });
  return [
    `# Motion review: ${title}, version ${version.number}`, "",
    `${version.renderKind === "final" ? "Final" : "Draft"} render${version.hyperframesVersion ? ` with HyperFrames ${version.hyperframesVersion}` : ""}. A FAIL in TECHNICAL blocks the export; CREATIVE guides the next fix and never blocks.`, "",
    ...sections.flat(),
  ].join("\n");
}

/** Writes MOTION_REVIEW.md for the project from one version's verdicts. */
export function mirrorReview(config: Pick<AppConfig, "genDir">, store: Store, versionId: string): boolean {
  const version = store.getGenVersion(versionId);
  const project = version ? store.getGenProject(version.projectId) : null;
  if (!version || !project) return false;
  const out = dir(config, project.id);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "MOTION_REVIEW.md"), reviewMarkdown(project.title ?? "Untitled video", version, store.genVerdictsForVersion(versionId)));
  return true;
}
