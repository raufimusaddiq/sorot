import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { loadConfig } from "../../src/config";
import { openDatabase } from "../../src/db";

describe("generate config", () => {
  test.each([
    [{}, { hyperframesVersion: "0.8.223", genConcurrency: 1, genKeepVersions: 10, genDir: "data/generate", nodePath: "node" }],
    [{ DATA_DIR: "/d", HYPERFRAMES_VERSION: " 0.9.0 ", GEN_CONCURRENCY: "2", GEN_KEEP_VERSIONS: "3", NODE_BIN: "/n/node" },
      { hyperframesVersion: "0.9.0", genConcurrency: 2, genKeepVersions: 3, genDir: "/d/generate", nodePath: "/n/node" }],
    [{ GEN_CONCURRENCY: "0", GEN_KEEP_VERSIONS: "-5" }, { genConcurrency: 1, genKeepVersions: 1 }],
  ])("%j", (env, expected) => {
    expect(loadConfig(env)).toMatchObject(expected);
  });
});

describe("generate schema", () => {
  const GEN_TABLES = ["gen_project", "gen_plan", "gen_version", "gen_verdict", "gen_asset", "gen_export", "gen_event", "gen_recipe", "gen_fact", "gen_idea"];
  const project = (over: Record<string, string | number> = {}) => {
    const row = { id: "p", brief: "b", format: "9:16", target_sec: 30, language: "id", recipe_id: "quick", recipe: "{}", status: "RUNNING",
      created_at: "t", updated_at: "t", ...over };
    return [`INSERT INTO gen_project (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map(() => "?").join(", ")})`, ...Object.values(row)] as const;
  };

  test("an old database opens unchanged and gains the tables; reopening keeps rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "vc-gen-"));
    const path = join(dir, "sorot.db");
    try {
      openDatabase(path).close();
      const raw = new Database(path);
      for (const t of GEN_TABLES) raw.run(`DROP TABLE ${t}`);
      raw.run("INSERT INTO video (id, source_type, file_path, created_at) VALUES ('v', 'LOCAL', 'f', 't')");
      raw.close();

      const db = openDatabase(path);
      const names = (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
      expect(GEN_TABLES.every((t) => names.includes(t))).toBe(true);
      const [sql, ...params] = project();
      db.query(sql).run(...params);
      db.close();
      const again = openDatabase(path);
      expect(again.query("SELECT COUNT(*) AS n FROM gen_project").get()).toEqual({ n: 1 });
      expect(again.query("SELECT COUNT(*) AS n FROM video").get()).toEqual({ n: 1 });
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each([
    ["brief over 2,000 chars", { brief: "x".repeat(2001) }],
    ["target_sec below 5", { target_sec: 4 }],
    ["target_sec above 90", { target_sec: 91 }],
    ["unknown format", { format: "4:3" }],
    ["unknown language", { language: "fr" }],
  ])("gen_project refuses %s", (_name, over) => {
    const db = openDatabase(":memory:");
    expect(() => db.query(project(over)[0]).run(...project(over).slice(1) as never[])).toThrow();
  });

  test.each([
    ["gen_version.status", "INSERT INTO gen_version (id, project_id, plan_id, number, status, created_at, updated_at) VALUES ('v','p','pl',1,'DONE','t','t')"],
    ["gen_version.render_kind", "INSERT INTO gen_version (id, project_id, plan_id, number, render_kind, created_at, updated_at) VALUES ('v','p','pl',1,'x','t','t')"],
    ["gen_verdict.kind", "INSERT INTO gen_verdict (id, version_id, kind, status, findings, judged_by, created_at) VALUES ('d','v','OTHER','PASS','[]','code','t')"],
    ["gen_verdict.status", "INSERT INTO gen_verdict (id, version_id, kind, status, findings, judged_by, created_at) VALUES ('d','v','TECHNICAL','OK','[]','code','t')"],
    ["gen_fact.status", "INSERT INTO gen_fact (id, claim, status, added_by, created_at, updated_at) VALUES ('f','c','maybe','owner','t','t')"],
    ["gen_idea.status", "INSERT INTO gen_idea (id, slug, brief, status, created_at, updated_at) VALUES ('i','s','b','done','t','t')"],
    ["gen_asset.kind", "INSERT INTO gen_asset (id, project_id, kind, origin, path, created_at) VALUES ('a','p','video','upload','x','t')"],
  ])("%s refuses an unknown value", (_name, sql) => {
    const db = openDatabase(":memory:");
    db.run("PRAGMA foreign_keys = OFF");
    expect(() => db.run(sql)).toThrow();
  });

  test("one verdict per kind per version, one slug per idea", () => {
    const db = openDatabase(":memory:");
    const verdict = "INSERT INTO gen_verdict (id, version_id, kind, status, findings, judged_by, created_at) VALUES (?, 'v', 'TECHNICAL', 'PASS', '[]', 'code', 't')";
    db.query(verdict).run("a");
    expect(() => db.query(verdict).run("b")).toThrow();
    const idea = "INSERT INTO gen_idea (id, slug, brief, created_at, updated_at) VALUES (?, 's', 'b', 't', 't')";
    db.query(idea).run("1");
    expect(() => db.query(idea).run("2")).toThrow();
  });
});
