import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { mask } from "../settings";

export interface Candidate { path: string; ok: boolean; videos: number; clips: number; hasKeys: boolean; problem?: string }

/** Filesystem and process facts the library commands read; tests inject fakes (constitution V: only the engine looks at engine files). */
export interface LibraryDeps {
  env: Record<string, string | undefined>;
  platform: string;
  cwd: string;
  home: string;
  exists(path: string): boolean;
  /** Entries of a folder; files are `dir: false`. */
  list(path: string): Array<{ name: string; dir: boolean }>;
  readText(path: string): string;
  copyFile(from: string, to: string): void;
  mkdirp(path: string): void;
  /** Row counts of a library's database; throws when it will not open or its schema cannot be read. */
  counts(dbPath: string): { videos: number; clips: number };
  /** Writes saved settings into DATA_DIR's database. */
  saveSettings(entries: Record<string, string>): void;
}

export function defaultLibraryDeps(saveSettings: LibraryDeps["saveSettings"]): LibraryDeps {
  return {
    env: process.env,
    platform: process.platform,
    cwd: process.cwd(),
    home: process.env.HOME || process.env.USERPROFILE || "",
    exists: existsSync,
    list: (p) => readdirSync(p, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() })),
    readText: (p) => readFileSync(p, "utf8"),
    copyFile: copyFileSync,
    mkdirp: (p) => { mkdirSync(p, { recursive: true }); },
    counts(dbPath) {
      const db = new Database(dbPath, { readonly: true, strict: true });
      try {
        const n = (table: string) => (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
        return { videos: n("video"), clips: n("clip") };
      } finally { db.close(); }
    },
    saveSettings,
  };
}

const DB_NAMES = ["sorot.db", "viralclipper.db"];
const norm = (p: string) => resolve(p).replaceAll("\\", "/");

/** Where an earlier install could have left its data folder: the install.ps1 folder, the Linux service env files, a repo checkout. */
function candidateDirs(d: LibraryDeps): string[] {
  const dirs: string[] = [];
  if (d.env.LOCALAPPDATA) dirs.push(join(d.env.LOCALAPPDATA, "Sorot", "data"));
  if (d.home) dirs.push(join(d.home, "Sorot", "data"), join(d.home, "sorot", "data"));
  const conf = "/etc/sorot";
  if (d.exists(conf)) {
    for (const f of d.list(conf).filter((e) => !e.dir && e.name.endsWith(".env"))) {
      const m = /^DATA_DIR=(.+)$/m.exec(d.readText(`${conf}/${f.name}`));
      if (m) dirs.push((m[1] as string).trim().replace(/^["']|["']$/g, ""));
    }
  }
  dirs.push(join(d.cwd, "data"), join(d.cwd, "..", "data"));
  return [...new Set(dirs.map(norm))];
}

const keyFile = (d: LibraryDeps, dir: string): string | null =>
  [join(dir, ".env.llm"), join(dir, "..", ".env.llm")].find((p) => d.exists(p)) ?? null;

export function inspectLibrary(d: LibraryDeps, dir: string): Candidate | null {
  const db = DB_NAMES.map((n) => join(dir, n)).find((p) => d.exists(p));
  if (!db) return null;
  const hasKeys = keyFile(d, dir) !== null;
  try {
    const { videos, clips } = d.counts(db);
    return { path: dir, ok: true, videos, clips, hasKeys };
  } catch (e) {
    return { path: dir, ok: false, videos: 0, clips: 0, hasKeys, problem: (e as Error).message || "the database will not open" };
  }
}

export function findLibraries(d: LibraryDeps): { candidates: Candidate[] } {
  const candidates = candidateDirs(d).map((dir) => inspectLibrary(d, dir)).filter((c): c is Candidate => c !== null);
  return { candidates };
}

/** Copies every file under `from` into `to`; unreadable ones are listed, never fatal; the source is only read. */
export function copyLibrary(d: LibraryDeps, from: string, to: string, progress: (n: number) => void = () => {}) {
  if (!d.exists(from)) throw new Error(`library not found: ${from}`);
  const files: string[] = [];
  const walk = (rel: string) => {
    for (const e of d.list(join(from, rel))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.dir) walk(r); else files.push(r);
    }
  };
  walk("");
  const skipped: string[] = [];
  let copied = 0;
  for (const [i, rel] of files.entries()) {
    try {
      d.mkdirp(dirname(join(to, rel)));
      d.copyFile(join(from, rel), join(to, rel));
      copied++;
    } catch {
      skipped.push(rel);
    }
    progress(Math.floor(((i + 1) / files.length) * 100));
  }
  if (files.length === 0) progress(100);
  return { copied, skipped };
}

/** .env.llm names → the `setting` keys the Settings screen writes (settings.ts CONNECTIONS). */
const KEY_MAP: Record<string, string> = {
  LLM_BASE_URL: "llm.baseUrl", LLM_MODEL: "llm.model", LLM_API_KEY: "llm.apiKey",
  JEV_URL: "jev.url", JEV_MODEL: "jev.model", JEV_API_KEY: "jev.apiKey",
  TEBAR_BASE_URL: "tebar.baseUrl", TEBAR_API_KEY: "tebar.apiKey",
};

/** Reads the .env.llm of the library at `from` into the setting table; returns only masked values. */
export function importKeys(d: LibraryDeps, from: string): { imported: Array<{ key: string; masked: string }> } {
  const file = keyFile(d, from);
  if (!file) return { imported: [] };
  const entries: Record<string, string> = {};
  const imported: Array<{ key: string; masked: string }> = [];
  for (const line of d.readText(file).split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    const spec = m ? KEY_MAP[m[1] as string] : undefined;
    const value = m ? (m[2] as string).replace(/^["']|["']$/g, "") : "";
    if (!spec || !value) continue;
    entries[spec] = JSON.stringify(value);
    imported.push({ key: m![1] as string, masked: mask(value) });
  }
  if (imported.length) d.saveSettings(entries);
  return { imported };
}

export type Envelope = { status: "ok"; data: unknown } | { status: "error"; error: string };

/** Runs one startup command (`--find-libraries`, `--copy-library`, `--import-keys`); null when `argv` is none of them. */
export function libraryCommand(argv: string[], d: LibraryDeps, stderr: (line: string) => void): Envelope | null {
  const [cmd, a, b] = argv;
  try {
    if (cmd === "--find-libraries") return { status: "ok", data: findLibraries(d) };
    if (cmd === "--copy-library") {
      if (!a || !b) return { status: "error", error: "usage: --copy-library <from> <to>" };
      return { status: "ok", data: copyLibrary(d, a, b, (n) => stderr(`PROGRESS ${n}`)) };
    }
    if (cmd === "--import-keys") {
      if (!a) return { status: "error", error: "usage: --import-keys <from>" };
      return { status: "ok", data: importKeys(d, a) };
    }
  } catch (e) {
    return { status: "error", error: (e as Error).message };
  }
  return null;
}
