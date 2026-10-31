// Plan validation and normalisation (data-model.md, "Plan JSON"). The director's plan comes in
// as untrusted JSON; what leaves is a plan that fits the limits, or a list of what to fix.
// All limits come from the project's frozen recipe; the defaults below are the Quick example's.

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
  transition: string;
  audio: string;
  narration: string | null;
  hold: boolean;
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
  /** Blocks from the HyperFrames catalog the plan may name; null = any. */
  blocks?: string[] | null;
  /** Do the recipe's plan step allow registry blocks? */
  blocksAllowed?: boolean;
  limits?: Partial<PlanLimits>;
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
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const round1 = (n: number) => Math.round(n * 10) / 10;

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
  const wantsNarration = sound.narration === true;
  if (wantsNarration && !ctx.narration) notes.push("narration was removed: it is off or no voice engine is available");
  const narrationOn = wantsNarration && ctx.narration;

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
    return {
      id, purpose: str(o.purpose) || "beat", durationSec: round1(durationSec), text, visual, motion: str(o.motion),
      transition: str(o.transition) || "cut", audio: str(o.audio), narration, hold: o.hold === true,
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

  if (errors.length) return { ok: false, plan: null, errors, notes };
  const plan: Plan = {
    title, message, format: ctx.format, totalSec: total, language: ctx.language,
    look: { palette: strs(look.palette), fonts, pacing: str(look.pacing), notes: str(look.notes) },
    sound: { music: str(sound.music) || "none", narration: narrationOn },
    narrationScript: narrationOn ? (str(raw.narrationScript) || null) : null,
    blocks, assumptions, shots,
  };
  return { ok: true, plan, errors, notes };
}
