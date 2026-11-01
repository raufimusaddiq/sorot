import { conceptText, earlierConcepts, repeatOf, type Concept } from "../novelty";
import { chosenStoryline } from "./storylines";
import type { RunFn } from "./types";

/**
 * Names the one visual mechanism of the video, before the plan. It must differ from the last
 * `novelty.lastN` concepts of videos made with the same recipe: judged by words, then by the
 * director's "same idea?" check. A repeat is asked about once more, with the repeated idea named;
 * a second repeat stops the run.
 */
export const run: RunFn = async (ctx) => {
  const { project, settings, store } = ctx;
  const lastN = Number((settings.novelty as { lastN?: number } | undefined)?.lastN ?? 30);
  const earlier = earlierConcepts(store, project, lastN);
  const assets = store.genAssetsForProject(project.id);
  const storyline = chosenStoryline(project);

  let note: string | undefined;
  let concept: Concept | null = null;
  let repeated: string | null = null;
  for (let attempt = 0; attempt < 2 && !concept; attempt++) {
    const found = await ctx.director.concept({ project, step: ctx.step, settings, assets, storyline, avoid: earlier, ...(note ? { note } : {}) });
    repeated = repeatOf(conceptText(found), earlier);
    if (!repeated && earlier.length) repeated = await ctx.director.sameIdea({ project, step: ctx.step, candidate: conceptText(found), earlier });
    if (!repeated) concept = found;
    else note = `Your last idea repeats this earlier one: "${repeated.slice(0, 200)}". Find a different mechanism.`;
  }
  if (!concept) throw new Error(`The concept repeats an earlier video's idea (${(repeated ?? "").slice(0, 120)}) even after a second try`);
  store.updateGenProject(project.id, { concept: JSON.stringify(concept) });
  return { status: "done", outputRef: "concept" };
};
