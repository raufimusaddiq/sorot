import type { Store } from "../store";
import type { GenProject } from "../types";

// A concept is the one visual idea a video is built on. Videos from the same recipe should not
// repeat each other: the last N concepts are kept, a new one is compared with them by its words,
// and (when there are any) by the director's own "same idea?" check.

export interface Concept { mechanism: string; concept: string }

/** Lower case, letters and digits only. */
export const normalise = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

const wordsOf = (text: string) => new Set(normalise(text).split(" ").filter((w) => w.length > 2));

/** Share of words two texts have in common (0 to 1). */
export function overlap(a: string, b: string): number {
  const x = wordsOf(a);
  const y = wordsOf(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

export const SAME_WORDS = 0.7;

/** The earlier text this one repeats by its words, or null. */
export function repeatOf(candidate: string, earlier: string[]): string | null {
  return earlier.find((e) => normalise(e) === normalise(candidate) || overlap(candidate, e) >= SAME_WORDS) ?? null;
}

export const conceptText = (c: Concept) => `${c.mechanism}\n${c.concept}`;

/** The concepts of this recipe's other videos, newest first, at most `lastN`. */
export function earlierConcepts(store: Store, project: GenProject, lastN: number): string[] {
  return store.listGenProjects()
    .filter((p) => p.id !== project.id && p.recipeId === project.recipeId && p.concept)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, lastN)
    .map((p) => conceptText(JSON.parse(p.concept as string) as Concept));
}
