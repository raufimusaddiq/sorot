import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db";
import { copyLibrary, defaultLibraryDeps, findLibraries, importKeys, libraryCommand, type LibraryDeps } from "../src/library";

let root = "";
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "vc-lib-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const norm = (p: string) => p.replaceAll("\\", "/");

/** A library folder with a real database holding `videos` videos and `clips` clips. */
function library(name: string, videos: number, clips: number, keys?: string) {
  const dir = join(root, name, "data");
  const db = openDatabase(join(dir, "sorot.db"));
  for (let i = 0; i < videos; i++) {
    db.query("INSERT INTO video (id, source_type, file_path, created_at) VALUES (?, 'LOCAL', '/x.mp4', 'now')").run(`v${i}`);
  }
  for (let i = 0; i < clips; i++) {
    db.query("INSERT INTO clip (id, video_id, rank_pos, score, tier, start_time, end_time, duration_sec, text_content, created_at) VALUES (?, 'v0', ?, 0.5, 'PRIMARY', 0, 10, 10, 't', 'now')").run(`c${i}`, i);
  }
  db.close();
  writeFileSync(join(dir, "clip1.mp4"), "video");
  if (keys !== undefined) writeFileSync(join(root, name, ".env.llm"), keys);
  return norm(dir);
}

const deps = (over: Partial<LibraryDeps> = {}): LibraryDeps => ({
  ...defaultLibraryDeps(() => {}),
  env: { LOCALAPPDATA: root }, home: "", cwd: join(root, "nowhere"),
  ...over,
});

describe("--find-libraries", () => {
  test.each([
    ["found, with keys", () => library("Sorot", 2, 3, "LLM_API_KEY=k\n"), { videos: 2, clips: 3, hasKeys: true, ok: true }],
    ["found, no keys", () => library("Sorot", 1, 0), { videos: 1, clips: 0, hasKeys: false, ok: true }],
    ["corrupt database is listed with a problem", () => {
      const dir = join(root, "Sorot", "data");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "sorot.db"), "this is not a database");
      return norm(dir);
    }, { videos: 0, clips: 0, hasKeys: false, ok: false }],
    ["an old viralclipper.db counts", () => {
      const dir = library("Sorot", 1, 1);
      require("node:fs").renameSync(join(dir, "sorot.db"), join(dir, "viralclipper.db"));
      return dir;
    }, { videos: 1, clips: 1, hasKeys: false, ok: true }],
  ])("%s", (_n, make, expected) => {
    const path = make();
    const { candidates } = findLibraries(deps({ env: { LOCALAPPDATA: join(root, "Sorot", "..") } }));
    const dirs = candidates.map((c) => c.path);
    expect(dirs).toEqual([path]);
    expect(candidates[0]).toMatchObject(expected);
    expect(Boolean(candidates[0]?.problem)).toBe(!expected.ok);
  });

  test("none found: an empty list, not an error", () => {
    expect(findLibraries(deps())).toEqual({ candidates: [] });
  });

  test("looks in the home folder, /etc/sorot env files and a repo checkout's data/, once each", () => {
    const seen: string[] = [];
    const d = deps({
      env: {}, home: "/home/u", cwd: "/repo/backend",
      exists: (p) => { const n = norm(p); seen.push(n); return n === "/etc/sorot"; },
      list: () => [{ name: "sorot.env", dir: false }, { name: "notes", dir: true }],
      readText: () => 'DATA_DIR="/srv/sorot/data"\n',
    });
    findLibraries(d);
    expect(seen.filter((p) => p.endsWith("/sorot.db")).map((p) => p.replace(/^[A-Za-z]:/, ""))).toEqual([
      "/home/u/Sorot/data/sorot.db", "/home/u/sorot/data/sorot.db", "/srv/sorot/data/sorot.db",
      "/repo/backend/data/sorot.db", "/repo/data/sorot.db",
    ]);
  });
});

describe("--copy-library", () => {
  test("copies everything, reports progress, skips unreadable files, never touches the source", () => {
    const from = library("Old", 1, 1);
    mkdirSync(join(from, "exports", "v0"), { recursive: true });
    writeFileSync(join(from, "exports", "v0", "a.mp4"), "a");
    writeFileSync(join(from, "locked.bin"), "x");
    const to = norm(join(root, "New", "data"));
    const real = deps();
    const progress: number[] = [];
    const out = copyLibrary({ ...real, copyFile: (a, b) => { if (a.endsWith("locked.bin")) throw new Error("EBUSY"); real.copyFile(a, b); } }, from, to, (n) => progress.push(n));
    expect(out.skipped).toEqual(["locked.bin"]);
    expect(out.copied).toBe(3);
    expect(existsSync(join(to, "exports", "v0", "a.mp4"))).toBe(true);
    expect(existsSync(join(from, "locked.bin"))).toBe(true);
    expect(existsSync(join(from, "sorot.db"))).toBe(true);
    expect(progress.at(-1)).toBe(100);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });

  test.each([
    ["a missing source is an error", () => join(root, "gone"), "library not found"],
  ])("%s", (_n, from, message) => {
    expect(() => copyLibrary(deps(), from(), join(root, "x"))).toThrow(message);
  });

  test("an empty library still reports 100", () => {
    mkdirSync(join(root, "empty"));
    const progress: number[] = [];
    expect(copyLibrary(deps(), join(root, "empty"), join(root, "to"), (n) => progress.push(n))).toEqual({ copied: 0, skipped: [] });
    expect(progress).toEqual([100]);
  });
});

describe("--import-keys", () => {
  test.each([
    ["keys present: saved as the settings the screen writes, printed masked", "LLM_BASE_URL=https://llm.test/v1\nLLM_API_KEY=sk-abcdef123456\nJEV_API_KEY=\"jev-key-9999\"\n# a comment\nOTHER=1\n",
      { "llm.baseUrl": '"https://llm.test/v1"', "llm.apiKey": '"sk-abcdef123456"', "jev.apiKey": '"jev-key-9999"' }, ["LLM_BASE_URL", "LLM_API_KEY", "JEV_API_KEY"]],
    ["file absent", undefined, {}, []],
    ["file with no known keys", "FOO=bar\nLLM_API_KEY=\n", {}, []],
  ] as Array<[string, string | undefined, Record<string, string>, string[]]>)("%s", (_n, content, saved, keys) => {
    const from = library("Old", 0, 0, content);
    let written: Record<string, string> = {};
    const out = importKeys(deps({ saveSettings: (e) => { written = e; } }), from);
    expect(written).toEqual(saved);
    expect(out.imported.map((i) => i.key)).toEqual(keys);
    const printed = JSON.stringify(out);
    for (const v of ["abcdef123456", "jev-key-9999", "llm.test"]) expect(printed).not.toContain(v);
    expect(out.imported.every((i) => i.masked.startsWith("••••"))).toBe(true);
  });

  test("the default saver writes into the settings table of the target database", () => {
    const from = library("Old", 0, 0, "TEBAR_API_KEY=tebar-0000\n");
    const target = join(root, "target.db");
    let db = openDatabase(target);
    db.close();
    importKeys(deps({ saveSettings: (e) => { db = new Database(target); for (const [k, v] of Object.entries(e)) db.query("INSERT INTO setting (key, value, updated_at) VALUES (?, ?, 'now')").run(k, v); db.close(); } }), from);
    db = new Database(target);
    expect(db.query("SELECT key, value FROM setting").all()).toEqual([{ key: "tebar.apiKey", value: '"tebar-0000"' }]);
    db.close();
    expect(readFileSync(join(root, "Old", ".env.llm"), "utf8")).toContain("tebar-0000"); // the source is untouched
  });
});

describe("libraryCommand", () => {
  test.each([
    [["--find-libraries"], "ok"],
    [["--copy-library", "a"], "error"],
    [["--copy-library", join("/no", "such"), "b"], "error"],
    [["--import-keys"], "error"],
    [["--import-keys", "/none"], "ok"],
    [["--serve"], null],
    [[], null],
  ] as Array<[string[], "ok" | "error" | null]>)("%j", (argv, status) => {
    const lines: string[] = [];
    const got = libraryCommand(argv, deps(), (l) => lines.push(l));
    expect(got?.status ?? null).toBe(status);
  });

  test("copy prints PROGRESS lines on stderr", () => {
    mkdirSync(join(root, "a"));
    writeFileSync(join(root, "a", "f"), "1");
    const lines: string[] = [];
    expect(libraryCommand(["--copy-library", join(root, "a"), join(root, "b")], deps(), (l) => lines.push(l))).toEqual({ status: "ok", data: { copied: 1, skipped: [] } });
    expect(lines).toEqual(["PROGRESS 100"]);
  });
});
