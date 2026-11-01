import { IdeaBank } from "../ideas";
import type { RunFn } from "./types";

/**
 * Where a video's brief comes from. A project made from an idea already has it: this only confirms
 * the link. One made some other way takes the recipe's next new idea (moving the cursor unless
 * `cursor` is false): the idea's brief becomes the project's brief, and the idea becomes `used`.
 */
export const run: RunFn = async (ctx) => {
  const { project, store } = ctx;
  const bank = new IdeaBank(store);
  if (project.ideaId) {
    const idea = store.getGenIdea(project.ideaId);
    if (!idea) throw new Error(`The idea ${project.ideaId} is no longer in the bank`);
    return { status: "done", outputRef: idea.id };
  }
  const idea = bank.next(project.recipeId);
  if (!idea) throw new Error("The idea bank has no new idea for this recipe: add one with sorot gen idea add");
  store.updateGenProject(project.id, { brief: idea.brief, ideaId: idea.id });
  bank.link(idea.id, project.id);
  if (ctx.settings.cursor !== false) bank.moveCursor(project.recipeId, idea.id);
  return { status: "done", outputRef: idea.id };
};
