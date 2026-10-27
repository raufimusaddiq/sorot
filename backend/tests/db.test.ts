import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDatabase } from "../src/db";
import { extractYoutubeId } from "../src/discovery";

describe("openDatabase", () => {
  test("migrates a pre-ALTER legacy database and keeps its rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "vc-db-"));
    const path = join(dir, "nested", "viralclipper.db");
    try {
      // Simulate a DB created by the earliest schema.sql (no title/description/text_sentiment).
      const legacy = openDatabase(path);
      legacy.close();
      const raw = new Database(path);
      raw.run("DROP TABLE clip");
      raw.run(`CREATE TABLE clip (id TEXT PRIMARY KEY, video_id TEXT NOT NULL, rank_pos INTEGER, score REAL,
        tier TEXT NOT NULL, start_time REAL NOT NULL, end_time REAL NOT NULL, duration_sec REAL NOT NULL,
        text_content TEXT, render_status TEXT NOT NULL DEFAULT 'PENDING', render_path TEXT,
        export_status TEXT NOT NULL DEFAULT 'PENDING', export_path TEXT, created_at TEXT NOT NULL)`);
      raw.run(`INSERT INTO clip (id, video_id, tier, start_time, end_time, duration_sec, created_at)
        VALUES ('c1', 'v1', 'PRIMARY', 0, 1, 1, '2026-01-01')`);
      raw.close();

      const db = openDatabase(path);
      const cols = (db.query("PRAGMA table_info(clip)").all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols).toContain("title");
      expect(cols).toContain("description");
      expect(db.query("SELECT id FROM clip").all()).toEqual([{ id: "c1" }]);
      expect((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
      db.close();
      // idempotent re-open
      openDatabase(path).close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loadConfig", () => {
  test("defaults match the old application.yml", () => {
    const c = loadConfig({});
    expect(c).toMatchObject({
      port: 8080, pythonPath: "python3", pipelineDir: "ai-pipeline", ffmpegPath: "ffmpeg", ytdlpPath: "yt-dlp",
      dataDir: "data", dbPath: "data/viralclipper.db", whisperModel: "medium", whisperDevice: "cuda",
      whisperLanguage: "id", maxConcurrentPipelines: 2, queueCapacity: 50, staticDir: "../frontend/out",
      subtitleStyle: "default", silenceTrim: false, silenceGapSec: 0.6, reframeMode: "face",
    });
  });

  test("caption and silence-trim settings", () => {
    const c = loadConfig({ SUBTITLE_STYLE: "hormozi", SILENCE_TRIM: "TRUE", SILENCE_GAP_SEC: "0.8" });
    expect(c).toMatchObject({ subtitleStyle: "hormozi", silenceTrim: true, silenceGapSec: 0.8 });
    expect(loadConfig({ SILENCE_TRIM: "no", SILENCE_GAP_SEC: "-1" })).toMatchObject({ silenceTrim: false, silenceGapSec: 0.6 });
    expect(loadConfig({ REFRAME_MODE: " Blur " }).reframeMode).toBe("blur");
    expect(loadConfig({ REFRAME_MODE: "sideways" }).reframeMode).toBe("face");
    expect(loadConfig({ HOOK_FIRST: "1", YOUTUBE_CAPTIONS: "true", YOUTUBE_AUTO_CAPTIONS: "on", BGM_FILE: " lofi.mp3 ", BGM_VOLUME: "0.3" }))
      .toMatchObject({ hookFirst: true, youtubeCaptions: true, allowAutoCaptions: true, bgmFile: "lofi.mp3", bgmVolume: 0.3 });
    expect(loadConfig({ BGM_VOLUME: "7" }).bgmVolume).toBe(0.12);
  });

  test("env overrides; empty strings fall back; bad ints fall back", () => {
    const c = loadConfig({ SERVER_PORT: "9000", DATA_DIR: "/app/data", WHISPER_MODEL: "", MAX_PARALLEL_RENDERS: "x", STATIC_DIR: "" });
    expect(c.port).toBe(9000);
    expect(c.dbPath).toBe("/app/data/viralclipper.db");
    expect(c.whisperModel).toBe("medium");
    expect(c.maxParallelRenders).toBe(2);
    expect(c.staticDir).toBe("");
  });
});

describe("extractYoutubeId", () => {
  test.each([
    ["https://www.youtube.com/watch?v=abcdefghijk&t=1", "abcdefghijk"],
    ["https://youtu.be/abcdefghijk", "abcdefghijk"],
    ["https://youtube.com/shorts/abc_def-hij", "abc_def-hij"],
    ["https://youtube.com/embed/abcdefghijk", "abcdefghijk"],
    ["https://youtube.com/watch?v=short", null],
    ["https://example.com", null],
    [null, null],
  ])("%s → %s", (url, id) => {
    expect(extractYoutubeId(url)).toBe(id);
  });
});
