import { now } from "../../store";
import { planContext } from "../planContext";
import { parseRecipe } from "../recipe";
import { requiresSourcedNumbers, unsourcedIn } from "../facts";
import type { Concept } from "../novelty";
import { readVoice, snapToVoice } from "../voice";
import { chosenStoryline } from "./storylines";
import type { RunFn, StepContext } from "./types";

/** A different pick builds a different plan. (A revision or an edit makes a new plan row and does not re-run this step.) */
export const inputKey = (ctx: StepContext) => `${ctx.project.pickedStoryline ?? ""}|${ctx.project.narrationScript ?? ""}|${ctx.project.narration}`;

/** Turns the brief and the chosen storyline into a plan: a new revision, waiting for the gate (approval). */
export const run: RunFn = async (ctx) => {
  const { project, store } = ctx;
  const assets = store.genAssetsForProject(project.id);
  const catalog = await ctx.catalog();
  const planCtx = planContext({ project, recipe: parseRecipe(project), assets, connected: ctx.connected, catalog: catalog.map((b) => b.name) });
  const voice = project.narration === 1 ? readVoice(ctx.config, project.id) : null;
  const generated = await ctx.director.plan({
    project, step: ctx.step, settings: ctx.settings, assets, storyline: chosenStoryline(project), planCtx, catalog,
    ...(voice ? { voice: voice.lines.map((l) => ({ id: l.id, text: l.text, durationSec: l.durationSec })) } : {}),
    ...(project.concept ? { concept: JSON.parse(project.concept) as Concept } : {}),
  });
  // `timingFrom: voice`: the plan runs as long as the voice does.
  // A factual recipe never finishes a plan that shows a number nothing has verified.
  if (requiresSourcedNumbers(ctx.recipe)) {
    const bad = unsourcedIn(generated.plan.shots.flatMap((s) => [...s.text.map((t) => t.value), s.narration ?? ""]), project.brief, store.genFactsForProject(project.id));
    if (bad.length) throw new Error(`The plan shows numbers without a verified fact: ${bad.join(", ")}. Add them as facts with a source and verify them, or take them out.`);
  }
  const plan = voice && ctx.settings.timingFrom === "voice" ? snapToVoice(generated.plan, voice.lines) : generated.plan;
  const revision = (store.genPlansForProject(project.id)[0]?.revision ?? 0) + 1;
  const id = crypto.randomUUID();
  store.saveGenPlan({ id, projectId: project.id, revision, plan: JSON.stringify(plan), changeRequest: null, changeSummary: null, approvedAt: null, createdAt: now() });
  store.updateGenProject(project.id, { currentPlanId: id, title: plan.title });
  return { status: "done", outputRef: id };
};
