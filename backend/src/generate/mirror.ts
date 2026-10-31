import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config";
import type { Store } from "../store";
import type { Storyline } from "./director";
import type { Plan } from "./planSchema";

// Read-only mirrors of the database, written for people and outside agents into
// data/generate/{projectId}/. The database stays the source of truth; a file is written only
// when there is something to put in it.

export const MIRROR_FILES = [
  "BRIEF.md", "facts.md", "audio_request.json", "audio_meta.json", "STORYLINES.md", "SPEC.md", "MOTION_PLAN.md", "CONCEPT.txt", "MOTION_REVIEW.md",
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

/** Rewrites the mirrors that the project's data supports (BRIEF.md, STORYLINES.md, SPEC.md). */
export function mirrorProject(config: Pick<AppConfig, "genDir">, store: Store, projectId: string): string[] {
  const project = store.getGenProject(projectId);
  if (!project) return [];
  const out = dir(config, projectId);
  mkdirSync(out, { recursive: true });
  const written: string[] = [];
  const put = (name: string, text: string) => { writeFileSync(join(out, name), text); written.push(name); };

  put("BRIEF.md", briefMd(project));
  if (project.storylines) put("STORYLINES.md", storylinesMd(JSON.parse(project.storylines) as Storyline[], project.pickedStoryline));
  const current = project.currentPlanId ? store.getGenPlan(project.currentPlanId) : null;
  if (current) put("SPEC.md", specMd(JSON.parse(current.plan) as Plan, current.revision, !!current.approvedAt));
  return written;
}

/** The text of one mirrored file, or null (unknown name, or not written yet). */
export function readMirror(config: Pick<AppConfig, "genDir">, projectId: string, name: string): string | null {
  if (!(MIRROR_FILES as readonly string[]).includes(name)) return null;
  const path = join(dir(config, projectId), name);
  return existsSync(path) ? readFileSync(path, "utf-8") : null;
}
