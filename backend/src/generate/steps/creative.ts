import { cpSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { JevError, noul } from "../../jev";
import { now } from "../../store";
import { builtFacts, creativeState, creativeVerdict, fromJev, fromLlm, jevQuestions, questionsFor, type Judgement } from "../creative";
import { readFindings, saveFindings } from "../findings";
import { HyperframesError } from "../hyperframes";
import { buildTarget, readScene } from "./build";
import { chosenStoryline } from "./storylines";
import type { RunFn, StepContext } from "./types";

const MAX_FRAMES = 4;
const MIME: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png" };

/** What `snapshot --review` writes: the beat sheet and the phone-size sheet (page 1 of each). */
const SHEETS: Array<[from: string, keep: string]> = [["review-beats-1.jpg", "review-beats.jpg"], ["review-phone-1.jpg", "review-phone.jpg"]];

/** The review sheets as data URLs (kept with the version too); without sheets, the first few frames. */
async function reviewImages(ctx: StepContext, dir: string): Promise<string[]> {
  try {
    const shots = await ctx.hyperframes.snapshot(dir, { review: true }, { signal: ctx.signal });
    const sheets: string[] = [];
    for (const [from, keep] of SHEETS) {
      const path = join(shots.outputDir, from);
      if (!(await Bun.file(path).exists())) continue;
      mkdirSync(join(dir, "sheets"), { recursive: true });
      cpSync(path, join(dir, "sheets", keep));
      sheets.push(path);
    }
    const files = sheets.length ? sheets : shots.frames.slice(0, MAX_FRAMES).map((f) => f.path);
    return files.map((f) => `data:${MIME[f.split(".").pop()?.toLowerCase() ?? ""] ?? "image/png"};base64,${readFileSync(f).toString("base64")}`);
  } catch (e) {
    if (e instanceof HyperframesError && e.code !== "cancelled") return [];   // the judge works from the measured facts instead
    throw e;
  }
}

/**
 * The CREATIVE verdict. Jev answers the recipe's questions first; when it is off or fails, a fresh
 * LLM judge does (with the review frames when a vision model is set up). The verdict is decided
 * here from the answers.
 */
export const run: RunFn = async (ctx) => {
  const { dir, plan } = buildTarget(ctx);
  const { project, version } = ctx;
  const { criteria, risks } = questionsFor(ctx.settings, ctx.recipe.rules);
  const facts = builtFacts(project.brief, plan, chosenStoryline(project), (i) => readScene(dir, i));
  const asked = { projectId: project.id, versionId: version!.id, kind: "judge" };

  let judgements: Judgement[] | null = null;
  let judgedBy = "";
  let pictures = 0;
  if (ctx.jev.enabled) {
    try {
      const decision = await ctx.log.track(
        { ...asked, model: ctx.jev.model, request: { state: creativeState(facts), questions: [...criteria, ...risks].map((c) => c.id) } },
        () => ctx.jev.decide(creativeState(facts), jevQuestions([...criteria, ...risks])),
        (d) => ({ response: Object.fromEntries(Object.entries(d.answers).map(([id, a]) => [id, noul(a)])), tokens: d.inputTokens }),
      );
      judgements = fromJev(Object.fromEntries(Object.entries(decision.answers).map(([id, a]) => [id, noul(a)])), criteria, risks);
      judgedBy = `jev:${decision.model}`;
    } catch (e) {
      if (!(e instanceof JevError)) throw e;   // Jev failed: the LLM judges instead
    }
  }
  if (!judgements) {
    const mode = String(ctx.settings.vision);
    if (mode === "on" && !ctx.director.visionModel) throw new Error("The creative step needs a vision model (vision: on): set one up in Settings, or use vision: auto");
    const images = mode !== "off" && ctx.director.visionModel ? await reviewImages(ctx, dir) : [];
    const answer = await ctx.director.judge({
      project, step: ctx.step, facts, criteria: criteria.map(({ id, question }) => ({ id, question: question.replace(/`/g, "") })),
      risks: risks.map(({ id, question }) => ({ id, question: question.replace(/`/g, "") })), images,
    });
    judgements = fromLlm(answer, criteria, risks);
    pictures = images.length;
    judgedBy = `${pictures ? "llm-vision" : "llm"}:${pictures ? ctx.director.visionModel : ctx.director.model}`;
  }

  const { status, findings } = creativeVerdict(judgements);
  saveFindings(dir, "creative", findings);
  ctx.store.saveGenVerdict({
    id: crypto.randomUUID(), versionId: version!.id, kind: "CREATIVE", status, findings: JSON.stringify(readFindings(dir).filter((f) => f.source === "creative")),
    judgedBy, inputs: JSON.stringify({ criteria: criteria.map((c) => c.id), risks: risks.map((c) => c.id), pictures, shots: plan.shots.length }), createdAt: now(),
  });
  return { status: "done", outputRef: status };
};
