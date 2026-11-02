// Plan validation and normalisation (data-model.md, "Plan JSON"). The director's plan comes in
// as untrusted JSON; what leaves is a plan that fits the limits, or a list of what to fix.
// All limits come from the project's frozen recipe; the defaults below are the Quick example's.

import { TRANSITION_NAMES, transitionKind } from "./transitions";

export interface PlanText { role: string; value: string }

export interface PlanVisual {
  description: string;
  block: string | null;
  generatedImage?: { prompt: string; style?: string };
  fallbackVisual?: string;
}

export interface Shot {
  id: string;
  purpose: string;
  durationSec: number;
  text: PlanText[];
  visual: PlanVisual;
  motion: string;
  /** How the shot enters from the one before: one of TRANSITIONS (the first shot's is always cut). */
  transition: string;
  audio: string;
  narration: string | null;
  hold: boolean;
  /** `numeric` plans: the frames the shot covers, [from, to), and what a stranger should take from it. */
  frames?: [number, number];
  heroMove?: string;
  reads?: string;
  handoff?: string;
  /** `motionPlan`: what moves when, in spec tokens and frames. */
  motionPlan?: MotionStep[];
  /** Light, blur, depth and glow as exact values, chosen by the director for this shot. */
  effects?: ShotEffects;
  /** How the shot looks, in the director's own terms, with the kit parts it will use (FR-041). */
  look?: ShotLook;
  /** The level the plan expects the shot to be written at (kit, compose, free; FR-042). */
  level?: string;
}

export interface ShotLook {
  description: string;
  /** Exact values in whatever terms the shot needs (colours, angles, sizes, timings). */
  values: Record<string, unknown>;
  /** Kit parts and their settings; checked against the installed kit. */
  parts?: Array<{ part: string; settings: Record<string, unknown> }>;
}

export interface ShotEffects {
  /** A key light: where it comes from (degrees, 0 = from the top, clockwise), how strong (0 to 1), its colour. */
  light?: { angleDeg: number; intensity: number; color?: string };
  /** Background blur in px (depth of field). */
  blurPx?: number;
  /** Layers at different depths that move apart (parallax), 2 to 5. */
  depthLayers?: number;
  /** Glow around the hero element in px. */
  glowPx?: number;
  /** Why the shot needs them. */
  reason?: string;
}

export interface MotionStep { token: string; fromFrame: number; toFrame: number; target: string }

/** Every adjective a number (`numeric: true`): colours, type, easing, durations and staggers in frames. */
export interface NumericSpec {
  fps: number;
  totalFrames: number;
  typography: Record<string, { font: string; weight: number; px: number; tracking: number }>;
  shadow: string;
  easing: Record<string, string>;
  durationsFrames: Record<string, number>;
  staggerFrames: Record<string, number>;
}

export interface Plan {
  title: string;
  message: string;
  format: string;
  totalSec: number;
  language: string;
  look: { palette: string[]; fonts: string[]; pacing: string; notes: string };
  sound: { music: string; narration: boolean };
  narrationScript: string | null;
  blocks: string[];
  assumptions: string[];
  shots: Shot[];
  numeric?: NumericSpec;
  /** What the director chose from the effects (transitions, blocks, light...) and why, one line each. */
  effectNotes?: string[];
}

export interface PlanLimits {
  maxShots: number;
  minShotSec: number;
  maxShotSec: number;
  /** The shots' total may differ from the target by this share. */
  sumTolerance: number;
  titleWords: number;
  textChars: number;
}

export const DEFAULT_PLAN_LIMITS: PlanLimits = {
  maxShots: 20, minShotSec: 1, maxShotSec: 15, sumTolerance: 0.1, titleWords: 6, textChars: 120,
};

/**
 * Music is only ever the owner's upload: a plan can't promise a track that isn't there (a real plan
 * described "acoustic guitar" with nothing uploaded, and the finished film failed audio_missing).
 */
function musicOf(music: string, ctx: PlanContext, notes: string[]): string {
  if (music === "none" || ctx.music === undefined || ctx.music.length) return music;
  notes.push("music was removed: no music track is uploaded");
  return "none";
}

export interface PlanContext {
  brief: string;
  targetSec: number;
  format: string;
  language: string;
  /** Font families the film may use: the bundled ones plus uploaded fonts. */
  fonts: string[];
  imageConnected: boolean;
  /** Narration is on for the project and a voice engine can speak it. */
  narration: boolean;
  /** The music tracks the film can use (uploads); undefined = not known, any choice is kept. */
  music?: string[];
  /** Blocks from the HyperFrames catalog the plan may name; null = any. */
  blocks?: string[] | null;
  /** Do the recipe's plan step allow registry blocks? */
  blocksAllowed?: boolean;
  limits?: Partial<PlanLimits>;
  /** The plan step's `numeric`: the plan carries a numeric spec (hex colours, type, easing, frames). */
  numeric?: boolean;
  /** The plan step's `motionPlan`: every shot says what moves when, using only the spec's tokens. */
  motionPlan?: boolean;
  /** The recipe's frame rate, to count frames in. */
  fps?: number;
  /** A factual recipe (`sourcedNumbers`): the numbers in these texts that no verified fact or the brief states. */
  unsourced?: (texts: string[]) => string[];
  /** Checks kit part references (`look.parts`) against the capability description: one message each (FR-045, FR-047). */
  kit?: (refs: Array<{ part: string; settings: Record<string, unknown> }>, path: string) => string[];
}

const MAX_LOOK_VALUES = 2000;

/** A shot's look: the director's own description and values, and the kit parts it names (FR-041). */
export function checkShotLook(raw: unknown, path: string, errors: string[], kit?: PlanContext["kit"]): ShotLook | undefined {
  if (!isObj(raw)) {
    errors.push(`${path}: must be an object {description, values, parts?}`);
    return undefined;
  }
  const description = str(raw.description);
  if (!description) errors.push(`${path}.description: say what the shot looks like`);
  if (description.length > 400) errors.push(`${path}.description: at most 400 characters`);
  const values = isObj(raw.values) ? raw.values : {};
  if (raw.values !== undefined && !isObj(raw.values)) errors.push(`${path}.values: an object of exact values`);
  if (JSON.stringify(values).length > MAX_LOOK_VALUES) errors.push(`${path}.values: keep it under ${MAX_LOOK_VALUES} characters`);
  const look: ShotLook = { description, values };
  if (raw.parts !== undefined) {
    if (!Array.isArray(raw.parts) || raw.parts.length > 8) errors.push(`${path}.parts: a list of at most 8 {part, settings}`);
    else {
      const parts = raw.parts.map((p, i) => {
        const o = isObj(p) ? p : {};
        if (!str(o.part)) errors.push(`${path}.parts[${i}]: name the part`);
        return { part: str(o.part), settings: isObj(o.settings) ? o.settings : {} };
      });
      if (kit) errors.push(...kit(parts, `${path}.parts`));
      look.parts = parts;
    }
  }
  return look;
}

export interface PlanCheck {
  ok: boolean;
  /** The normalised plan, set only when `ok`. */
  plan: Plan | null;
  errors: string[];
  /** Things changed or flagged on the way (a stripped image prompt, an added assumption). */
  notes: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean) : []);
/** Words, not symbols: "=", "→" or "&" between words are not read as one. */
const words = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
const round1 = (n: number) => Math.round(n * 10) / 10;
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const EASING = /^(?:none|linear|(?:power[1-4]|sine|expo|circ|back|elastic|bounce)\.(?:in|out|inOut)|cubic-bezier\(\s*-?\d*\.?\d+(?:\s*,\s*-?\d*\.?\d+){3}\s*\))$/;
const int = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const record = (v: unknown): Record<string, unknown> => (isObj(v) ? v : {});

/** Numbers as written ("1,5", "2.500", "40"), compared with the decimal comma unified. */
export function numbersIn(text: string): string[] {
  return (text.match(/\d+(?:[.,]\d+)*/g) ?? []).map((n) => n.replace(",", "."));
}

export function validatePlan(raw: unknown, ctx: PlanContext): PlanCheck {
  const L = { ...DEFAULT_PLAN_LIMITS, ...ctx.limits };
  const errors: string[] = [];
  const notes: string[] = [];
  if (!isObj(raw)) return { ok: false, plan: null, errors: ["the plan must be a JSON object"], notes };

  const title = str(raw.title);
  const message = str(raw.message);
  if (!title) errors.push("title is required");
  if (!message) errors.push("message is required (the one thing the viewer remembers)");

  const look = isObj(raw.look) ? raw.look : {};
  const fonts = strs(look.fonts);
  const unknownFonts = fonts.filter((f) => !ctx.fonts.some((a) => a.toLowerCase() === f.toLowerCase()));
  if (unknownFonts.length) errors.push(`fonts must be bundled or uploaded; not available: ${unknownFonts.join(", ")} (available: ${ctx.fonts.join(", ")})`);

  const sound = isObj(raw.sound) ? raw.sound : {};
  // Narration is the owner's choice for the project: the director can't switch it on without a voice, or off with one
  // (a real plan said narration: false while the voice was recorded for it).
  const wantsNarration = sound.narration === true;
  if (wantsNarration && !ctx.narration) notes.push("narration was removed: it is off or no voice engine is available");
  if (!wantsNarration && ctx.narration) notes.push("narration stays on: the project asks for a voice");
  const narrationOn = ctx.narration;

  const blocks = strs(raw.blocks);
  if (blocks.length && ctx.blocksAllowed === false) errors.push("this recipe doesn't allow registry blocks: leave blocks empty and draw everything");
  else if (ctx.blocks) {
    const unknown = blocks.filter((b) => !ctx.blocks!.includes(b));
    if (unknown.length) errors.push(`unknown blocks: ${unknown.join(", ")}`);
  }

  const shotsRaw = Array.isArray(raw.shots) ? raw.shots : [];
  if (shotsRaw.length < 1 || shotsRaw.length > L.maxShots) errors.push(`needs 1 to ${L.maxShots} shots (got ${shotsRaw.length})`);

  const ids = new Set<string>();
  const shots: Shot[] = shotsRaw.map((s, i): Shot => {
    const at = `shot ${i + 1}`;
    const o = isObj(s) ? s : {};
    const id = str(o.id) || `s${String(i + 1).padStart(2, "0")}`;
    if (ids.has(id)) errors.push(`${at}: the id "${id}" is used twice`);
    ids.add(id);
    const durationSec = typeof o.durationSec === "number" ? o.durationSec : Number.NaN;
    if (!Number.isFinite(durationSec) || durationSec < L.minShotSec || durationSec > L.maxShotSec) {
      errors.push(`${at} (${id}): durationSec must be between ${L.minShotSec} and ${L.maxShotSec}`);
    }
    const text: PlanText[] = (Array.isArray(o.text) ? o.text : []).filter(isObj).map((t) => ({ role: str(t.role) || "body", value: str(t.value) }));
    for (const t of text) {
      if (t.value.length > L.textChars) errors.push(`${at} (${id}): a ${t.role} line is ${t.value.length} characters; the limit is ${L.textChars}`);
      if (t.role === "title" && words(t.value) > L.titleWords) errors.push(`${at} (${id}): the title "${t.value}" has ${words(t.value)} words; the limit is ${L.titleWords}`);
    }
    const v = isObj(o.visual) ? o.visual : {};
    const visual: PlanVisual = { description: str(v.description), block: str(v.block) || null };
    if (!visual.description) errors.push(`${at} (${id}): visual.description is required`);
    if (visual.block && ctx.blocksAllowed === false) visual.block = null;
    const fallback = str(v.fallbackVisual);
    if (fallback) visual.fallbackVisual = fallback;
    if (isObj(v.generatedImage) && str(v.generatedImage.prompt)) {
      if (ctx.imageConnected) visual.generatedImage = { prompt: str(v.generatedImage.prompt), ...(str(v.generatedImage.style) ? { style: str(v.generatedImage.style) } : {}) };
      else {
        notes.push(`${id}: the image prompt was dropped (no image connection); the shot is drawn from its fallback visual`);
        visual.fallbackVisual ??= visual.description;
      }
    }
    const narration = narrationOn ? (str(o.narration) || null) : null;
    const transition = i === 0 ? "cut" : transitionKind(str(o.transition));
    if (transition === null) errors.push(`${at} (${id}): transition "${str(o.transition)}" isn't one Sorot can build; use one of ${TRANSITION_NAMES.join(", ")}`);
    const effects = o.effects === undefined || o.effects === null ? undefined : checkEffects(o.effects, `${at} (${id}): effects`, errors);
    const shotLook = o.look === undefined || o.look === null ? undefined : checkShotLook(o.look, `${at} (${id}): look`, errors, ctx.kit);
    const level = o.level === undefined || o.level === null ? undefined : str(o.level);
    if (level !== undefined && !["kit", "compose", "free"].includes(level)) errors.push(`${at} (${id}): level must be kit, compose or free`);
    return {
      id, purpose: str(o.purpose) || "beat", durationSec: round1(durationSec), text, visual, motion: str(o.motion),
      transition: transition ?? "cut", audio: str(o.audio), narration, hold: o.hold === true,
      ...(effects ? { effects } : {}), ...(shotLook ? { look: shotLook } : {}), ...(level ? { level } : {}),
    };
  });

  const total = round1(shots.reduce((n, s) => n + (Number.isFinite(s.durationSec) ? s.durationSec : 0), 0));
  const low = ctx.targetSec * (1 - L.sumTolerance);
  const high = ctx.targetSec * (1 + L.sumTolerance);
  if (shots.length && (total < low - 1e-9 || total > high + 1e-9)) {
    errors.push(`the shots add up to ${total} s; the target is ${ctx.targetSec} s (allowed ${round1(low)} to ${round1(high)} s)`);
  }

  // FR-007: numbers the plan shows must come from the brief; anything else is listed as an assumption.
  const assumptions = strs(raw.assumptions);
  const known = new Set(numbersIn(ctx.brief));
  const shown = new Set(shots.flatMap((s) => [...s.text.map((t) => t.value), s.narration ?? ""]).flatMap(numbersIn));
  for (const n of [...shown].filter((x) => !known.has(x))) {
    if (!assumptions.some((a) => numbersIn(a).includes(n))) {
      assumptions.push(`The number ${n} is not in the brief; it was added by the director.`);
      notes.push(`added an assumption for the number ${n}`);
    }
  }

  // A factual recipe shows only numbers it can source: an error here gets the director's repair call.
  const unsourced = ctx.unsourced?.(shots.flatMap((s) => [...s.text.map((t) => t.value), s.narration ?? ""])) ?? [];
  if (unsourced.length) errors.push(`these numbers have no verified fact: ${unsourced.join(", ")}; show only numbers from the brief or the verified facts, or none`);

  const numeric = ctx.numeric ? checkNumeric(raw, shots, total, look, ctx, errors) : undefined;

  if (errors.length) return { ok: false, plan: null, errors, notes };
  const plan: Plan = {
    title, message, format: ctx.format, totalSec: total, language: ctx.language,
    look: { palette: strs(look.palette), fonts, pacing: str(look.pacing), notes: str(look.notes) },
    sound: { music: musicOf(str(sound.music) || "none", ctx, notes), narration: narrationOn },
    narrationScript: narrationOn ? (str(raw.narrationScript) || null) : null,
    blocks, assumptions, shots,
    ...(numeric ? { numeric } : {}),
    ...(strs(raw.effectNotes).length ? { effectNotes: strs(raw.effectNotes).slice(0, 40) } : {}),
  };
  return { ok: true, plan, errors, notes };
}

/** A shot's effects, each an exact value in range; anything else is an error to fix. */
export function checkEffects(raw: unknown, at: string, errors: string[]): ShotEffects | undefined {
  if (!isObj(raw)) {
    errors.push(`${at} must be an object`);
    return undefined;
  }
  const out: ShotEffects = {};
  const num = (key: string, v: unknown, min: number, max: number): number | undefined => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
      errors.push(`${at}.${key} is a number from ${min} to ${max}`);
      return undefined;
    }
    return v;
  };
  if (raw.light !== undefined && raw.light !== null) {
    const l = record(raw.light);
    const angleDeg = num("light.angleDeg", l.angleDeg, 0, 360);
    const intensity = num("light.intensity", l.intensity, 0, 1);
    const color = str(l.color);
    if (color && !HEX.test(color)) errors.push(`${at}.light.color is a hex colour like #FFD580`);
    if (angleDeg === undefined || intensity === undefined) errors.push(`${at}.light needs angleDeg and intensity`);
    else out.light = { angleDeg, intensity, ...(color && HEX.test(color) ? { color } : {}) };
  }
  const blurPx = num("blurPx", raw.blurPx, 0, 40);
  const depthLayers = num("depthLayers", raw.depthLayers, 2, 5);
  const glowPx = num("glowPx", raw.glowPx, 0, 80);
  if (depthLayers !== undefined && !Number.isInteger(depthLayers)) errors.push(`${at}.depthLayers is a whole number`);
  if (blurPx !== undefined) out.blurPx = blurPx;
  if (depthLayers !== undefined && Number.isInteger(depthLayers)) out.depthLayers = depthLayers;
  if (glowPx !== undefined) out.glowPx = glowPx;
  if (str(raw.reason)) out.reason = str(raw.reason).slice(0, 200);
  return Object.keys(out).filter((k) => k !== "reason").length ? out : undefined;
}

/**
 * A numeric plan (every adjective a number): hex colours, type per role, easing per role, durations and
 * staggers in frames, and every shot's frame range with no gap between them. Fills each shot's
 * `frames`, `heroMove`, `reads`, `handoff` and (with `motionPlan`) `motionPlan` in place.
 */
function checkNumeric(raw: Record<string, unknown>, shots: Shot[], totalSec: number, look: Record<string, unknown>, ctx: PlanContext, errors: string[]): NumericSpec | undefined {
  const fps = ctx.fps ?? 30;
  const n = record(raw.numeric);
  const palette = strs(look.palette);
  if (palette.length < 2 || palette.some((c) => !HEX.test(c))) errors.push("numeric: look.palette needs at least two hex colours like #0B1020");

  const typography: NumericSpec["typography"] = {};
  const roles = Object.entries(record(n.typography));
  if (!roles.length) errors.push("numeric.typography: give the font, weight, px and tracking of each text role (title, body...)");
  for (const [role, v] of roles) {
    const t = record(v);
    const font = str(t.font);
    const weight = t.weight;
    if (!ctx.fonts.some((f) => f.toLowerCase() === font.toLowerCase())) errors.push(`numeric.typography.${role}: the font "${font}" isn't available (${ctx.fonts.join(", ")})`);
    if (!int(weight) || weight < 100 || weight > 900 || weight % 100) errors.push(`numeric.typography.${role}: weight is 100, 200 ... 900`);
    if (typeof t.px !== "number" || t.px < 8 || t.px > 400) errors.push(`numeric.typography.${role}: px is a number from 8 to 400`);
    if (typeof t.tracking !== "number" || t.tracking < -0.2 || t.tracking > 0.5) errors.push(`numeric.typography.${role}: tracking is in em, from -0.2 to 0.5`);
    typography[role] = { font, weight: weight as number, px: t.px as number, tracking: t.tracking as number };
  }

  const shadow = str(n.shadow);
  if (!shadow) errors.push('numeric.shadow: give the shadow as CSS (or "none")');

  const easing: Record<string, string> = {};
  for (const [role, v] of Object.entries(record(n.easing))) {
    if (typeof v !== "string" || !EASING.test(v)) errors.push(`numeric.easing.${role}: use a GSAP ease like power2.out or a cubic-bezier(a, b, c, d)`);
    else easing[role] = v;
  }
  if (!Object.keys(easing).length) errors.push("numeric.easing: give an easing curve for each kind of motion");

  const frames = (key: "durationsFrames" | "staggerFrames"): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const [name, v] of Object.entries(record(n[key]))) {
      if (!int(v) || v < 0) errors.push(`numeric.${key}.${name}: a whole number of frames`);
      else out[name] = v;
    }
    return out;
  };
  const durationsFrames = frames("durationsFrames");
  const staggerFrames = frames("staggerFrames");

  const totalFrames = Math.round(totalSec * fps);
  if (int(n.totalFrames) && Math.abs(n.totalFrames - totalFrames) > 1) errors.push(`numeric.totalFrames is ${n.totalFrames}; ${totalSec} s at ${fps} fps is ${totalFrames}`);

  // every shot: its frame range follows on from the one before, and says what it shows and hands on
  const rawShots = Array.isArray(raw.shots) ? raw.shots : [];
  const tokens = new Set([...Object.keys(easing), ...Object.keys(durationsFrames), ...Object.keys(staggerFrames)]);
  let at = 0;
  shots.forEach((shot, i) => {
    const o = record(rawShots[i]);
    const label = `shot ${i + 1} (${shot.id})`;
    const f = Array.isArray(o.frames) ? o.frames : [];
    if (f.length !== 2 || !int(f[0]) || !int(f[1])) errors.push(`${label}: frames is [from, to] in whole frames`);
    else {
      if (f[0] !== at) errors.push(`${label}: frames start at ${f[0]} but the shot before ends at ${at} (no gaps, no overlap)`);
      if (f[1] <= f[0]) errors.push(`${label}: frames end before they start`);
      else if (Math.abs((f[1] - f[0]) / fps - shot.durationSec) > 1 / fps + 1e-9) errors.push(`${label}: ${f[1] - f[0]} frames is ${round1((f[1] - f[0]) / fps)} s but durationSec is ${shot.durationSec}`);
      shot.frames = [f[0], f[1]];
      at = f[1];
    }
    for (const key of ["heroMove", "reads", "handoff"] as const) {
      const v = str(o[key]);
      if (!v) errors.push(`${label}: ${key} is required (${{ heroMove: "the one thing that moves most", reads: "what a stranger reads in this shot", handoff: "what carries into the next shot" }[key]})`);
      else shot[key] = v;
    }
    if (ctx.motionPlan) {
      const steps: MotionStep[] = [];
      for (const [k, m] of (Array.isArray(o.motionPlan) ? o.motionPlan : []).entries()) {
        const s = record(m);
        // Frames count from the start of the film; a director that counted from the start of the shot is read that way
        // when only that reading fits (a real numeric plan wrote every shot's motion from 0).
        if (shot.frames && int(s.fromFrame) && int(s.toFrame) && (s.fromFrame < shot.frames[0] || s.toFrame > shot.frames[1])
          && s.fromFrame >= 0 && s.toFrame <= shot.frames[1] - shot.frames[0]) {
          s.fromFrame += shot.frames[0];
          s.toFrame += shot.frames[0];
        }
        const token = str(s.token);
        if (!tokens.has(token)) errors.push(`${label}: motionPlan[${k}] uses "${token}", which isn't in the spec (${[...tokens].join(", ") || "no tokens"})`);
        else if (!int(s.fromFrame) || !int(s.toFrame) || s.toFrame <= s.fromFrame) errors.push(`${label}: motionPlan[${k}] needs whole fromFrame < toFrame`);
        else if (shot.frames && (s.fromFrame < shot.frames[0] || s.toFrame > shot.frames[1])) errors.push(`${label}: motionPlan[${k}] runs outside the shot's frames ${shot.frames[0]} to ${shot.frames[1]}`);
        else steps.push({ token, fromFrame: s.fromFrame, toFrame: s.toFrame, target: str(s.target) });
      }
      if (!steps.length) errors.push(`${label}: motionPlan needs at least one step`);
      shot.motionPlan = steps;
    }
  });
  if (shots.length && at !== totalFrames && Math.abs(at - totalFrames) > 1) errors.push(`the shots' frames end at ${at} but the film is ${totalFrames} frames`);

  return { fps, totalFrames: at || totalFrames, typography, shadow, easing, durationsFrames, staggerFrames };
}
