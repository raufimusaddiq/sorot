import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/config";
import { Hyperframes, HyperframesError, renderTimeoutMs, requiredOk } from "../../src/generate/hyperframes";
import type { ExecFn, ProcResult, SpawnOptions } from "../../src/runner";
import { fakeHyperframes, hfFixture, procOk } from "../helpers";

const config = loadConfig({ NODE_BIN: "node22", HYPERFRAMES_BIN: "/hf/cli.mjs", HYPERFRAMES_VERSION: "0.8.223" });
const res = (over: Partial<ProcResult>): ProcResult => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, aborted: false, ...over });

/** An exec that records the command line and options of its one call and answers with `answer`. */
function spy(answer: ProcResult | ((opts: SpawnOptions) => ProcResult)) {
  const seen: { cmd?: string; args?: string[]; opts?: SpawnOptions } = {};
  const exec: ExecFn = async (cmd, args, opts = {}) => {
    Object.assign(seen, { cmd, args, opts });
    if (typeof answer === "function") {
      return answer(opts);
    }
    return answer;
  };
  return { hf: new Hyperframes(config, exec), seen };
}

describe("Hyperframes wrapper", () => {
  test("every command runs the pinned script under Node, non-interactive", async () => {
    const { hf, seen } = spy(procOk(hfFixture("lint-ok")));
    await hf.lint("/p");
    expect(seen).toMatchObject({ cmd: "node22", args: ["/hf/cli.mjs", "lint", "/p", "--json"] });
    expect(seen.opts).toMatchObject({ env: { HYPERFRAMES_AGENT: "1", HYPERFRAMES_SKIP_SKILLS: "1" }, timeoutMs: 120_000 });
    expect(hf.version).toBe("0.8.223");
  });

  test.each([
    ["init", (hf: Hyperframes) => hf.init("/p", "16:9"),
      ["init", "/p", "--non-interactive", "--skip-skills", "--resolution", "landscape", "--example", "blank"], procOk()],
    ["init (unknown format)", (hf: Hyperframes) => hf.init("/p", "4:3"), ["--resolution", "portrait"], procOk()],
    ["add", (hf: Hyperframes) => hf.add("/p", ["data-chart", "x"]), ["add", "--dir", "/p", "--no-clipboard", "data-chart", "x", "--json"], procOk("{}")],
    ["catalog", (hf: Hyperframes) => hf.catalog(), ["catalog", "--json"], procOk("[]")],
    ["check", (hf: Hyperframes) => hf.check("/p"), ["check", "/p", "--json"], procOk(hfFixture("check-ok"))],
    ["snapshot review", (hf: Hyperframes) => hf.snapshot("/p", { review: true }), ["snapshot", "/p", "--review", "--json"], procOk(hfFixture("snapshot-review"))],
    ["snapshot at", (hf: Hyperframes) => hf.snapshot("/p", { at: [1, 3.5] }), ["snapshot", "/p", "--at", "1,3.5", "--json"], procOk(hfFixture("snapshot-at"))],
    ["doctor", (hf: Hyperframes) => hf.doctor(), ["doctor", "--json"], procOk(hfFixture("doctor"))],
    ["render", (hf: Hyperframes) => hf.render("/p", { output: "/o.mp4", quality: "standard", fps: 24, durationSec: 30, workers: 2, gpu: true }),
      ["render", "/p", "-o", "/o.mp4", "-q", "looks", "-f", "24", "--quiet", "-w", "2", "--gpu"], procOk()],
    ["render (plain)", (hf: Hyperframes) => hf.render("/p", { output: "/o.mp4", quality: "draft", fps: 30, durationSec: 5 }),
      ["render", "/p", "-o", "/o.mp4", "-q", "draft", "-f", "30", "--quiet"], procOk()],
  ])("%s command line", async (_name, call, args, answer) => {
    const { hf, seen } = spy(answer);
    await call(hf);
    expect(seen.args).toEqual(expect.arrayContaining(["/hf/cli.mjs", ...args]));
  });

  test("lint and check report findings through exit 1 without failing", async () => {
    const { hf } = spy(res({ exitCode: 1, stdout: hfFixture("lint-fail") }));
    const lint = await hf.lint("/p");
    expect(lint.ok).toBe(false);
    expect(lint.findings.map((f) => f.code)).toContain("non_deterministic_code");
    expect((await hf.check("/p")).ok).toBe(false);
  });

  test("the captured outputs have the fields the verdicts read", async () => {
    const check = await spy(procOk(hfFixture("check-ok"))).hf.check("/p");
    expect(check.layout.findings[0]).toMatchObject({ code: "sweep_static", severity: "warning", selector: "[data-composition-id]" });
    const shots = await spy(procOk(hfFixture("snapshot-review"))).hf.snapshot("/p", { review: true });
    expect(shots.frames[0]).toMatchObject({ time: 1, role: "beat" });
  });

  test.each([
    ["exit 2 is a usage error", res({ exitCode: 2, stderr: "bad flag" }), "usage"],
    ["any other exit is a failure", res({ exitCode: 1, stderr: "boom" }), "failed"],
    ["a timeout", res({ exitCode: 137, timedOut: true }), "timeout"],
    ["a cancel", res({ exitCode: 137, aborted: true }), "cancelled"],
  ])("render: %s", async (_name, answer, code) => {
    const err = await spy(answer).hf.render("/p", { output: "/o", quality: "draft", fps: 30, durationSec: 5 }).catch((e) => e);
    expect(err).toBeInstanceOf(HyperframesError);
    expect(err).toMatchObject({ code });
  });

  test("JSON commands: exit 2 and unreadable output are errors", async () => {
    expect(await spy(res({ exitCode: 2 })).hf.check("/p").catch((e) => e)).toMatchObject({ code: "usage" });
    expect(await spy(res({ exitCode: 1, stdout: "{}" })).hf.catalog().catch((e) => e)).toMatchObject({ code: "failed" });
    expect(await spy(procOk("not json")).hf.doctor().catch((e) => e)).toMatchObject({ code: "invalid-output" });
    expect(await spy(res({ exitCode: 2 })).hf.init("/p", "9:16").catch((e) => e)).toMatchObject({ code: "usage" });
  });

  test("render time limit scales with length and frame rate; progress comes from percent lines", async () => {
    expect(renderTimeoutMs(10, 30)).toBe(600_000);
    expect(renderTimeoutMs(60, 30)).toBe(900_000);
    expect(renderTimeoutMs(60, 60)).toBe(1_800_000);
    const progress: number[] = [];
    const exec: ExecFn = async (_c, _a, opts) => {
      for (const line of ["start", "frames 40%", "done 100 %", "over 140%"]) opts?.onStderrLine?.(line);
      return procOk();
    };
    await new Hyperframes(config, exec).render("/p", { output: "/o", quality: "delivery", fps: 30, durationSec: 60 }, { onProgress: (p) => progress.push(p) });
    expect(progress).toEqual([40, 100, 100]);
    const { hf, seen } = spy(procOk());
    await hf.render("/p", { output: "/o", quality: "delivery", fps: 30, durationSec: 60 });
    expect(seen.opts!.timeoutMs).toBe(900_000);
    await hf.render("/p", { output: "/o", quality: "delivery", fps: 30, durationSec: 60 }, { timeoutMs: 5 });
    expect(seen.opts!.timeoutMs).toBe(5);
  });

  test("doctor: only Node, FFmpeg and Chrome decide availability", async () => {
    const doctor = JSON.parse(hfFixture("doctor"));
    expect(doctor.ok).toBe(false); // optional tools are missing in the captured run
    expect(requiredOk(doctor)).toEqual({ ok: true, failed: [] });
    const broken = { ...doctor, checks: doctor.checks.map((c: { name: string }) => (c.name === "Chrome" ? { ...c, ok: false, detail: "none" } : c)) };
    expect(requiredOk(broken).failed.map((c) => c.name)).toEqual(["Chrome"]);
    expect(requiredOk({ ...doctor, checks: [] }).failed.map((c) => c.name)).toEqual(["Node.js", "FFmpeg", "Chrome"]);
  });

  test("fakeHyperframes serves the captured outputs and the default handlers", async () => {
    const fake = fakeHyperframes({ lint: () => procOk(hfFixture("lint-fail")) });
    const hf = new Hyperframes(config, fake.exec);
    expect((await hf.lint("/p")).ok).toBe(false);
    expect((await hf.check("/p")).ok).toBe(true);
    expect((await hf.catalog())[0]!.name).toBe("data-chart");
    expect(await hf.add("/p", ["x"])).toEqual({});
    expect((await hf.doctor()).checks.length).toBeGreaterThan(3);
    expect(fake.calls.map((c) => c[0])).toEqual(["lint", "check", "catalog", "add", "doctor"]);
    const unknown = await fake.exec("node", ["cli", "nope"]);
    expect(unknown.exitCode).toBe(2);
  });
});
