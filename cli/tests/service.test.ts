import { describe, expect, test } from "bun:test";
import { Fail, harness } from "./helpers";

const healthy = { "GET /api/health": { healthy: true } };

describe("up / down / restart", () => {
  test("docker: compose in the app dir, then waits for health", async () => {
    const h = harness(healthy);
    expect(await h.run("up")).toBe(0);
    expect(h.runs[0]).toEqual({ cmd: ["docker", "compose", "--env-file", ".env.docker", "up", "-d", "backend"], cwd: "/opt/vc" });
    expect(h.out.at(-1)).toBe("Ready: http://app:8080");
    await h.run("down");
    await h.run("restart");
    expect(h.runs.slice(1).map((r) => r.cmd.slice(4))).toEqual([["down"], ["restart", "backend"]]);
  });

  test("native: systemctl through sudo unless root", async () => {
    const h = harness(healthy, { mode: "native", service: "viralclip" });
    await h.run("up");
    await h.run("down");
    h.state.isRoot = true;
    await h.run("restart");
    expect(h.runs.map((r) => r.cmd)).toEqual([
      ["sudo", "systemctl", "start", "viralclip"],
      ["sudo", "systemctl", "stop", "viralclip"],
      ["systemctl", "restart", "viralclip"],
    ]);
  });

  test("failures: command fails, app never healthy, no install", async () => {
    const h = harness({ "GET /api/health": new Fail(503, "starting") });
    h.state.runCode = 3;
    expect(await h.run("up")).toBe(3);
    h.state.runCode = 0;
    expect(await h.run("up")).toBe(1);
    expect(h.err.at(-1)).toBe("The app didn't answer on http://app:8080. Check: vclip logs");
    const none = harness(healthy, { mode: "none" });
    expect(await none.run("up")).toBe(2);
    expect(none.err.at(-1)).toContain("No install found");
    expect(await none.run("logs")).toBe(2);
  });
});

test("logs: docker compose or journalctl, -f follows", async () => {
  const d = harness();
  await d.run("logs", "-f");
  expect(d.runs[0]!.cmd).toEqual(["docker", "compose", "--env-file", ".env.docker", "logs", "--tail", "200", "-f", "backend"]);
  const n = harness({}, { mode: "native" });
  await n.run("logs");
  expect(n.runs[0]!.cmd).toEqual(["sudo", "journalctl", "-u", "viralclip", "-n", "200", "--no-pager"]);
});

test("health", async () => {
  const h = harness(healthy);
  expect(await h.run("health")).toBe(0);
  expect(h.out.at(-1)).toBe("OK http://app:8080");
  await h.run("health", "--json");
  expect(h.out.at(-1)).toBe('{"healthy":true}');
  const down = harness();
  expect(await down.run("health")).toBe(1);
  expect(down.err.at(-1)).toContain("no route GET /api/health");
});

describe("doctor", () => {
  test("docker install with a GPU, all good", async () => {
    const h = harness(healthy);
    h.existing.add("/opt/vc");
    h.state.captures = {
      "nvidia-smi": { code: 0, stdout: "NVIDIA GeForce RTX 4060, 617.42\n" },
      docker: { code: 0, stdout: "2.27.0\n" },
    };
    expect(await h.run("doctor")).toBe(0);
    expect(h.out).toEqual([
      "✓ install: docker (/etc/viralclip/cli.conf)",
      "✓ app dir: /opt/vc",
      "✓ GPU: NVIDIA GeForce RTX 4060, 617.42",
      "✓ docker compose 2.27.0",
      "✓ API http://app:8080",
    ]);
  });

  test("native install, service down, CPU only, API unreachable", async () => {
    const h = harness({}, { mode: "native", appDir: "" });
    h.state.captures = { systemctl: { code: 3, stdout: "inactive\n" }, ffmpeg: { code: 0, stdout: "libx264" } };
    expect(await h.run("doctor")).toBe(1);
    const text = h.text();
    expect(text).toContain("✗ app dir: ?\n    → re-run the installer");
    expect(text).toContain("· GPU: none found");
    expect(text).toContain("✗ service viralclip: inactive\n    → vclip up");
    expect(text).toContain("✓ ffmpeg");
    expect(text).not.toContain("NVENC");
    expect(text).toContain("✗ API http://app:8080");
  });

  test("native with GPU reports NVENC; unknown service state; no install", async () => {
    const h = harness(healthy, { mode: "native" });
    h.existing.add("/opt/vc");
    h.state.captures = { "nvidia-smi": { code: 0, stdout: "GPU" }, ffmpeg: { code: 0, stdout: "h264_nvenc" }, systemctl: { code: 0, stdout: "" } };
    await h.run("doctor");
    expect(h.text()).toContain("✓ ffmpeg NVENC encoder available");
    expect(h.text()).toContain("✗ service viralclip: unknown");
    const noNvenc = harness(healthy, { mode: "native" });
    noNvenc.state.captures = { "nvidia-smi": { code: 0, stdout: "GPU" }, ffmpeg: { code: 1, stdout: "" } };
    await noNvenc.run("doctor");
    expect(noNvenc.text()).toContain("· ffmpeg NVENC encoder not built in");
    expect(noNvenc.text()).toContain("✗ ffmpeg\n    → sudo apt install ffmpeg");
    const none = harness(healthy, { mode: "none", source: null });
    expect(await none.run("doctor")).toBe(1);
    expect(none.out[0]).toBe("✗ install: none\n    → run scripts/install.sh");
    const noCompose = harness(healthy);
    await noCompose.run("doctor");
    expect(noCompose.text()).toContain("✗ docker compose \n    → install Docker with the compose plugin");
  });
});
