import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { jsonError, parseJson, tool, withImages, type ChatInput, type ChatMessage, type Llm, type ToolCall, type ToolDef, type ToolHandler } from "../llm";
import { isOnPage, headlineOnly, MIN_QUOTE } from "./facts";
import { findPreset, presetBrief } from "./presets";
import { numbersOf, sameNumber } from "./numbers";
import type { GenAsset, GenProject, Json } from "../types";
import type { DirectorLog } from "./events";
import { shotFile, shotId } from "./composer";
import { checkEffects, validatePlan, type Plan, type PlanContext } from "./planSchema";
import { contrastOf, SEAM_MIN_CONTRAST, seamColour, TRANSITIONS, TRANSITION_NAMES, transitionKind } from "./transitions";
import type { RecipeStep } from "./recipe";
import type { Capabilities, Level } from "./capabilities";
import type { KitManifest } from "./kit";
import { validateKitShot, type KitShot } from "./kitScene";
import { LIMIT_REACHED, TOOL_DEFS, TOOL_ORDER, type SceneTools } from "./directorTools";

// The bounded LLM director (contracts/director.md). Every call is one request and one TOOL CALL:
// the model must call one function whose arguments are the answer, so a reasoning model can't
// wrap it in prose. The arguments are validated in code, with a closing `task` field that
// restates the job. A step's own prompt text is added after Sorot's instructions (append) or in
// their place (replace), never over the function the model must call. One repair call on a
// validation error (the failure goes back as the tool's result); an LlmError passes through, so
// the project keeps its state.

export class DirectorError extends Error {}

export interface Storyline {
  title: string;
  pitch: string;
  opening: string;
  beats: string[];
  look: string;
  sound: string;
  bold: boolean;
  recommended: boolean;
  reason: string;
  /** The owner's note when they picked this one ("make it calmer"). */
  note?: string;
}

export interface GateDecision { decision: string; index?: number; reason: string }

interface Validated<T> { value?: T; errors?: string[] }

/** What is wrong with arguments that aren't JSON, and where, so the repair call can fix that spot (FR-045). */
const malformed = (answer: string): string => {
  const e = jsonError(answer);
  return e ? `the function arguments were not valid JSON: ${e.message} at character ${e.at}, near «${e.excerpt}»; send the whole answer again with that fixed` : "the function arguments were not valid JSON";
};

const MAX_REASON = 240;
const clip = (s: unknown, max: number) => (typeof s === "string" ? s.trim().slice(0, max) : "");

const str = (description: string) => ({ type: "string", description });
const PLAN_PROPS: Json = {
  title: str("The video's title"),
  message: str("The one thing the viewer remembers"),
  look: {
    type: "object", properties: {
      palette: { type: "array", items: str("#hex colour") }, fonts: { type: "array", items: str("a family from the allowed list") },
      pacing: str("e.g. brisk"), notes: str("anything else about the look"),
    }, required: ["palette", "fonts", "pacing"],
  },
  sound: { type: "object", properties: { music: str('"none", or one of connections.music (uploaded tracks only; Sorot makes no music)'), narration: { type: "boolean" } } },
  narrationScript: { type: ["string", "null"] },
  blocks: { type: "array", items: str("a registry block name") },
  assumptions: { type: "array", items: str("anything you added that the brief did not say") },
  effectNotes: { type: "array", items: str("an effect you chose and why, one line each") },
  numeric: {
    type: "object", description: "only when the recipe asks for a numeric plan: every adjective as a number", properties: {
      typography: { type: "object", description: "per text role (title, body...): {font, weight 100-900, px, tracking in em}" },
      shadow: str('CSS box-shadow or "none"'),
      easing: { type: "object", description: "per kind of motion: a GSAP ease (power2.out) or cubic-bezier(a,b,c,d)" },
      durationsFrames: { type: "object", description: "named durations in whole frames" },
      staggerFrames: { type: "object", description: "named staggers in whole frames" },
    },
  },
  shots: {
    type: "array", items: {
      type: "object", required: ["id", "purpose", "durationSec", "text", "visual", "motion"], properties: {
        id: str("s01, s02, ..."), purpose: str("hook, beat, payoff..."), durationSec: { type: "number", description: "seconds, 1 to 15" },
        text: { type: "array", items: { type: "object", required: ["role", "value"], properties: { role: str("title, body, caption..."), value: str("the words on screen") } } },
        visual: {
          type: "object", required: ["description"], properties: {
            description: str("what we see"), block: { type: ["string", "null"] },
            generatedImage: { type: "object", properties: { prompt: { type: "string" }, style: { type: "string" } } }, fallbackVisual: { type: "string" },
          },
        },
        motion: str("how it moves"), transition: { type: "string", enum: TRANSITION_NAMES, description: `how this shot enters from the one before (the first shot's is ignored): ${TRANSITIONS.map((x) => `${x.name} = ${x.description}`).join("; ")}` },
        effects: {
          type: "object", description: "light, blur, depth and glow for this shot as exact values, only with a reason", properties: {
            light: { type: "object", properties: { angleDeg: { type: "number", description: "0 = from the top, clockwise" }, intensity: { type: "number", description: "0 to 1" }, color: str("#hex") } },
            blurPx: { type: "number", description: "background blur, 0 to 40" }, depthLayers: { type: "integer", description: "2 to 5 layers that move apart" }, glowPx: { type: "number", description: "0 to 80" }, reason: { type: "string" },
          },
        },
        look: {
          type: "object", description: "how this shot looks, in whatever terms it needs, with exact values where you have them; name kit parts from capabilities.kit only", properties: {
            description: str("what the shot looks like, one or two sentences"),
            values: { type: "object", description: "exact values: colours, angles, sizes, timings; speed: \"fast\" turns on motion blur for the shot" },
            parts: { type: "array", items: { type: "object", required: ["part", "settings"], properties: { part: str("a kit part name"), settings: { type: "object" } } } },
          },
        },
        audio: { type: "string" }, narration: { type: ["string", "null"] }, hold: { type: "boolean" },
        frames: { type: "array", items: { type: "integer" }, description: "numeric plans: [from, to) in frames; the first starts at 0 and each starts where the one before ends" },
        heroMove: str("numeric plans: the one thing that moves most"), reads: str("numeric plans: what a stranger reads in this shot"), handoff: str("numeric plans: what carries into the next shot"),
        motionPlan: {
          type: "array", description: "when asked: what moves when, using only spec tokens", items: {
            type: "object", required: ["token", "fromFrame", "toFrame"], properties: { token: str("an easing, durationsFrames or staggerFrames name"), fromFrame: { type: "integer", description: "counted from the start of the film, inside the shot's frames" }, toFrame: { type: "integer", description: "counted from the start of the film" }, target: { type: "string" } },
          },
        },
      },
    },
  },
};

const TOOLS = {
  storylines: tool("submit_storylines", "Submit the storylines. Exactly one has recommended: true.", {
    storylines: {
      type: "array", items: {
        type: "object", required: ["title", "pitch", "opening", "beats", "look", "sound", "bold", "recommended", "reason"], properties: {
          title: { type: "string" }, pitch: str("one line"), opening: str("what the viewer sees and hears in the first 2 seconds"),
          beats: { type: "array", items: { type: "string" }, description: "hook, ..., ending" }, look: str("one line"), sound: str("one line"),
          bold: { type: "boolean" }, recommended: { type: "boolean" }, reason: str("why this one, one sentence"),
        },
      },
    },
  }),
  plan: tool("submit_plan", "Submit the shot-by-shot plan.", PLAN_PROPS, ["title", "message", "look", "shots"]),
  outline: tool("submit_plan_outline", "Submit the film and its shot list; each shot's motion detail (heroMove, reads, handoff, motionPlan) comes in a later call. Frames are counted by Sorot from the durations.", PLAN_PROPS, ["title", "message", "look", "shots"]),
  specs: tool("submit_shot_specs", "Submit the motion detail of the shots you were given.", {
    shots: {
      type: "array", items: {
        type: "object", required: ["id", "heroMove", "reads", "handoff", "motionPlan"], properties: {
          id: str("the shot's id, as given"), heroMove: str("the one thing that moves most"), reads: str("what a stranger reads in this shot"),
          handoff: str("what carries into the next shot"),
          motionPlan: {
            type: "array", description: "what moves when, using only spec tokens; frames count from the start of the film, inside the shot's frames", items: {
              type: "object", required: ["token", "fromFrame", "toFrame"], properties: { token: str("an easing, durationsFrames or staggerFrames name"), fromFrame: { type: "integer" }, toFrame: { type: "integer" }, target: { type: "string" } },
            },
          },
        },
      },
    },
  }),
  revise: tool("submit_revision", "Submit the full revised plan and a one-sentence summary of the change.", {
    plan: { type: "object", description: "the full revised plan", properties: PLAN_PROPS, required: ["title", "message", "look", "shots"] },
    changeSummary: str("one sentence on what changed"),
  }, ["plan", "changeSummary"]),
  gate: tool("submit_decision", "Submit the decision.", {
    decision: { type: "string", enum: ["pick", "approve", "reject"] },
    index: { type: "integer", description: "the storyline number, only for pick" }, reason: str("one clause"),
  }, ["decision", "reason"]),
  fix: tool("submit_fix", "Submit what to change to fix the findings.", {
    sceneEdits: {
      type: "array", description: "how a shot's scene should change, one entry per shot that needs it",
      items: { type: "object", required: ["shotId", "instruction"], properties: { shotId: str("the plan's shot id, like s02"), instruction: str("what to change, in a sentence or two") } },
    },
    planEdits: { type: "object", description: "the full revised plan, only when a finding can't be fixed without changing the plan (its text or timing)", properties: PLAN_PROPS, required: ["title", "message", "look", "shots"] },
    summary: str("one sentence on what you changed"),
  }, ["sceneEdits", "summary"]),
  verify: tool("submit_verification", "Say whether the source supports the claim.", {
    verdict: { type: "string", enum: ["verified", "corrected", "unverifiable"] },
    correctedValue: str("only for corrected: the value the source gives, as the source writes it"),
    evidence: str("a passage copied word for word from the source page; required unless unverifiable"),
    reason: str("one sentence"),
  }, ["verdict", "reason"]),
  look: tool("submit_look", "Submit what you see in the frames, as a stranger would.", {
    frames: {
      type: "array", items: {
        type: "object", required: ["shotId", "description", "objects", "unexplained", "matches", "heroVisible"], properties: {
          shotId: str("the shot the picture belongs to"), description: str("what a stranger sees, in a sentence or two, written before you look at what was meant"),
          objects: { type: "array", items: { type: "string" } }, unexplained: { type: "array", items: { type: "string" }, description: "objects whose purpose a stranger could not tell" },
          matches: { type: "boolean", description: "does the picture read as `reads` says?" }, heroVisible: { type: "boolean", description: "can the hero move be seen?" },
        },
      },
    },
    defaultsSeen: { type: "array", items: { type: "string" }, description: "items of defaultsAudit that you can see" },
  }, ["frames", "defaultsSeen"]),
  concept: tool("submit_concept", "Submit the one visual idea this video is built on.", {
    mechanism: str("the single visual mechanism, born from this topic, in one sentence"),
    concept: str("the idea in two to four sentences: what the viewer sees and why it explains the topic"),
    boltOn: { type: "boolean", description: "true if the mechanism could be pasted onto any other topic unchanged (then it is a bolt-on and wrong)" },
  }, ["mechanism", "concept", "boltOn"]),
  sameidea: tool("submit_sameidea", "Say whether the new concept is the same idea as an earlier one.", {
    same: { type: "boolean" }, as: str("the earlier concept it repeats, if it does"),
  }, ["same"]),
  script: tool("submit_script", "Submit the narration script, line by line.", {
    lines: {
      type: "array", description: "the spoken lines in order, one idea each",
      items: { type: "object", required: ["id", "text"], properties: { id: str("l1, l2, ..."), text: str("what is said, one or two sentences") } },
    },
  }, ["lines"]),
  copy: tool("submit_copy", "Submit the title and the description to post the finished video with.", {
    title: str("at most 100 characters, plain text, in the video's language; no hashtags"),
    description: str("at most 400 characters; what the video says, in the video's language; a few hashtags at the end are fine"),
  }, ["title", "description"]),
  judge: tool("submit_judgement", "Submit your judgement of the finished video.", {
    criteria: {
      type: "array", items: {
        type: "object", required: ["id", "answer", "reason"], properties: {
          id: str("the criterion's id"), answer: { type: "string", enum: ["yes", "partly", "no"] }, reason: str("one sentence a person can act on"),
          shotId: { type: "string", description: "the shot it is about, when one shot" }, fromSec: { type: "number" }, toSec: { type: "number" },
          suggestedFix: str("what to change"),
        },
      },
    },
    risks: {
      type: "array", items: {
        type: "object", required: ["id", "flagged", "reason"], properties: {
          id: str("the risk's id"), flagged: { type: "boolean" }, reason: str("one sentence"), shotId: { type: "string" }, suggestedFix: { type: "string" },
        },
      },
    },
  }),
  scene: tool("submit_scene", "Submit the scene file for this one shot.", {
    html: str("the complete compositions/shot-NN.html document"),
  }),
  repair: tool("submit_repair", "Submit the repaired scene file, and any warning you are keeping on purpose.", {
    html: str("the complete repaired compositions/shot-NN.html document"),
    holds: {
      type: "array", description: "warnings kept on purpose, each with its reason",
      items: { type: "object", required: ["code", "reason"], properties: { code: { type: "string" }, reason: { type: "string" } } },
    },
  }, ["html"]),
  kitshot: tool("submit_shot_kit", "Submit this shot as kit parts: which parts, their settings and when each runs. Sorot writes the scene from them.", {
    shotId: str("the shot's id, as given"),
    layers: {
      type: "array", description: "1 to 8 parts, back to front; each runs from fromSec to toSec of the shot", items: {
        type: "object", required: ["part", "settings", "fromSec", "toSec"], properties: {
          part: str("a part name from capabilities.kit"), settings: { type: "object", description: "only settings the part has (capabilities.kitDetail)" },
          fromSec: { type: "number" }, toSec: { type: "number" }, layer: { type: "integer", description: "stacking order, 0 at the back" },
        },
      },
    },
    text: {
      type: "array", description: "the shot's planned lines, word for word, each with its role",
      items: { type: "object", required: ["role", "value"], properties: { role: str("title, body, caption..."), value: str("the planned words") } },
    },
  }, ["shotId", "layers"]),
} as const satisfies Record<string, ToolDef>;

/** Top-level sections of story.md that apply to each job. */
const GUIDANCE_SECTIONS: Record<keyof typeof TOOLS | "effects", string[]> = { effects: ["Effects"], outline: ["Plan", "Effects"], specs: ["Plan"], storylines: ["Storylines"], plan: ["Plan", "Effects"], revise: ["Plan", "Effects", "Revising"], gate: [], scene: [], repair: [], kitshot: [], judge: [], fix: ["Plan", "Revising"], copy: [], script: [], concept: [], sameidea: [], look: [], verify: [] };

const INSTRUCTIONS = {
  storylines: "You are the director of a short 2D motion video. From the brief, write storylines: different films, not rewordings of one.",
  outline: "You are the director of a short 2D motion video. Turn the brief and the chosen storyline into a plan the owner will approve, in two parts: now the film (title, message, the numeric look) and its shot list (each shot's purpose, length, text, visual, narration, transition). Each shot's motion detail comes in a later call. Text on screen is in the project's language. Use only the fonts listed. Use only numbers from the brief; list any other number you need in assumptions.",
  specs: "You are the director of a short 2D motion video. The film's plan is written; now give the motion detail of the shots you are given: the one thing that moves most, what a stranger reads, what carries into the next shot, and the motion plan, using only the spec's easing, duration and stagger names, inside each shot's frames.",
  plan: "You are the director of a short 2D motion video. Turn the brief and the chosen storyline into a shot-by-shot plan the owner will approve before anything is built. Text on screen is in the project's language. Use only the fonts listed. Use only numbers from the brief; list any other number you need in assumptions.",
  revise: "You are the director of a short 2D motion video. Change the plan as the owner asks. Change only what the request names: every other shot keeps its text, timing and look exactly as it is.",
  gate: "You are the director of a short 2D motion video, deciding for the owner who is not at the keyboard. Choose by the rule given, and state the reason in one clause.",
  fix: "You are the director of a short 2D motion video. The video was built and judged; fix the findings the owner chose (and do what their note says). Prefer sceneEdits: they change how a shot looks and moves and cost little. Change the plan (planEdits) only when a finding cannot be fixed without it, because changing the plan's words or timing makes the owner approve again. Keep everything the findings don't touch exactly as it is.",
  verify: "You check one claim against the text of its source page. Verified: the page says it, and you can copy the passage that does. Corrected: the page gives a different value; copy the passage and give the value it states. Unverifiable: the page does not say it, or only a headline does. Never add a fact the page does not state and never guess.",
  look: "You are a stranger who has never heard of this video. You are shown one picture per shot. For each, first say what you see, as plainly as you can, and list the things on screen; name any whose purpose you cannot tell. Only then compare it with what was meant, and say whether the picture reads that way and whether the main move can be seen. Also say which of the listed defaults you can see.",
  concept: "You are the director of a short 2D motion video. Before any plan, name the ONE visual mechanism this video is built on: an idea that grows out of this topic and could not be moved onto another one. It must differ from the earlier concepts you are shown. Then say, honestly, whether it is a bolt-on.",
  sameidea: "You compare video concepts. Two concepts are the same idea when they rest on the same visual mechanism, even in different words or for different topics. Answer for the new concept against the earlier ones.",
  script: "You write the narration of a short 2D motion video: what a voice says over it. Plain spoken language in the project's language, short sentences, one idea per line, no stage directions, nothing a voice cannot say. Use only facts and numbers from the brief.",
  copy: "You write the post text for a finished 2D motion video: a title and a short description a viewer would read before watching. Say only what the video says. Do not invent numbers, names or promises.",
  judge: "You are a fresh judge of a finished 2D video. You did not make it and know nothing of how it was made. Judge only what the brief, the plan, and what was built (and the pictures, if any) show. Answer every criterion and every risk you are given, honestly: yes only when it clearly holds, no when it clearly doesn't, partly in between. A risk is flagged only when you can point at it. Point at the shot and the moment when you can, and say what to change.",
  effects: "You are the director of a short 2D motion video. The plan is written; now choose its effects with the tools, as a film editor would: a transition only where something on screen causes it, light, blur, depth or glow only where a shot needs it, and a registry block only when it shows the shot's idea better than drawing it. Every choice needs a reason. A few strong effects beat many weak ones; a film with none looks flat.",
  scene: "You are the motion designer of a short 2D video. Write the scene file for the ONE shot you are given, exactly as the approved plan describes it, following the authoring contract below.",
  repair: "You are the motion designer of a short 2D video. Fix the scene file for the ONE shot you are given so that every finding listed is resolved, changing nothing else, following the authoring contract below. A warning that is intended may be kept: list it in holds with the reason.",
  kitshot: "You are the motion designer of a short 2D video. Build the ONE shot you are given from the kit parts listed in capabilities: choose the parts, set only the settings each part has, and say when each runs inside the shot. Draw the shot's subject with drawing parts (shape draws circles, coins, petals, leaves, stars, bars and more in a layout; image-place an image from assets; particles). Parts with a target setting act on what is already there: the shot's text (.k-text, .t-title, .t-body, one class per role) or what a drawing part made ([data-kit=\"shape\"]); an empty target means the whole shot. Use the shot's look and the film's look. Keep it to the few parts the shot needs.",
} as const;

type Kind = keyof typeof TOOLS;
/** Which Generate role answers each call (Settings → LLM: plan, scene and judge models). */
const roleOf = (kind: Kind | "effects" | "research"): "plan" | "scene" | "judge" => (kind === "judge" ? "judge" : SCENE_KINDS.has(kind as Kind) ? "scene" : "plan");
const TEMPERATURE: Record<Kind, number> = { storylines: 0.8, plan: 0.4, outline: 0.4, specs: 0.4, revise: 0.3, gate: 0.1, scene: 0.5, repair: 0.2, kitshot: 0.4, judge: 0.1, fix: 0.3, copy: 0.5, script: 0.6, concept: 0.9, sameidea: 0.1, look: 0.1, verify: 0.0 };
/** Words a voice says per second, pauses between lines included: Fish in Indonesian measured 1.7 to 2.0 (2026-11-01). */
const WORDS_PER_SEC = 1.8;

/** The setting a director call's budget comes from, named when a reasoning model runs out of it. */
export const GEN_BUDGET = "the Generate token budget (Settings → LLM, GEN_LLM_MAX_TOKENS)";
/** Output budget by job, as a floor under GEN_LLM_MAX_TOKENS: a reasoning model thinks before it writes the arguments. */
const MIN_TOKENS: Record<Kind, number> = { storylines: 8000, plan: 12000, outline: 12000, specs: 8000, revise: 12000, gate: 3000, scene: 16000, repair: 16000, kitshot: 6000, judge: 8000, fix: 12000, copy: 3000, script: 6000, concept: 6000, sameidea: 3000, look: 8000, verify: 4000 };

export interface JudgeAnswer {
  criteria: Array<{ id: string; answer: "yes" | "partly" | "no"; reason: string; shotId?: string; fromSec?: number; toSec?: number; suggestedFix?: string }>;
  risks: Array<{ id: string; flagged: boolean; reason: string; shotId?: string; suggestedFix?: string }>;
}

/** One claim checked against its source page. */
export interface Verification { verdict: "verified" | "corrected" | "unverifiable"; correctedValue: string | null; evidence: string | null; reason: string }

export interface FixAnswer {
  /** The revised plan, when the fix needs one. */
  plan: Plan | null;
  /** The plan's words, timing or title changed: the owner has to approve again. */
  needsApproval: boolean;
  sceneEdits: Array<{ shotId: string; instruction: string }>;
  summary: string;
}

/** Did the plan change in the parts the owner approved: its title and message, and each shot's words and length? */
export function approvalChanges(before: Plan, after: Plan): boolean {
  if (before.title !== after.title || before.message !== after.message || before.shots.length !== after.shots.length) return true;
  return before.shots.some((s, i) => {
    const t = after.shots[i]!;
    return s.id !== t.id || s.durationSec !== t.durationSec || JSON.stringify(s.text) !== JSON.stringify(t.text) || s.narration !== t.narration;
  });
}

export interface SceneInput {
  project: GenProject;
  step: RecipeStep;
  plan: Plan;
  /** 0-based position of the shot in the plan. */
  index: number;
  width: number;
  height: number;
  /** Paths of the files the scene may use (assets/...). */
  assets: string[];
  /** Installed registry blocks the shot uses: name -> its source, as examples to follow. */
  blocks?: Record<string, string>;
  /** The level the shot is written at (default compose). */
  level?: Level;
  /** The build's director session (its version id): every scene, repair and kit shot of a build is one conversation. */
  session?: string;
  /** The tools this shot's turn may use before it submits (FR-049); none = one forced call. Only a session has turns. */
  tools?: SceneTools | null;
}

/** One answer's outcome, for the model's record (research R25). Scene kinds report their level; plan kinds report `plan`. */
export interface AnswerEvent { kind: string; level: Level | "plan"; outcome: "firstPass" | "repaired" | "malformed" | "failed"; ms: number }
/** Calls whose outcome is the plan's record; scene calls count at their level (their real pass is decided by the author step). */
const PLAN_KINDS: ReadonlySet<string> = new Set(["plan", "outline", "specs", "revise"]);
const SCENE_KINDS: ReadonlySet<string> = new Set(["scene", "repair", "kitshot"]);
/** A session offers all three scene tools every turn (the same list keeps the conversation's prefix the same). */
const SESSION_TOOLS: ToolDef[] = [TOOLS.scene, TOOLS.repair, TOOLS.kitshot];
/** Builds whose sessions stay open (one per pipeline; a few for retries and fixes). */
const MAX_SESSIONS = 4;
/** One build's conversation: the opening (instructions, film), every turn since, and the latest answer for each shot. */
interface Session { messages: ChatInput[]; opening: number; latest: Map<number, string>; turn: Promise<unknown>; /** The tool definitions offered on every turn of the session, fixed when it opens. */ tools: ToolDef[] }

/** A capability query: the call's level and the parts whose full settings it gets (none for plan calls). */
export interface CapabilityQuery { level?: Level; parts?: string[] }
/** The calls that are told what this install can do (FR-047). */
const CAPABLE: ReadonlySet<string> = new Set(["storylines", "plan", "outline", "specs", "revise", "scene", "repair", "kitshot", "fix"]);

/** The scene's HTML from a call's arguments; a model sometimes wraps it in a markdown fence. */
function htmlOf(parsed: unknown): { value?: string; errors?: string[] } {
  const raw = (parsed as { html?: unknown })?.html;
  if (typeof raw !== "string") return { errors: ['"html" must be the scene file as text'] };
  const html = raw.replace(/^\s*```(?:html)?\s*\n/i, "").replace(/\n```\s*$/, "").trim();
  if (html.length < 40 || !html.includes("<")) return { errors: ['"html" must be a complete HTML document'] };
  if (html.length > 200_000) return { errors: ['"html" is too long: keep the scene under 200 KB'] };
  return { value: html };
}

/** Shot ids a plain-words request names ("s03", "shot 3", "shot ke-3", "scene 3"), or none. */
export function shotsNamed(request: string, plan: Plan): Set<string> {
  const named = new Set<string>();
  for (const m of request.matchAll(/\bs0*(\d{1,2})\b|\b(?:shot|scene|adegan)\s*(?:ke-?|no\.?\s*)?(\d{1,2})\b/gi)) {
    const n = Number(m[1] ?? m[2]);
    const shot = plan.shots.find((s) => Number(s.id.replace(/\D/g, "")) === n) ?? plan.shots[n - 1];
    if (shot) named.add(shot.id);
  }
  return named;
}

/** Ids of shots whose content differs between two plans (added, removed or changed). */
export function changedShots(before: Plan, after: Plan): string[] {
  const was = new Map(before.shots.map((s) => [s.id, JSON.stringify(s)]));
  const now = new Map(after.shots.map((s) => [s.id, JSON.stringify(s)]));
  return [...new Set([...was.keys(), ...now.keys()])].filter((id) => was.get(id) !== now.get(id));
}

/**
 * An outline with the parts Sorot owns filled in: each shot's frames, counted from the lengths, and
 * placeholders for the motion detail that is asked for later, valid so the usual check can run.
 */
export function withPlaceholders(parsed: unknown, fps: number): Record<string, unknown> {
  const raw = (typeof parsed === "object" && parsed !== null ? structuredClone(parsed) : {}) as Record<string, unknown>;
  const numeric = (typeof raw.numeric === "object" && raw.numeric !== null ? raw.numeric : {}) as Record<string, Record<string, unknown>>;
  const token = Object.keys({ ...numeric.easing, ...numeric.durationsFrames, ...numeric.staggerFrames })[0] ?? "";
  let at = 0;
  raw.shots = (Array.isArray(raw.shots) ? raw.shots : []).map((s) => {
    const shot = (typeof s === "object" && s !== null ? s : {}) as Record<string, unknown>;
    const length = typeof shot.durationSec === "number" ? Math.round(shot.durationSec * fps) : 0;
    const frames = [at, at + length];
    at += length;
    return { ...shot, frames, heroMove: "(later)", reads: "(later)", handoff: "(later)", motionPlan: [{ token, fromFrame: frames[0], toFrame: Math.max(frames[0]! + 1, frames[1]!) }] };
  });
  raw.numeric = { ...numeric, totalFrames: at };
  return raw;
}

export class Director {
  private guide: string | null = null;
  private contract: string | null = null;
  private sample: string | null = null;

  /** Open build sessions by version id (the newest few). */
  private readonly sessions = new Map<string, Session>();
  /** The capability description for a call; set by the service (null: calls go without it). */
  capabilities: ((q: CapabilityQuery) => Capabilities) | null = null;
  /** Hears each answer's outcome; the service adds it to the model's record. */
  onAnswer: ((e: AnswerEvent) => void) | null = null;

  constructor(private readonly llm: Llm, private readonly log: DirectorLog, private readonly generatorDir: string) {}

  /**
   * Calls that may name parts with settings (a plan's shot looks) get every usable part's settings: with
   * the one-line summary alone a real plan invented settings (`fit`, `tiltDeg`, `keyLight`) and failed
   * its check twice (2026-11-02). Storylines only need the summary.
   */
  private planCapabilities(kind: string): Capabilities {
    const summary = (this.capabilities as (q: CapabilityQuery) => Capabilities)({});
    return kind === "storylines" ? summary : (this.capabilities as (q: CapabilityQuery) => Capabilities)({ parts: summary.kit.map((p) => p.name) });
  }

  /**
   * A scene call gets the full settings of every part its level may use: with only the parts the shot's
   * look named, a real kit-level answer used `shape` (listed, but without its settings), guessed them and
   * failed every retry (2026-11-02). The whole kit's settings are a few KB.
   */
  private sceneCapabilities(input: SceneInput): Capabilities | null {
    if (!this.capabilities) return null;
    const level = input.level ?? "compose";
    return this.capabilities({ level, parts: this.capabilities({ level }).kit.map((p) => p.name) });
  }

  /** The model that answers, and the one that looks at pictures (null when none is set up). */
  /** The model that writes scenes: the one the level records and Calibrate are about. */
  get model(): string { return this.llm.modelFor("scene"); }
  /** The CREATIVE judge's model when it judges without pictures. */
  get judgeModel(): string { return this.llm.modelFor("judge"); }
  /** Whether the director can be shown pictures: a Generate director model reasons and sees, so whenever the LLM is on. */
  get canSee(): boolean { return this.llm.enabled; }

  /** generator/prompts/authoring.md: the contract a scene must keep (read once). */
  private authoring(): string {
    if (this.contract === null) {
      const path = join(this.generatorDir, "prompts", "authoring.md");
      this.contract = existsSync(path) ? readFileSync(path, "utf-8").replace(/<!--[\s\S]*?-->/g, "").trim() : "";
    }
    return this.contract;
  }

  /**
   * generator/prompts/example-scene.html: one finished shot that keeps the contract (zones that don't
   * overlap, one continuous build, a flat camera over the isometric part, the title whole on the first
   * frame), for the model to learn the craft from. Read once; empty when the file is missing.
   */
  private example(): string {
    if (this.sample === null) {
      const path = join(this.generatorDir, "prompts", "example-scene.html");
      this.sample = existsSync(path) ? readFileSync(path, "utf-8").trim() : "";
    }
    return this.sample ? `\n\n# A worked example\n\nOne finished shot from another film; it uses only kit parts, so it fits the compose and free levels. Learn the craft from it (how the zones, parts, timing and text fit together); don't copy its content, colours or words.\n\n\`\`\`html\n${this.sample}\n\`\`\`` : "";
  }

  /** The part of generator/prompts/story.md that applies to this job (the file is read once). */
  private guidance(kind: Kind | "effects"): string {
    if (this.guide === null) {
      const path = join(this.generatorDir, "prompts", "story.md");
      this.guide = existsSync(path) ? readFileSync(path, "utf-8").replace(/<!--[\s\S]*?-->/g, "").trim() : "";
    }
    if (kind === "scene" || kind === "repair") return `${this.authoring()}${this.example()}`;
    // story.md has one top-level section per job: each call gets its own.
    const wanted = GUIDANCE_SECTIONS[kind];
    return this.guide.split(/^(?=# )/m).filter((sec) => wanted.some((w) => sec.startsWith(`# ${w}`))).join("\n\n").trim();
  }

  /** The system message: Sorot's instructions (or the step's, with `replace`), the guidance, and which function to call. */
  private system(kind: Kind, step: RecipeStep): string {
    const own = step.prompt;
    const instructions = own?.mode === "replace" ? own.text : `${INSTRUCTIONS[kind]}\n\n${this.guidance(kind)}${own ? `\n\n${own.text}` : ""}`;
    return `${instructions.trim()}\n\nGive your answer by calling the function ${TOOLS[kind].function.name}. Do not write the answer as text.`;
  }

  /**
   * One request, one tool call, validated; a failed validation goes back to the model as the tool's
   * result and it gets one more try. If the model writes JSON as text instead of calling the
   * function, that is read too.
   */
  private async ask<T>(
    project: GenProject, kind: Kind, step: RecipeStep, payload: Record<string, unknown>, task: string,
    validate: (parsed: unknown) => Validated<T>,
    images: string[] = [],
  ): Promise<T> {
    // what this install can do goes with every planning and writing call; scene calls bring their own
    if (CAPABLE.has(kind) && this.capabilities && !("capabilities" in payload)) payload = { capabilities: this.planCapabilities(kind), ...payload };   // shared prefix first (cache)
    const brief = JSON.stringify({ ...payload, task });
    const messages: ChatInput[] = [
      { role: "system", content: this.system(kind, step) },
      images.length ? withImages(brief, ...images) : { role: "user", content: brief },
    ];
    const level: AnswerEvent["level"] | null = PLAN_KINDS.has(kind) ? "plan"
      : SCENE_KINDS.has(kind) ? ((payload.capabilities as { level?: Level } | undefined)?.level ?? "compose") : null;
    return (await this.converse<T>(project, kind, messages, [TOOLS[kind]], task, validate, level, images.length > 0)).value;
  }

  /**
   * The tool steps of one turn: the model may call the turn's tools (`loop.tools`) before it submits;
   * each result goes back as the tool's result (images, as a user message after them). Past a tool's
   * limit it gets "limit reached: submit now"; the step after `loop.steps` is forced to the submit tool.
   * A tool that fails returns its error to the model: it never fails the build.
   */
  private async useTools(
    project: GenProject, model: string, messages: ChatInput[], loop: SceneTools, submit: string,
    callModel: (force: boolean) => Promise<{ message: ChatMessage; call: ToolCall | undefined }>,
  ): Promise<{ message: ChatMessage; call: ToolCall | undefined }> {
    const used: Record<string, number> = {};
    for (let step = 0; ; step++) {
      const reply = await callModel(step >= loop.steps);
      const calls = reply.message.tool_calls ?? [];
      if (reply.call || !calls.length) return reply;
      messages.push({ role: "assistant", content: reply.message.content ?? "", tool_calls: calls });
      const seen: string[] = [];
      for (const c of calls) {
        const toolName = c.function?.name ?? "";
        const t = loop.tools[toolName];
        let result: unknown;
        if (!t) result = { error: `no tool named ${toolName}: use ${[...Object.keys(loop.tools), submit].join(", ")}` };
        else if ((used[toolName] = (used[toolName] ?? 0) + 1) > t.limit) result = LIMIT_REACHED;
        else {
          let args: Record<string, unknown> = {};
          const parsed = typeof c.function.arguments === "string" ? parseJson(c.function.arguments) : c.function.arguments;   // no JSON: the tool says what it needed
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
          try {
            const out = await this.log.track(
              { projectId: project.id, kind: toolName, model, request: JSON.stringify(args).slice(0, 4000) },
              () => t.run(args),
              (o) => ({ response: JSON.stringify(o.result).slice(0, 4000) + (o.images?.length ? ` +${o.images.length} image(s)` : "") }),
            );
            result = out.result;
            seen.push(...(out.images ?? []));
          } catch (e) {
            result = { error: (e as Error).message };
          }
        }
        messages.push({ role: "tool", tool_call_id: c.id || toolName, name: toolName, content: JSON.stringify(result) });
      }
      if (seen.length) messages.push(withImages("Frames from your draft, in the order you asked.", ...seen));
    }
  }

  /**
   * One forced tool call on `messages`, validated; a failed validation goes back to the model as the
   * tool's result and it gets one more try. The exchange stays in `messages` (a session keeps it).
   */
  private async converse<T>(
    project: GenProject, kind: Kind, messages: ChatInput[], tools: ToolDef[], task: string,
    validate: (parsed: unknown) => Validated<T>, level: AnswerEvent["level"] | null, seeing = false, loop: SceneTools | null = null,
  ): Promise<{ value: T; call: ToolCall | undefined }> {
    const name = TOOLS[kind].function.name;
    let problems: string[] = [];
    const tell = (outcome: AnswerEvent["outcome"], ms: number) => { if (level && this.onAnswer) this.onAnswer({ kind, level, outcome, ms }); };
    const started = Date.now();
    const model = this.llm.modelFor(roleOf(kind));
    for (let attempt = 0; attempt < 2; attempt++) {
      let answer = "";
      // one model call: forced to the submit tool, or free to use the turn's other tools
      const callModel = (force: boolean) => this.log.track(
        { projectId: project.id, kind, model, request: messages.map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : `${m.content.length - 1} image(s), ${(m.content[0] as { text: string }).text}`}`).join("\n\n") },
        async () => {
          const opts = { tools, ...(force ? { toolChoice: name } : {}), temperature: TEMPERATURE[kind], maxTokens: Math.max(this.llm.genMaxTokens, MIN_TOKENS[kind]), budgetName: GEN_BUDGET };
          const r = seeing ? await this.llm.see(messages, { ...opts, model }) : await this.llm.chat(messages as ChatMessage[], { ...opts, model });
          const call = r.tool_calls?.find((c) => c.function?.name === name);
          const args = call?.function.arguments;
          answer = typeof args === "string" ? args : args ? JSON.stringify(args) : r.content;
          return { message: r, call };
        },
        (out) => ({ response: answer || out.message.content }),
      );
      const reply = loop ? await this.useTools(project, model, messages, loop, name, callModel) : await callModel(true);
      const parsed = answer ? parseJson(answer) : null;
      const result: Validated<T> = parsed === null
        ? { errors: [reply.call ? malformed(answer) : `you didn't call ${name}`] }
        : validate(parsed);
      if (reply.call) {
        messages.push(
          { role: "assistant", content: "", tool_calls: [reply.call] },
          { role: "tool", tool_call_id: reply.call.id || name, name, content: JSON.stringify(result.value !== undefined ? { accepted: true } : { accepted: false, problems: result.errors ?? [] }) },
        );
      } else {
        messages.push({ role: "assistant", content: reply.message.content });
      }
      if (result.value !== undefined) {
        tell(attempt === 0 ? "firstPass" : "repaired", Date.now() - started);
        return { value: result.value, call: reply.call };
      }
      // not JSON, or (for a scene) not the asked shape: the model's record counts it, once per ask,
      // so the malformed share stays a share (a record showed 41 malformed for 28 asks, 2026-11-02)
      if ((parsed === null || SCENE_KINDS.has(kind)) && attempt === 0) tell("malformed", 0);
      problems = result.errors ?? [];
      messages.push({ role: "user", content: JSON.stringify({ problems, task: `Fix these problems and call ${name} again with the full answer. ${task}` }) });
    }
    tell("failed", Date.now() - started);
    throw new DirectorError(`The director's ${kind} didn't pass the checks: ${problems.join("; ")}`);
  }

  /** The preset the video started from, as the director is told about it (its name alone if the file no longer lists it). */
  private presetOf(project: GenProject) {
    const preset = findPreset(this.generatorDir, project.preset);
    return preset ? presetBrief(preset) : project.preset;
  }

  private base(project: GenProject, assets: GenAsset[]) {
    return {
      brief: project.brief, format: project.format, targetSec: project.targetSec, language: project.language,
      styleNotes: project.styleNotes, preset: this.presetOf(project),
      assets: assets.map((a) => ({ kind: a.kind, path: a.path, shotId: a.shotId })),
    };
  }

  // ---- storylines -----------------------------------------------------------

  async storylines(input: {
    project: GenProject; step: RecipeStep; settings: Record<string, unknown>; assets: GenAsset[]; note?: string;
  }): Promise<Storyline[]> {
    const count = Number(input.settings.count ?? 3);
    const requireBold = input.settings.requireBold === true;
    return this.ask(
      input.project, "storylines", input.step,
      { ...this.base(input.project, input.assets), count, requireBold, note: input.note ?? null },
      `Write ${count} different storylines for this brief. Exactly one is recommended${requireBold ? " and exactly one is bold" : ""}.`,
      (parsed) => {
        const list = Array.isArray((parsed as { storylines?: unknown })?.storylines) ? (parsed as { storylines: unknown[] }).storylines : null;
        if (!list?.length) return { errors: ['"storylines" must be a non-empty list'] };
        const items: Storyline[] = list.slice(0, count).map((raw) => {
          const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
          return {
            title: clip(o.title, 120), pitch: clip(o.pitch, 300), opening: clip(o.opening, 300),
            beats: (Array.isArray(o.beats) ? o.beats : []).map((b) => clip(b, 200)).filter(Boolean).slice(0, 8),
            look: clip(o.look, 300), sound: clip(o.sound, 300), bold: o.bold === true, recommended: o.recommended === true, reason: clip(o.reason, MAX_REASON),
          };
        });
        const errors: string[] = [];
        items.forEach((s, i) => {
          if (!s.title || !s.pitch || !s.opening || s.beats.length < 2) errors.push(`storyline ${i + 1} needs a title, pitch, opening and at least 2 beats`);
        });
        if (requireBold && items.filter((s) => s.bold).length !== 1) errors.push('exactly one storyline must have "bold": true');
        if (errors.length) return { errors };
        // Exactly one recommended: the first one flagged, else the first.
        const pick = Math.max(0, items.findIndex((s) => s.recommended));
        return { value: items.map((s, i) => ({ ...s, recommended: i === pick })) };
      },
    );
  }

  // ---- plan -----------------------------------------------------------------

  async plan(input: {
    project: GenProject; step: RecipeStep; settings: Record<string, unknown>; assets: GenAsset[];
    storyline: Storyline | null; planCtx: PlanContext; catalog: Array<{ name: string; tags: string[] }>;
    /** The spoken lines and how long each takes, when a voice was recorded before the plan. */
    voice?: Array<{ id: string; text: string; durationSec: number }>;
    /** The visual idea recorded before the plan; the plan builds on it. */
    concept?: { mechanism: string; concept: string } | null;
  }): Promise<{ plan: Plan; notes: string[] }> {
    const { planCtx } = input;
    if (planCtx.numeric) return this.planInParts(input);
    return this.ask(
      input.project, "plan", input.step,
      {
        ...this.base(input.project, input.assets), storyline: input.storyline,
        fonts: planCtx.fonts, maxShots: planCtx.limits?.maxShots ?? 20,
        blocks: planCtx.blocksAllowed === false ? [] : input.catalog.map((b) => ({ name: b.name, tags: b.tags })),
        connections: { image: planCtx.imageConnected, narration: planCtx.narration, music: planCtx.music ?? null },
        ...(input.voice?.length ? { voiceLines: input.voice } : {}),
        ...(input.concept ? { concept: input.concept } : {}),
      },
      `Write the shot-by-shot plan for this ${input.project.targetSec}-second ${input.project.format} video. The shot durations add up to ${input.project.targetSec} seconds.${input.voice?.length ? " The voice is already recorded: each shot's narration is whole voiceLines, in order, copied word for word." : ""}`,
      (parsed) => {
        const check = validatePlan(parsed, planCtx);
        return check.ok ? { value: { plan: check.plan as Plan, notes: check.notes } } : { errors: check.errors };
      },
    );
  }

  /**
   * A numeric plan in parts (FR-045): its answers are large, and one lost brace in 12,000 characters
   * failed a whole plan twice. First the film and its shot list, with every shot's frames counted in
   * code from its length and its motion detail filled with valid placeholders, so the usual check
   * holds the outline. Then the motion detail four shots at a time, each batch checked in place and
   * sent back with only its own problems.
   */
  private async planInParts(input: Parameters<Director["plan"]>[0]): Promise<{ plan: Plan; notes: string[] }> {
    const { planCtx } = input;
    const fps = planCtx.fps ?? 30;
    const payload = {
      ...this.base(input.project, input.assets), storyline: input.storyline,
      fonts: planCtx.fonts, maxShots: planCtx.limits?.maxShots ?? 20,
      blocks: planCtx.blocksAllowed === false ? [] : input.catalog.map((b) => ({ name: b.name, tags: b.tags })),
      connections: { image: planCtx.imageConnected, narration: planCtx.narration, music: planCtx.music ?? null },
      ...(input.voice?.length ? { voiceLines: input.voice } : {}),
      ...(input.concept ? { concept: input.concept } : {}),
    };
    let draft: Record<string, unknown> = {};
    await this.ask(
      input.project, "outline", input.step, payload,
      `Write the film and its shot list for this ${input.project.targetSec}-second ${input.project.format} video: the shot durations add up to ${input.project.targetSec} seconds. Leave out each shot's heroMove, reads, handoff and motionPlan: they come next.`,
      (parsed) => {
        draft = withPlaceholders(parsed, fps);
        const check = validatePlan(draft, planCtx);
        return check.ok ? { value: true } : { errors: check.errors };
      },
    );
    const shots = draft.shots as Array<Record<string, unknown>>;
    const tokens = Object.keys({ ...(draft.numeric as { easing?: object }).easing, ...(draft.numeric as { durationsFrames?: object }).durationsFrames, ...(draft.numeric as { staggerFrames?: object }).staggerFrames });
    for (let at = 0; at < shots.length; at += 4) {
      const batch = shots.slice(at, at + 4);
      const ids = batch.map((s) => String(s.id));
      await this.ask(
        input.project, "specs", input.step,
        {
          film: { title: draft.title, message: draft.message, look: draft.look, numeric: draft.numeric },
          shots: batch.map((s) => ({ id: s.id, purpose: s.purpose, frames: s.frames, text: s.text, visual: s.visual, narration: s.narration ?? null })),
          tokens, next: shots[at + 4] ? { id: shots[at + 4]!.id, purpose: shots[at + 4]!.purpose } : null,
        },
        `Give the motion detail of ${ids.join(", ")}: heroMove, reads, handoff and a motionPlan using only ${tokens.join(", ")}, inside each shot's frames.`,
        (parsed) => {
          const list = (Array.isArray((parsed as { shots?: unknown }).shots) ? (parsed as { shots: unknown[] }).shots : []) as Array<Record<string, unknown>>;
          const missing = ids.filter((id) => !list.some((s) => s?.id === id));
          if (missing.length) return { errors: [`give the detail of ${missing.join(", ")}`] };
          const before = batch.map((s) => ({ ...s }));
          for (const spec of list) {
            const shot = batch.find((s) => s.id === spec.id);
            if (shot) Object.assign(shot, { heroMove: spec.heroMove, reads: spec.reads, handoff: spec.handoff, motionPlan: spec.motionPlan });
          }
          const mine = validatePlan(draft, planCtx).errors.filter((e) => ids.some((id) => e.includes(`(${id})`)));
          if (mine.length) batch.forEach((s, k) => Object.assign(s, before[k]));   // put the placeholders back for the retry
          return mine.length ? { errors: mine } : { value: true };
        },
      );
    }
    const check = validatePlan(draft, planCtx);
    if (!check.ok) throw new DirectorError(`The director's plan didn't pass the checks: ${check.errors.join("; ")}`);
    return { plan: check.plan as Plan, notes: check.notes };
  }

  // ---- revise ---------------------------------------------------------------

  async revise(input: {
    project: GenProject; step: RecipeStep; current: Plan; request: string; planCtx: PlanContext;
  }): Promise<{ plan: Plan; changeSummary: string; notes: string[] }> {
    const named = shotsNamed(input.request, input.current);
    return this.ask(
      input.project, "revise", input.step,
      { currentPlan: input.current, request: input.request, shotsNamed: [...named], fonts: input.planCtx.fonts },
      `Apply the owner's request to the plan and return the full revised plan with a one-sentence summary.${named.size ? ` Change only ${[...named].join(", ")}.` : ""}`,
      (parsed) => {
        const raw = parsed as { plan?: unknown; changeSummary?: unknown };
        const check = validatePlan(raw.plan, input.planCtx);
        if (!check.ok) return { errors: check.errors };
        const stray = named.size ? changedShots(input.current, check.plan as Plan).filter((id) => !named.has(id)) : [];
        if (stray.length) return { errors: [`you changed ${stray.join(", ")}, which the request doesn't name; keep those shots exactly as they were`] };
        return { value: { plan: check.plan as Plan, changeSummary: clip(raw.changeSummary, 300), notes: check.notes } };
      },
    );
  }

  // ---- effects --------------------------------------------------------------

  /**
   * The director chooses the film's effects itself: it searches HyperFrames' catalog and Sorot's
   * transitions, and sets a transition, a block or a shot's light, blur, depth and glow, one tool
   * call at a time, each checked here. Bounded by steps and a token budget; every choice and its
   * reason is kept in the plan's effectNotes, so the owner approves them with the plan.
   */
  async effects(input: {
    project: GenProject; step: RecipeStep; plan: Plan; planCtx: PlanContext; maxSteps: number; tokenBudget: number;
    catalog: Array<{ name: string; tags: string[]; type?: string; description?: string }>;
  }): Promise<{ plan: Plan; notes: string[] }> {
    const plan: Plan = JSON.parse(JSON.stringify(input.plan));
    const notes: string[] = [];
    const blocksOn = input.planCtx.blocksAllowed !== false;
    const known = new Set(input.planCtx.blocks ?? input.catalog.map((b) => b.name));
    const shot = (id: unknown) => {
      const s = plan.shots.find((x) => x.id === id);
      if (!s) throw new Error(`there is no shot ${String(id)}; the shots are ${plan.shots.map((x) => x.id).join(", ")}`);
      return s;
    };
    const why = (a: Json) => {
      const r = clip(a.reason, 200);
      if (!r) throw new Error("give the reason: what on screen causes this effect");
      return r;
    };
    const tools = [
      tool("search_catalog", "Search the effects: Sorot's transitions and, when allowed, HyperFrames' registry blocks and components.", {
        query: str("words to match in names, tags and descriptions, e.g. light, glow, chart, wipe"),
        kind: { type: "string", enum: ["transition", "block", "any"] },
      }, ["query"]),
      tool("set_transition", "How a shot enters from the one before.", { shotId: str("s02, s03... (not the first shot)"), name: { type: "string", enum: TRANSITION_NAMES }, reason: str("what on screen causes it") }),
      ...(blocksOn ? [tool("add_block", "Use a registry block or component in a shot.", { shotId: str("the shot"), name: str("a name search_catalog returned"), reason: str("why this shot needs it") })] : []),
      tool("set_look", "Give a shot light, blur, depth or glow, as exact values.", {
        shotId: str("the shot"), light: { type: "object", properties: { angleDeg: { type: "number" }, intensity: { type: "number" }, color: str("#hex") } },
        blurPx: { type: "number" }, depthLayers: { type: "integer" }, glowPx: { type: "number" }, reason: str("why this shot needs it"),
      }, ["shotId", "reason"]),
    ];
    const handlers: Record<string, ToolHandler> = {
      search_catalog: (a) => {
        const words = String(a.query ?? "").toLowerCase().split(/\W+/).filter(Boolean);
        const hit = (text: string) => !words.length || words.some((w) => text.toLowerCase().includes(w));
        const transitions = a.kind === "block" ? [] : TRANSITIONS.filter((x) => hit(`${x.name} ${x.description}`)).map((x) => ({ name: x.name, kind: "transition", description: x.description }));
        const blocks = a.kind === "transition" || !blocksOn ? [] : input.catalog.filter((b) => known.has(b.name) && hit(`${b.name} ${b.tags.join(" ")} ${b.description ?? ""}`))
          .slice(0, 12).map((b) => ({ name: b.name, kind: b.type ?? "block", tags: b.tags, description: clip(b.description, 140) }));
        return [...transitions, ...blocks];
      },
      set_transition: (a) => {
        const s = shot(a.shotId);
        if (s === plan.shots[0]) throw new Error("the first shot has nothing before it: set the transition of a later shot");
        const kind = transitionKind(String(a.name ?? ""));
        if (!kind) throw new Error(`use one of ${TRANSITION_NAMES.join(", ")}`);
        // a seam that paints a colour must show on the film's ground (a white flash vanished on a white film)
        const ground = plan.look.palette.find((c) => contrastOf(c, c) !== null);
        const paint = seamColour(kind, plan.look.palette);
        const ratio = ground && paint ? contrastOf(paint, ground) : null;
        if (ratio !== null && ratio < SEAM_MIN_CONTRAST) throw new Error(`a ${kind} won't show on this film's ground ${ground} (contrast ${ratio}:1); pick a transition that moves or veils the shots instead`);
        const reason = why(a);
        s.transition = kind;
        notes.push(`${s.id} enters with ${kind}: ${reason}`);
        return { ok: true };
      },
      add_block: (a) => {
        const s = shot(a.shotId);
        const name = String(a.name ?? "");
        if (!known.has(name)) throw new Error(`${name} isn't in the catalog: use a name search_catalog returned`);
        const reason = why(a);
        s.visual.block = name;
        if (!plan.blocks.includes(name)) plan.blocks.push(name);
        notes.push(`${s.id} uses the block ${name}: ${reason}`);
        return { ok: true };
      },
      set_look: (a) => {
        const s = shot(a.shotId);
        const reason = why(a);
        const errors: string[] = [];
        const effects = checkEffects({ ...s.effects, ...a, reason }, `${s.id} effects`, errors);
        if (errors.length || !effects) throw new Error(errors.join("; ") || "give at least one of light, blurPx, depthLayers, glowPx");
        s.effects = effects;
        notes.push(`${s.id} look (${Object.keys(effects).filter((k) => k !== "reason").join(", ")}): ${reason}`);
        return { ok: true };
      },
    };
    const system = `${INSTRUCTIONS.effects}\n\n${this.guidance("effects")}`.trim();
    const brief = JSON.stringify({
      ...(this.capabilities ? { capabilities: this.planCapabilities("effects") } : {}),
      plan: { title: plan.title, message: plan.message, look: plan.look, shots: plan.shots.map((s) => ({ id: s.id, purpose: s.purpose, seconds: s.durationSec, text: s.text.map((t) => t.value), visual: s.visual.description, motion: s.motion, transition: s.transition, hold: s.hold })) },
      blocksAllowed: blocksOn,
      task: "Choose this film's effects with the tools: a few seams with a transition that has a cause, and light, blur, depth or glow where a shot needs it. Search first, then set. When you are done, answer with one sentence on what you chose.",
    });
    const summary = await this.log.track(
      { projectId: input.project.id, kind: "effects", model: this.llm.modelFor("plan"), request: brief },
      () => this.llm.runTools([{ role: "system", content: system }, { role: "user", content: brief }], tools, handlers, {
        maxSteps: input.maxSteps, tokenBudget: input.tokenBudget, temperature: TEMPERATURE.plan, maxTokens: this.llm.genMaxTokens, budgetName: GEN_BUDGET, model: this.llm.modelFor("plan"),
        finalPrompt: "Stop choosing. Answer with one sentence on the effects you chose.",
      }),
      (out) => ({ response: { choices: notes, summary: out } }),
    );
    // The pass has the last word on a shot it changed: the plan's own notes about that shot go, or the
    // plan says two things at once (a real gate refused "s06 -> s07 wipe" next to "s07 enters with zoom").
    const changed = new Set(notes.map((n) => n.split(" ")[0]!));
    const kept = (plan.effectNotes ?? []).filter((n) => ![...changed].some((id) => new RegExp(`\\b${id}\\b`).test(n)));
    const check = validatePlan({ ...plan, effectNotes: [...kept, ...notes] }, input.planCtx);
    if (!check.ok) throw new DirectorError(`The effects the director chose broke the plan: ${check.errors.join("; ")}`);
    return { plan: check.plan as Plan, notes: [...notes, ...(clip(summary, 300) ? [clip(summary, 300)] : [])] };
  }

  // ---- scenes ---------------------------------------------------------------

  /**
   * What a scene call knows: the shot with its effects and the transitions on either side, what the
   * shot before hands on and how the next one opens, the film around it, the size, the files and fonts.
   */
  private sceneBase(input: SceneInput) {
    const { plan, index } = input;
    const prev = plan.shots[index - 1];
    const next = plan.shots[index + 1];
    const shot = plan.shots[index]!;
    // what every shot of the film shares comes first and the shot's own fields after it: providers cache
    // a request's prefix, and with the shot first the 9 KB capabilities were never cached (34% cache
    // hits on a real build, 2026-11-02)
    return {
      ...(this.capabilities ? { capabilities: this.sceneCapabilities(input) } : {}),
      film: { title: plan.title, message: plan.message, look: plan.look, language: plan.language, shots: plan.shots.length },
      size: { width: input.width, height: input.height }, assets: input.assets, fonts: plan.look.fonts, blocks: input.blocks ?? {},
      position: index + 1, compositionId: shotId(index), file: shotFile(index),
      shot, effects: shot.effects ?? null,
      enters: index === 0 ? "the film opens on this shot" : shot.transition, leaves: next ? next.transition : "the film ends on this shot",
      before: prev ? { id: prev.id, purpose: prev.purpose, lastText: prev.text.at(-1)?.value ?? null, handoff: prev.handoff ?? null } : null,
      after: next ? { id: next.id, purpose: next.purpose, firstText: next.text[0]?.value ?? null, opens: next.visual.description } : null,
    };
  }

  /**
   * A scene, repair or kit shot. With a session (the build's version id, GEN_SESSION on) it is the next
   * turn of the build's one conversation: the film and the parts are said once at the start, every shot
   * written so far stays in view (so the film stays consistent), and each call reuses the whole
   * conversation from the provider's prompt cache. Turns take their place in line, one at a time.
   * Without one it is a fresh call, as before.
   */
  private async askScene<T>(
    input: SceneInput, kind: "scene" | "repair" | "kitshot", extra: Record<string, unknown>, task: string,
    validate: (parsed: unknown) => Validated<T>, keep: (value: T) => string,
  ): Promise<T> {
    if (!input.session || !this.llm.genSession) return this.ask(input.project, kind, input.step, { ...this.sceneBase(input), ...extra }, task, validate);
    const session = this.sessionFor(input);
    const turn = session.turn.then(async () => {
      this.trim(session);
      const level = input.level ?? "compose";
      const levelMeans = this.capabilities ? this.capabilities({ level }).levelMeans : undefined;
      session.messages.push({ role: "user", content: JSON.stringify({ request: kind, level, ...(levelMeans ? { levelMeans } : {}), ...this.sceneOwn(input), ...extra, task }) });
      const { value } = await this.converse<T>(input.project, kind, session.messages, [...session.tools, ...SESSION_TOOLS], task, validate, level, false, input.tools ?? null);
      session.latest.set(input.index, keep(value));
      return value;
    });
    session.turn = turn.catch(() => undefined);
    return turn;
  }

  /** The build's session, opened on its first turn: the instructions, then the whole film and what the parts can do. */
  private sessionFor(input: SceneInput): Session {
    const key = input.session as string;
    const open = this.sessions.get(key);
    if (open) return open;
    const { plan } = input;
    const film = {
      ...(this.capabilities ? { capabilities: this.sceneCapabilities({ ...input, level: "free" }) } : {}),
      film: { title: plan.title, message: plan.message, look: plan.look, language: plan.language, shots: plan.shots },
      size: { width: input.width, height: input.height }, assets: input.assets, fonts: plan.look.fonts,
      task: "This is the film you are building, and what this install can do. Each request that follows asks for one shot (request scene), a repair of one (repair) or a kit-level shot (kitshot), at the level it names (levelMeans says what that level allows). Keep the film one film: the same characters, objects, colours and drawing style from shot to shot.",
    };
    const session: Session = {
      messages: [{ role: "system", content: this.sessionSystem(input.step) }, { role: "user", content: JSON.stringify(film) }],
      opening: 2, latest: new Map(), turn: Promise.resolve(),
      tools: TOOL_ORDER.filter((n) => input.tools?.tools[n]).map((n) => TOOL_DEFS[n]),
    };
    this.sessions.set(key, session);
    while (this.sessions.size > MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value as string);
    return session;
  }

  /** The session's system message: the three jobs, the authoring contract with its worked example, and the step's own prompt. */
  private sessionSystem(step: RecipeStep): string {
    const own = step.prompt;
    const jobs = `${INSTRUCTIONS.scene}\n\nRequests come one at a time in this conversation. A "repair" request: ${INSTRUCTIONS.repair.replace(/^You are[^.]*\. /, "")} A "kitshot" request: ${INSTRUCTIONS.kitshot.replace(/^You are[^.]*\. /, "")}`;
    const instructions = own?.mode === "replace" ? own.text : `${jobs}\n\n${this.guidance("scene")}${own ? `\n\n${own.text}` : ""}`;
    return `${instructions.trim()}\n\nGive each answer by calling the function its request names (submit_scene, submit_repair or submit_shot_kit). Do not write the answer as text.`;
  }

  /**
   * Past GEN_CONTEXT_TOKENS (≈ 3.5 characters a token) the session starts again from its opening and
   * the latest version of every shot written so far, so it never outgrows the model's window.
   */
  private trim(session: Session): void {
    const chars = session.messages.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0) + JSON.stringify(m.tool_calls ?? "").length, 0);
    if (chars / 3.5 <= this.llm.genContextTokens) return;
    const shots = [...session.latest].sort((a, b) => a[0] - b[0]).map(([i, latest]) => ({ shot: i + 1, file: shotFile(i), latest }));
    session.messages = [...session.messages.slice(0, session.opening), { role: "user", content: JSON.stringify({ shotsSoFar: shots, task: "The conversation was shortened to fit: these are the latest versions of the shots written so far. Carry on from them." }) }];
  }

  /** What a scene call says about its own shot (the session said the rest at its start). */
  private sceneOwn(input: SceneInput) {
    const base = this.sceneBase(input);
    const { capabilities: _c, film: _f, size: _s, assets: _a, fonts: _o, ...own } = base as typeof base & { capabilities?: unknown };
    return own;
  }

  /** The scene file for one shot (compositions/shot-NN.html). The checks run in code afterwards. */
  async scene(input: SceneInput): Promise<string> {
    const id = shotId(input.index);
    return this.askScene<string>(
      input, "scene", {},
      `Write ${shotFile(input.index)} for shot ${input.index + 1} of ${input.plan.shots.length} as one complete HTML document, with data-composition-id="${id}".`,
      (parsed) => htmlOf(parsed), (html) => html,
    );
  }

  /** A scene that failed its checks goes back with its own findings; it may keep a warning with a reason. */
  async repair(input: SceneInput & { html: string; findings: Array<{ code: string; message: string; hint?: string }> }): Promise<{ html: string; holds: Array<{ code: string; reason: string }> }> {
    return this.askScene<{ html: string; holds: Array<{ code: string; reason: string }> }>(
      input, "repair", { currentHtml: input.html, findings: input.findings },
      `Repair ${shotFile(input.index)} so that every finding is resolved. Change only what the findings need, and keep the planned text and timeline.`,
      (parsed) => {
        const out = htmlOf(parsed);
        if (out.errors) return { errors: out.errors };
        const raw = (parsed as { holds?: unknown }).holds;
        const holds = (Array.isArray(raw) ? raw : []).flatMap((h) => {
          const o = (typeof h === "object" && h !== null ? h : {}) as Record<string, unknown>;
          return clip(o.code, 80) && clip(o.reason, 300) ? [{ code: clip(o.code, 80), reason: clip(o.reason, 300) }] : [];
        });
        return { value: { html: out.value as string, holds } };
      },
      (out) => out.html,
    );
  }

  /**
   * The kit level (FR-042): the model only picks parts, settings and times for the shot; Sorot writes
   * the scene from the answer. The answer is checked against the capability description and the plan.
   */
  async kitShot(input: SceneInput & { kit: KitManifest[]; findings?: Array<{ code: string; message: string; hint?: string }> }): Promise<KitShot> {
    const caps = this.sceneCapabilities({ ...input, level: "kit" }) ?? undefined;
    const shot = input.plan.shots[input.index]!;
    return this.askScene<KitShot>(
      { ...input, level: "kit" }, "kitshot", input.findings ? { findings: input.findings } : {},
      `Build shot ${shot.id} (${shot.durationSec} s) from kit parts: call submit_shot_kit with its layers and its planned lines.`,
      (parsed) => validateKitShot(parsed, shot, caps, input.kit), (answer) => JSON.stringify(answer),
    );
  }

  // ---- judge ----------------------------------------------------------------

  /**
   * The CREATIVE judge when Jev is off or failing: a call with fresh messages (the brief, the plan
   * and what was built, never the director's history), optionally with the review sheets as images.
   * Every criterion and risk asked about must be answered.
   */
  async judge(input: {
    project: GenProject; step: RecipeStep; facts: unknown; criteria: Array<{ id: string; question: string }>;
    risks: Array<{ id: string; question: string }>; images?: string[];
  }): Promise<JudgeAnswer> {
    return this.ask<JudgeAnswer>(
      input.project, "judge", input.step,
      { facts: input.facts, criteria: input.criteria, risks: input.risks, pictures: (input.images ?? []).length },
      "Judge the video: answer each criterion with yes, partly or no and a reason, and say for each risk whether it is flagged.",
      (parsed) => {
        const raw = parsed as { criteria?: unknown; risks?: unknown };
        const list = (v: unknown) => (Array.isArray(v) ? v : []).filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null);
        const criteria = list(raw.criteria).flatMap((c) => (
          typeof c.id === "string" && (c.answer === "yes" || c.answer === "partly" || c.answer === "no")
            ? [{
              id: c.id, answer: c.answer as "yes" | "partly" | "no", reason: clip(c.reason, 300),
              ...(clip(c.shotId, 20) ? { shotId: clip(c.shotId, 20) } : {}), ...(typeof c.fromSec === "number" ? { fromSec: c.fromSec } : {}),
              ...(typeof c.toSec === "number" ? { toSec: c.toSec } : {}), ...(clip(c.suggestedFix, 300) ? { suggestedFix: clip(c.suggestedFix, 300) } : {}),
            }] : []));
        const risks = list(raw.risks).flatMap((r) => (typeof r.id === "string" && typeof r.flagged === "boolean"
          ? [{ id: r.id, flagged: r.flagged, reason: clip(r.reason, 300), ...(clip(r.shotId, 20) ? { shotId: clip(r.shotId, 20) } : {}), ...(clip(r.suggestedFix, 300) ? { suggestedFix: clip(r.suggestedFix, 300) } : {}) }] : []));
        const missing = [
          ...input.criteria.filter((c) => !criteria.some((a) => a.id === c.id)).map((c) => c.id),
          ...input.risks.filter((c) => !risks.some((a) => a.id === c.id)).map((c) => c.id),
        ];
        return missing.length ? { errors: [`you didn't answer: ${missing.join(", ")}`] } : { value: { criteria, risks } };
      },
      input.images,
    );
  }

  // ---- facts -----------------------------------------------------------------

  /**
   * One claim against the text of its source. A verdict of verified or corrected must quote the page
   * (checked here), and a number in the claim or the correction must be in the quote: nothing new is
   * ever added. A page that is only a headline cannot verify anything unless the recipe allows it.
   */
  async verifyFact(input: {
    project: GenProject; step: RecipeStep; claim: string; value: string | null; sourceUrl: string; page: string; headlinesAsEvidence: boolean;
  }): Promise<Verification> {
    return this.ask<Verification>(
      input.project, "verify", input.step, { claim: input.claim, value: input.value, sourceUrl: input.sourceUrl, sourceText: input.page },
      "Check the claim against sourceText: verified, corrected (give the value the page states) or unverifiable. Quote the page word for word.",
      (parsed) => {
        const raw = parsed as { verdict?: unknown; correctedValue?: unknown; evidence?: unknown; reason?: unknown };
        const reason = clip(raw.reason, 300);
        if (raw.verdict === "unverifiable") return { value: { verdict: "unverifiable", correctedValue: null, evidence: null, reason } };
        if (raw.verdict !== "verified" && raw.verdict !== "corrected") return { errors: ["verdict is verified, corrected or unverifiable"] };
        const evidence = clip(raw.evidence, 600);
        if (!evidence || !isOnPage(evidence, input.page)) return { errors: ["the evidence must be a passage copied word for word from sourceText"] };
        if (evidence.length < MIN_QUOTE && !input.headlinesAsEvidence) return { errors: [`the evidence is only ${evidence.length} characters; quote the sentence that states it`] };
        if (headlineOnly(input.page) && !input.headlinesAsEvidence) return { value: { verdict: "unverifiable", correctedValue: null, evidence: null, reason: "the source is only a headline, which is not evidence" } };
        const stated = numbersOf(evidence);
        if (raw.verdict === "corrected") {
          const corrected = clip(raw.correctedValue, 120);
          const n = numbersOf(corrected)[0];
          if (!corrected || (n && !stated.some((s) => sameNumber(s, n)))) return { errors: ["correctedValue must be a value that the evidence states"] };
          return { value: { verdict: "corrected", correctedValue: corrected, evidence, reason } };
        }
        const mine = numbersOf(`${input.claim} ${input.value ?? ""}`);
        const missing = mine.filter((n, i) => !stated.some((s) => sameNumber(s, n)) && mine.findIndex((m) => sameNumber(m, n)) === i);
        if (missing.length) return { errors: [`the evidence does not state ${missing.map((n) => n.raw).join(", ")}: choose corrected or unverifiable`] };
        return { value: { verdict: "verified", correctedValue: null, evidence, reason } };
      },
    );
  }

  /**
   * Finds facts for a topic with read-only tools (fetch a page, search the web, query a registered
   * data source). Whatever comes back must name its source; the step drops the rest.
   */
  async research(input: {
    project: GenProject; step: RecipeStep; known: string[]; maxSteps: number; handlers: Record<string, ToolHandler>; dataSources: string[];
  }): Promise<Array<{ claim: string; value: string | null; sourceUrl: string }>> {
    const tools = [
      tool("fetch_url", "Read a web page as text.", { url: { type: "string" } }),
      tool("search_web", "Search the web.", { query: { type: "string" } }),
      ...(input.dataSources.length ? [tool("query_data", `Run one read-only SELECT on a data source (${input.dataSources.join(", ")}).`, { source: { type: "string" }, sql: { type: "string" } })] : []),
    ];
    const system = "You gather facts for a short video. Use the tools to find numbers and claims about the brief's topic, each with the address of the page (or data:<source>) that states it. Only report what a tool showed you; never recall from memory. Finally answer with JSON only: {\"facts\":[{\"claim\":\"...\",\"value\":\"...\",\"sourceUrl\":\"...\"}]}.";
    const brief = JSON.stringify({ brief: input.project.brief, language: input.project.language, alreadyKnown: input.known, task: "Find the facts the video needs, with their sources, then answer with the JSON." });
    const messages: ChatMessage[] = [{ role: "system", content: system }, { role: "user", content: brief }];
    const text = await this.log.track(
      { projectId: input.project.id, kind: "research", model: this.llm.modelFor("plan"), request: brief },
      () => this.llm.runTools(messages, tools, input.handlers, { model: this.llm.modelFor("plan"), maxSteps: input.maxSteps, temperature: 0.2, maxTokens: this.llm.genMaxTokens, budgetName: GEN_BUDGET, finalPrompt: "Stop researching. Answer now with the JSON of the facts you found, each with its source." }),
      (out) => ({ response: out }),
    );
    const list = (parseJson(text) as { facts?: unknown } | null)?.facts;
    return (Array.isArray(list) ? list : []).flatMap((f) => {
      const o = (typeof f === "object" && f !== null ? f : {}) as Record<string, unknown>;
      return clip(o.claim, 400) && clip(o.sourceUrl, 500) ? [{ claim: clip(o.claim, 400), value: clip(o.value, 120) || null, sourceUrl: clip(o.sourceUrl, 500) }] : [];
    });
  }

  // ---- look ------------------------------------------------------------------

  /** A fresh look at the frames of a build, by the vision model. Every shot with a picture must be answered. */
  async look(input: {
    project: GenProject; step: RecipeStep; expected: Array<{ shotId: string; reads: string; heroMove: string }>; audit: string[]; images: string[];
  }): Promise<{ frames: Array<{ shotId: string; description: string; objects: string[]; unexplained: string[]; matches: boolean; heroVisible: boolean }>; defaultsSeen: string[] }> {
    return this.ask(
      input.project, "look", input.step,
      { pictures: input.images.length, shots: input.expected.map((e) => e.shotId), meant: input.expected, defaultsAudit: input.audit },
      "Describe each picture as a stranger, then compare it with `meant`. Answer for every shot: the pictures come in the order of `shots`.",
      (parsed) => {
        const raw = parsed as { frames?: unknown; defaultsSeen?: unknown };
        const list = Array.isArray(raw.frames) ? raw.frames : [];
        const texts = (v: unknown) => (Array.isArray(v) ? v.map((x) => clip(x, 120)).filter(Boolean) : []);
        const frames = list.flatMap((f) => {
          const o = (typeof f === "object" && f !== null ? f : {}) as Record<string, unknown>;
          const shotId = clip(o.shotId, 20);
          return shotId && clip(o.description, 400) && typeof o.matches === "boolean" && typeof o.heroVisible === "boolean"
            ? [{ shotId, description: clip(o.description, 400), objects: texts(o.objects), unexplained: texts(o.unexplained), matches: o.matches, heroVisible: o.heroVisible }] : [];
        });
        const missing = input.expected.filter((e) => !frames.some((f) => f.shotId === e.shotId)).map((e) => e.shotId);
        return missing.length ? { errors: [`you didn't describe: ${missing.join(", ")}`] } : { value: { frames, defaultsSeen: texts(raw.defaultsSeen) } };
      },
      input.images,
    );
  }

  // ---- concept ---------------------------------------------------------------

  /** The one visual mechanism of the video. With `mechanismTest` a bolt-on is refused; `avoid` lists earlier concepts to differ from. */
  async concept(input: {
    project: GenProject; step: RecipeStep; settings: Record<string, unknown>; assets: GenAsset[]; storyline: Storyline | null; avoid: string[]; note?: string;
  }): Promise<{ mechanism: string; concept: string }> {
    const test = input.settings.mechanismTest === true;
    return this.ask(
      input.project, "concept", input.step,
      { ...this.base(input.project, input.assets), storyline: input.storyline, earlierConcepts: input.avoid, ...(input.note ? { note: input.note } : {}) },
      `Name the one visual mechanism for this video and say whether it is a bolt-on.${input.avoid.length ? " It must not repeat any earlier concept." : ""}`,
      (parsed) => {
        const raw = parsed as { mechanism?: unknown; concept?: unknown; boltOn?: unknown };
        const mechanism = clip(raw.mechanism, 300);
        const concept = clip(raw.concept, 800);
        if (!mechanism || !concept) return { errors: ["give both the mechanism and the concept"] };
        if (test && raw.boltOn !== false) return { errors: ["the mechanism is a bolt-on: it could be moved onto any other topic. Find one that only this topic has."] };
        return { value: { mechanism, concept } };
      },
    );
  }

  /** Is the new concept the same idea as one of the earlier ones? Returns the one it repeats, or null. */
  async sameIdea(input: { project: GenProject; step: RecipeStep; candidate: string; earlier: string[] }): Promise<string | null> {
    return this.ask(
      input.project, "sameidea", input.step, { candidate: input.candidate, earlier: input.earlier },
      "Is `candidate` the same idea as any of `earlier`? Answer same: true with the one it repeats, or same: false.",
      (parsed) => {
        const raw = parsed as { same?: unknown; as?: unknown };
        if (typeof raw.same !== "boolean") return { errors: ["answer same with true or false"] };
        return { value: raw.same ? (clip(raw.as, 400) || input.earlier[0] || "an earlier concept") : null };
      },
    ) as Promise<string | null>;
  }

  // ---- script ----------------------------------------------------------------

  /** The narration, line by line: spoken words only, as long as the video allows. */
  async script(input: {
    project: GenProject; step: RecipeStep; settings: Record<string, unknown>; assets: GenAsset[];
    /** A factual recipe: the numbers in these lines that nothing verified states (an error to repair). */
    unsourced?: (texts: string[]) => string[];
  }): Promise<Array<{ id: string; text: string }>> {
    const { settings, project } = input;
    // The voice must fit the video: a recipe's maxWords is a ceiling, the length is the budget (a 60 s film once got 80 s of voice).
    const fits = Math.max(10, Math.floor(project.targetSec * WORDS_PER_SEC));
    const maxWords = Math.min(typeof settings.maxWords === "number" ? settings.maxWords : fits, fits);
    const spell = settings.spellNumbers === true;
    return this.ask(
      project, "script", input.step,
      { ...this.base(project, input.assets), tone: typeof settings.tone === "string" ? settings.tone : null, maxWords, spellNumbers: spell },
      `Write the narration for this ${project.targetSec}-second video in ${project.language === "en" ? "English" : "Indonesian"}: at most ${maxWords} words in all.${spell ? " Write every number out in words, as it is spoken." : ""}`,
      (parsed) => {
        const raw = (parsed as { lines?: unknown }).lines;
        const list = Array.isArray(raw) ? raw : [];
        const lines = list.flatMap((l) => {
          const o = (typeof l === "object" && l !== null ? l : {}) as Record<string, unknown>;
          return clip(o.text, 400) ? [{ id: clip(o.id, 20) || `l${list.indexOf(l) + 1}`, text: clip(o.text, 400) }] : [];
        });
        const errors: string[] = [];
        if (!lines.length || lines.length > 40) errors.push("write between 1 and 40 lines");
        if (new Set(lines.map((l) => l.id)).size !== lines.length) errors.push("every line needs its own id");
        const words = lines.reduce((n, l) => n + l.text.split(/\s+/).length, 0);
        if (words > maxWords) errors.push(`the script has ${words} words; the most allowed is ${maxWords}`);
        if (spell && lines.some((l) => /\d/.test(l.text))) errors.push("write numbers out in words (no digits): a voice reads them aloud");
        const unsourced = input.unsourced?.(lines.map((l) => l.text)) ?? [];
        if (unsourced.length) errors.push(`these numbers have no verified fact: ${unsourced.join(", ")}; say only numbers from the brief or the verified facts, or none`);
        return errors.length ? { errors } : { value: lines };
      },
    );
  }

  // ---- copy -----------------------------------------------------------------

  /** The title and description an export is posted with, from the approved plan. */
  async copy(input: { project: GenProject; step: RecipeStep; plan: Plan }): Promise<{ title: string; description: string }> {
    const { plan } = input;
    return this.ask<{ title: string; description: string }>(
      input.project, "copy", input.step,
      {
        language: plan.language, title: plan.title, message: plan.message,
        shots: plan.shots.map((s) => ({ text: s.text.map((t) => t.value), narration: s.narration })),
      },
      "Write the title (at most 100 characters) and the description (at most 400 characters) to post this video with.",
      (parsed) => {
        const raw = parsed as { title?: unknown; description?: unknown };
        const title = clip(raw.title, 100).replace(/[<>]/g, "");
        const description = clip(raw.description, 400);
        return title && description ? { value: { title, description } } : { errors: ["give both a title and a description"] };
      },
    );
  }

  // ---- fix ------------------------------------------------------------------

  /**
   * A fix round: the findings the owner chose (and their note) in, what to change out. Scene edits
   * are cheap; a plan edit that changes approved words or timing needs the owner's approval again.
   */
  async fix(input: {
    project: GenProject; step: RecipeStep; plan: Plan; planCtx: PlanContext; note?: string; shotId?: string;
    findings: Array<{ id: string; severity: string; shotId: string | null; fromSec?: number; toSec?: number; code: string; description: string; suggestedFix?: string }>;
  }): Promise<FixAnswer> {
    return this.ask<FixAnswer>(
      input.project, "fix", input.step,
      { approvedPlan: input.plan, findings: input.findings, note: input.note ?? null, onlyShot: input.shotId ?? null, fonts: input.planCtx.fonts },
      `Say how to fix the findings${input.note ? " and do what the note asks" : ""}${input.shotId ? `, only in shot ${input.shotId}` : ""}: sceneEdits per shot, and planEdits only if the plan itself has to change.`,
      (parsed) => {
        const raw = parsed as { sceneEdits?: unknown; planEdits?: unknown; summary?: unknown };
        const list = Array.isArray(raw.sceneEdits) ? raw.sceneEdits : [];
        const sceneEdits = list.flatMap((e) => {
          const o = (typeof e === "object" && e !== null ? e : {}) as Record<string, unknown>;
          return clip(o.shotId, 20) && clip(o.instruction, 600) ? [{ shotId: clip(o.shotId, 20), instruction: clip(o.instruction, 600) }] : [];
        });
        const unknown = sceneEdits.filter((e) => !input.plan.shots.some((s) => s.id === e.shotId)).map((e) => e.shotId);
        if (unknown.length) return { errors: [`there is no shot ${unknown.join(", ")} in the plan (the shots are ${input.plan.shots.map((s) => s.id).join(", ")})`] };
        let plan: Plan | null = null;
        if (raw.planEdits !== undefined && raw.planEdits !== null) {
          const check = validatePlan(raw.planEdits, input.planCtx);
          if (!check.ok) return { errors: check.errors };
          plan = check.plan as Plan;
        }
        if (!sceneEdits.length && !plan) return { errors: ["answer with at least one scene edit, or a revised plan"] };
        return { value: { plan, needsApproval: plan ? approvalChanges(input.plan, plan) : false, sceneEdits, summary: clip(raw.summary, 300) } };
      },
    );
  }

  // ---- gate -----------------------------------------------------------------

  /** A `gate: director` step: the director decides for the owner and says why (storylines: which one; plan: approve or not). */
  async gate(input: {
    project: GenProject; step: RecipeStep; kind: "storylines" | "plan"; output: unknown; rule?: string;
  }): Promise<GateDecision> {
    const count = input.kind === "storylines" ? (input.output as Storyline[]).length : 0;
    return this.ask<GateDecision>(
      input.project, "gate", input.step,
      { stepOutput: input.output, kind: input.kind, brief: input.project.brief, rule: input.rule ?? null },
      input.kind === "storylines"
        ? `Pick one storyline by its number (0 to ${count - 1}) and give the reason: decision "pick".`
        : 'Decide whether this plan is ready for the owner to build from: decision "approve" or "reject".',
      (parsed) => {
        const o = parsed as { decision?: unknown; index?: unknown; reason?: unknown };
        const reason = clip(o.reason, MAX_REASON);
        if (!reason) return { errors: ['"reason" is required'] };
        if (input.kind === "storylines") {
          return o.decision === "pick" && Number.isInteger(o.index) && (o.index as number) >= 0 && (o.index as number) < count
            ? { value: { decision: "pick", index: o.index as number, reason } }
            : { errors: [`decision must be "pick" with an index from 0 to ${count - 1}`] };
        }
        return o.decision === "approve" || o.decision === "reject" ? { value: { decision: o.decision, reason } } : { errors: ['decision must be "approve" or "reject"'] };
      },
    );
  }
}
