// Real-subprocess tests: `bun` stands in for the Python interpreter so the
// spawn / drain / timeout / kill paths run for real (replaces the mock-only
// PythonRunnerTest.java).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { createPythonRunner, killTree, parseEnvelope, spawnCapture, timeoutFor } from "../src/runner";

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

/** A killed orphan can linger as a zombie (state Z) where init doesn't reap; that's stopped too. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[2] !== "Z";
  } catch {
    return true;   // no /proc (macOS, Windows): it answered signal 0, so it runs
  }
}

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

  test("a kill also stops the processes the script started", async () => {
    // The script's own child (standing in for ffmpeg) prints its pid, then hangs.
    writeFileSync(join(dir, "parent.js"),
      `const c = Bun.spawn({ cmd: [process.execPath, ${JSON.stringify(join(dir, "hang.js"))}] }); console.log(c.pid); setInterval(() => {}, 1000)`);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 300);
    const res = await spawnCapture(process.execPath, [join(dir, "parent.js")], { signal: ctrl.signal });
    expect(res.aborted).toBeTrue();
    const child = Number(res.stdout.trim());
    expect(child).toBeGreaterThan(0);
    await Bun.sleep(100);
    expect(running(child)).toBeFalse();   // stopped, not orphaned
  });

  test("killTree uses taskkill on Windows", () => {
    const calls: string[][] = [];
    killTree(1234, true, (cmd) => calls.push(cmd));
    expect(calls).toEqual([["taskkill", "/PID", "1234", "/T", "/F"]]);
  });

  test("captures stdout with a tail limit", async () => {
    const res = await spawnCapture(process.execPath, [join(dir, "noisy.js")], { stdoutTail: 10 });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toStartWith("…[truncated]…");
  });
});

describe("timeoutFor", () => {
  test("fixed limit, longer for long media", () => {
    expect(timeoutFor("transcribe.py", 0, 1.5)).toBe(20);            // unknown length → fixed limit
    expect(timeoutFor("transcribe.py", 10 * 60, 1.5)).toBe(20);      // short video → fixed limit
    expect(timeoutFor("transcribe.py", 60 * 60, 1.5)).toBe(90);      // 1 h on CPU
    expect(timeoutFor("media_features.py", 60 * 60, 0.3)).toBe(18);
    expect(timeoutFor("unknown.py", 0, 1)).toBe(15);                 // default limit
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
