import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Same tables as the Java backend's schema.sql, so an existing
// data/viralclipper.db opens unchanged. Columns that schema.sql added via
// ALTER TABLE are folded into the CREATE here and re-applied below (guarded)
// for databases created before those migrations.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS video (
    id TEXT PRIMARY KEY,
    source_url TEXT,
    source_type TEXT NOT NULL,
    title TEXT,
    duration_sec INTEGER,
    file_path TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES video(id),
    status TEXT NOT NULL DEFAULT 'QUEUED',
    current_stage TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stage_status (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES job(id),
    stage TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    started_at TEXT,
    completed_at TEXT,
    error_message TEXT,
    output_path TEXT,
    UNIQUE(job_id, stage)
);

CREATE TABLE IF NOT EXISTS clip (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES video(id),
    rank_pos INTEGER,
    score REAL,
    tier TEXT NOT NULL,
    title TEXT,
    description TEXT,
    start_time REAL NOT NULL,
    end_time REAL NOT NULL,
    duration_sec REAL NOT NULL,
    text_content TEXT,
    render_status TEXT NOT NULL DEFAULT 'PENDING',
    render_path TEXT,
    export_status TEXT NOT NULL DEFAULT 'PENDING',
    export_path TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clip_score (
    id TEXT PRIMARY KEY,
    clip_id TEXT NOT NULL UNIQUE REFERENCES clip(id),
    hook_strength REAL,
    keyword_trigger REAL,
    novelty REAL,
    clarity REAL,
    emotional_energy REAL,
    text_sentiment REAL,
    pause_structure REAL,
    face_presence REAL,
    scene_change REAL,
    topic_fit REAL,
    history_score REAL,
    boost_total REAL DEFAULT 0,
    penalty_total REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS clip_feedback (
    id TEXT PRIMARY KEY,
    clip_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    features TEXT NOT NULL,
    predicted_score REAL NOT NULL,
    predicted_tier TEXT NOT NULL,
    tiktok_views INTEGER DEFAULT 0,
    tiktok_likes INTEGER DEFAULT 0,
    tiktok_comments INTEGER DEFAULT 0,
    tiktok_shares INTEGER DEFAULT 0,
    tiktok_saves INTEGER DEFAULT 0,
    actual_viral_score REAL,
    posted_at TEXT,
    last_checked TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS discovered_video (
    id TEXT PRIMARY KEY,
    youtube_id TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT,
    channel TEXT,
    duration_sec INTEGER DEFAULT 0,
    view_count INTEGER,
    upload_date TEXT,
    age_hours REAL,
    source_mode TEXT NOT NULL,
    source_query TEXT,
    relevance_score REAL DEFAULT 0,
    transcript_score REAL,
    predicted_score REAL,
    transcript_sample TEXT,
    status TEXT NOT NULL DEFAULT 'NEW',
    job_id TEXT,
    video_id TEXT,
    discovered_at TEXT NOT NULL,
    enriched_at TEXT,
    UNIQUE(youtube_id)
);

CREATE TABLE IF NOT EXISTS discovery_query (
    id TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    query TEXT NOT NULL,
    channel_url TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    auto_refresh_hours INTEGER NOT NULL DEFAULT 24,
    last_run_at TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_job_video ON job(video_id);
CREATE INDEX IF NOT EXISTS idx_job_status ON job(status);
CREATE INDEX IF NOT EXISTS idx_clip_video ON clip(video_id);
CREATE INDEX IF NOT EXISTS idx_clip_tier ON clip(tier);
CREATE INDEX IF NOT EXISTS idx_clip_rank ON clip(rank_pos);
CREATE INDEX IF NOT EXISTS idx_stage_job ON stage_status(job_id);
CREATE INDEX IF NOT EXISTS idx_feedback_clip ON clip_feedback(clip_id);
CREATE INDEX IF NOT EXISTS idx_feedback_video ON clip_feedback(video_id);
CREATE INDEX IF NOT EXISTS idx_job_updated_at ON job(updated_at);
CREATE INDEX IF NOT EXISTS idx_stage_status_stage_status ON stage_status(stage, status);
CREATE INDEX IF NOT EXISTS idx_discovered_status_score ON discovered_video(status, predicted_score DESC);
CREATE INDEX IF NOT EXISTS idx_discovered_status_relevance ON discovered_video(status, relevance_score DESC);
CREATE INDEX IF NOT EXISTS idx_discovered_youtube_id ON discovered_video(youtube_id);
CREATE INDEX IF NOT EXISTS idx_discovery_query_active ON discovery_query(active, last_run_at);
`;

const LEGACY_COLUMNS: Array<[table: string, column: string, type: string]> = [
  ["clip", "title", "TEXT"],
  ["clip", "description", "TEXT"],
  ["clip_score", "text_sentiment", "REAL"],
];

export function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA busy_timeout = 5000");
  if (path !== ":memory:") db.run("PRAGMA journal_mode = WAL");
  db.run(SCHEMA);
  for (const [table, column, type] of LEGACY_COLUMNS) {
    const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }
  return db;
}
