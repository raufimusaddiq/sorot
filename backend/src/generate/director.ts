import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJson, tool, type ChatMessage, type Llm, type ToolDef } from "../llm";
import type { GenAsset, GenProject, Json } from "../types";
import type { DirectorLog } from "./events";
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
} as const satisfies Record<string, ToolDef>;

/** Top-level sections of story.md that apply to each job. */
const GUIDANCE_SECTIONS: Record<keyof typeof TOOLS, string[]> = { storylines: ["Storylines"], plan: ["Plan"], revise: ["Plan", "Revising"], gate: [] };

const INSTRUCTIONS = {
  storylines: "You are the director of a short 2D motion video. From the brief, write storylines: different films, not rewordings of one.",
  plan: "You are the director of a short 2D motion video. Turn the brief and the chosen storyline into a shot-by-shot plan the owner will approve before anything is built. Text on screen is in the project's language. Use only the fonts listed. Use only numbers from the brief; list any other number you need in assumptions.",
  revise: "You are the director of a short 2D motion video. Change the plan as the owner asks. Change only what the request names: every other shot keeps its text, timing and look exactly as it is.",
  gate: "You are the director of a short 2D motion video, deciding for the owner who is not at the keyboard. Choose by the rule given, and state the reason in one clause.",
} as const;

type Kind = keyof typeof TOOLS;
const TEMPERATURE: Record<Kind, number> = { storylines: 0.8, plan: 0.4, revise: 0.3, gate: 0.1 };
/** Output budget by job, as a floor: a reasoning model thinks before it writes the arguments. */
const MIN_TOKENS: Record<Kind, number> = { storylines: 8000, plan: 12000, revise: 12000, gate: 3000 };

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

  constructor(private readonly llm: Llm, private readonly log: DirectorLog, private readonly generatorDir: string) {}

  /** The part of generator/prompts/story.md that applies to this job (the file is read once). */
  private guidance(kind: Kind): string {
    if (this.guide === null) {
      const path = join(this.generatorDir, "prompts", "story.md");
      this.guide = existsSync(path) ? readFileSync(path, "utf-8").replace(/<!--[\s\S]*?-->/g, "").trim() : "";
    }
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
  ): Promise<T> {
    const def = TOOLS[kind];
    const name = def.function.name;
    const messages: ChatMessage[] = [
      { role: "system", content: this.system(kind, step) },
      { role: "user", content: JSON.stringify({ ...payload, task }) },
    ];
    let problems: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      let answer = "";
      const reply = await this.log.track(
        { projectId: project.id, kind, model: this.llm.model, request: messages.map((m) => `${m.role}: ${m.content}`).join("\n\n") },
        async () => {
          const r = await this.llm.chat(messages, { tools: [def], toolChoice: name, temperature: TEMPERATURE[kind], maxTokens: Math.max(this.llm.maxTokens, MIN_TOKENS[kind]) });
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
