import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { jsonError, Llm, LlmError, MAX_TOOL_RESULT_CHARS, parseJson, tool, type ChatMessage } from "../src/llm";

const CFG = { llmBaseUrl: "http://llm:1/v1/", llmModel: "m", llmApiKey: "", llmTimeoutSec: 5 };

/** Fake OpenAI-compatible server: replies from a queue, records requests. */
function server(...replies: Array<Partial<ChatMessage> | Response | Error>) {
  const requests: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    requests.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    const r = replies.shift();
    if (r instanceof Error) throw r;
    if (r instanceof Response) return r;
    return Response.json({ choices: [{ message: r }] });
  }) as unknown as typeof fetch;
  return { fetchFn, requests };
}

const call = (name: string, args: unknown, id = "c1") => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });

describe("config", () => {
  test("off unless base URL and model are set", () => {
    expect(new Llm(loadConfig({})).enabled).toBeFalse();
    expect(new Llm(loadConfig({ LLM_BASE_URL: "http://x" })).enabled).toBeFalse();
    const c = loadConfig({ LLM_BASE_URL: " http://x/v1 ", LLM_MODEL: " qwen ", LLM_API_KEY: "k", LLM_TIMEOUT: "30", WEB_SEARCH: "off" });
    expect(c).toMatchObject({ llmBaseUrl: "http://x/v1", llmModel: "qwen", llmApiKey: "k", llmTimeoutSec: 30, webSearch: "off" });
    expect(new Llm(c).enabled).toBeTrue();
    expect(new Llm(c).model).toBe("qwen");
    expect(loadConfig({}).webSearch).toBe("bing");
    expect(loadConfig({}).llmTimeoutSec).toBe(120);
    expect([loadConfig({}).genLlmMaxTokens, new Llm(CFG).genMaxTokens, loadConfig({ GEN_LLM_MAX_TOKENS: "64000" }).genLlmMaxTokens]).toEqual([32000, 32000, 64000]);
  });
});

describe("chat", () => {
  test("request shape, auth header and null content", async () => {
    const s = server({ content: null as unknown as string });
    const llm = new Llm({ ...CFG, llmApiKey: "sk" }, s.fetchFn);
    const msg = await llm.chat([{ role: "user", content: "yo" }], { tools: [tool("t", "d", { q: { type: "string" } })], temperature: 0.9 });
    expect(msg.content).toBe("");
    const r = s.requests[0]!;
    expect(r.url).toBe("http://llm:1/v1/chat/completions");
    expect(r.headers.Authorization).toBe("Bearer sk");
    expect(r.body).toMatchObject({ model: "m", temperature: 0.9, max_tokens: 4000, tool_choice: "auto" });
    expect(r.body.tools[0].function.parameters).toEqual({ type: "object", properties: { q: { type: "string" } }, required: ["q"] });
    const plain = server({ content: "x" });
    await new Llm(CFG, plain.fetchFn).chat([]);
    expect(plain.requests[0]!.body.tools).toBeUndefined();
    expect(plain.requests[0]!.headers.Authorization).toBeUndefined();
  });

  test("failures throw LlmError", async () => {
    const llm = (...replies: Parameters<typeof server>) => new Llm(CFG, server(...replies).fetchFn, 0);
    await expect(new Llm({ ...CFG, llmModel: "" }).chat([])).rejects.toThrow("No LLM configured");
    await expect(llm(...Array.from({ length: 3 }, () => new Error("ECONNREFUSED"))).chat([])).rejects.toThrow("LLM unreachable at http://llm:1/v1: ECONNREFUSED");
    await expect(llm(new Response("bad key", { status: 401 })).chat([])).rejects.toThrow("LLM HTTP 401: bad key");
    await expect(llm(new Response("<html>")).chat([])).rejects.toThrow("invalid JSON");
    await expect(llm(Response.json({ error: "x" }), Response.json({ error: "x" })).chat([])).rejects.toBeInstanceOf(LlmError);
    // A gateway's failure inside an HTTP 200, and a reasoning model that spent the whole budget thinking.
    const gateway = () => Response.json({ error: { code: "all_providers_failed", message: "upstream unavailable" } });
    await expect(llm(gateway(), gateway(), gateway()).chat([])).rejects.toThrow("LLM error: upstream unavailable");
    await expect(llm(...Array.from({ length: 3 }, () => Response.json({ error: { type: "x" } }))).chat([])).rejects.toThrow('LLM error: {"type":"x"}');
    const thinking = server(Response.json({ choices: [{ finish_reason: "length", message: { role: "assistant", content: null, reasoning_content: "hmm" } }] }));
    await expect(new Llm({ ...CFG, llmMaxTokens: 300 }, thinking.fetchFn).chat([])).rejects.toThrow("used all 300 max_tokens before answering (raise LLM_MAX_TOKENS");
    const generating = server(Response.json({ choices: [{ finish_reason: "length", message: { role: "assistant", content: null } }] }));
    await expect(new Llm(CFG, generating.fetchFn).chat([], { budgetName: "GEN_LLM_MAX_TOKENS" })).rejects.toThrow("(raise GEN_LLM_MAX_TOKENS");
    const cut = server(Response.json({ choices: [{ finish_reason: "length", message: { role: "assistant", content: "partial" } }] }));
    expect((await new Llm(CFG, cut.fetchFn).chat([])).content).toBe("partial");   // some text: let the caller judge it
  });

  test("a transient failure is tried again, up to 3 attempts; others are not", async () => {
    for (const first of [new Error("ECONNRESET"), new Response("busy", { status: 503 }), new Response("slow", { status: 429 }),
      Response.json({ error: { code: "all_providers_failed", message: "upstream unavailable" } })]) {
      const s = server(first, { content: "OK" });
      expect((await new Llm(CFG, s.fetchFn, 0).chat([])).content).toBe("OK");
      expect(s.requests).toHaveLength(2);
    }
    const flaky = server(new Response("busy", { status: 503 }), new Response("busy", { status: 503 }), { content: "OK" });
    expect((await new Llm(CFG, flaky.fetchFn, 0).chat([])).content).toBe("OK");
    expect(flaky.requests).toHaveLength(3);
    for (const first of [new Response("bad key", { status: 401 }), new Response("bad", { status: 400 })]) {
      const s = server(first, { content: "OK" });
      await expect(new Llm(CFG, s.fetchFn, 0).chat([])).rejects.toBeInstanceOf(LlmError);
      expect(s.requests).toHaveLength(1);
    }
    const timeout = Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
    const slow = server(timeout, { content: "OK" });
    await expect(new Llm(CFG, slow.fetchFn, 0).chat([])).rejects.toThrow("no answer for 5 s");   // already waited LLM_TIMEOUT
    expect(slow.requests).toHaveLength(1);
  });

  test.each([
    // the real failure: one shot's inner object never closed, so the next shot lands inside it
    ["an object left open", '{"shots": [{"id": "s01", "visual": {"a": 1}, {"id": "s02"}]}', "expected a quoted string", 45],
    ["a string that never ends", '{"a": "b', "a string that never ends", 8],
    ["cut off", '{"a": [1, 2', "expected ',' or ']' (an array not closed?)", 11],
    ["a raw line break in a string", '{"a": "b\nc"}', "a raw line break or control character inside a string", 8],
    ["no JSON at all", "sorry", "no JSON object in the answer", 0],
  ])("jsonError says what is wrong and where: %s", (_name, text, message, at) => {
    expect(jsonError(text)).toMatchObject({ message, at, excerpt: text.slice(Math.max(0, at - 40), at + 40) });
  });

  test("jsonError is null for valid JSON, after any prose", () => {
    expect(jsonError('here: {"a": [1, -2.5e3, true, null, "x\\"y"], "b": {}}')).toBeNull();
  });

  /** A server that streams: each part becomes one `data:` line of an event stream. */
  const sse = (...parts: unknown[]) => new Response(parts.map((p) => `data: ${typeof p === "string" ? p : JSON.stringify(p)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
  const delta = (d: unknown, finish: string | null = null) => ({ choices: [{ delta: d, finish_reason: finish }] });

  test("answers are asked streamed and put back together: text, tool calls in pieces, why it stopped, tokens used", async () => {
    const s = server(sse(
      delta({ role: "assistant", content: "" }), ": keep-alive", delta({ reasoning_content: "thinking" }),
      delta({ tool_calls: [{ index: 0, id: "c1", function: { name: "submit_plan", arguments: '{"ti' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: 'tle": "x"}' } }] }), "not json",
      delta({}, "tool_calls"), { choices: [], usage: { total_tokens: 1234 } }, "[DONE]",
    ));
    const msg = await new Llm(CFG, s.fetchFn, 0).chat([]);
    expect(s.requests[0]!.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(msg).toEqual({ role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "submit_plan", arguments: '{"title": "x"}' } }], usage: 1234 });
    const text = server(sse(delta({ content: "Hal" }), delta({ content: "o" }, "stop")));
    expect((await new Llm(CFG, text.fetchFn, 0).chat([])).content).toBe("Halo");
    // a gateway error inside the stream is transient, so it is tried again; a stream cut by the budget says so
    const down = server(sse({ error: { code: "all_providers_failed", message: "upstream unavailable" } }), sse(delta({ content: "OK" }, "stop")));
    expect((await new Llm(CFG, down.fetchFn, 0).chat([])).content).toBe("OK");
    const thinking = server(sse(delta({ reasoning_content: "hmm" }, "length")));
    await expect(new Llm({ ...CFG, llmMaxTokens: 300 }, thinking.fetchFn, 0).chat([])).rejects.toThrow("used all 300 max_tokens");
    // LLM_STREAM=0: plain requests
    const plain = server({ content: "x" });
    await new Llm({ ...CFG, llmStream: false }, plain.fetchFn).chat([]);
    expect(plain.requests[0]!.body.stream).toBeUndefined();
    expect([loadConfig({}).llmStream, loadConfig({ LLM_STREAM: "0" }).llmStream]).toEqual([true, false]);
  });

  test("only a silence times out: a stream that keeps sending is never cut, one that goes quiet is, keep-alives don't count, and a call has a total cap", async () => {
    const drip = (gapMs: number, chunks: number, ping = false) => (async (_u: unknown, init?: RequestInit) => new Response(new ReadableStream({
      async start(c) {
        for (let i = 0; i < chunks; i++) {
          if (init?.signal?.aborted) return c.error(new DOMException("aborted", "AbortError"));
          await Bun.sleep(gapMs);
          c.enqueue(new TextEncoder().encode(ping && i < chunks - 1 ? ": keep-alive\n\n" : `data: ${JSON.stringify(delta({ content: "a" }, i === chunks - 1 ? "stop" : null))}\n\n`));
        }
        c.close();
      },
    }), { headers: { "Content-Type": "text/event-stream" } })) as unknown as typeof fetch;
    const quick = { ...CFG, llmTimeoutSec: 0.2 };
    expect((await new Llm(quick, drip(60, 6), 0).chat([])).content).toBe("aaaaaa");   // 0.36 s in all, never 0.2 s quiet
    await expect(new Llm(quick, drip(400, 2), 0).chat([])).rejects.toThrow("no answer for 0.2 s");
    // a gateway pinging ": keep-alive" for half an hour held a build in check (2026-11-02)
    await expect(new Llm(quick, drip(60, 8, true), 0).chat([])).rejects.toThrow("no answer for 0.2 s");
    await expect(new Llm({ ...quick, llmMaxCallSec: 0.3 }, drip(60, 12), 0).chat([])).rejects.toThrow("ran past LLM_MAX_CALL_SEC (0.3 s)");
    expect([loadConfig({}).llmMaxCallSec, loadConfig({ LLM_MAX_CALL_SEC: "5" }).llmMaxCallSec]).toEqual([1800, 60]);
  });
  test("parseJson tolerates prose and fences", () => {
    expect(parseJson('{"a": 1}')).toEqual({ a: 1 });
    expect(parseJson('Sure!\n```json\n{"a": 2}\n```')).toEqual({ a: 2 });
    expect(parseJson('Here: {"a": 3} hope it helps')).toEqual({ a: 3 });
    expect(parseJson("list [1, 2]")).toEqual([1, 2]);
    expect(parseJson("no json {")).toBeNull();
    expect(parseJson("")).toBeNull();
    expect(parseJson(null)).toBeNull();
  });
});

describe("tool loop", () => {
  test("runs tools until the model answers; errors go back to the model", async () => {
    const s = server(
      { content: "", tool_calls: [call("add", { a: 1, b: 2 }), call("boom", {}, "c2"), call("nope", {}, "c3")] },
      { content: "done: 3" },
    );
    const seen: unknown[] = [];
    const out = await new Llm(CFG, s.fetchFn).runTools([{ role: "user", content: "go" }], [], {
      add: async (a) => ({ sum: (a.a as number) + (a.b as number) }),
      boom: () => { throw new Error("tool broke"); },
    }, { onCall: (n, a, r) => seen.push([n, a, r]) });
    expect(out).toBe("done: 3");
    const toolMsgs = s.requests[1]!.body.messages.filter((m: ChatMessage) => m.role === "tool");
    expect(toolMsgs.map((m: ChatMessage) => JSON.parse(m.content))).toEqual([{ sum: 3 }, { error: "tool broke" }, { error: "unknown tool nope" }]);
    expect(toolMsgs[0].tool_call_id).toBe("c1");
    expect(s.requests[1]!.body.messages[1].tool_calls).toHaveLength(3);
    expect(seen[0]).toEqual(["add", { a: 1, b: 2 }, { sum: 3 }]);
  });

  test("bad arguments, object arguments, long results, step limit", async () => {
    const bad = { id: "x", function: { name: "add", arguments: "{not json" } };
    await expect(new Llm(CFG, server({ tool_calls: [bad] }, { tool_calls: [bad] }).fetchFn)
      .runTools([], [], { add: () => 1 }, { maxSteps: 2 })).rejects.toThrow("after 2 steps");
    const obj = { id: "", function: { name: "echo", arguments: { a: 5 } } };
    const s = server({ tool_calls: [obj, call("big", {})] }, { content: "ok" });
    await new Llm(CFG, s.fetchFn).runTools([], [], { echo: (a) => a.a, big: () => "x".repeat(10_000) });
    const msgs = s.requests[1]!.body.messages;
    expect(msgs[1]).toMatchObject({ role: "tool", tool_call_id: "echo", content: "5" });
    expect(msgs[2].content).toHaveLength(MAX_TOOL_RESULT_CHARS);
    // with a final prompt, the step limit ends in one tool-less answer instead of an error
    const wrap = server({ tool_calls: [call("add", {})] }, { content: '{"picks":[]}' });
    expect(await new Llm(CFG, wrap.fetchFn).runTools([], [], { add: () => 1 }, { maxSteps: 1, finalPrompt: "answer now" })).toBe('{"picks":[]}');
    expect(wrap.requests[1]!.body.tools).toBeUndefined();
    expect(wrap.requests[1]!.body.messages.at(-1)).toEqual({ role: "user", content: "answer now" });
    const empty = server({ tool_calls: [{ id: "e", function: { name: "nil", arguments: "" } }] }, { content: "fin" });
    expect(await new Llm(CFG, empty.fetchFn).runTools([], [], { nil: () => undefined })).toBe("fin");
    expect(empty.requests[1]!.body.messages[1].content).toBe("null");
    // a token budget ends the loop like the step limit; each call carries the per-call budget
    const used = () => Response.json({ choices: [{ message: { role: "assistant", content: "", tool_calls: [call("add", {})] } }], usage: { total_tokens: 500 } });
    const spent = server(used(), { content: "done" });
    expect(await new Llm(CFG, spent.fetchFn).runTools([], [], { add: () => 1 }, { tokenBudget: 400, maxTokens: 9000, finalPrompt: "answer now" })).toBe("done");
    expect(spent.requests.map((r) => [r.body.max_tokens, r.body.messages.length])).toEqual([[9000, 0], [9000, 3]]);   // the second call is the final prompt
  });
});
