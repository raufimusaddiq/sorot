import type { Store } from "../store";
import { now } from "../store";
import type { GenEvent } from "../types";

// The local director log: one gen_event row per LLM / Jev / tool / command call. It replaces
// hosted tracing (research R4), so nothing leaves the machine and no secret may enter it.

export interface EventContext {
  projectId: string;
  versionId?: string | null;
  kind: string;
  model?: string | null;
  /** The prompt or command line. */
  request?: unknown;
}

export interface EventOutcome {
  response?: unknown;
  tokens?: number;
}

const REDACTIONS: Array<[RegExp, string]> = [
  [/([?&](?:api[_-]?key|token|key)=)[^&\s"]+/gi, "$1***"],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, "Bearer ***"],
  [/\b(sk|pk|xi|fk|key)[-_][A-Za-z0-9_-]{12,}/g, "$1-***"],
  [/("?(?:api[_-]?key|token|secret|password|authorization|x-api-key|xi-api-key)"?\s*[:=]\s*)"?(?!Bearer\b|\*\*\*)[^\s",}&]{4,}"?/gi, "$1\"***\""],
];

/** Removes keys, tokens and bearer headers from text before it is stored. */
export function redact(text: string): string {
  return REDACTIONS.reduce((t, [re, to]) => t.replace(re, to), text);
}

const asText = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  return redact(typeof v === "string" ? v : JSON.stringify(v));
};

export class DirectorLog {
  constructor(private readonly store: Store) {}

  /** Runs `fn`, saves one event with its outcome and timing, and returns (or rethrows) its result. */
  async track<T>(ctx: EventContext, fn: () => Promise<T>, outcome: (value: T) => EventOutcome = (v) => ({ response: v })): Promise<T> {
    const started = performance.now();
    const base = (): Omit<GenEvent, "ok" | "response" | "tokens"> => ({
      id: crypto.randomUUID(), projectId: ctx.projectId, versionId: ctx.versionId ?? null, kind: ctx.kind,
      model: ctx.model ?? null, request: asText(ctx.request), ms: Math.round(performance.now() - started), createdAt: now(),
    });
    try {
      const value = await fn();
      const o = outcome(value);
      this.store.saveGenEvent({ ...base(), ok: 1, response: asText(o.response), tokens: o.tokens ?? null });
      return value;
    } catch (e) {
      this.store.saveGenEvent({ ...base(), ok: 0, response: asText((e as Error).message), tokens: null });
      throw e;
    }
  }

  /** The log of one project, newest first. */
  list(projectId: string, limit?: number) { return this.store.genEventsForProject(projectId, limit); }
}
