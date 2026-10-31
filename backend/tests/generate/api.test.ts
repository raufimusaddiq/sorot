import { afterEach, describe, expect, test } from "bun:test";
import { makeEnv, type TestEnv } from "../helpers";

let env: TestEnv;
afterEach(() => env?.cleanup());

describe("generate API", () => {
  test("GET /api/generate/status reports availability under the usual envelope", async () => {
    env = makeEnv({ llmBaseUrl: "http://llm/v1", llmModel: "m" });
    const { status, body } = await env.json("GET", "/api/generate/status");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      status: "ok",
      data: { available: true, reasons: [], hyperframes: { ok: true }, llm: { configured: true }, compute: "gpu", presets: [] },
    });
  });

  test("without an LLM it still answers, with the reason", async () => {
    env = makeEnv();
    const { body } = await env.json("GET", "/api/generate/status");
    expect(body.data).toMatchObject({ available: false, llm: { configured: false } });
    expect(body.data.reasons[0]).toContain("Connect an LLM");
  });
});
