import { now } from "../../store";
import { planContext } from "../planContext";
import { parseRecipe } from "../recipe";
import { chosenStoryline } from "./storylines";
import type { RunFn, StepContext } from "./types";

/** A different pick builds a different plan. (A revision or an edit makes a new plan row and does not re-run this step.) */
export const inputKey = (ctx: StepContext) => String(ctx.project.pickedStoryline ?? "");

/** Turns the brief and the chosen storyline into a plan: a new revision, waiting for the gate (approval). */
export const run: RunFn = async (ctx) => {
  const { project, store } = ctx;
  const assets = store.genAssetsForProject(project.id);
  const catalog = await ctx.catalog();
  const planCtx = planContext({ project, recipe: parseRecipe(project), assets, connected: ctx.connected, catalog: catalog.map((b) => b.name) });
  const { plan } = await ctx.director.plan({
    project, step: ctx.step, settings: ctx.settings, assets, storyline: chosenStoryline(project), planCtx, catalog,
  });
  const revision = (store.genPlansForProject(project.id)[0]?.revision ?? 0) + 1;
  const id = crypto.randomUUID();
  store.saveGenPlan({ id, projectId: project.id, revision, plan: JSON.stringify(plan), changeRequest: null, changeSummary: null, approvedAt: null, createdAt: now() });
  store.updateGenProject(project.id, { currentPlanId: id, title: plan.title });
  return { status: "done", outputRef: id };
};
