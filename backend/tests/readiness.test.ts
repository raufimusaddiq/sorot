import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app";
import type { AppConfig } from "../src/config";
import { openDatabase } from "../src/db";
import { defaultReadinessDeps, manifest, readinessItems, type ReadinessDeps } from "../src/readiness/checks";
import { defaultDiskDeps } from "../src/readiness/disk";
import { makeEnv, procOk } from "./helpers";

const SHA = "a".repeat(64);
const build = (bins: string[], dir = "pkg/bin") => ({ url: "https://example.test/f.tar.xz", sha256: SHA, dir, bins });
const fakeManifest = {
  ffmpeg: { "linux-x64": build(["ffmpeg", "ffprobe"]) },
  uv: { "linux-x64": build(["uv"], "") },
  python: "3.12",
  cudaWheels: ["nvidia-cublas-cu12"],
  whisper: { name: "large-v3-turbo", approxBytes: 1.6e9, files: [
    { url: "https://example.test/model.bin", name: "model.bin", sha256: SHA },
    { url: "https://example.test/config.json", name: "config.json", sha256: SHA },
  ] },
};

interface Opts {
  /** Commands (or the argument) that fail with exit 1. */
  missing?: string[];
  files?: string[];
  gpu?: boolean;
  downloadSha?: string;
  downloadError?: string;
  uv?: boolean;
  /** stderr of a failing `uv` / `tar` / node call. */
  stderr?: string;
  gate?: Promise<void>;
  platform?: { os: string; arch: string };
  /** The bare names `ffmpeg` / `python3` do not resolve (a fresh machine); installed paths do. */
  bareMissing?: boolean;
}

/** A machine where `missing` commands fail; every command and file change is recorded, nothing is real. */
function machine(o: Opts = {}) {
  const files = new Set(o.files ?? []);
  const log: string[] = [];
  const deps: ReadinessDeps = {
    exec: async (cmd, args) => {
      log.push([cmd, ...args].join(" "));
      if (o.bareMissing && (cmd === "ffmpeg" || cmd === "python3")) return { ...procOk(), exitCode: 1 };
      if (cmd === "uv" && args[0] === "venv") files.add(`${args.at(-1)}/bin/python`);
      if (cmd === "nvidia-smi") return o.gpu ? procOk("NVIDIA RTX 4060\n") : { ...procOk(), exitCode: 1 };
      if (cmd === "uv" && !o.uv) return { ...procOk(), exitCode: 1 };
      if ((o.missing ?? []).some((m) => cmd.endsWith(m) || args.includes(m))) return { ...procOk(), exitCode: 1, stderr: o.stderr ?? "" };
      return args[0] === "-c" ? procOk("3.12\n") : procOk();
    },
    exists: (p) => files.has(p),
    remove: (p) => { files.delete(p); log.push(`rm ${p}`); },
    mkdirp: () => {},
    rename: (a, b) => { files.add(b); log.push(`mv ${a} ${b}`); },
    download: async (url, dest, onPercent) => {
      await o.gate;
      if (o.downloadError) throw new Error(o.downloadError);
      files.add(dest);
      onPercent(50);
      return o.downloadSha ?? SHA;
    },
    platform: o.platform ?? { os: "linux", arch: "x64" },
    manifest: fakeManifest,
    home: "/home/u",
  };
  return { deps, files, log };
}

const apps: App[] = [];
const envs: Array<{ cleanup(): void }> = [];
afterEach(() => { apps.splice(0).forEach((a) => a.close()); envs.splice(0).forEach((e) => e.cleanup()); });

/** The real app with the fake machine and a config rooted at /d. */
function boot(m: ReturnType<typeof machine>, over: Partial<AppConfig> = {}, db = openDatabase(":memory:")) {
  const e = makeEnv({ dataDir: "/d", pipelineDir: "pipe", ...over });
  e.app.close();
  envs.push(e);
  const app = createApp(e.config, { db, exec: async () => procOk(), readiness: m.deps });
  apps.push(app);
  const call = async (method: string, path: string) => {
    const res = await app.fetch(new Request(`http://localhost${path}`, { method }));
    return { status: res.status, body: (await res.json()) as any };
  };
  const item = async (id: string) => (await call("GET", "/api/readiness")).body.data.items.find((i: any) => i.id === id);
  return { app, config: e.config, call, item };
}

describe("readinessItems", () => {
  const MODEL = "/d/models/large-v3-turbo/model.bin";
  test.each([
    ["everything present", { files: [MODEL] }, { ffmpeg: true, python: true, whisperModel: true, gpu: false, generateBrowser: true }],
    ["ffmpeg missing", { files: [MODEL], missing: ["ffmpeg"] }, { ffmpeg: false, python: true, whisperModel: true, gpu: false, generateBrowser: true }],
    ["python packages missing", { files: [MODEL], missing: ["-c"] }, { ffmpeg: true, python: false, whisperModel: true, gpu: false, generateBrowser: true }],
    ["no model, no browser, a GPU", { gpu: true, missing: ["path"] }, { ffmpeg: true, python: true, whisperModel: false, gpu: true, generateBrowser: false }],
  ] as Array<[string, Opts, Record<string, boolean>]>)("%s", async (_n, o, expected) => {
    const items = await readinessItems({ ...makeEnv().config, dataDir: "/d" }, machine(o).deps);
    expect(Object.fromEntries(items.map((i) => [i.id, i.ok]))).toEqual(expected);
    expect(items.map((i) => [i.id, i.required, i.fixable])).toEqual([
      ["ffmpeg", true, true], ["python", true, true], ["whisperModel", true, true], ["gpu", false, false], ["generateBrowser", false, true],
    ]);
  });

  test("a model in the Hugging Face cache or at an absolute path counts; a command that cannot start is missing", async () => {
    const cfg = { ...makeEnv().config, dataDir: "/d" };
    const hf = machine({ files: ["/home/u/.cache/huggingface/hub/models--Systran--faster-whisper-large-v3-turbo"] });
    expect((await readinessItems(cfg, hf.deps))[2]?.ok).toBe(true);
    const abs = machine({ files: ["/m/large/model.bin"] });
    expect((await readinessItems({ ...cfg, whisperModel: "/m/large" }, abs.deps))[2]?.ok).toBe(true);
    const broken = machine();
    broken.deps.exec = async () => { throw new Error("ENOENT"); };
    expect((await readinessItems(cfg, broken.deps)).filter((i) => i.ok)).toEqual([]);
  });

  test("the shipped manifest pins every download with a 64-hex SHA-256 over https, the model to a commit, and ffmpeg for every desktop OS", () => {
    const builds = [...Object.values(manifest.ffmpeg), ...Object.values(manifest.uv)];
    for (const b of [...builds, ...manifest.whisper.files]) {
      expect(b.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(b.url).toStartWith("https://");
    }
    for (const f of manifest.whisper.files) expect(f.url).toMatch(/\/resolve\/[0-9a-f]{40}\//);
    expect(Object.keys(manifest.ffmpeg).sort()).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"]);
  });
});

describe("routes", () => {
  test("GET lists the five items in the engine envelope", async () => {
    const t = boot(machine());
    const r = await t.call("GET", "/api/readiness");
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("ok");
    expect(r.body.data.items.map((i: any) => i.id)).toEqual(["ffmpeg", "python", "whisperModel", "gpu", "generateBrowser"]);
  });

  test.each([["nope", 404], ["gpu", 400]])("POST fix of %s answers %d", async (id, status) => {
    expect((await boot(machine()).call("POST", `/api/readiness/${id}/fix`)).status).toBe(status);
  });

  test("a fix answers 202 with a task id; a second start while it runs is 409; progress shows, then clears", async () => {
    let release!: () => void;
    const m = machine({ missing: ["ffmpeg"], gate: new Promise<void>((r) => { release = r; }) });
    const t = boot(m);
    const first = await t.call("POST", "/api/readiness/ffmpeg/fix");
    expect(first.status).toBe(202);
    expect(first.body).toEqual({ status: "ok", data: { taskId: expect.stringMatching(/^fix-ffmpeg-/) } });
    expect((await t.call("POST", "/api/readiness/ffmpeg/fix")).status).toBe(409);
    expect((await t.item("ffmpeg")).progress).toEqual({ percent: 0, label: "Downloading ffmpeg" });
    release();
    await t.app.readiness.settled("ffmpeg");
    expect((await t.item("ffmpeg")).progress).toBeUndefined();
  });
});

describe("fixes", () => {
  test("ffmpeg: verified, unpacked, installed into tools, and the config follows", async () => {
    const m = machine({ missing: ["ffmpeg"] });
    const t = boot(m);
    await t.call("POST", "/api/readiness/ffmpeg/fix");
    await t.app.readiness.settled("ffmpeg");
    expect(t.config.ffmpegPath).toBe("/d/tools/ffmpeg");
    expect(m.log).toContain("mv /d/tools/ffmpeg-unpack/pkg/bin/ffmpeg /d/tools/ffmpeg");
    expect(m.log.some((l) => l.startsWith("tar -xf /d/tools/ffmpeg-f.tar.xz"))).toBe(true);
  });

  test.each([
    ["a checksum mismatch deletes the file", { downloadSha: "b".repeat(64) }, "checksum mismatch", true],
    ["no network", { downloadError: "offline" }, "offline", false],
    ["tar fails", { missing: ["tar"], stderr: "bad archive" }, "unpack failed: bad archive", true],
  ] as Array<[string, Opts, string, boolean]>)("ffmpeg fix fails: %s", async (_n, o, error, deleted) => {
    const m = machine({ missing: ["ffmpeg"], ...o, ...(o.missing ? { missing: ["ffmpeg", ...o.missing] } : {}) });
    const t = boot(m);
    await t.call("POST", "/api/readiness/ffmpeg/fix");
    await t.app.readiness.settled("ffmpeg");
    expect((await t.item("ffmpeg")).error).toBe(error);
    expect(m.log.includes("rm /d/tools/ffmpeg-f.tar.xz")).toBe(deleted);
  });

  test("a platform without a pinned build is not fixable", async () => {
    const t = boot(machine({ platform: { os: "freebsd", arch: "x64" }, missing: ["ffmpeg"] }));
    expect((await t.item("ffmpeg")).fixable).toBe(false);
    expect((await t.call("POST", "/api/readiness/ffmpeg/fix")).status).toBe(400);
  });

  test.each([
    ["ffmpeg beside its configured path", "ffmpegPath", "/opt/f/ffmpeg", "ffmpeg", "mv /opt/f/ffmpeg-unpack", "/opt/f/ffmpeg"],
    ["python in its configured venv", "pythonPath", "/v/.venv/bin/python", "python", "uv venv --python 3.12 /v/.venv", "/v/.venv/bin/python"],
    ["ffmpeg beside a Windows path", "ffmpegPath", "C:\\rt\\ffmpeg\\ffmpeg.exe", "ffmpeg", "mv C:\\rt\\ffmpeg/ffmpeg-unpack", "C:\\rt\\ffmpeg/ffmpeg"],
    ["python in a Windows venv", "pythonPath", "C:\\rt\\.venv\\Scripts\\python.exe", "python", "uv venv --python 3.12 C:\\rt\\.venv", "C:\\rt\\.venv\\Scripts\\python.exe"],
  ])("a fix installs where the configured path points: %s", async (_n, key, path, id, logged, expected) => {
    const m = machine({ uv: true, missing: [id === "ffmpeg" ? "ffmpeg" : "-c"] });
    const t = boot(m, { [key]: path });
    await t.call("POST", `/api/readiness/${id}/fix`);
    await t.app.readiness.settled(id);
    expect(m.log.some((l) => l.includes(logged))).toBe(true);
    expect((t.config as any)[key]).toBe(expected);
  });

  test("after a restart (config rebuilt from the same env, same database) the fixes still hold", async () => {
    const m = machine({ uv: true, bareMissing: true, gpu: false });
    const db = openDatabase(":memory:");
    const first = boot(m, {}, db);
    for (const id of ["ffmpeg", "python", "whisperModel"]) {
      await first.call("POST", `/api/readiness/${id}/fix`);
      await first.app.readiness.settled(id);
    }
    expect(m.files.has("/d/models/large-v3-turbo/model.bin")).toBe(true);
    // the restart: a new config from the same env, the same settings database
    const second = boot(m, {}, db);
    expect([second.config.ffmpegPath, second.config.pythonPath, second.config.whisperModel])
      .toEqual(["/d/tools/ffmpeg", "/d/venv/bin/python", "/d/models/large-v3-turbo"]);
    const items = (await second.call("GET", "/api/readiness")).body.data.items;
    expect(items.filter((i: any) => i.required).map((i: any) => i.ok)).toEqual([true, true, true]);
  });

  test.each([
    ["ffmpegPath", "/opt/f/ffmpeg", "readiness.ffmpegPath", "/d/tools/ffmpeg"],
    ["ffmpegPath", "C:\\rt\\ffmpeg.exe", "readiness.ffmpegPath", "/d/tools/ffmpeg"],
    ["pythonPath", "C:\\rt\\.venv\\Scripts\\python.exe", "readiness.pythonPath", "/d/venv/bin/python"],
    ["whisperModel", "D:\\models\\large", "readiness.whisperModel", "/d/models/large-v3-turbo"],
  ])("a saved result never overrides an explicit %s = %s", (key, explicit, saved, file) => {
    const m = machine({ files: [file, `${file}/model.bin`] });
    const db = openDatabase(":memory:");
    db.query("INSERT INTO setting (key, value, updated_at) VALUES (?, ?, 'now')").run(saved, file);
    expect((boot(m, { [key]: explicit }, db).config as any)[key]).toBe(explicit);
  });

  test("a saved path whose file is gone is ignored", async () => {
    const m = machine({ bareMissing: true });
    const db = openDatabase(":memory:");
    db.query("INSERT INTO setting (key, value, updated_at) VALUES ('readiness.ffmpegPath', '/d/tools/ffmpeg', 'now')").run();
    expect(boot(m, {}, db).config.ffmpegPath).toBe("ffmpeg");
  });

  test.each([
    ["CPU box: venv, packages", false, ["uv venv --python 3.12 /d/venv", "uv pip install --python /d/venv/bin/python -r pipe/requirements.txt"]],
    ["NVIDIA box adds the CUDA wheels", true, ["uv venv --python 3.12 /d/venv", "uv pip install --python /d/venv/bin/python -r pipe/requirements.txt", "uv pip install --python /d/venv/bin/python nvidia-cublas-cu12"]],
  ])("python fix, uv on PATH: %s", async (_n, gpu, cmds) => {
    const m = machine({ uv: true, gpu, missing: ["-c"] });
    const t = boot(m);
    await t.call("POST", "/api/readiness/python/fix");
    await t.app.readiness.settled("python");
    expect(m.log.filter((l) => l.startsWith("uv ") && !l.startsWith("uv --version"))).toEqual(cmds);
    expect(t.config.pythonPath).toBe("/d/venv/bin/python");
  });

  test("python fix without uv downloads the pinned uv first; an offline pip fails with 'offline'", async () => {
    const m = machine({ missing: ["-c"], stderr: "dns error: failed to lookup address" });
    const t = boot(m);
    const exec = m.deps.exec;
    m.deps.exec = async (cmd, args, o) => (cmd.endsWith("/tools/uv") && args[0] === "pip" ? { ...procOk(), exitCode: 2, stderr: "error sending request" } : exec(cmd, args, o));
    await t.call("POST", "/api/readiness/python/fix");
    await t.app.readiness.settled("python");
    expect(m.log).toContain("mv /d/tools/uv-unpack/uv /d/tools/uv");
    expect((await t.item("python")).error).toBe("offline");
  });

  test("python fix reports a failing venv step", async () => {
    const m = machine({ uv: true, missing: ["-c", "venv"], stderr: "no interpreter" });
    const t = boot(m);
    await t.call("POST", "/api/readiness/python/fix");
    await t.app.readiness.settled("python");
    expect((await t.item("python")).error).toBe("Creating Python 3.12 failed: no interpreter");
  });

  test("whisper fix: every file verified, installed, and the config points at the folder", async () => {
    const m = machine();
    const t = boot(m);
    await t.call("POST", "/api/readiness/whisperModel/fix");
    await t.app.readiness.settled("whisperModel");
    expect(t.config.whisperModel).toBe("/d/models/large-v3-turbo");
    expect(m.log.filter((l) => l.startsWith("mv "))).toEqual([
      "mv /d/models/large-v3-turbo/model.bin.part /d/models/large-v3-turbo/model.bin",
      "mv /d/models/large-v3-turbo/config.json.part /d/models/large-v3-turbo/config.json",
    ]);
  });

  test.each([
    ["checksum mismatch", { downloadSha: "c".repeat(64) }, "checksum mismatch"],
    ["offline", { downloadError: "offline" }, "offline"],
  ] as Array<[string, Opts, string]>)("whisper fix fails: %s, and the partial file is removed", async (_n, o, error) => {
    const m = machine(o);
    const t = boot(m);
    await t.call("POST", "/api/readiness/whisperModel/fix");
    await t.app.readiness.settled("whisperModel");
    expect((await t.item("whisperModel")).error).toBe(error);
    expect(m.files.has("/d/models/large-v3-turbo/model.bin.part")).toBe(false);
  });

  test("a model with no pinned checksum is refused, never installed unverified", async () => {
    const m = machine();
    m.deps.manifest = { ...fakeManifest, whisper: { ...fakeManifest.whisper, files: [{ url: "https://x.test/m", name: "model.bin", sha256: "" }] } };
    const t = boot(m);
    await t.call("POST", "/api/readiness/whisperModel/fix");
    await t.app.readiness.settled("whisperModel");
    expect((await t.item("whisperModel")).error).toBe("no pinned checksum for model.bin");
  });

  test.each([
    ["ok", { }, undefined],
    ["offline", { missing: ["ensure"], stderr: "getaddrinfo ENOTFOUND storage.googleapis.com" }, "offline"],
    ["other failure", { missing: ["ensure"], stderr: "disk full" }, "Chrome install failed: disk full"],
  ] as Array<[string, Opts, string | undefined]>)("Generate browser fix: %s", async (_n, o, error) => {
    const m = machine({ missing: ["path"], ...o, ...(o.missing ? { missing: ["path", ...o.missing] } : {}) });
    const t = boot(m);
    await t.call("POST", "/api/readiness/generateBrowser/fix");
    await t.app.readiness.settled("generateBrowser");
    expect((await t.item("generateBrowser")).error).toBe(error);
  });
});

describe("default deps", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("download streams to disk and returns the SHA-256 and progress; HTTP errors and dropped connections fail", async () => {
    dir = mkdtempSync(join(tmpdir(), "vc-ready-"));
    const body = "hello world";
    const sha = new Bun.CryptoHasher("sha256").update(body).digest("hex");
    const ok = defaultReadinessDeps(procOkExec, (async () => new Response(body, { headers: { "content-length": String(body.length) } })) as unknown as typeof fetch);
    const seen: number[] = [];
    expect(await ok.download("https://x.test/f", join(dir, "a", "f.bin"), (p) => seen.push(p))).toBe(sha);
    expect(readFileSync(join(dir, "a", "f.bin"), "utf8")).toBe(body);
    expect(seen.at(-1)).toBe(100);

    const notFound = defaultReadinessDeps(procOkExec, (async () => new Response("no", { status: 404 })) as unknown as typeof fetch);
    await expect(notFound.download("https://x.test/f", join(dir, "b"), () => {})).rejects.toThrow("download failed (HTTP 404)");
    const down = defaultReadinessDeps(procOkExec, (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch);
    await expect(down.download("https://x.test/f", join(dir, "c"), () => {})).rejects.toThrow("offline");
    const cut = defaultReadinessDeps(procOkExec, (async () => new Response(new ReadableStream({ pull() { throw new Error("reset"); } }))) as unknown as typeof fetch);
    await expect(cut.download("https://x.test/f", join(dir, "d"), () => {})).rejects.toThrow("offline");
  });

  test("remove, mkdirp, rename and exists work on real files; the disk deps read real sizes", () => {
    dir = mkdtempSync(join(tmpdir(), "vc-ready-"));
    const d = defaultReadinessDeps(procOkExec);
    d.mkdirp(join(dir, "x", "y"));
    writeFileSync(join(dir, "x", "y", "f"), "1234");
    expect(d.exists(join(dir, "x", "y"))).toBe(true);
    d.rename(join(dir, "x"), join(dir, "z"));
    expect(defaultDiskDeps.fileBytes(join(dir, "z", "y", "f"))).toBe(4);
    expect(defaultDiskDeps.fileBytes(join(dir, "nope"))).toBeNull();
    expect(defaultDiskDeps.freeBytes(join(dir, "not", "yet", "created"))).toBeGreaterThan(0);
    d.remove(join(dir, "z"));
    expect(d.exists(join(dir, "z"))).toBe(false);
  });
});

const procOkExec = async () => procOk();
