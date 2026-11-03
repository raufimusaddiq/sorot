// OpenAI-compatible chat client and tool-calling loop. Works with any server
// speaking `/chat/completions`: a local Ollama (http://localhost:11434/v1),
// LM Studio, vLLM, Groq, OpenRouter, OpenAI…
//
// Off unless LLM_BASE_URL and LLM_MODEL are set (env, or the UI / CLI
// connection settings, which read this config live); every caller then uses
// its rule-based path, and must also fall back when a call throws LlmError.

import type { AppConfig } from "./config";
import type { Json } from "./types";

export const MAX_TOOL_RESULT_CHARS = 6000;

export class LlmError extends Error {
  /**
   * `transient`: worth one more try at once (network, 429 / 5xx, a gateway error inside an HTTP 200).
   * `budget`: a reasoning model spent its whole budget thinking and answered nothing; asking again
   * later, with a fresh sample, usually finishes (a scene did this once in a real build).
   */
  constructor(message: string, readonly transient = false, readonly budget = false) {
    super(message);
  }
}

/** A transient failure is tried up to this many times: long reasoning calls are often dropped by hosted gateways. */
const LLM_ATTEMPTS = 3;
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504, 529]);

export interface ToolCall {
  id: string;
  type?: "function";
  function: { name: string; arguments: string | Json };
}

/** A piece of a message that has pictures in it (vision models). */
export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  /** Tokens the call used, when the server reports it (replies only; never sent). */
  usage?: number;
}

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Json };
}

/** What can be sent: text as before, or text and images. What comes back is always a ChatMessage with text. */
export type ChatInput = Omit<ChatMessage, "content"> & { content: string | ContentPart[] };

/** A message with a picture: the text, then each image as a data URL or a URL. */
export const withImages = (text: string, ...urls: string[]): ChatInput => ({
  role: "user", content: [{ type: "text", text }, ...urls.map((url): ContentPart => ({ type: "image_url", image_url: { url } }))],
});

export interface ChatOptions {
  /** Overrides the configured model for this call (the vision model). */
  model?: string;
  tools?: ToolDef[];
  /** Name of the one function the model must call (otherwise it chooses). */
  toolChoice?: string;
  temperature?: number;
  maxTokens?: number;
  /** The setting that holds this call's budget, named when a reasoning model runs out of it. */
  budgetName?: string;
}

export type ToolHandler = (args: Json) => unknown | Promise<unknown>;

/** OpenAI `tools` entry: a function taking an object of `properties`. */
export function tool(name: string, description: string, properties: Json, required = Object.keys(properties)): ToolDef {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}

/** The first JSON object/array in a reply; tolerates prose and ```json fences,
 *  which small local models emit even when asked for bare JSON. */
export function parseJson(text: string | null | undefined): unknown {
  if (!text) return null;
  const candidates = [text];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced) candidates.push(fenced[1] as string);
  for (const [open, close] of [["{", "}"], ["[", "]"]] as const) {
    const a = text.indexOf(open);
    const b = text.lastIndexOf(close);
    if (a !== -1 && b > a) candidates.push(text.slice(a, b + 1));
  }
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* next candidate */
    }
  }
  return null;
}

/**
 * Where JSON text first goes wrong, for a repair message a model can act on: Bun's JSON.parse
 * gives no position, and "not valid JSON" alone gave a model nothing to fix (a 12,000-character
 * plan that lost one closing brace). Checks from the first `{` or `[`; null when it is valid.
 */
export function jsonError(text: string): { message: string; at: number; excerpt: string } | null {
  const start = text.search(/[{[]/);
  if (start < 0) return { message: "no JSON object in the answer", at: 0, excerpt: text.slice(0, 80) };
  let i = start;
  const fail = (message: string): never => { throw Object.assign(new Error(message), { at: i }); };
  const space = () => { while (i < text.length && /\s/.test(text[i]!)) i++; };
  const string = () => {
    if (text[i] !== '"') fail("expected a quoted string");
    for (i++; i < text.length; i++) {
      if (text[i] === "\\") i++;
      else if (text[i] === '"') { i++; return; }
      else if (text[i]! < " ") fail("a raw line break or control character inside a string");
    }
    fail("a string that never ends");
  };
  const value = (): void => {
    space();
    const c = text[i];
    if (c === "{") {
      i++; space();
      if (text[i] === "}") { i++; return; }
      for (;;) {
        space(); string(); space();
        if (text[i] !== ":") fail("expected ':' after a property name");
        i++; value(); space();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "}") { i++; return; }
        fail("expected ',' or '}' (an object not closed?)");
      }
    }
    if (c === "[") {
      i++; space();
      if (text[i] === "]") { i++; return; }
      for (;;) {
        value(); space();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "]") { i++; return; }
        fail("expected ',' or ']' (an array not closed?)");
      }
    }
    if (c === '"') return string();
    const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
    if (!m) fail(i >= text.length ? "the answer ends too early (something not closed)" : "expected a value");
    i += m![0].length;
  };
  try {
    value();
    return null;
  } catch (e) {
    const at = (e as { at: number }).at;
    return { message: (e as Error).message, at, excerpt: text.slice(Math.max(0, at - 40), at + 40) };
  }
}

export class Llm {
  constructor(
    private readonly config: Pick<AppConfig, "llmBaseUrl" | "llmModel" | "llmApiKey" | "llmTimeoutSec"> & { llmMaxCallSec?: number }
      & { llmEnabled?: boolean; llmMaxTokens?: number; genLlmMaxTokens?: number; llmStream?: boolean }
      & { genPlanModel?: string; genSceneModel?: string; genJudgeModel?: string; genSession?: boolean; genContextTokens?: number; genTurnTokens?: number },
    private readonly fetchFn: typeof fetch = fetch,
    private readonly retryWaitMs = 2000,
  ) {}

  get enabled(): boolean {
    return this.config.llmEnabled !== false && !!this.config.llmBaseUrl && !!this.config.llmModel;
  }

  get model(): string {
    return this.config.llmModel;
  }

  /** Generate's build session (GEN_SESSION, default on) and how far it may grow (GEN_CONTEXT_TOKENS, Settings → LLM). */
  get genSession(): boolean {
    return this.config.genSession !== false;
  }
  get genContextTokens(): number {
    return this.config.genContextTokens ?? 600000;
  }
  get genTurnTokens(): number {
    return this.config.genTurnTokens ?? 60000;
  }

  /** Generate's model for a role (Settings → LLM): its own when set, else LLM_MODEL. */
  modelFor(role: "plan" | "scene" | "judge"): string {
    const own = { plan: this.config.genPlanModel, scene: this.config.genSceneModel, judge: this.config.genJudgeModel }[role];
    return own?.trim() || this.config.llmModel;
  }



  /** The configured output budget per call; it includes a reasoning model's thinking. */
  get maxTokens(): number {
    return this.config.llmMaxTokens ?? 4000;
  }

  /** Generate's own budget per director call (GEN_LLM_MAX_TOKENS, Settings → LLM): a scene file is long. */
  get genMaxTokens(): number {
    return this.config.genLlmMaxTokens ?? 32000;
  }

  /** One chat completion; a transient failure (hosted gateways drop requests) is tried again, up to 3 attempts. */
  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatMessage> {
    return this.send(messages, opts);
  }

  /** A call with pictures in it. There is no separate vision model: the model answering must see (a Generate director reasons and sees). */
  async see(messages: ChatInput[], opts: ChatOptions = {}): Promise<ChatMessage> {
    return this.send(messages, opts);
  }

  private async send(messages: ChatInput[], opts: ChatOptions): Promise<ChatMessage> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.chatOnce(messages, opts);
      } catch (e) {
        if (!(e instanceof LlmError) || !e.transient || attempt >= LLM_ATTEMPTS) throw e;
        await Bun.sleep(this.retryWaitMs * attempt);
      }
    }
  }

  private async chatOnce(messages: ChatInput[], opts: ChatOptions): Promise<ChatMessage> {
    if (!this.enabled) throw new LlmError("No LLM configured (set LLM_BASE_URL and LLM_MODEL)");
    const base = this.config.llmBaseUrl.replace(/\/+$/, "");
    const body: Json = {
      model: opts.model ?? this.config.llmModel, messages, temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens ?? this.config.llmMaxTokens ?? 4000,
    };
    if (opts.tools?.length) {
      Object.assign(body, { tools: opts.tools, tool_choice: opts.toolChoice ? { type: "function", function: { name: opts.toolChoice } } : "auto" });
    }
    // Streamed by default: a hosted gateway cut every non-streamed request at 180 s ("upstream
    // unavailable"), while the same request streamed finished (measured 2026-11-01). A server that
    // doesn't stream answers with plain JSON, which is read as before.
    const streaming = this.config.llmStream !== false;
    if (streaming) Object.assign(body, { stream: true, stream_options: { include_usage: true } });
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.llmApiKey) headers.Authorization = `Bearer ${this.config.llmApiKey}`;
    // LLM_TIMEOUT is the longest silence: the wait for the first byte, then between streamed chunks that
    // carry part of the answer (a keep-alive ping doesn't count). LLM_MAX_CALL_SEC caps the whole call:
    // a gateway that kept a Generate scene call open with pings held a build for over 30 min (2026-11-02).
    const abort = new AbortController();
    let timer = setTimeout(() => abort.abort(), this.config.llmTimeoutSec * 1000);
    const alive = () => {
      clearTimeout(timer);
      timer = setTimeout(() => abort.abort(), this.config.llmTimeoutSec * 1000);
    };
    let overLong = false;
    const cap = setTimeout(() => { overLong = true; abort.abort(); }, (this.config.llmMaxCallSec ?? 1800) * 1000);
    let res: Response;
    let text = "";
    let data: Json = {};
    try {
      try {
        res = await this.fetchFn(`${base}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal: abort.signal });
        if (streaming && res.ok && (res.headers.get("content-type") ?? "").includes("text/event-stream")) data = await readStream(res, alive, abort.signal);
        else text = await res.text();
      } catch (e) {
        // A timeout already waited LLM_TIMEOUT: not retried, so a stage can't stall twice as long.
        const timedOut = abort.signal.aborted || (e as Error).name === "TimeoutError";
        if (overLong) throw new LlmError(`LLM call ran past LLM_MAX_CALL_SEC (${this.config.llmMaxCallSec ?? 1800} s) without finishing`, false);
        throw new LlmError(`LLM unreachable at ${base}: ${timedOut ? `no answer for ${this.config.llmTimeoutSec} s` : (e as Error).message}`, !timedOut);
      }
    } finally {
      clearTimeout(timer);
      clearTimeout(cap);
    }
    if (!res.ok) throw new LlmError(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`, TRANSIENT_STATUSES.has(res.status));
    if (!data.choices && !data.error) {
      try {
        data = JSON.parse(text) as Json;
      } catch {
        throw new LlmError(`LLM answered with invalid JSON: ${text.slice(0, 120)}`);
      }
    }
    const choice = (data.choices as Array<{ message?: ChatMessage; finish_reason?: string }> | undefined)?.[0];
    const msg = choice?.message;
    // Some gateways report a failure as {"error": …} with HTTP 200.
    const err = data.error as { message?: string; code?: string } | undefined;
    if (!msg && err) throw new LlmError(`LLM error: ${err.message ?? err.code ?? JSON.stringify(err).slice(0, 200)}`, true);
    if (!msg) throw new LlmError(`Unexpected LLM response: ${(text || JSON.stringify(data)).slice(0, 300)}`);
    // A reasoning model can spend the whole budget thinking and answer nothing.
    if (!msg.content && !msg.tool_calls?.length && choice?.finish_reason === "length") {
      throw new LlmError(`LLM used all ${String(body.max_tokens)} max_tokens before answering (raise ${opts.budgetName ?? "LLM_MAX_TOKENS"} for reasoning models)`, false, true);
    }
    const used = (data.usage as { total_tokens?: unknown } | undefined)?.total_tokens;
    return { ...msg, content: msg.content ?? "", ...(typeof used === "number" ? { usage: used } : {}) };
  }

  /**
   * Chat with tools until the model answers without calling one. Tool errors
   * go back to the model (it can recover). After `maxSteps` rounds the model
   * gets `finalPrompt` and one last turn without tools (so its research isn't
   * lost); without `finalPrompt` that throws LlmError, as does an unreachable
   * LLM. Returns the final assistant text.
   */
  async runTools(
    messages: ChatMessage[], tools: ToolDef[], handlers: Record<string, ToolHandler>,
    opts: {
      maxSteps?: number; temperature?: number; finalPrompt?: string; onCall?: (name: string, args: Json, result: unknown) => void;
      /** Per call, and the setting it comes from. */
      maxTokens?: number; budgetName?: string; model?: string;
      /** Tokens the whole loop may use (as the server reports them); past it the loop ends like at maxSteps. */
      tokenBudget?: number;
    } = {},
  ): Promise<string> {
    const history = [...messages];
    const maxSteps = opts.maxSteps ?? 8;
    const per = { temperature: opts.temperature, maxTokens: opts.maxTokens, budgetName: opts.budgetName, model: opts.model };
    let used = 0;
    for (let step = 0; step < maxSteps && !(opts.tokenBudget && used >= opts.tokenBudget); step++) {
      const msg = await this.chat(history, { tools, ...per });
      used += msg.usage ?? 0;
      const calls = msg.tool_calls ?? [];
      history.push({ role: "assistant", content: msg.content, ...(calls.length ? { tool_calls: calls } : {}) });
      if (calls.length === 0) return msg.content;
      for (const call of calls) {
        const name = call.function?.name ?? "";
        let args: Json = {};
        let result: unknown;
        try {
          const raw = call.function?.arguments ?? "{}";
          args = typeof raw === "string" ? (JSON.parse(raw || "{}") as Json) : raw;
          const handler = handlers[name];
          if (!handler) throw new Error(`unknown tool ${name}`);
          result = await handler(args);
        } catch (e) {
          result = { error: (e as Error).message };
        }
        opts.onCall?.(name, args, result);
        history.push({
          role: "tool", tool_call_id: call.id || name, name,
          content: JSON.stringify(result ?? null).slice(0, MAX_TOOL_RESULT_CHARS),
        });
      }
    }
    if (!opts.finalPrompt) throw new LlmError(`LLM still calling tools after ${maxSteps} steps`);
    history.push({ role: "user", content: opts.finalPrompt });
    return (await this.chat(history, per)).content;
  }
}

/**
 * A streamed answer (server-sent events) put back together in the shape of a plain one: the text,
 * the tool calls (their arguments arrive in pieces, by index), why it stopped, the tokens used, or the
 * gateway's error. `alive` is called on every chunk, so only a silence times out.
 */
async function readStream(res: Response, alive: () => void, signal: AbortSignal): Promise<Json> {
  // only a chunk that carries part of the answer (or its end) keeps the call alive, not a keep-alive ping
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  // a silence ends the read here too, whatever the fetch implementation does with the signal
  signal.addEventListener("abort", () => void reader.cancel().catch(() => undefined), { once: true });
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let finish: string | undefined;
  let usage: Json | undefined;
  let error: Json | undefined;
  const calls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];
  const take = (line: string) => {
    const data = line.startsWith("data:") ? line.slice(5).trim() : "";
    if (!data || data === "[DONE]") return;
    let chunk: Json;
    try {
      chunk = JSON.parse(data) as Json;
    } catch {
      return;   // a keep-alive or a broken line: the rest of the stream still counts
    }
    if (chunk.error || chunk.usage || chunk.choices) alive();
    if (chunk.error) error = chunk.error as Json;
    if (chunk.usage) usage = chunk.usage as Json;
    const choice = (chunk.choices as Array<{ delta?: Json; finish_reason?: string | null }> | undefined)?.[0];
    if (!choice) return;
    if (choice.finish_reason) finish = choice.finish_reason;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string") content += delta.content;
    for (const part of (delta.tool_calls as Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> | undefined) ?? []) {
      const call = (calls[part.index ?? 0] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
      if (part.id) call.id = part.id;
      if (part.function?.name) call.function.name += part.function.name;
      if (part.function?.arguments) call.function.arguments += part.function.arguments;
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      take(buffer.slice(0, end).trim());
      buffer = buffer.slice(end + 1);
    }
  }
  if (signal.aborted) throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
  take(buffer.trim());
  const listed = calls.filter(Boolean);
  if (error && !content && !listed.length) return { error };
  const message: Json = { role: "assistant", content, ...(listed.length ? { tool_calls: listed } : {}) };
  return { choices: [{ message, finish_reason: finish }], ...(usage ? { usage } : {}) };
}