import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// A finding is one thing wrong (or worth a look) in a build: data-model.md, "Finding JSON". The
// steps of a build leave theirs in findings.json beside the HyperFrames project, each step
// replacing only its own, and the verdicts read them from there.

export type Severity = "must-fix" | "should-fix" | "polish";

export interface Finding {
  id: string;
  severity: Severity;
  /** The plan's shot id (s02), or null for something about the whole video. */
  shotId: string | null;
  fromSec?: number;
  toSec?: number;
  code: string;
  description: string;
  suggestedFix?: string;
  state: "open" | "fixed" | "kept";
  /** Why a warning was kept on purpose; required when `state` is kept. */
  keptReason?: string;
  /** The recipe rule or criterion it comes from. */
  rule?: string;
  /** The step that found it: author, check, technical... */
  source: string;
}

export type NewFinding = Omit<Finding, "id" | "source">;

export const findingsPath = (projectDir: string) => join(projectDir, "findings.json");

export function readFindings(projectDir: string): Finding[] {
  const path = findingsPath(projectDir);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as Finding[]) : [];
}

/** Replaces everything `source` found before with `found`; other steps' findings stay. */
export function saveFindings(projectDir: string, source: string, found: NewFinding[]): Finding[] {
  const mine = found.map((f, i): Finding => ({ ...f, id: `${source}-${i + 1}`, source }));
  const all = [...readFindings(projectDir).filter((f) => f.source !== source), ...mine];
  writeFileSync(findingsPath(projectDir), `${JSON.stringify(all, null, 2)}\n`);
  return all;
}
