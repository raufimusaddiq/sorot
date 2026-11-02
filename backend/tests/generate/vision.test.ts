import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/config";
import { Llm, withImages } from "../../src/llm";
import { makeEnv, type TestEnv } from "../helpers";

const CFG = { llmBaseUrl: "http://llm/v1", llmModel: "text-model", llmApiKey: "", llmTimeoutSec: 5 };

function server() {
  const requests: any[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
  }) as unknown as typeof fetch;
  return { fetchFn, requests };
}

describe("pictures", () => {
  test("there is no separate vision model: a call with pictures goes to the model answering, images as content parts; the text path keeps plain strings", async () => {
    const s = server();
    const llm = new Llm(CFG, s.fetchFn, 0);
    expect((await llm.see([withImages("Describe this frame", "data:image/png;base64,AAA", "https://x/y.png")], { temperature: 0 })).content).toBe("ok");
    await llm.see([withImages("x")], { model: "judge-model" });
    await llm.chat([{ role: "user", content: "hello" }]);
    expect(s.requests.map((r) => r.model)).toEqual(["text-model", "judge-model", "text-model"]);
    expect(s.requests[0].messages[0]).toEqual({
      role: "user", content: [
        { type: "text", text: "Describe this frame" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
        { type: "image_url", image_url: { url: "https://x/y.png" } },
      ],
    });
    expect(s.requests[2].messages[0]).toEqual({ role: "user", content: "hello" });
    expect([new Llm(CFG).maxTokens, new Llm({ ...CFG, llmMaxTokens: 9000 }).maxTokens]).toEqual([4000, 9000]);
  });
});

describe("vision in the connection settings", () => {
  let env: TestEnv;
  afterEach(() => env?.cleanup());

  test("Generate can look whenever the LLM is on (its model sees); the old vision fields are gone; Generate's budgets and role models are saved like the other LLM fields", async () => {
    env = makeEnv({ llmBaseUrl: "http://llm/v1", llmModel: "m" });
    expect([(await env.app.generate.status()).vision.configured, env.app.generate.connected("vision")]).toEqual([true, true]);
    for (const old of [{ visionModel: "qwen-vl" }, { vision: true }]) expect((await env.json("PUT", "/api/settings/llm", old)).status).toBe(400);
    // Generate's own token budget: a whole number (a form sends text), read by the director per call
    expect((await env.json("PUT", "/api/settings/llm", { genMaxTokens: "48000" })).body.data.llm.genMaxTokens).toBe(48000);
    expect(env.app.llm.genMaxTokens).toBe(48000);
    for (const bad of [100, 1.5, "lots"]) expect((await env.json("PUT", "/api/settings/llm", { genMaxTokens: bad })).status).toBe(400);
    // the build session's context budget (up to a 1M-token window and beyond), and a model per role
    expect((await env.json("PUT", "/api/settings/llm", { contextTokens: "750000", sceneModel: "glm" })).body.data.llm).toMatchObject({ contextTokens: 750000, sceneModel: "glm" });
    expect([env.app.llm.genContextTokens, env.app.llm.modelFor("scene"), loadConfig({}).genContextTokens, loadConfig({ GEN_SESSION: "off" }).genSession]).toEqual([750000, "glm", 600000, false]);
    for (const bad of [1000, 3_000_000]) expect((await env.json("PUT", "/api/settings/llm", { contextTokens: bad })).status).toBe(400);
  });
});
