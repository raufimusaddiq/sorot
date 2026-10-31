import { describe, expect, test } from "bun:test";
import { harness } from "./helpers";

const status = (over: Record<string, unknown> = {}) => ({
  available: true, reasons: [], hyperframes: { ok: true, version: "0.8.223" }, llm: { configured: true }, jev: { configured: false },
  image: { configured: false }, vision: { configured: false }, voice: { engines: [], localAvailable: true }, compute: "gpu", presets: [], ...over,
});

describe("sorot gen status", () => {
  test("available: a summary of what is connected, exit 0", async () => {
    const h = harness({ "GET /api/generate/status": status({ voice: { engines: ["elevenlabs", "local"], localAvailable: true } }) });
    expect(await h.run("gen", "status")).toBe(0);
    expect(h.out).toEqual([
      "Generate: available",
      "  HyperFrames 0.8.223: ok · renders on the GPU",
      "  LLM connected · Jev off · images off · vision off",
      "  Voice engines: elevenlabs, local",
    ]);
  });

  test("unavailable: the reasons are listed and the exit code is 1", async () => {
    const h = harness({ "GET /api/generate/status": status({
      available: false, llm: { configured: false }, compute: "cpu", hyperframes: { ok: false, version: "0.8.223" },
      voice: { engines: [], localAvailable: false, localReason: "the local voice needs a GPU install" },
      reasons: ["Connect an LLM in Settings: Generate needs one"],
    }) });
    expect(await h.run("gen", "status")).toBe(1);
    expect(h.text()).toContain("Generate: unavailable");
    expect(h.text()).toContain("not working · renders on the CPU");
    expect(h.text()).toContain("Voice engines: none (the local voice needs a GPU install)");
    expect(h.text()).toContain("  - Connect an LLM in Settings");
  });

  test("--json prints the status as is and keeps the exit code", async () => {
    const h = harness({ "GET /api/generate/status": status({ available: false, reasons: ["x"] }) });
    expect(await h.run("gen", "status", "--json")).toBe(1);
    expect(JSON.parse(h.out[0]!)).toMatchObject({ available: false, reasons: ["x"] });
  });

  test("a missing or unknown gen command is a usage error", async () => {
    const h = harness();
    expect(await h.run("gen")).toBe(2);
    expect(h.err[0]).toContain("Missing gen command (status, new,");
    expect(await h.run("gen", "dance")).toBe(2);
    expect(h.err.at(-1)).toContain("Unknown gen command: dance");
  });
});
