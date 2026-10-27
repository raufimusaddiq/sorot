import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, realDeps } from "../src/main";

const dir = mkdtempSync(join(tmpdir(), "vclip-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("real process and file wiring", async () => {
  const conf = join(dir, "cli.conf");
  writeFileSync(conf, "VCLIP_MODE=native\nVCLIP_URL=http://box:1\n");
  const prev = process.env.VCLIP_CONFIG;
  process.env.VCLIP_CONFIG = conf;
  const d = realDeps();
  process.env.VCLIP_CONFIG = prev;
  expect(d.config).toMatchObject({ mode: "native", url: "http://box:1", source: conf });
  expect(d.pollMs).toBe(2000);

  const bun = process.execPath;
  const v = await d.capture([bun, "--version"]);
  expect(v.code).toBe(0);
  expect(v.stdout.trim()).toBe(Bun.version);
  expect((await d.capture(["definitely-not-a-command-vclip"])).code).toBe(127);
  expect(await d.run([bun, "-e", "process.exit(3)"], { cwd: dir })).toBe(3);
  expect(await d.run([bun, "-e", "0"])).toBe(0);
  await d.sleep(1);

  const sub = join(dir, "a", "b");
  d.fs.mkdir(sub);
  writeFileSync(join(sub, "src.txt"), "hi");
  d.fs.copy(join(sub, "src.txt"), join(sub, "dst.txt"));
  expect(d.fs.exists(join(sub, "dst.txt"))).toBeTrue();
  expect(await d.fs.write(join(sub, "dl.bin"), new Response("12345"))).toBe(5);
  expect(readFileSync(join(sub, "dl.bin"), "utf8")).toBe("12345");
  // a real file response from a Bun server — the case Bun.write(path, response) hung on
  const big = new Uint8Array(3_000_000).map((_, i) => i % 251);
  writeFileSync(join(sub, "big.bin"), big);
  const server = Bun.serve({ port: 0, fetch: () => new Response(Bun.file(join(sub, "big.bin"))) });
  try {
    expect(await d.fs.write(join(sub, "dl2.bin"), await fetch(`http://localhost:${server.port}/`))).toBe(3_000_000);
    expect(new Uint8Array(readFileSync(join(sub, "dl2.bin")))).toEqual(big);
  } finally {
    server.stop(true);
  }
  expect(await d.fs.write(join(sub, "empty.bin"), new Response(null))).toBe(0);
  expect(typeof d.isRoot).toBe("boolean");
  expect(typeof d.cwd).toBe("string");

  const lines: string[] = [];
  const orig = console.log;
  console.log = (s: string) => lines.push(s);
  try {
    expect(await main(["--version"], d)).toBe(0);
  } finally {
    console.log = orig;
  }
  expect(lines).toEqual(["1.0.0"]);
});

test("unexpected errors are not swallowed", async () => {
  const d = realDeps();
  const fetchFn = (async () => Response.json({ status: "ok", data: {} })) as unknown as typeof fetch;
  // /api/jobs answered without a jobs array: a bug, not a user error → rethrown
  await expect(main(["jobs"], { ...d, err: () => {}, fetchFn })).rejects.toBeInstanceOf(TypeError);
  expect(realDeps().config.mode).toBeDefined();
  const unreadable = join(dir, "missing.conf");
  process.env.VCLIP_CONFIG = unreadable;
  expect(realDeps().config.source).not.toBe(unreadable);
  delete process.env.VCLIP_CONFIG;
});
