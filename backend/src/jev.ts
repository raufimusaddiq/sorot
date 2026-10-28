// Jev (TypeSafe's "System One" decision model) client. Jev does not write
// text: it answers typed questions about a `state` — a yes/no probability
// (noul), one option of a fixed set (choice) or a level on an ordered scale
// (score). That makes it a cheap, bounded judge for what the LLM produced.
//
// POST https://api.typesafe.ai/v1/systemone with Bearer auth; OpenRouter's
// /api/alpha/decisions takes the same body (set JEV_URL and its model id).
// Off unless JEV_API_KEY is set (env, or the UI / CLI connection settings);
// callers fall back to their rules when it is off or a call throws JevError.
// Docs: https://docs.typesafe.ai/api/system-one.md

import type { AppConfig } from "./config";
import type { Json } from "./types";

export class JevError extends Error {}

/** Probability that the answer is yes (0-1). Criteria are optional. */
export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
}

/** One option name from `criteria` (name → when it applies). */
export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

/** Ordered levels, lowest first (2-10); the answer is the probability-weighted level index. */
export interface ScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export type Answer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number | null; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number | null; probabilities: Record<string, number> };

export interface Decision {
  /** The versioned model that answered (an alias resolves to it). */
  model: string;
  answers: Record<string, Answer>;
  inputTokens: number;
}

const RETRY_STATUSES = new Set([429, 529]);   // rate limit, overloaded: TypeSafe asks for a retry with backoff
const MAX_RETRY_WAIT_MS = 10_000;

const finite01 = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= -1e-6 && v <= 1 + 1e-6;

function probabilities(v: unknown): Record<string, number> {
  if (!v || typeof v !== "object") return {};
  return Object.fromEntries(Object.entries(v as Json).filter(([, p]) => finite01(p))) as Record<string, number>;
}

/** Check one answer against its question; anything off is an error, never a default. */
export function readAnswer(id: string, q: Question, raw: unknown): Answer {
  const a = (raw ?? {}) as Json;
  if (a.type !== q.type) throw new JevError(`answer ${id}: expected ${q.type}, got ${String(a.type)}`);
  const confidence = finite01(a.confidence) ? a.confidence : null;
  if (q.type === "noul") {
    if (!finite01(a.noul)) throw new JevError(`answer ${id}: noul is not a probability`);
    return { type: "noul", noul: Math.min(Math.max(a.noul, 0), 1) };
  }
  if (q.type === "choice") {
    if (typeof a.choice !== "string" || !(a.choice in q.criteria)) throw new JevError(`answer ${id}: unknown choice ${String(a.choice)}`);
    return { type: "choice", choice: a.choice, confidence, probabilities: probabilities(a.probabilities) };
  }
  const top = q.criteria.length - 1;
  if (typeof a.score !== "number" || !Number.isFinite(a.score) || a.score < -1e-6 || a.score > top + 1e-6) {
    throw new JevError(`answer ${id}: score outside 0-${top}`);
  }
  return { type: "score", score: Math.min(Math.max(a.score, 0), top), confidence, probabilities: probabilities(a.probabilities) };
}

export class Jev {
  constructor(
    private readonly config: Pick<AppConfig, "jevUrl" | "jevModel" | "jevApiKey" | "jevTimeoutSec"> & { jevEnabled?: boolean },
    private readonly fetchFn: typeof fetch = fetch,
    private readonly retryWaitMs = 1000,
  ) {}

  get enabled(): boolean {
    return this.config.jevEnabled !== false && !!this.config.jevApiKey && !!this.config.jevModel && !!this.config.jevUrl;
  }

  get model(): string {
    return this.config.jevModel;
  }

  /** Ask every question about one state in a single request (Jev evaluates them in parallel). */
  async decide(state: string | Json | unknown[], questions: Record<string, Question>): Promise<Decision> {
    if (!this.enabled) throw new JevError("No Jev configured (set JEV_API_KEY)");
    const body = JSON.stringify({ model: this.config.jevModel, state, questions });
    let res = await this.post(body);
    if (RETRY_STATUSES.has(res.status)) {
      const after = Number(res.headers.get("retry-after"));
      await Bun.sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, MAX_RETRY_WAIT_MS) : this.retryWaitMs);
      res = await this.post(body);
    }
    const text = await res.text();
    if (!res.ok) throw new JevError(`Jev HTTP ${res.status}: ${text.slice(0, 300)}`);
    let data: Json;
    try {
      data = JSON.parse(text) as Json;
    } catch {
      throw new JevError(`Jev answered with invalid JSON: ${text.slice(0, 120)}`);
    }
    const answers = (data.answers ?? {}) as Json;
    const out: Record<string, Answer> = {};
    for (const [id, q] of Object.entries(questions)) {
      if (!(id in answers)) throw new JevError(`Jev left question ${id} unanswered`);
      out[id] = readAnswer(id, q, answers[id]);
    }
    const usage = (data.usage ?? {}) as Json;
    return {
      model: typeof data.model === "string" ? data.model : this.config.jevModel,
      answers: out,
      inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
    };
  }

  private async post(body: string): Promise<Response> {
    try {
      return await this.fetchFn(this.config.jevUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.config.jevApiKey}` },
        body,
        signal: AbortSignal.timeout(this.config.jevTimeoutSec * 1000),
      });
    } catch (e) {
      throw new JevError(`Jev unreachable at ${this.config.jevUrl}: ${(e as Error).message}`);
    }
  }
}

/** Noul probability of an answer (0 for other types; callers only read nouls they asked). */
export const noul = (a: Answer | undefined): number => (a?.type === "noul" ? a.noul : 0);
