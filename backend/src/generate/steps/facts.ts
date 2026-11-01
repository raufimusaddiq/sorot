import { now } from "../../store";
import type { GenFact } from "../../types";
import { dataEvidence, fetchPageText, queryData, type FactWeb } from "../facts";
import type { RunFn, StepContext } from "./types";

/** Never more than this many facts are checked in one run. */
const MAX_FACTS = 60;

const page = async (ctx: StepContext, web: FactWeb | undefined, url: string): Promise<string> => (web ? web.fetchText(url) : fetchPageText(url));

/** Checks each fact against its source; returns how many ended verified, corrected or unverifiable. */
export async function verifyFacts(ctx: StepContext, facts: GenFact[]): Promise<{ verified: number; corrected: number; unverifiable: number }> {
  const out = { verified: 0, corrected: 0, unverifiable: 0 };
  for (const [i, fact] of facts.slice(0, MAX_FACTS).entries()) {
    const stamp = { updatedAt: now() };
    if (fact.sourceUrl?.startsWith("data:")) {
      // a value read straight from a registered data source already carries its evidence
      ctx.store.updateGenFact(fact.id, { status: fact.evidence ? "verified" : "unverifiable", ...stamp });
      out[fact.evidence ? "verified" : "unverifiable"]++;
      continue;
    }
    let text = "";
    let failure = "";
    if (!fact.sourceUrl) failure = "it has no source";
    else {
      try {
        text = await page(ctx, ctx.web, fact.sourceUrl);
      } catch (e) {
        if (ctx.signal?.aborted) throw e;
        failure = `the source can't be read (${(e as Error).message})`;
      }
    }
    if (failure) {
      ctx.store.updateGenFact(fact.id, { status: "unverifiable", evidence: failure, ...stamp });
      out.unverifiable++;
    } else {
      const answer = await ctx.director.verifyFact({
        project: ctx.project, step: ctx.step, claim: fact.claim, value: fact.value, sourceUrl: fact.sourceUrl as string, page: text,
        headlinesAsEvidence: ctx.settings.headlinesAsEvidence === true,
      });
      if (answer.verdict === "corrected") {
        ctx.store.updateGenFact(fact.id, { status: "corrected", originalValue: fact.originalValue ?? fact.value, value: answer.correctedValue, evidence: answer.evidence, ...stamp });
        out.corrected++;
      } else if (answer.verdict === "verified") {
        ctx.store.updateGenFact(fact.id, { status: "verified", evidence: answer.evidence, ...stamp });
        out.verified++;
      } else {
        ctx.store.updateGenFact(fact.id, { status: "unverifiable", evidence: answer.reason, ...stamp });
        out.unverifiable++;
      }
    }
    ctx.progress(((i + 1) / Math.min(facts.length, MAX_FACTS)) * 100, "facts");
  }
  return out;
}

/**
 * Builds or checks the project's fact list. `verify` checks the owner's facts against their sources
 * and adds none; `research` first lets the director look things up with read-only tools (every fact
 * it adds must name its source), then checks those too; `brief-only` leaves the list as it is.
 */
export const run: RunFn = async (ctx) => {
  const { project, store, settings } = ctx;
  const mode = String(settings.mode ?? "verify");
  if (mode === "brief-only") return { status: "done", outputRef: "brief only" };

  if (mode === "research") {
    const sourceNames = (Array.isArray(settings.sources) ? settings.sources : []) as string[];
    const sources = ctx.config.dataSources.filter((s) => sourceNames.includes(s.name));
    const evidenceFor = new Map<string, string>();
    const added = await ctx.director.research({
      project, step: ctx.step, maxSteps: Number(settings.maxSteps ?? 8), dataSources: sources.map((s) => s.name),
      known: store.genFactsForProject(project.id).map((f) => f.claim),
      handlers: {
        fetch_url: async (a) => ({ text: (await page(ctx, ctx.web, String(a.url))).slice(0, 6000) }),
        search_web: async (a) => {
          if (!ctx.web) throw new Error("Web search isn't available");
          return { results: await ctx.web.search(String(a.query)) };
        },
        query_data: (a) => {
          const r = queryData(sources, String(a.source), String(a.sql));
          evidenceFor.set(`data:${String(a.source)}`, dataEvidence(String(a.source), String(a.sql), r));
          return r;
        },
      },
    });
    const known = new Set(store.genFactsForProject(project.id).map((f) => f.claim.toLowerCase()));
    for (const f of added) {
      if (known.has(f.claim.toLowerCase())) continue;
      known.add(f.claim.toLowerCase());
      const t = now();
      store.saveGenFact({
        id: crypto.randomUUID(), projectId: project.id, ideaId: null, claim: f.claim, value: f.value, sourceUrl: f.sourceUrl,
        status: "unverified", originalValue: null, evidence: evidenceFor.get(f.sourceUrl) ?? null, addedBy: "director", createdAt: t, updatedAt: t,
      });
    }
  }

  const pending = store.genFactsForProject(project.id).filter((f) => f.status === "unverified" || f.status === "unverifiable" || f.status === "corrected");
  const result = await verifyFacts(ctx, pending.filter((f) => f.status !== "corrected"));
  return {
    status: "done", outputRef: `${result.verified} verified, ${result.corrected} corrected, ${result.unverifiable} unverifiable`,
    ...(result.unverifiable ? { reason: `${result.unverifiable} fact${result.unverifiable > 1 ? "s" : ""} could not be verified` } : {}),
  };
};
