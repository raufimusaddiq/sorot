// Settings schemas of the step library (contracts/recipe.md). Pure data + one checker, so the
// recipe validator, the editor's generated forms and the runner all read the same definitions.

export type Field =
  | { t: "bool" }
  | { t: "int"; min: number; max: number }
  | { t: "num"; min: number; max: number }
  | { t: "enum"; values: readonly string[] }
  | { t: "str"; max?: number }
  | { t: "strs"; maxItems: number; maxLen?: number }
  | { t: "obj"; fields: Record<string, Field>; required?: readonly string[] }
  /** true / false, or an object of settings (`false` is refused when `always` is set). */
  | { t: "flag"; fields?: Record<string, Field>; always?: boolean }
  | { t: "list"; max: number; item: Field };

export const STEP_TYPES = [
  "idea", "facts", "script", "voice", "align", "storylines", "plan", "concept", "images", "music",
  "author", "check", "look", "render", "command", "technical", "creative", "export",
] as const;
export type StepType = (typeof STEP_TYPES)[number];

export type Gate = "owner" | "director" | "none";
export const QUALITIES = ["draft", "standard", "delivery"] as const;
export const VOICE_ENGINES = ["elevenlabs", "fish", "openai", "local"] as const;

const MEASURES: Record<string, Field> = {
  // Always on (FR-012): a recipe tunes their numbers but cannot switch them off.
  output: { t: "flag", always: true, fields: { fpsTolerance: { t: "num", min: 0, max: 10 }, lengthToleranceSec: { t: "num", min: 0, max: 5 } } },
  planText: { t: "flag", always: true },
  layout: { t: "flag", always: true },
  readability: { t: "flag", always: true },
  firstFrame: { t: "flag", always: true },
  audio: { t: "flag", always: true, fields: { minMeanVolumeDb: { t: "num", min: -80, max: 0 }, maxTruePeakDb: { t: "num", min: -20, max: 3 } } },
  forbiddenNumbers: { t: "flag", always: true },
  // jumps and stalls inside shots, from the rendered frames (research R28)
  motion: { t: "flag", always: true, fields: { jumpRatio: { t: "num", min: 2, max: 50 }, stallFrames: { t: "int", min: 2, max: 120 } } },
  // Optional.
  speechMatch: { t: "flag", fields: { maxWordErrorRate: { t: "num", min: 0, max: 1 } } },
  voiceRoute: { t: "flag" },
  sourcedNumbers: { t: "flag" },
  deadStretchSec: { t: "num", min: 0.5, max: 30 },
};
export const ALWAYS_ON_MEASURES = Object.entries(MEASURES).filter(([, f]) => f.t === "flag" && f.always).map(([k]) => k);
export const OPTIONAL_MEASURES = Object.keys(MEASURES).filter((k) => !ALWAYS_ON_MEASURES.includes(k));

const CRITERION: Field = {
  t: "obj", required: ["id", "question"],
  fields: { id: { t: "str", max: 40 }, question: { t: "str", max: 500 }, fail: { t: "enum", values: ["main"] } },
};

export interface StepSpec {
  /** Gates this step may carry; the first is the default. */
  gates: readonly Gate[];
  fields: Record<string, Field>;
  required?: readonly string[];
}

const none: readonly Gate[] = ["none"];
const optionalGate: readonly Gate[] = ["none", "owner", "director"];

export const STEP_SPECS: Record<StepType, StepSpec> = {
  idea: { gates: none, fields: { cursor: { t: "bool" } } },
  facts: { gates: optionalGate, fields: {
    mode: { t: "enum", values: ["verify", "research", "brief-only"] }, sources: { t: "strs", maxItems: 20, maxLen: 80 },
    headlinesAsEvidence: { t: "bool" }, maxSteps: { t: "int", min: 1, max: 20 } } },
  script: { gates: optionalGate, fields: { spellNumbers: { t: "bool" }, maxWords: { t: "int", min: 10, max: 600 }, tone: { t: "str", max: 200 } } },
  voice: { gates: none, fields: {
    engine: { t: "enum", values: VOICE_ENGINES }, voice: { t: "str", max: 120 }, failClosed: { t: "bool" }, speed: { t: "num", min: 0.5, max: 2 } } },
  align: { gates: none, fields: { source: { t: "enum", values: ["auto", "engine", "whisper"] }, model: { t: "str", max: 60 } } },
  storylines: { gates: optionalGate, fields: {
    count: { t: "int", min: 1, max: 5 }, skipUnderSec: { t: "int", min: 0, max: 90 }, requireBold: { t: "bool" }, pickRule: { t: "str", max: 500 } } },
  plan: { gates: ["owner", "director"], fields: {
    numeric: { t: "bool" }, motionPlan: { t: "bool" }, timingFrom: { t: "enum", values: ["plan", "voice"] }, blocks: { t: "bool" },
    templates: { t: "bool" }, maxShots: { t: "int", min: 1, max: 20 },
    // No defaults (a default joins every step's hash): effects on, minEffects 3 from 15 s, both in code.
    minEffects: { t: "int", min: 0, max: 20 },
    effects: { t: "flag", fields: { maxSteps: { t: "int", min: 1, max: 30 }, tokenBudget: { t: "int", min: 1000, max: 500_000 } } } } },
  concept: { gates: optionalGate, fields: {
    novelty: { t: "obj", fields: { lastN: { t: "int", min: 1, max: 200 } } }, mechanismTest: { t: "bool" } } },
  images: { gates: none, fields: { style: { t: "str", max: 300 }, size: { t: "str", max: 20 } } },
  music: { gates: none, fields: { track: { t: "str", max: 200 }, duckUnderVoiceDb: { t: "num", min: -40, max: 0 } } },
  author: { gates: none, fields: {
    require: { t: "strs", maxItems: 20, maxLen: 80 }, repairRounds: { t: "int", min: 0, max: 5 }, concurrency: { t: "int", min: 1, max: 4 },
    // The director's tool loop per shot (FR-049): steps before it must submit (0 = one forced call) and looks at its own draft; defaults 8 and 2 in code.
    toolSteps: { t: "int", min: 0, max: 16 }, looks: { t: "int", min: 0, max: 4 },
    // No defaults (a default joins every step's hash): level auto and maxLevel free (or the machine's), in code.
    level: { t: "enum", values: ["auto", "kit", "compose", "free"] }, maxLevel: { t: "enum", values: ["kit", "compose", "free"] } } },
  check: { gates: none, fields: { warnings: { t: "enum", values: ["fix", "fix-or-hold", "report"] }, rounds: { t: "int", min: 0, max: 5 } } },
  look: { gates: none, fields: { rounds: { t: "int", min: 0, max: 5 }, beatOffsetSec: { t: "num", min: 0, max: 2 }, audit: { t: "bool" } } },
  render: { gates: none, fields: {
    quality: { t: "enum", values: QUALITIES }, fps: { t: "int", min: 12, max: 60 }, workers: { t: "int", min: 1, max: 16 },
    // No default in DEFAULTS: auto (blur on the shots the plan marks fast), in code.
    motionBlur: { t: "enum", values: ["auto", "on", "off"] } } },
  command: { gates: none, required: ["name"], fields: { name: { t: "str", max: 80 }, counts: { t: "enum", values: ["technical", "creative"] } } },
  technical: { gates: none, fields: { measures: { t: "obj", fields: MEASURES }, autoFixRounds: { t: "int", min: 0, max: 3 } } },
  creative: { gates: none, fields: {
    criteria: { t: "list", max: 8, item: CRITERION }, framesEverySec: { t: "num", min: 0.5, max: 10 },
    vision: { t: "enum", values: ["auto", "on", "off"] }, autoFixRounds: { t: "int", min: 0, max: 3 } } },
  export: { gates: ["none", "owner"], fields: { mode: { t: "enum", values: ["copy", "rerender"] }, quality: { t: "enum", values: QUALITIES } } },
};

/** Checks `value` against `field`; pushes one message per problem, each starting with `path`. */
export function checkField(field: Field, value: unknown, path: string, errors: string[]): void {
  const bad = (msg: string) => errors.push(`${path}: ${msg}`);
  switch (field.t) {
    case "bool":
      if (typeof value !== "boolean") bad("must be true or false");
      return;
    case "int":
    case "num":
      if (typeof value !== "number" || !Number.isFinite(value) || (field.t === "int" && !Number.isInteger(value))) bad(`must be ${field.t === "int" ? "a whole number" : "a number"}`);
      else if (value < field.min || value > field.max) bad(`must be between ${field.min} and ${field.max}`);
      return;
    case "enum":
      if (typeof value !== "string" || !field.values.includes(value)) bad(`must be one of ${field.values.join(", ")}`);
      return;
    case "str":
      if (typeof value !== "string") bad("must be text");
      else if (field.max !== undefined && value.length > field.max) bad(`must be at most ${field.max} characters`);
      return;
    case "strs":
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) bad("must be a list of text");
      else if (value.length > field.maxItems) bad(`must have at most ${field.maxItems} items`);
      else if (field.maxLen !== undefined && value.some((v: string) => v.length > (field.maxLen as number))) bad(`items must be at most ${field.maxLen} characters`);
      return;
    case "list":
      if (!Array.isArray(value)) bad("must be a list");
      else if (value.length > field.max) bad(`must have at most ${field.max} items`);
      else value.forEach((v, i) => checkField(field.item, v, `${path}[${i}]`, errors));
      return;
    case "flag":
      if (value === false) {
        if (field.always) bad("is always on and can't be turned off");
      } else if (value !== true) {
        if (field.fields && isObject(value)) checkObject(field.fields, value, path, errors);
        else bad(field.fields ? "must be true, false or an object" : "must be true or false");
      }
      return;
    case "obj":
      if (!isObject(value)) bad("must be an object");
      else checkObject(field.fields, value, path, errors, field.required);
  }
}

/**
 * Checks that `spec` is itself a field definition (a kit part's `settings` use the recipe schema).
 * `flag` is left out: it only means something for TECHNICAL measures.
 */
export function checkFieldSpec(spec: unknown, path: string, errors: string[], depth = 0): spec is Field {
  const bad = (msg: string) => { errors.push(`${path}: ${msg}`); return false; };
  if (!isObject(spec)) return bad("must be a field definition like {\"t\": \"num\", \"min\": 0, \"max\": 1}");
  const n = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const known: Record<string, string[]> = {
    bool: ["t"], int: ["t", "min", "max"], num: ["t", "min", "max"], enum: ["t", "values"], str: ["t", "max"],
    strs: ["t", "maxItems", "maxLen"], obj: ["t", "fields", "required"], list: ["t", "max", "item"],
  };
  const t = spec.t;
  if (typeof t !== "string" || !known[t]) return bad(`"t" must be one of ${Object.keys(known).join(", ")}`);
  const extra = Object.keys(spec).filter((k) => !known[t]!.includes(k));
  if (extra.length) return bad(`unknown keys for ${t}: ${extra.join(", ")}`);
  if (depth > 3 && (t === "obj" || t === "list")) return bad("is nested too deep");
  switch (t) {
    case "int":
    case "num":
      if (!n(spec.min) || !n(spec.max) || (spec.min as number) > (spec.max as number)) return bad("needs numbers min ≤ max");
      return true;
    case "enum":
      if (!Array.isArray(spec.values) || !spec.values.length || spec.values.some((v) => typeof v !== "string")) return bad("needs a non-empty list of text values");
      return true;
    case "str":
      if (spec.max !== undefined && !n(spec.max)) return bad("max must be a number");
      return true;
    case "strs":
      if (!n(spec.maxItems) || (spec.maxLen !== undefined && !n(spec.maxLen))) return bad("needs maxItems (and maxLen, if any) as numbers");
      return true;
    case "obj": {
      if (!isObject(spec.fields)) return bad("needs fields");
      const before = errors.length;
      for (const [k, f] of Object.entries(spec.fields)) checkFieldSpec(f, `${path}.fields.${k}`, errors, depth + 1);
      if (spec.required !== undefined && (!Array.isArray(spec.required) || spec.required.some((r) => typeof r !== "string" || !(r in (spec.fields as object))))) {
        return bad("required must list names from fields");
      }
      return errors.length === before;
    }
    case "list":
      if (!n(spec.max)) return bad("needs max as a number");
      return checkFieldSpec(spec.item, `${path}.item`, errors, depth + 1);
    default:
      return true;
  }
}

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Unknown keys are errors (a typo must not silently do nothing). */
export function checkObject(fields: Record<string, Field>, value: Record<string, unknown>, path: string, errors: string[], required: readonly string[] = []): void {
  for (const key of required) if (value[key] === undefined) errors.push(`${path}.${key}: is required`);
  for (const [key, v] of Object.entries(value)) {
    const f = fields[key];
    if (!f) errors.push(`${path}.${key}: unknown setting`);
    else checkField(f, v, `${path}.${key}`, errors);
  }
}
