import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/config";
import { Llm, LlmError, withImages } from "../../src/llm";
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

describe("vision model", () => {
  test("it is set by LLM_VISION_MODEL and on by default; it needs the LLM itself", () => {
    expect(loadConfig({})).toMatchObject({ llmVision: true, llmVisionModel: "" });
    expect(loadConfig({ LLM_VISION_MODEL: " vl-model ", LLM_VISION: "off" })).toMatchObject({ llmVision: false, llmVisionModel: "vl-model" });
    const on = { ...CFG, llmVisionModel: "vl-model" };
    expect(new Llm(on).visionModel).toBe("vl-model");
    expect(new Llm(CFG).visionModel).toBeNull();                                          // no vision model set
    expect(new Llm({ ...on, llmVision: false }).visionModel).toBeNull();                   // switched off
    expect(new Llm({ ...on, llmEnabled: false }).visionModel).toBeNull();                  // the LLM is off
    expect(new Llm({ ...on, llmBaseUrl: "" }).visionModel).toBeNull();
    expect(new Llm(on).maxTokens).toBe(4000);
    expect(new Llm({ ...on, llmMaxTokens: 9000 }).maxTokens).toBe(9000);
  });

  test("a call with pictures goes to the vision model with the images as content parts", async () => {
    const s = server();
    const llm = new Llm({ ...CFG, llmVisionModel: "vl-model" }, s.fetchFn, 0);
    const reply = await llm.see([withImages("Describe this frame", "data:image/png;base64,AAA", "https://x/y.png")], { temperature: 0 });
    expect(reply.content).toBe("ok");
    expect(s.requests[0]).toMatchObject({ model: "vl-model", temperature: 0 });
    expect(s.requests[0].messages[0]).toEqual({
      role: "user", content: [
        { type: "text", text: "Describe this frame" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
        { type: "image_url", image_url: { url: "https://x/y.png" } },
      ],
    });
  });

  test("a model can be named for one call; the text path keeps the plain model and string content", async () => {
    const s = server();
    const llm = new Llm({ ...CFG, llmVisionModel: "vl-model" }, s.fetchFn, 0);
    await llm.see([withImages("x")], { model: "other-vl" });
    await llm.chat([{ role: "user", content: "hello" }]);
    expect(s.requests.map((r) => r.model)).toEqual(["other-vl", "text-model"]);
    expect(s.requests[1].messages[0]).toEqual({ role: "user", content: "hello" });
  });

  test("without a vision model it says so instead of sending the images to the text model", async () => {
    const s = server();
    await expect(new Llm(CFG, s.fetchFn, 0).see([withImages("x", "data:image/png;base64,AAA")])).rejects.toThrow(LlmError);
    expect(s.requests).toHaveLength(0);
  });
});

describe("vision in the connection settings", () => {
  let env: TestEnv;
  afterEach(() => env?.cleanup());

  test("the vision model and its switch are saved like the other LLM fields, and make Generate's vision connection", async () => {
    env = makeEnv({ llmBaseUrl: "http://llm/v1", llmModel: "m" });
    expect((await env.app.generate.status()).vision.configured).toBe(false);
    const saved = await env.json("PUT", "/api/settings/llm", { visionModel: " qwen-vl ", vision: true });
    expect(saved.body.data.llm).toMatchObject({ visionModel: "qwen-vl", vision: true, saved: expect.arrayContaining(["visionModel", "vision"]) });
    expect((await env.app.generate.status()).vision.configured).toBe(true);
    expect(env.app.generate.connected("vision")).toBe(true);

    await env.json("PUT", "/api/settings/llm", { vision: false });
    expect(env.app.generate.connected("vision")).toBe(false);
    const reset = await env.json("PUT", "/api/settings/llm", { visionModel: null, vision: null });
    expect(reset.body.data.llm).toMatchObject({ visionModel: "", vision: true });
    expect((await env.json("PUT", "/api/settings/llm", { vision: "yes" })).status).toBe(400);
  });
});
