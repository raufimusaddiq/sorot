import { HttpError } from "../http";
import { now, type Store } from "../store";
import type { GenIdea } from "../types";
import type { Concept } from "./novelty";

// The idea bank (FR-034): ideas the owner (or an outside agent) lines up, taken one by one by
// unattended runs. Each recipe keeps a cursor: "the next idea" is the first still-new one after the
// idea its last run took. Naming an idea resumes it and never moves the cursor.

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const IDEA_STATUSES: ReadonlyArray<GenIdea["status"]> = ["new", "used", "built", "posted"];
const RANK: Record<GenIdea["status"], number> = { new: 0, used: 1, built: 2, posted: 3 };

/** Brief flags an idea may carry; the run turns them into project settings. */
export interface IdeaFlags {
  language?: "id" | "en";
  format?: string;
  targetSec?: number;
  preset?: string;
  narration?: boolean;
  /** `false`: the video shows no numbers but the brief's own. */
  market_data?: boolean;
}

export const historyKey = (recipeId: string) => `gen.history.${recipeId}`;

export interface HistoryFile {
  concepts?: Array<{ recipeId?: string; mechanism?: string; concept?: string; date?: string }>;
  ideas?: Array<{ id?: string; slug?: string; brief?: string; flags?: unknown; status?: string }>;
}

export class IdeaBank {
  constructor(private readonly store: Store) {}

  /** Statuses follow what happened to the idea's video: a version built, an export posted. They only move forward. */
  private refresh(idea: GenIdea): GenIdea {
    if (!idea.projectId) return idea;
    let status = idea.status;
    const versions = this.store.genVersionsForProject(idea.projectId);
    if (versions.some((v) => v.status === "BUILT") && RANK[status] < RANK.built) status = "built";
    const posted = this.store.genExportsForProject(idea.projectId).some((e) =>
      this.store.socialPostsForClip(e.id).some((p) => ["PUBLISHED", "PARTIAL", "SCHEDULED"].includes(p.status)));
    if (posted) status = "posted";
    if (status !== idea.status) {
      this.store.updateGenIdea(idea.id, { status });
      return { ...idea, status };
    }
    return idea;
  }

  list(status?: string): GenIdea[] {
    if (status !== undefined && !IDEA_STATUSES.includes(status as GenIdea["status"])) throw new HttpError(400, `status is one of ${IDEA_STATUSES.join(", ")}`);
    const all = this.store.listGenIdeas().map((i) => this.refresh(i));
    return status ? all.filter((i) => i.status === status) : all;
  }

  get(id: string): GenIdea {
    const idea = this.store.getGenIdea(id);
    if (!idea) throw new HttpError(404, `Idea not found: ${id}`);
    return this.refresh(idea);
  }

  private checkFlags(flags: unknown): string | null {
    if (flags === undefined || flags === null) return null;
    if (typeof flags !== "object" || Array.isArray(flags)) throw new HttpError(400, "flags must be an object");
    const f = flags as Record<string, unknown>;
    if (f.language !== undefined && f.language !== "id" && f.language !== "en") throw new HttpError(400, "flags.language is id or en");
    if (f.targetSec !== undefined && (!Number.isInteger(f.targetSec))) throw new HttpError(400, "flags.targetSec is a whole number of seconds");
    if (f.market_data !== undefined && typeof f.market_data !== "boolean") throw new HttpError(400, "flags.market_data is true or false");
    if (f.narration !== undefined && typeof f.narration !== "boolean") throw new HttpError(400, "flags.narration is true or false");
    return JSON.stringify(f);
  }

  private fields(input: { id?: unknown; slug?: unknown; brief?: unknown; flags?: unknown }, partial: boolean) {
    const out: { id?: string; slug?: string; brief?: string; flags?: string | null } = {};
    if (!partial || input.slug !== undefined) {
      const slug = typeof input.slug === "string" ? input.slug.trim() : "";
      if (!SLUG.test(slug)) throw new HttpError(400, "slug: lowercase letters, digits and dashes (at most 64)");
      out.slug = slug;
    }
    if (!partial || input.brief !== undefined) {
      const brief = typeof input.brief === "string" ? input.brief.trim() : "";
      if (!brief) throw new HttpError(400, "brief required");
      if (brief.length > 2000) throw new HttpError(400, "The brief can be at most 2000 characters");
      out.brief = brief;
    }
    if (input.flags !== undefined) out.flags = this.checkFlags(input.flags);
    if (!partial && input.id !== undefined) {
      if (typeof input.id !== "string" || !ID.test(input.id)) throw new HttpError(400, "id: letters, digits, dots, dashes and underscores (at most 64)");
      out.id = input.id;
    }
    return out;
  }

  /** Adds an idea; `facts` are kept with it and go to the project that is made from it. */
  add(input: { id?: unknown; slug?: unknown; brief?: unknown; flags?: unknown; status?: unknown }, facts: Array<{ claim: string; value: string | null; sourceUrl: string }> = []): GenIdea {
    const f = this.fields(input, false);
    const id = f.id ?? crypto.randomUUID();
    if (this.store.getGenIdea(id)) throw new HttpError(409, `An idea with the id ${id} exists already`);
    if (this.store.listGenIdeas().some((i) => i.slug === f.slug)) throw new HttpError(409, `An idea with the slug ${f.slug} exists already`);
    const status = input.status === undefined ? "new" : input.status;
    if (!IDEA_STATUSES.includes(status as GenIdea["status"])) throw new HttpError(400, `status is one of ${IDEA_STATUSES.join(", ")}`);
    const t = now();
    const idea = this.store.saveGenIdea({
      id, slug: f.slug as string, brief: f.brief as string, flags: f.flags ?? null, status: status as GenIdea["status"], projectId: null, createdAt: t, updatedAt: t,
    });
    for (const fact of facts) {
      this.store.saveGenFact({
        id: crypto.randomUUID(), projectId: null, ideaId: id, claim: fact.claim, value: fact.value, sourceUrl: fact.sourceUrl, status: "unverified",
        originalValue: null, evidence: null, addedBy: "idea", createdAt: t, updatedAt: t,
      });
    }
    return idea;
  }

  update(id: string, input: { slug?: unknown; brief?: unknown; flags?: unknown }): GenIdea {
    const idea = this.get(id);
    const f = this.fields(input, true);
    if (f.slug && f.slug !== idea.slug && this.store.listGenIdeas().some((i) => i.slug === f.slug)) throw new HttpError(409, `An idea with the slug ${f.slug} exists already`);
    this.store.updateGenIdea(id, { ...f });
    return this.get(id);
  }

  remove(id: string): void {
    this.get(id);
    for (const fact of this.store.genFactsForIdea(id)) this.store.deleteGenFact(fact.id);
    this.store.deleteGenIdea(id);
  }

  /** The facts that came with an idea. */
  factsOf(id: string) {
    return this.store.genFactsForIdea(id);
  }

  /** The next idea for a recipe: still new, and after the one its last run took. */
  next(recipeId: string): GenIdea | null {
    const cursorId = this.store.getGenRecipe(recipeId)?.ideaCursor ?? null;
    const all = this.list();
    const at = cursorId ? all.findIndex((i) => i.id === cursorId) : -1;
    return all.slice(at + 1).find((i) => i.status === "new") ?? null;
  }

  moveCursor(recipeId: string, ideaId: string): void {
    this.store.updateGenRecipe(recipeId, { ideaCursor: ideaId });
  }

  link(ideaId: string, projectId: string): void {
    this.store.updateGenIdea(ideaId, { status: "used", projectId });
  }

  // ---- past work ------------------------------------------------------------------

  /** Concepts a recipe's novelty check also compares with (history imported from elsewhere). */
  history(recipeId: string): Array<Concept & { date: string }> {
    const raw = this.store.settings()[historyKey(recipeId)];
    try {
      return raw ? (JSON.parse(raw) as Array<Concept & { date: string }>) : [];
    } catch {
      return [];
    }
  }

  /**
   * Past concepts become novelty history and past ideas join the bank (status as given, `used` by
   * default: they were made already). Anything already there is skipped, not replaced.
   */
  importHistory(input: unknown, knownRecipes: (id: string) => boolean): { concepts: number; ideas: number; skipped: number } {
    if (typeof input !== "object" || input === null || Array.isArray(input)) throw new HttpError(400, 'Send {"concepts": [...], "ideas": [...]}');
    const file = input as HistoryFile;
    if (file.concepts !== undefined && !Array.isArray(file.concepts)) throw new HttpError(400, "concepts must be a list");
    if (file.ideas !== undefined && !Array.isArray(file.ideas)) throw new HttpError(400, "ideas must be a list");
    const result = { concepts: 0, ideas: 0, skipped: 0 };
    const byRecipe = new Map<string, Array<Concept & { date: string }>>();
    for (const [i, c] of (file.concepts ?? []).entries()) {
      const recipeId = c.recipeId ?? "quick";
      if (!knownRecipes(recipeId)) throw new HttpError(400, `concepts[${i}]: there is no recipe "${recipeId}"`);
      const mechanism = typeof c.mechanism === "string" ? c.mechanism.trim() : "";
      const concept = typeof c.concept === "string" ? c.concept.trim() : "";
      if (!mechanism || !concept) throw new HttpError(400, `concepts[${i}]: give both mechanism and concept`);
      const known = byRecipe.get(recipeId) ?? this.history(recipeId);
      if (known.some((k) => k.mechanism === mechanism && k.concept === concept)) { result.skipped++; byRecipe.set(recipeId, known); continue; }
      byRecipe.set(recipeId, [...known, { mechanism, concept, date: typeof c.date === "string" && !Number.isNaN(Date.parse(c.date)) ? c.date : now() }]);
      result.concepts++;
    }
    const added: GenIdea[] = [];
    for (const [i, idea] of (file.ideas ?? []).entries()) {
      try {
        added.push(this.add({ id: idea.id, slug: idea.slug, brief: idea.brief, flags: idea.flags, status: idea.status ?? "used" }));
        result.ideas++;
      } catch (e) {
        if (e instanceof HttpError && e.status === 409) result.skipped++;
        else throw new HttpError(400, `ideas[${i}]: ${(e as Error).message}`);
      }
    }
    for (const [recipeId, list] of byRecipe) this.store.setSetting(historyKey(recipeId), JSON.stringify(list));
    return result;
  }
}
