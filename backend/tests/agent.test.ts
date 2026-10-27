// Auto-discover: the LLM agent's tool loop (scripted LLM), the algorithm
// fallback, the run API, and the key-free web search.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { agentPrompt, summarize } from "../src/discoveryAgent";
import { LlmError, type ChatMessage, type ToolDef } from "../src/llm";
import { htmlText, parseBing, unwrapBingUrl, WebSearch } from "../src/webSearch";
import { defaultExec, makeEnv, procOk, ytDate, ytLines, type TestEnv } from "./helpers";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => {
  await env.app.agent.whenIdle();
  await env.app.discovery.whenIdle();
  env.cleanup();
});

const BING = `<html><li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&amp;p=x&amp;u=a1${Buffer.from("https://news.id/viral").toString("base64url")}&amp;ntb=1">Topik <strong>viral</strong> &amp; heboh</a></h2>
<div class="b_caption"><p class="b_lineclamp2">Sidang kasus &#8220;X&#8221; hari&nbsp;ini</p></div></li>
<li class="b_algo"><div>no title link</div></li>
<li class="b_algo"><h2><a href="https://plain.example/a">Plain</a></h2></li></html>`;

const call = (id: string, name: string, args: object) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });

/** An LLM that answers with the given messages in order, recording what it was sent. */
function scriptLlm(replies: Array<Partial<ChatMessage> | Error>) {
  const seen: Array<{ messages: ChatMessage[]; tools?: ToolDef[]; temperature?: number }> = [];
  env.config.llmBaseUrl = "http://llm/v1";
  env.config.llmModel = "qwen";
  env.app.llm.chat = async (messages, opts = {}) => {
    seen.push({ messages: [...messages], tools: opts.tools, temperature: opts.temperature });
    const r = replies.shift() ?? { content: "{}" };
    if (r instanceof Error) throw r;
    return { role: "assistant", content: "", ...r };
  };
  return seen;
}

async function runAuto(body: object = {}) {
  const r = await env.json("POST", "/api/discover/auto", body);
  expect(r.body.data.status).toBe("RUNNING");
  await env.app.agent.whenIdle();
  return (await env.json("GET", `/api/discover/auto/${r.body.data.id}`)).body.data;
}

describe("auto-discover with an LLM", () => {
  test("researches with tools, keeps only videos it saw, stores picks with reasons", async () => {
    env.fetchHandler.fn = (url) => new Response(url.startsWith("https://www.bing.com/") ? BING : "", { status: 200 });
    const seen = scriptLlm([
      { tool_calls: [call("1", "web_search", { query: "viral minggu ini" }), call("2", "youtube_search", { query: "podcast viral", max_results: 99 })] },
      { tool_calls: [call("3", "analyze_video", { video_id: "abcdefghijk" }), call("4", "analyze_video", { video_id: "nope" }),
        call("5", "channel_videos", { channel: "UCch" }), call("6", "source_channels", {}), call("7", "analyze_video", { video_id: "abcdefghijk" })] },
      { content: 'Here you go:\n```json\n{"picks": [{"video_id": "abcdefghijk", "reason": "Hot topic, 3 strong moments"}, {"video_id": "zyxwvutsrqp"}, {"video_id": "ghostghost1", "reason": "x"}, {"video_id": "abcdefghijk"}], "notes": "Sidang X dominates"}\n```' },
    ]);
    const run = await runAuto({ goal: "drama artis", maxResults: 5 });

    expect(run).toMatchObject({ status: "DONE", mode: "agent", model: "qwen", goal: "drama artis", notes: "Sidang X dominates", llmError: null, count: 2 });
    expect(run.steps.map((s: { tool: string }) => s.tool)).toEqual(["web_search", "youtube_search", "analyze_video", "analyze_video",
      "channel_videos", "source_channels", "analyze_video"]);
    expect(run.steps[0].result).toBe("2 results");
    expect(run.steps[3].result).toBe("error: unknown video_id: use an id from youtube_search or channel_videos");
    expect(run.steps[2].result).toMatch(/^predicted [\d.]+, \d+ strong moments$/);
    expect(seen[0]!.temperature).toBe(0.8);
    expect(seen[0]!.tools!.map((t) => t.function.name)).toEqual(["web_search", "youtube_search", "analyze_video", "channel_videos", "source_channels"]);
    expect(seen[0]!.messages[1]!.content).toBe("Find videos for: drama artis");
    // tool results reach the model: web results unwrapped, YouTube rows compact
    const toolMsgs = seen[1]!.messages.filter((m) => m.role === "tool");
    expect(JSON.parse(toolMsgs[0]!.content)[0]).toEqual({ title: "Topik viral & heboh", url: "https://news.id/viral", snippet: "Sidang kasus “X” hari ini" });
    expect(JSON.parse(toolMsgs[1]!.content)[0]).toMatchObject({ video_id: "abcdefghijk", minutes: 60, type: "PODCAST", channel_id: "UCch" });
    const ytSearch = env.execCalls.find((c) => c.args[0]!.startsWith("ytsearch"))!.args;
    expect(ytSearch[0]).toBe("ytsearch15:podcast viral");

    const [a, b] = run.videos;
    expect(a).toMatchObject({ videoId: "abcdefghijk", sourceMode: "auto", sourceQuery: "drama artis", reason: "Hot topic, 3 strong moments" });
    expect(a.why[0]).toBe("Hot topic, 3 strong moments");
    expect(a.transcriptScore).toBeGreaterThan(0);              // analyzed by the agent, stored with the pick
    expect(b).toMatchObject({ videoId: "zyxwvutsrqp", reason: "Picked by the discovery agent", transcriptScore: null });
    await env.app.discovery.whenIdle();                         // the unanalyzed pick is enriched as usual
    expect(env.app.store.discoveredByYoutubeId("zyxwvutsrqp")!.enrichedAt).toBeString();
    // the analyzed pick was fetched once (cache) and not re-enriched
    expect(env.execCalls.filter((c) => c.args.includes("--sub-format") && c.args[0]!.includes("abcdefghijk") && c.args.includes("id"))).toHaveLength(1);
  });

  test("already-handled videos are flagged to the model; no web tool when WEB_SEARCH=off", async () => {
    env.app.store.saveDiscovered({ ...(await seedCandidate()), status: "SKIPPED" });
    const fresh = makeEnv({ webSearch: "off" });
    try {
      const prev = env;
      env = fresh;
      const seen = scriptLlm([{ tool_calls: [call("1", "youtube_search", { query: "x" })] }, { content: '{"picks": []}' }]);
      env = prev;
      await fresh.json("POST", "/api/discover/auto", {});
      await fresh.app.agent.whenIdle();
      expect(seen[0]!.tools!.map((t) => t.function.name)).not.toContain("web_search");
      expect(seen[0]!.messages[0]!.content).not.toContain("web_search");
      expect(seen[0]!.messages[1]!.content).toBe("Find what's worth clipping this week.");
      expect(fresh.app.agent.latest()).toMatchObject({ mode: "algorithm", llmError: "The LLM picked no videos it had seen" });
    } finally {
      await fresh.app.discovery.whenIdle();
      fresh.cleanup();
    }
    const seen = scriptLlm([{ tool_calls: [call("1", "youtube_search", { query: "x" })] }, { content: '{"picks":[{"video_id":"abcdefghijk"}]}' }]);
    await runAuto();
    expect(JSON.parse(seen[1]!.messages.at(-1)!.content)[0]).toMatchObject({ video_id: "abcdefghijk", status: "SKIPPED" });
  });

  test("LLM down → algorithm; an unexpected error fails the run", async () => {
    scriptLlm([new LlmError("LLM unreachable")]);
    const run = await runAuto();
    expect(run).toMatchObject({ status: "DONE", mode: "algorithm", llmError: "LLM unreachable" });

    scriptLlm([new Error("bug")]);
    expect(await runAuto()).toMatchObject({ status: "FAILED", error: "bug", finishedAt: expect.any(String) });
  });
});

async function seedCandidate() {
  await env.json("POST", "/api/discover/search", { query: "seed" });
  await env.app.discovery.whenIdle();
  return env.app.store.discoveredByYoutubeId("abcdefghijk")!;
}

describe("auto-discover without an LLM (algorithm)", () => {
  test("random anchor queries (goal first), every new video analyzed, best first, ≤ 2 per channel", async () => {
    const feed = [1, 2, 3].map((i) => ({ id: `same${i}xxxxxx`, url: `https://www.youtube.com/watch?v=same${i}xxxxxx`, title: `Podcast ${i}`,
      duration: 3600, channel: "One", channel_id: "UC1", view_count: 1000 * i, upload_date: ytDate(2) }));
    env.execHandler.fn = (cmd, args) => (args.includes("--dump-json") ? procOk(ytLines([...feed, ...[{ id: "otherxxxxxx", title: "Wawancara",
      url: "https://youtu.be/otherxxxxxx", duration: 2400, channel: "Two", upload_date: ytDate(3) }]])) : defaultExec(cmd, args));
    const run = await runAuto({ goal: "wawancara eksklusif", maxResults: 50 });

    expect(run).toMatchObject({ status: "DONE", mode: "algorithm", maxResults: 20, model: null,
      llmError: "No LLM configured (set LLM_BASE_URL and LLM_MODEL)" });
    const searches = run.steps.filter((s: { tool: string }) => s.tool === "youtube_search");
    expect(searches).toHaveLength(3);
    expect(searches[0]).toEqual({ tool: "youtube_search", args: { query: "wawancara eksklusif" }, result: "4 videos" });
    expect(run.steps.filter((s: { tool: string }) => s.tool === "analyze_video")).toHaveLength(4);
    expect(run.videos.map((v: { channel: string }) => v.channel).sort()).toEqual(["One", "One", "Two"]);
    expect(run.videos[0].reason).toBe('Algorithm pick (no LLM), found via "wawancara eksklusif"');
    const preds = run.videos.map((v: { predictedScore: number }) => v.predictedScore);
    expect(preds).toEqual([...preds].sort((x, y) => y - x));
  });

  test("failed searches are logged; skipped videos are not re-picked", async () => {
    await seedCandidate();
    env.app.store.updateDiscovered(env.app.store.discoveredByYoutubeId("abcdefghijk")!.id, { status: "SKIPPED" });
    let n = 0;
    env.execHandler.fn = (cmd, args) => (args.includes("--dump-json") && n++ === 0 ? { ...procOk("", "HTTP 429"), exitCode: 1 } : defaultExec(cmd, args));
    const run = await runAuto();
    expect(run.steps[0].result).toBe("error: yt-dlp search failed: HTTP 429");
    expect(run.videos.map((v: { videoId: string }) => v.videoId)).toEqual(["zyxwvutsrqp"]);
  });
});

describe("run API", () => {
  test("one run at a time; latest and by id", async () => {
    expect((await env.json("GET", "/api/discover/auto")).status).toBe(404);
    const first = await env.json("POST", "/api/discover/auto", { maxResults: "x" });
    expect(first.body.data.maxResults).toBe(10);
    const second = await env.json("POST", "/api/discover/auto", {});
    expect(second).toEqual({ status: 409, body: { status: "error", error: `Auto-discover already running: ${first.body.data.id}` } });
    await env.app.agent.whenIdle();
    expect((await env.json("GET", "/api/discover/auto")).body.data.id).toBe(first.body.data.id);
    expect((await env.json("GET", "/api/discover/auto/nope")).status).toBe(404);
  });
});

describe("prompt and trace", () => {
  test("prompt states the goal, limit and date", () => {
    const p = agentPrompt("", 7, "2026-10-27", true);
    expect(p).toContain("Today is 2026-10-27");
    expect(p).toContain("whatever Indonesians are talking about right now");
    expect(p).toContain("At most 7 picks");
    expect(p).toContain("web_search");
  });

  test("summaries", () => {
    expect(summarize([1, 2])).toBe("2 results");
    expect(summarize({ error: "x" })).toBe("error: x");
    expect(summarize({ predictedScore: 0.5, captions: false })).toBe("predicted 0.5, no captions");
    expect(summarize({ predictedScore: 0.5, strongMoments: 2 })).toBe("predicted 0.5, 2 strong moments");
    expect(summarize({})).toBe("ok");
    expect(summarize(null)).toBe("ok");
  });
});

describe("web search", () => {
  test("Bing HTML parsing", () => {
    expect(parseBing(BING)).toEqual([
      { title: "Topik viral & heboh", url: "https://news.id/viral", snippet: "Sidang kasus “X” hari ini" },
      { title: "Plain", url: "https://plain.example/a", snippet: "" },
    ]);
    expect(parseBing(BING, 1)).toHaveLength(1);
    expect(htmlText("a&#x41;&lt;b&gt;&unknown;")).toBe("aA<b>&unknown;");
    expect(unwrapBingUrl("https://x.example/?q=1&amp;r=2")).toBe("https://x.example/?q=1&r=2");
  });

  test("SearXNG JSON, HTTP errors, off", async () => {
    const urls: string[] = [];
    const fake = (body: string, status = 200) => (async (u: string | URL | Request) => { urls.push(String(u)); return new Response(body, { status }); }) as typeof fetch;
    const searx = new WebSearch("http://searx.local/", fake(JSON.stringify({ results: [{ title: "T", url: "U", content: "C" }, {}] })));
    expect(await searx.search("a b", 1)).toEqual([{ title: "T", url: "U", snippet: "C" }]);
    expect(urls[0]).toBe("http://searx.local/search?format=json&q=a%20b");
    expect(await new WebSearch("http://searx.local", fake("{}")).search("x")).toEqual([]);
    expect(await new WebSearch("http://searx.local", fake(JSON.stringify({ results: [{}] }))).search("x")).toEqual([{ title: "", url: "", snippet: "" }]);
    expect(new WebSearch("bing", fake("", 429)).search("x")).rejects.toThrow("web search HTTP 429");
    const off = new WebSearch("OFF");
    expect(off.enabled).toBeFalse();
    expect(off.search("x")).rejects.toThrow("Web search is off");
  });
});
