import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// A fix round starts a new version from the one it fixes: the scenes that need no change are
// copied over, and this file tells the author step which shots to change and how. The marker file
// of a shot says its edit was applied, so a retry of the same version doesn't apply it twice.

export interface FixEdit {
  shotId: string;
  instruction: string;
  /** What the checks and judges found in this shot, so the repair sees it too. */
  findings?: Array<{ code: string; message: string; hint?: string }>;
}

export interface FixFile {
  parentVersionId: string;
  summary: string;
  edits: FixEdit[];
  /** Started by the recipe's autoFixRounds, not by the owner. */
  auto: boolean;
  /** How many automatic fix rounds led to this version. */
  depth: number;
}

export const fixPath = (projectDir: string) => join(projectDir, "fix.json");
const markerPath = (projectDir: string, shotId: string) => join(projectDir, "compositions", `.fixed-${shotId}`);

export const readFix = (projectDir: string): FixFile | null => (existsSync(fixPath(projectDir)) ? (JSON.parse(readFileSync(fixPath(projectDir), "utf-8")) as FixFile) : null);

export const writeFix = (projectDir: string, fix: FixFile): void => writeFileSync(fixPath(projectDir), `${JSON.stringify(fix, null, 2)}\n`);

export const editApplied = (projectDir: string, shotId: string): boolean => existsSync(markerPath(projectDir, shotId));

export const markEditApplied = (projectDir: string, shotId: string): void => writeFileSync(markerPath(projectDir, shotId), "");
