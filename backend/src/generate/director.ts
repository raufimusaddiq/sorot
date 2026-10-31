import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJson, tool, withImages, type ChatInput, type ChatMessage, type Llm, type ToolDef } from "../llm";
import type { GenAsset, GenProject, Json } from "../types";
import type { DirectorLog } from "./events";
import { shotFile, shotId } from "./composer";
import { validatePlan, type Plan, type PlanContext } from "./planSchema";
import type { RecipeStep } from "./recipe";

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
  sound: { type: "object", properties: { music: str('"none" or an asset'), narration: { type: "boolean" } } },
  narrationScript: { type: ["string", "null"] },
  blocks: { type: "array", items: str("a registry block name") },
  assumptions: { type: "array", items: str("anything you added that the brief did not say") },
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
        motion: str("how it moves"), transition: str("cut, wipe..."), audio: { type: "string" }, narration: { type: ["string", "null"] }, hold: { type: "boolean" },
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
} as const satisfies Record<string, ToolDef>;

/** Top-level sections of story.md that apply to each job. */
const GUIDANCE_SECTIONS: Record<keyof typeof TOOLS, string[]> = { storylines: ["Storylines"], plan: ["Plan"], revise: ["Plan", "Revising"], gate: [], scene: [], repair: [], judge: [], fix: ["Plan", "Revising"] };

const INSTRUCTIONS = {
  storylines: "You are the director of a short 2D motion video. From the brief, write storylines: different films, not rewordings of one.",
  plan: "You are the director of a short 2D motion video. Turn the brief and the chosen storyline into a shot-by-shot plan the owner will approve before anything is built. Text on screen is in the project's language. Use only the fonts listed. Use only numbers from the brief; list any other number you need in assumptions.",
  revise: "You are the director of a short 2D motion video. Change the plan as the owner asks. Change only what the request names: every other shot keeps its text, timing and look exactly as it is.",
  gate: "You are the director of a short 2D motion video, deciding for the owner who is not at the keyboard. Choose by the rule given, and state the reason in one clause.",
  fix: "You are the director of a short 2D motion video. The video was built and judged; fix the findings the owner chose (and do what their note says). Prefer sceneEdits: they change how a shot looks and moves and cost little. Change the plan (planEdits) only when a finding cannot be fixed without it, because changing the plan's words or timing makes the owner approve again. Keep everything the findings don't touch exactly as it is.",
  judge: "You are a fresh judge of a finished 2D video. You did not make it and know nothing of how it was made. Judge only what the brief, the plan, and what was built (and the pictures, if any) show. Answer every criterion and every risk you are given, honestly: yes only when it clearly holds, no when it clearly doesn't, partly in between. A risk is flagged only when you can point at it. Point at the shot and the moment when you can, and say what to change.",
  scene: "You are the motion designer of a short 2D video. Write the scene file for the ONE shot you are given, exactly as the approved plan describes it, following the authoring contract below.",
  repair: "You are the motion designer of a short 2D video. Fix the scene file for the ONE shot you are given so that every finding listed is resolved, changing nothing else, following the authoring contract below. A warning that is intended may be kept: list it in holds with the reason.",
} as const;

type Kind = keyof typeof TOOLS;
const TEMPERATURE: Record<Kind, number> = { storylines: 0.8, plan: 0.4, revise: 0.3, gate: 0.1, scene: 0.5, repair: 0.2, judge: 0.1, fix: 0.3 };
/** Output budget by job, as a floor: a reasoning model thinks before it writes the arguments. */
const MIN_TOKENS: Record<Kind, number> = { storylines: 8000, plan: 12000, revise: 12000, gate: 3000, scene: 16000, repair: 16000, judge: 8000, fix: 12000 };

export interface JudgeAnswer {
  criteria: Array<{ id: string; answer: "yes" | "partly" | "no"; reason: string; shotId?: string; fromSec?: number; toSec?: number; suggestedFix?: string }>;
  risks: Array<{ id: string; flagged: boolean; reason: string; shotId?: string; suggestedFix?: string }>;
}

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
}

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

export class Director {
  private guide: string | null = null;
  private contract: string | null = null;

  constructor(private readonly llm: Llm, private readonly log: DirectorLog, private readonly generatorDir: string) {}

  /** The model that answers, and the one that looks at pictures (null when none is set up). */
  get model(): string { return this.llm.model; }
  get visionModel(): string | null { return this.llm.visionModel; }

  /** generator/prompts/authoring.md: the contract a scene must keep (read once). */
  private authoring(): string {
    if (this.contract === null) {
      const path = join(this.generatorDir, "prompts", "authoring.md");
      this.contract = existsSync(path) ? readFileSync(path, "utf-8").replace(/<!--[\s\S]*?-->/g, "").trim() : "";
    }
    return this.contract;
  }

  /** The part of generator/prompts/story.md that applies to this job (the file is read once). */
  private guidance(kind: Kind): string {
    if (this.guide === null) {
      const path = join(this.generatorDir, "prompts", "story.md");
      this.guide = existsSync(path) ? readFileSync(path, "utf-8").replace(/<!--[\s\S]*?-->/g, "").trim() : "";
    }
    if (kind === "scene" || kind === "repair") return this.authoring();
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
    const def = TOOLS[kind];
    const name = def.function.name;
    const brief = JSON.stringify({ ...payload, task });
    const messages: ChatInput[] = [
      { role: "system", content: this.system(kind, step) },
      images.length ? withImages(brief, ...images) : { role: "user", content: brief },
    ];
    let problems: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      let answer = "";
      const reply = await this.log.track(
        { projectId: project.id, kind, model: images.length ? (this.llm.visionModel ?? this.llm.model) : this.llm.model, request: messages.map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : `${m.content.length - 1} image(s), ${(m.content[0] as { text: string }).text}`}`).join("\n\n") },
        async () => {
          const opts = { tools: [def], toolChoice: name, temperature: TEMPERATURE[kind], maxTokens: Math.max(this.llm.maxTokens, MIN_TOKENS[kind]) };
          const r = images.length ? await this.llm.see(messages, opts) : await this.llm.chat(messages as ChatMessage[], opts);
          const call = r.tool_calls?.find((c) => c.function?.name === name);
          const args = call?.function.arguments;
          answer = typeof args === "string" ? args : args ? JSON.stringify(args) : r.content;
          return { message: r, call };
        },
        (out) => ({ response: answer || out.message.content }),
      );
      const parsed = answer ? parseJson(answer) : null;
      const result: Validated<T> = parsed === null
        ? { errors: [reply.call ? "the function arguments were not valid JSON" : `you didn't call ${name}`] }
        : validate(parsed);
      if (result.value !== undefined) return result.value;
      problems = result.errors ?? [];
      const retry = JSON.stringify({ problems, task: `Fix these problems and call ${name} again with the full answer. ${task}` });
      if (reply.call) {
        messages.push(
          { role: "assistant", content: "", tool_calls: [reply.call] },
          { role: "tool", tool_call_id: reply.call.id || name, name, content: JSON.stringify({ accepted: false, problems }) },
        );
      } else {
        messages.push({ role: "assistant", content: reply.message.content });
      }
      messages.push({ role: "user", content: retry });
    }
    throw new DirectorError(`The director's ${kind} didn't pass the checks: ${problems.join("; ")}`);
  }

  private base(project: GenProject, assets: GenAsset[]) {
    return {
      brief: project.brief, format: project.format, targetSec: project.targetSec, language: project.language,
      styleNotes: project.styleNotes, preset: project.preset,
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
  }): Promise<{ plan: Plan; notes: string[] }> {
    const { planCtx } = input;
    return this.ask(
      input.project, "plan", input.step,
      {
        ...this.base(input.project, input.assets), storyline: input.storyline,
        fonts: planCtx.fonts, maxShots: planCtx.limits?.maxShots ?? 20,
        blocks: planCtx.blocksAllowed === false ? [] : input.catalog,
        connections: { image: planCtx.imageConnected, narration: planCtx.narration },
      },
      `Write the shot-by-shot plan for this ${input.project.targetSec}-second ${input.project.format} video. The shot durations add up to ${input.project.targetSec} seconds.`,
      (parsed) => {
        const check = validatePlan(parsed, planCtx);
        return check.ok ? { value: { plan: check.plan as Plan, notes: check.notes } } : { errors: check.errors };
      },
    );
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

  // ---- scenes ---------------------------------------------------------------

  /** What a scene call knows: the shot, the film around it, the size, the files and fonts it may use. */
  private sceneBase(input: SceneInput) {
    const { plan, index } = input;
    return {
      shot: plan.shots[index], compositionId: shotId(index), file: shotFile(index), size: { width: input.width, height: input.height },
      film: { title: plan.title, message: plan.message, look: plan.look, language: plan.language, position: index + 1, of: plan.shots.length },
      assets: input.assets, fonts: plan.look.fonts, blocks: input.blocks ?? {},
    };
  }

  /** The scene file for one shot (compositions/shot-NN.html). The checks run in code afterwards. */
  async scene(input: SceneInput): Promise<string> {
    const id = shotId(input.index);
    return this.ask<string>(
      input.project, "scene", input.step, this.sceneBase(input),
      `Write ${shotFile(input.index)} for shot ${input.index + 1} of ${input.plan.shots.length} as one complete HTML document, with data-composition-id="${id}".`,
      (parsed) => htmlOf(parsed),
    );
  }

  /** A scene that failed its checks goes back with its own findings; it may keep a warning with a reason. */
  async repair(input: SceneInput & { html: string; findings: Array<{ code: string; message: string; hint?: string }> }): Promise<{ html: string; holds: Array<{ code: string; reason: string }> }> {
    return this.ask<{ html: string; holds: Array<{ code: string; reason: string }> }>(
      input.project, "repair", input.step, { ...this.sceneBase(input), currentHtml: input.html, findings: input.findings },
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
