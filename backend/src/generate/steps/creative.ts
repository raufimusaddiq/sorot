import { cpSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { JevError, noul } from "../../jev";
import { now } from "../../store";
import { builtFacts, creativeState, creativeVerdict, fromJev, fromLlm, jevQuestions, questionsFor, type Judgement } from "../creative";
import { isCreative, readFindings, saveFindings } from "../findings";
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
 * The CREATIVE verdict. With a vision model, the questions about how the film looks (SEEN) go to a
 * fresh LLM judge with the review frames; Jev answers the others first; whatever Jev doesn't answer
 * (off or failing) goes to the LLM judge too. The verdict is decided here from the answers.
 */
/** The questions only the frames can answer: a vision judge takes them when one is set up. */
const SEEN = new Set(["finished", "motion"]);

export const run: RunFn = async (ctx) => {
  const { dir, plan } = buildTarget(ctx);
  const { project, version } = ctx;
  const { criteria, risks } = questionsFor(ctx.settings, ctx.recipe.rules);
  const facts = builtFacts(project.brief, plan, chosenStoryline(project), (i) => readScene(dir, i));
  const asked = { projectId: project.id, versionId: version!.id, kind: "judge" };

  const mode = String(ctx.settings.vision);
  if (mode === "on" && !ctx.director.canSee) throw new Error("The creative step needs the LLM to look at the frames (vision: on): connect it in Settings, or use vision: auto");
  const canSee = mode !== "off" && ctx.director.canSee;
  // what only pictures can answer goes to the vision judge when there is one: Jev reads text, and it
  // passed a film whose world was tilted on its side and whose closing line sat on the house (2026-11-02)
  const seen = (q: { id: string }) => canSee && SEEN.has(q.id);
  let judgements: Judgement[] = [];
  const judges: string[] = [];
  let pictures = 0;
  let left = { criteria, risks };
  const toJev = { criteria: criteria.filter((q) => !seen(q)), risks: risks.filter((q) => !seen(q)) };
  if (ctx.jev.enabled && toJev.criteria.length + toJev.risks.length) {
    const questions = [...toJev.criteria, ...toJev.risks];
    try {
      const decision = await ctx.log.track(
        { ...asked, model: ctx.jev.model, request: { state: creativeState(facts), questions: questions.map((c) => c.id) } },
        () => ctx.jev.decide(creativeState(facts), jevQuestions(questions)),
        (d) => ({ response: Object.fromEntries(Object.entries(d.answers).map(([id, a]) => [id, noul(a)])), tokens: d.inputTokens }),
      );
      judgements = fromJev(Object.fromEntries(Object.entries(decision.answers).map(([id, a]) => [id, noul(a)])), toJev.criteria, toJev.risks);
      judges.push(`jev:${decision.model}`);
      left = { criteria: criteria.filter(seen), risks: risks.filter(seen) };
    } catch (e) {
      if (!(e instanceof JevError)) throw e;   // Jev failed: the LLM judges everything
    }
  }
  if (left.criteria.length + left.risks.length) {
    const images = canSee ? await reviewImages(ctx, dir) : [];
    const answer = await ctx.director.judge({
      project, step: ctx.step, facts, criteria: left.criteria.map(({ id, question }) => ({ id, question: question.replace(/`/g, "") })),
      risks: left.risks.map(({ id, question }) => ({ id, question: question.replace(/`/g, "") })), images,
    });
    judgements = [...judgements, ...fromLlm(answer, left.criteria, left.risks)];
    pictures = images.length;
    judges.push(`${pictures ? "llm-vision" : "llm"}:${ctx.director.judgeModel}`);
  }
  const judgedBy = judges.join(" + ");

  const verdict = creativeVerdict(judgements);
  const findings = verdict.findings;
  saveFindings(dir, "creative", findings);
  const mine = readFindings(dir).filter(isCreative);
  // A custom check that counts as creative can ask for a look, never block.
  const status = verdict.status === "PASS" && mine.some((f) => f.source !== "creative" && f.state === "open" && f.severity !== "polish") ? "REVIEW" : verdict.status;
  ctx.store.saveGenVerdict({
    id: crypto.randomUUID(), versionId: version!.id, kind: "CREATIVE", status, findings: JSON.stringify(mine),
    judgedBy, inputs: JSON.stringify({ criteria: criteria.map((c) => c.id), risks: risks.map((c) => c.id), pictures, shots: plan.shots.length }), createdAt: now(),
  });
  return { status: "done", outputRef: status };
};
