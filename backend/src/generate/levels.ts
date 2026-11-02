import type { Store } from "../store";
import type { GenModelRecord } from "../types";
import { atMost, isLevel, LEVELS, type Level } from "./capabilities";
import type { Capabilities } from "./capabilities";
import { checkScene, type SceneKit } from "./composer";
import { DirectorError, type Director } from "./director";
import type { KitManifest } from "./kit";
import { writeKitScene } from "./kitScene";
import type { Plan } from "./planSchema";
import type { GenProject } from "../types";
import { now as stamp } from "../store";

// Director levels (research R24 to R26, FR-042 to FR-044): how much code the model writes per shot.
// Owner's requirement (2026-11-02): the director's creativity is never stopped up front. Every shot
// starts at the highest level the recipe and the machine allow (`free`: any drawing), and the kit is
// only the floor it falls back to when a shot fails (level_drop). The model's record is kept and shown
// (and Calibrate fills it), but it no longer lowers where a shot starts. Only an explicit pin (the
// recipe's or the owner's) starts lower.

/**
 * First guesses (research R25), to be checked in spike S7. A level the owner calibrated counts with
 * the calibration's own three shots: otherwise Calibrate could never lift a model off `kit` by itself
 * (found on the first real calibration, 2026-11-02).
 */
export const LEVEL_RULE = { minShots: 8, minCalibratedShots: 3, minFirstPass: 0.6, maxMalformed: 0.1 } as const;

export type Outcome = "firstPass" | "repaired" | "dropped" | "malformed" | "failed";

/** Adds one answer's outcome to the model's record at `level` (`plan` for plan calls). */
export function recordAnswer(store: Store, model: string, level: GenModelRecord["level"], outcome: Outcome, ms = 0): void {
  if (!model) return;
  // `asked` counts what was asked once; a malformed answer is a retry of the same ask
  const add = outcome === "malformed" ? { malformed: 1, ms } : outcome === "dropped" ? { dropped: 1 } : { asked: 1, ms, ...(outcome === "failed" ? {} : { [outcome]: 1 }) };
  store.addGenModelRecord(model, level, add);
}

/** Does this record show the model can work at its level? */
export function qualifies(r: (Pick<GenModelRecord, "asked" | "firstPass" | "malformed"> & { calibratedAt?: string | null }) | undefined): boolean {
  if (!r || r.asked < (r.calibratedAt ? LEVEL_RULE.minCalibratedShots : LEVEL_RULE.minShots)) return false;
  return r.firstPass / r.asked >= LEVEL_RULE.minFirstPass && r.malformed / r.asked <= LEVEL_RULE.maxMalformed;
}

export interface LevelChoice {
  /** The model's pin (Settings), or null. */
  pin?: Level | null;
  /** The recipe's `author.level` (auto or a pin). */
  recipeLevel?: Level | "auto";
  /** The recipe's `author.maxLevel`. */
  maxLevel?: Level;
  /** The machine's ceiling (a CPU install may be lower). */
  cpuCap?: Level;
  /** The model's records by level. */
  record: Partial<Record<Level, Pick<GenModelRecord, "asked" | "firstPass" | "malformed"> & { calibratedAt?: string | null }>>;
}

/**
 * The level a shot starts at: a pin (the recipe's, then the owner's for the model) if there is one,
 * else the highest level the caps allow, so the director is never held back; a shot that fails drops
 * one level from there. The record doesn't choose: it only tells the owner how the model fares.
 */
export function chooseLevel(c: LevelChoice): Level {
  const cap = atMost(c.maxLevel ?? "free", c.cpuCap ?? "free");
  const pinned = c.recipeLevel && c.recipeLevel !== "auto" ? c.recipeLevel : c.pin ?? null;
  return pinned ? atMost(pinned, cap) : cap;
}

/** The highest level the record says the model reliably passes (shown to the owner; it never caps a shot). */
export function provenLevel(record: LevelChoice["record"]): Level {
  return [...LEVELS].reverse().find((l) => l !== "kit" && qualifies(record[l])) ?? "kit";
}

/** The model's records keyed by level. */
export function recordOf(store: Store, model: string): LevelChoice["record"] {
  return Object.fromEntries(store.genModelRecords(model).filter((r) => isLevel(r.level)).map((r) => [r.level, r]));
}

const PIN_KEY = (model: string) => `gen.modelLevel.${model}`;

/** The owner's pin for a model (Settings), or null. */
export function modelPin(store: Store, model: string): Level | null {
  const v = store.settings()[PIN_KEY(model)];
  return isLevel(v) ? v : null;
}

/** Pins a model's level, or unpins it with null. */
export function setModelPin(store: Store, model: string, level: Level | null): void {
  store.setSetting(PIN_KEY(model), level);
}

// ---- calibration (R25): three sample shots at each level fill the record at once ----


/** A fixed brief's plan: three ordinary shots, so every model is measured on the same work. */
export const CALIBRATION_PLAN: Plan = {
  title: "Uang tumbuh sendiri", message: "Bunga majemuk membuat tabungan tumbuh makin cepat", format: "9:16", totalSec: 12, language: "id",
  look: { palette: ["#0B1020", "#F5F1E8", "#FFB000"], fonts: ["Plus Jakarta Sans"], pacing: "tenang", notes: "" },
  sound: { music: "none", narration: false }, narrationScript: null, blocks: [], assumptions: [],
  shots: [
    { id: "s01", purpose: "hook", durationSec: 4, text: [{ role: "title", value: "Uang bisa tumbuh?" }], visual: { description: "a single gold coin on a dark ground, lit from the upper left", block: null }, motion: "the coin lands and settles", transition: "cut", audio: "", narration: null, hold: false },
    { id: "s02", purpose: "beat", durationSec: 4, text: [{ role: "title", value: "Bunga berbunga" }, { role: "body", value: "Bunga ikut menghasilkan bunga" }], visual: { description: "coins stacking into a taller and taller column", block: null }, motion: "the column grows step by step", transition: "fade", audio: "", narration: null, hold: false },
    { id: "s03", purpose: "payoff", durationSec: 4, text: [{ role: "title", value: "Mulai dari sekarang" }], visual: { description: "a young tree with coin leaves, gentle snow of light", block: null }, motion: "the camera drifts in slowly", transition: "fade", audio: "", narration: null, hold: false },
  ],
};

const CALIBRATION_PROJECT: GenProject = {
  id: "calibration", title: CALIBRATION_PLAN.title, brief: "Jelaskan bunga majemuk dalam 12 detik", format: "9:16", targetSec: 12, language: "id",
  styleNotes: null, preset: null, recipeId: "calibration", recipe: "{}", ideaId: null, briefFlags: null, narrationScript: null, concept: null,
  stepIndex: 0, stepState: null, narration: 0, storylines: null, pickedStoryline: null, status: "RUNNING", currentPlanId: null,
  acceptedVersionId: null, errorMessage: null, createdAt: "", updatedAt: "",
};

export interface CalibrationDeps {
  store: Store;
  director: Director;
  kit: KitManifest[];
  capabilities: (level: Level) => Capabilities;
  /** The highest level this machine offers. */
  maxLevel: Level;
  signal?: AbortSignal;
}

export type CalibrationResult = Partial<Record<Level, { asked: number; firstPass: number; repaired: number; failed: number }>>;

/** Writes the three sample shots at each level the machine offers and adds what happened to the model's record. */
export async function calibrate(d: CalibrationDeps): Promise<CalibrationResult> {
  const model = d.director.model;
  const at = stamp();
  const result: CalibrationResult = {};
  const step = { use: "author" as const };
  const size = { width: 1080, height: 1920 };
  for (const level of LEVELS.filter((l) => LEVELS.indexOf(l) <= LEVELS.indexOf(d.maxLevel))) {
    const caps = d.capabilities(level);
    if (level === "kit" && !caps.kit.length) continue;
    const kit: SceneKit = { installed: d.kit.map((m) => m.name), allowed: caps.kit.map((p) => p.name), level, webgl: caps.renderer.runtimes.includes("webgl") };
    const tally = { asked: 0, firstPass: 0, repaired: 0, failed: 0 };
    const started = Date.now();
    for (const [i, shot] of CALIBRATION_PLAN.shots.entries()) {
      if (d.signal?.aborted) throw new DirectorError("Calibration cancelled");
      tally.asked++;
      const input = { project: CALIBRATION_PROJECT, step, plan: CALIBRATION_PLAN, index: i, ...size, assets: [], level };
      try {
        if (level === "kit") {
          const answer = await d.director.kitShot({ ...input, kit: d.kit });
          const issues = checkScene(writeKitScene({ plan: CALIBRATION_PLAN, index: i, ...size, answer, kit: d.kit }), shot, i, { assets: [], kit });
          if (issues.length) tally.failed++;
          else tally.firstPass++;
          continue;
        }
        let html = await d.director.scene(input);
        let issues = checkScene(html, shot, i, { assets: [], kit });
        if (!issues.length) { tally.firstPass++; continue; }
        html = (await d.director.repair({ ...input, html, findings: issues })).html;
        issues = checkScene(html, shot, i, { assets: [], kit });
        if (issues.length) tally.failed++;
        else tally.repaired++;
      } catch (e) {
        if (!(e instanceof DirectorError)) throw e;
        tally.failed++;
      }
    }
    d.store.addGenModelRecord(model, level, { asked: tally.asked, firstPass: tally.firstPass, repaired: tally.repaired, ms: Date.now() - started }, at);
    result[level] = tally;
  }
  return result;
}
