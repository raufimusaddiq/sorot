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

export class LlmError extends Error {}

export interface ToolCall {
  id: string;
  type?: "function";
  function: { name: string; arguments: string | Json };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Json };
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

export class Llm {
  constructor(
    private readonly config: Pick<AppConfig, "llmBaseUrl" | "llmModel" | "llmApiKey" | "llmTimeoutSec">
      & { llmEnabled?: boolean; llmMaxTokens?: number },
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  get enabled(): boolean {
    return this.config.llmEnabled !== false && !!this.config.llmBaseUrl && !!this.config.llmModel;
  }

  get model(): string {
    return this.config.llmModel;
  }

  async chat(messages: ChatMessage[], opts: { tools?: ToolDef[]; temperature?: number; maxTokens?: number } = {}): Promise<ChatMessage> {
    if (!this.enabled) throw new LlmError("No LLM configured (set LLM_BASE_URL and LLM_MODEL)");
    const base = this.config.llmBaseUrl.replace(/\/+$/, "");
    const body: Json = {
      model: this.config.llmModel, messages, temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens ?? this.config.llmMaxTokens ?? 4000,
    };
    if (opts.tools?.length) Object.assign(body, { tools: opts.tools, tool_choice: "auto" });
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.llmApiKey) headers.Authorization = `Bearer ${this.config.llmApiKey}`;
    let res: Response;
    try {
      res = await this.fetchFn(`${base}/chat/completions`, {
        method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(this.config.llmTimeoutSec * 1000),
      });
    } catch (e) {
      throw new LlmError(`LLM unreachable at ${base}: ${(e as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) throw new LlmError(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
    let data: Json;
    try {
      data = JSON.parse(text) as Json;
    } catch {
      throw new LlmError(`LLM answered with invalid JSON: ${text.slice(0, 120)}`);
    }
    const choice = (data.choices as Array<{ message?: ChatMessage; finish_reason?: string }> | undefined)?.[0];
    const msg = choice?.message;
    // Some gateways report a failure as {"error": …} with HTTP 200.
    const err = data.error as { message?: string; code?: string } | undefined;
    if (!msg && err) throw new LlmError(`LLM error: ${err.message ?? err.code ?? JSON.stringify(err).slice(0, 200)}`);
    if (!msg) throw new LlmError(`Unexpected LLM response: ${text.slice(0, 300)}`);
    // A reasoning model can spend the whole budget thinking and answer nothing.
    if (!msg.content && !msg.tool_calls?.length && choice?.finish_reason === "length") {
      throw new LlmError(`LLM used all ${String(body.max_tokens)} max_tokens before answering (raise LLM_MAX_TOKENS for reasoning models)`);
    }
    return { ...msg, content: msg.content ?? "" };
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
    opts: { maxSteps?: number; temperature?: number; finalPrompt?: string; onCall?: (name: string, args: Json, result: unknown) => void } = {},
  ): Promise<string> {
    const history = [...messages];
    const maxSteps = opts.maxSteps ?? 8;
    for (let step = 0; step < maxSteps; step++) {
      const msg = await this.chat(history, { tools, temperature: opts.temperature });
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
    return (await this.chat(history, { temperature: opts.temperature })).content;
  }
}
