import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Same tables as the Java backend's schema.sql, so an existing
// data/viralclipper.db (the app's old name) opens unchanged. Columns that schema.sql added via
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
    post_views INTEGER DEFAULT 0,
    post_likes INTEGER DEFAULT 0,
    post_comments INTEGER DEFAULT 0,
    post_shares INTEGER DEFAULT 0,
    post_saves INTEGER DEFAULT 0,
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

-- Tracked source channels (discovery v2). trust_score is an EMA seeded at 0.5;
-- clip-farm / short-form channels are kept as REJECTED rows for dedup.
CREATE TABLE IF NOT EXISTS discovery_channel (
    id TEXT PRIMARY KEY,
    youtube_channel_id TEXT NOT NULL,
    channel_name TEXT NOT NULL,
    channel_url TEXT NOT NULL,
    primary_category TEXT,
    avg_duration_sec INTEGER,
    median_view_count BIGINT,
    uploads_per_week REAL,
    subscriber_count BIGINT,
    is_likely_clipper_channel INTEGER DEFAULT 0,
    trust_score REAL DEFAULT 0.5,
    trust_samples INTEGER DEFAULT 0,
    poll_cadence_hours INTEGER DEFAULT 24,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    first_seen_at TEXT NOT NULL,
    last_crawled_at TEXT,
    last_profile_refresh_at TEXT,
    UNIQUE(youtube_channel_id)
);

-- Connection settings saved from the UI / CLI (settings.ts); they override the env.
CREATE TABLE IF NOT EXISTS setting (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Clips sent to social accounts through a publisher (Tebar). targets holds the
-- provider's per-account status / permalink; request is the exact body sent,
-- so a retry re-sends it with the same idempotency key.
CREATE TABLE IF NOT EXISTS social_post (
    id TEXT PRIMARY KEY,
    clip_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_post_id TEXT,
    status TEXT NOT NULL,
    scheduled_at TEXT,
    idempotency_key TEXT NOT NULL,
    request TEXT,
    targets TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_synced_at TEXT
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
CREATE INDEX IF NOT EXISTS idx_dc_status_poll ON discovery_channel(status, last_crawled_at);
CREATE INDEX IF NOT EXISTS idx_dc_trust ON discovery_channel(trust_score DESC);
CREATE INDEX IF NOT EXISTS idx_dc_category ON discovery_channel(primary_category);
CREATE INDEX IF NOT EXISTS idx_social_post_clip ON social_post(clip_id);
`;

// Indexes on LEGACY_COLUMNS: created after the ALTERs so old databases have the columns.
const LATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_discovered_channel ON discovered_video(channel_id);
CREATE INDEX IF NOT EXISTS idx_discovered_content_type ON discovered_video(content_type);
`;

// Columns added after a table's first release: applied with ALTER TABLE when
// missing, so both fresh and existing databases end up with the same shape.
const LEGACY_COLUMNS: Array<[table: string, column: string, type: string]> = [
  ["clip", "title", "TEXT"],
  ["clip", "description", "TEXT"],
  ["clip_score", "text_sentiment", "REAL"],
  // all 13 scored features are kept (feedback training reads them)
  ["clip_score", "motion", "REAL"],
  ["clip_score", "onset_density", "REAL"],
  // editing suite (2026-10-27)
  ["video", "section_start", "REAL"],
  ["video", "section_end", "REAL"],
  ["job", "options", "TEXT"],
  ["clip", "options", "TEXT"],
  ["clip", "caption_words", "TEXT"],
  ["clip", "updated_at", "TEXT"],
  // scoring in Bun + optional LLM review (2026-10-27)
  ["clip", "reason", "TEXT"],
  ["clip", "scored_by", "TEXT"],
  // discovery v2 (channel crawler)
  ["discovered_video", "channel_id", "TEXT"],
  ["discovered_video", "content_type", "TEXT"],
  ["discovered_video", "speech_density_wpm", "REAL"],
  ["discovered_video", "is_likely_clipped", "INTEGER DEFAULT 0"],
  // discovery in Bun: whole-video caption analysis + agent reasons
  ["discovered_video", "strong_moments", "INTEGER"],
  ["discovered_video", "top_moments", "TEXT"],
  ["discovered_video", "reason", "TEXT"],
  ["discovered_video", "picked_by", "TEXT"],
  // LLM director + quality gate (2026-10-28)
  ["video", "brief", "TEXT"],
  ["clip", "source", "TEXT"],
  ["clip", "hook_start", "REAL"],
  ["clip", "hook_end", "REAL"],
  ["clip", "gate_verdict", "TEXT"],
  ["clip", "gate", "TEXT"],
];

// Fills a column just added to an old database, where the value can be recovered.
const BACKFILL: Record<string, string> = {
  // auto picks made before picked_by: the algorithm's reasons say so, the rest came from the LLM
  "discovered_video.picked_by": `UPDATE discovered_video SET picked_by =
    CASE WHEN reason LIKE 'Algorithm pick%' THEN 'algorithm' ELSE 'LLM' END
    WHERE source_mode = 'auto' AND reason IS NOT NULL`,
};

// Columns renamed in place on old databases: posted-clip metrics are no longer
// tied to one platform (they were tiktok_*).
const RENAMED_COLUMNS: Array<[table: string, from: string, to: string]> = [
  ["clip_feedback", "tiktok_views", "post_views"],
  ["clip_feedback", "tiktok_likes", "post_likes"],
  ["clip_feedback", "tiktok_comments", "post_comments"],
  ["clip_feedback", "tiktok_shares", "post_shares"],
  ["clip_feedback", "tiktok_saves", "post_saves"],
];

export function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA busy_timeout = 5000");
  if (path !== ":memory:") db.run("PRAGMA journal_mode = WAL");
  db.run(SCHEMA);
  for (const [table, from, to] of RENAMED_COLUMNS) {
    const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === from) && !cols.some((c) => c.name === to)) {
      db.run(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`);
    }
  }
  for (const [table, column, type] of LEGACY_COLUMNS) {
    const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      const backfill = BACKFILL[`${table}.${column}`];
      if (backfill) db.run(backfill);
    }
  }
  db.run(LATE_INDEXES);
  return db;
}
