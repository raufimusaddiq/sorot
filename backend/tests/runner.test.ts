// Real-subprocess tests: `bun` stands in for the Python interpreter so the
// spawn / drain / timeout / kill paths run for real (replaces the mock-only
// PythonRunnerTest.java).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { createPythonRunner, parseEnvelope, spawnCapture } from "../src/runner";

let dir: string;
const scripts: Record<string, string> = {
  "ok.js": `console.log(JSON.stringify({ success: true, data: { result: "ok", enc: process.env.PYTHONIOENCODING } }))`,
  "noisy.js": `console.log("loading model..."); console.log(JSON.stringify({ success: true, data: { n: 1 } }))`,
  "arraydata.js": `console.log(JSON.stringify({ success: true, data: [1, 2] }))`,
  "fail.js": `console.log(JSON.stringify({ success: false, error: "model not found" }))`,
  "failnomsg.js": `console.log(JSON.stringify({ success: false }))`,
  "exit.js": `console.error("Traceback: boom"); process.exit(3)`,
  "garbage.js": `console.log("not json at all")`,
  "hang.js": `setInterval(() => {}, 1000)`,
  "spam.js": `process.stderr.write("x".repeat(200000) + "TAIL"); console.log(JSON.stringify({ success: true, data: {} }))`,
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "vc-runner-"));
  for (const [name, src] of Object.entries(scripts)) writeFileSync(join(dir, name), src);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const runner = () => createPythonRunner({ ...loadConfig({}), pythonPath: process.execPath, pipelineDir: dir });

describe("createPythonRunner", () => {
  test("returns the data envelope and sets PYTHONIOENCODING", async () => {
    expect(await runner()("ok.js", [])).toEqual({ result: "ok", enc: "utf-8" });
  });

  test("tolerates log lines before the JSON", async () => {
    expect(await runner()("noisy.js", [])).toEqual({ n: 1 });
  });

  test("non-object data becomes {}", async () => {
    expect(await runner()("arraydata.js", [])).toEqual({});
  });

  test("success:false → error with message", async () => {
    expect(runner()("fail.js", [])).rejects.toThrow("Python script fail.js error: model not found");
    expect(runner()("failnomsg.js", [])).rejects.toThrow("Python script failnomsg.js error: Unknown error");
  });

  test("non-zero exit → error with stderr", async () => {
    expect(runner()("exit.js", [])).rejects.toThrow(/failed \(exit=3\): Traceback: boom/);
  });

  test("invalid JSON → error", async () => {
    expect(runner()("garbage.js", [])).rejects.toThrow("Python script garbage.js returned invalid JSON on stdout: not json at all");
  });

  test("timeout kills the process", async () => {
    expect(runner()("hang.js", [], { timeoutMinutes: 0.005 })).rejects.toThrow(/exceeded 0.005 min wall-clock budget; killed/);
  });

  test("abort kills the process and reports cancel", async () => {
    const ctrl = new AbortController();
    const p = runner()("hang.js", [], { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 50);
    expect(p).rejects.toThrow("Job cancelled by user");
  });

  test("stderr is clipped to the tail", async () => {
    const res = await spawnCapture(process.execPath, [join(dir, "spam.js")], { stderrTail: 1000 });
    expect(res.stderr.startsWith("…[truncated]…")).toBeTrue();
    expect(res.stderr.endsWith("TAIL")).toBeTrue();
    expect(res.stderr.length).toBeLessThan(1100);
    expect(await runner()("spam.js", [])).toEqual({});
  });
});

describe("spawnCapture", () => {
  test("already-aborted signal kills immediately", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const res = await spawnCapture(process.execPath, [join(dir, "hang.js")], { signal: ctrl.signal });
    expect(res.aborted).toBeTrue();
    expect(res.exitCode).not.toBe(0);
  });

  test("captures stdout with a tail limit", async () => {
    const res = await spawnCapture(process.execPath, [join(dir, "noisy.js")], { stdoutTail: 10 });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toStartWith("…[truncated]…");
  });
});

describe("parseEnvelope", () => {
  test("whole-stdout JSON, last-line fallback, failures", () => {
    expect(parseEnvelope('{"success":true}\n')).toEqual({ success: true });
    expect(parseEnvelope('progress 10%\n{"a":1}')).toEqual({ a: 1 });
    expect(() => parseEnvelope("")).toThrow("invalid JSON");
    expect(() => parseEnvelope("a\nb")).toThrow("invalid JSON");
  });
});
