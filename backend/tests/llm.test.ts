import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { Llm, LlmError, MAX_TOOL_RESULT_CHARS, parseJson, tool, type ChatMessage } from "../src/llm";

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
    await expect(new Llm({ ...CFG, llmModel: "" }).chat([])).rejects.toThrow("No LLM configured");
    await expect(new Llm(CFG, server(new Error("ECONNREFUSED")).fetchFn).chat([])).rejects.toThrow("LLM unreachable at http://llm:1/v1: ECONNREFUSED");
    await expect(new Llm(CFG, server(new Response("bad key", { status: 401 })).fetchFn).chat([])).rejects.toThrow("LLM HTTP 401: bad key");
    await expect(new Llm(CFG, server(new Response("<html>")).fetchFn).chat([])).rejects.toThrow("invalid JSON");
    await expect(new Llm(CFG, server(Response.json({ error: "x" })).fetchFn).chat([])).rejects.toBeInstanceOf(LlmError);
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
    const empty = server({ tool_calls: [{ id: "e", function: { name: "nil", arguments: "" } }] }, { content: "fin" });
    expect(await new Llm(CFG, empty.fetchFn).runTools([], [], { nil: () => undefined })).toBe("fin");
    expect(empty.requests[1]!.body.messages[1].content).toBe("null");
  });
});
