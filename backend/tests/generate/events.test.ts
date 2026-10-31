import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db";
import { DirectorLog, redact } from "../../src/generate/events";
import { Store } from "../../src/store";

describe("director log", () => {
  test.each([
    ["Authorization: Bearer abcdefghijklmnop", "Bearer ***"],
    ["use sk-abcdefghijklmnop1234 now", "sk-***"],
    ['{"apiKey":"s3cr3t-value"}', '"apiKey":"***"'],
    ["xi-api-key: abcd1234", "***"],
    ["https://x/y?api_key=abc123&a=1", "api_key=***&a=1"],
    ["nothing secret here", "nothing secret here"],
  ])("redact %s", (input, expected) => {
    const out = redact(input);
    expect(out).toContain(expected);
    expect(out).not.toMatch(/abcdefghijklmnop|s3cr3t|abcd1234|abc123/);
  });

  test("an ok call saves kind, model, request, response, timing and tokens", async () => {
    const store = new Store(openDatabase(":memory:"));
    const log = new DirectorLog(store);
    const value = await log.track(
      { projectId: "p", versionId: "v", kind: "plan", model: "m", request: { brief: "hi", key: "xyz" } },
      async () => ({ shots: 3 }), (v) => ({ response: v, tokens: 42 }),
    );
    expect(value).toEqual({ shots: 3 });
    expect(log.list("p")[0]).toMatchObject({
      projectId: "p", versionId: "v", kind: "plan", model: "m", ok: 1, tokens: 42, response: '{"shots":3}',
    });
    expect(log.list("p")[0]!.ms).toBeGreaterThanOrEqual(0);
  });

  test("a failing call is logged with its message and rethrown; defaults fill the optional fields", async () => {
    const store = new Store(openDatabase(":memory:"));
    const log = new DirectorLog(store);
    await expect(log.track({ projectId: "p", kind: "scene" }, async () => { throw new Error("bad token=abc12345"); })).rejects.toThrow("bad");
    await log.track({ projectId: "p", kind: "tool" }, async () => "text");
    const [ok, failed] = log.list("p");
    expect(ok).toMatchObject({ kind: "tool", ok: 1, response: "text", request: null, model: null, versionId: null, tokens: null });
    expect(failed).toMatchObject({ kind: "scene", ok: 0, tokens: null });
    expect(failed!.response).not.toContain("abc12345");
    expect(log.list("p", 1)).toHaveLength(1);
    await log.track({ projectId: "p", kind: "x" }, async () => undefined);
    expect(log.list("p", 1)[0]!.response).toBeNull();
  });
});
