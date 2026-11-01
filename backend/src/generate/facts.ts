import { Database } from "bun:sqlite";
import type { GenDataSource } from "../config";
import type { GenFact } from "../types";
import { unmatchedNumbers } from "./numbers";
import { htmlText, type WebResult } from "../webSearch";

// Facts with sources (FR-026, FR-027). A fact is a claim, its value and where it comes from.
// Nothing here invents: a fact is verified only by a passage that is really on its source page,
// a correction must be in that passage too, and research may only add facts it can name a source for.

/** What the facts step reaches out to: pages and search results. */
export interface FactWeb {
  /** The readable text of a page. */
  fetchText(url: string): Promise<string>;
  search(query: string): Promise<WebResult[]>;
}

export const SOURCE_CHARS = 20_000;
/** A page shorter than this is a headline or a stub, not evidence. */
export const MIN_EVIDENCE_PAGE = 300;
export const MIN_QUOTE = 25;
export const ROW_CAP = 50;

/** A page's text from `fetchFn`: tags stripped, cut to what a model can read. */
export async function fetchPageText(url: string, fetchFn: typeof fetch = fetch): Promise<string> {
  if (!/^https?:\/\//i.test(url)) throw new Error(`"${url}" is not a web address`);
  const res = await fetchFn(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; Sorot)" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`the page answered HTTP ${res.status}`);
  const body = await res.text();
  const noScripts = body.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ");
  return htmlText(noScripts).slice(0, SOURCE_CHARS);
}

const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}%.,]+/gu, " ").trim();

/** Is `quote` really on the page (ignoring case, spacing and punctuation)? */
export const isOnPage = (quote: string, page: string): boolean => {
  const q = squash(quote);
  return q.length > 0 && squash(page).includes(q);
};

/** A headline-sized page can't carry evidence unless the recipe says headlines count. */
export const headlineOnly = (page: string): boolean => page.length < MIN_EVIDENCE_PAGE;

// ---- data sources -------------------------------------------------------------------

const FORBIDDEN_SQL = /\b(insert|update|delete|drop|alter|create|replace|attach|detach|pragma|vacuum|reindex)\b/i;

/** Runs a read-only SELECT on a registered source; at most `ROW_CAP` rows come back. */
export function queryData(sources: GenDataSource[], name: string, sql: string): { columns: string[]; rows: unknown[][]; truncated: boolean } {
  const source = sources.find((s) => s.name === name);
  if (!source) throw new Error(`There is no data source "${name}" (${sources.map((s) => s.name).join(", ") || "none registered"})`);
  const text = sql.trim().replace(/;\s*$/, "");
  if (!/^select\b/i.test(text) || text.includes(";") || FORBIDDEN_SQL.test(text)) throw new Error("Only a single SELECT is allowed");
  const db = new Database(source.path, { readonly: true });
  try {
    const rows = db.query(text).all() as Array<Record<string, unknown>>;
    const columns = rows[0] ? Object.keys(rows[0]) : [];
    return { columns, rows: rows.slice(0, ROW_CAP).map((r) => columns.map((c) => r[c])), truncated: rows.length > ROW_CAP };
  } finally {
    db.close();
  }
}

/** A query's answer as the text that counts as evidence. */
export const dataEvidence = (name: string, sql: string, r: { columns: string[]; rows: unknown[][] }): string =>
  `${name}: ${sql.trim()} -> ${r.columns.join(", ")} | ${r.rows.slice(0, 5).map((row) => row.join(", ")).join(" | ")}`.slice(0, 600);

// ---- facts as a file ----------------------------------------------------------------

const STATUS: Record<GenFact["status"], string> = { verified: "verified", corrected: "corrected", unverified: "not checked yet", unverifiable: "could not be verified" };

/** facts.md: for people and outside agents. */
export function factsMarkdown(facts: GenFact[]): string {
  return [
    "# Facts", "",
    ...facts.flatMap((f) => [
      `- **${f.claim}**${f.value ? ` (${f.value})` : ""} — ${STATUS[f.status]}${f.addedBy !== "owner" ? `, added by ${f.addedBy}` : ""}`,
      ...(f.originalValue ? [`  - Was: ${f.originalValue}`] : []), ...(f.sourceUrl ? [`  - Source: ${f.sourceUrl}`] : []), ...(f.evidence ? [`  - Evidence: "${f.evidence}"`] : []),
    ]), "",
  ].join("\n");
}

/** Does the recipe require every number to be sourced (`technical.measures.sourcedNumbers`)? */
export function requiresSourcedNumbers(recipe: { steps: Array<{ use: string; with?: Record<string, unknown> }> }): boolean {
  const m = recipe.steps.find((s) => s.use === "technical")?.with?.measures as Record<string, unknown> | undefined;
  const v = m?.sourcedNumbers;
  return v === true || (typeof v === "object" && v !== null);
}

/** The numbers in `texts` that no verified fact (or the brief) states, as written. */
export function unsourcedIn(texts: string[], brief: string, facts: GenFact[]): string[] {
  return [...new Set(unmatchedNumbers(texts.join(" . "), allowedTexts(brief, facts)).map((n) => n.raw))];
}

/** The numbers a video may show: those in the brief and in verified or corrected facts. */
export const allowedTexts = (brief: string, facts: GenFact[]): string[] => [
  brief, ...facts.filter((f) => f.status === "verified" || f.status === "corrected").map((f) => `${f.claim} ${f.value ?? ""}`),
];
