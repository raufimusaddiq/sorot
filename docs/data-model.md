# Data Model

SQLite database: `data/sorot.db` (installs from before the rename keep `data/viralclipper.db`)

## Entity-Relationship Diagram

```
Video 1──* Job
Video 1──* Clip
Clip  1──* ClipScore
```

## Tables

### `video`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | UUID |
| `source_url` | TEXT | | YouTube URL (nullable for local files) |
| `source_type` | TEXT | NOT NULL | `YOUTUBE` or `LOCAL` |
| `title` | TEXT | | Video title from metadata |
| `duration_sec` | INTEGER | | Duration in seconds |
| `file_path` | TEXT | NOT NULL | Path to raw video in data/raw/ |
| `created_at` | TEXT | NOT NULL | ISO 8601 timestamp |

### `job`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | UUID |
| `video_id` | TEXT | FK → video.id | |
| `status` | TEXT | NOT NULL | `QUEUED`, `RUNNING`, `COMPLETED`, `FAILED` |
| `current_stage` | TEXT | | Current pipeline stage name |
| `error_message` | TEXT | | Error details if FAILED |
| `created_at` | TEXT | NOT NULL | ISO 8601 |
| `updated_at` | TEXT | NOT NULL | ISO 8601 |

### `stage_status`

Tracks each pipeline stage within a job.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | UUID |
| `job_id` | TEXT | FK → job.id | |
| `stage` | TEXT | NOT NULL | `IMPORT`, `AUDIO_EXTRACT`, `TRANSCRIBE`, `SEGMENT`, `SCORE`, `RENDER`, `SUBTITLE` |
| `status` | TEXT | NOT NULL | `PENDING`, `IN_PROGRESS`, `COMPLETED`, `FAILED`, `SKIPPED` |
| `started_at` | TEXT | | ISO 8601 |
| `completed_at` | TEXT | | ISO 8601 |
| `error_message` | TEXT | | |
| `output_path` | TEXT | | Path to stage output file |

Unique constraint: `(job_id, stage)`

### `clip`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | UUID |
| `video_id` | TEXT | FK → video.id | |
| `rank_pos` | INTEGER | | Rank by score (1 = best) |
| `score` | REAL | | Final weighted score (0.0 - 1.0+) |
| `tier` | TEXT | NOT NULL | `PRIMARY`, `BACKUP`, `SKIP` |
| `start_time` | REAL | NOT NULL | Start time in seconds |
| `end_time` | REAL | NOT NULL | End time in seconds |
| `duration_sec` | REAL | NOT NULL | Clip duration in seconds |
| `text` | TEXT | | Transcript text for this clip |
| `render_status` | TEXT | NOT NULL | `PENDING`, `COMPLETED`, `FAILED` |
| `render_path` | TEXT | | Path to rendered video in data/renders/ |
| `export_status` | TEXT | NOT NULL | `PENDING`, `COMPLETED`, `FAILED` |
| `export_path` | TEXT | | Path to exported video in data/exports/ |
| `created_at` | TEXT | NOT NULL | ISO 8601 |

### `clip_score`

Breakdown of scoring features per clip.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | UUID |
| `clip_id` | TEXT | FK → clip.id, UNIQUE | One score row per clip |
| `hook_strength` | REAL | | 0.0 - 1.0 |
| `keyword_trigger` | REAL | | 0.0 - 1.0 |
| `novelty` | REAL | | 0.0 - 1.0 |
| `clarity` | REAL | | 0.0 - 1.0 |
| `emotional_energy` | REAL | | 0.0 - 1.0 |
| `pause_structure` | REAL | | 0.0 - 1.0 |
| `face_presence` | REAL | | 0.0 - 1.0 |
| `scene_change` | REAL | | 0.0 - 1.0 |
| `topic_fit` | REAL | | 0.0 - 1.0 |
| `history_score` | REAL | | 0.0 - 1.0 |
| `boost_total` | REAL | | Sum of all boosts applied |
| `penalty_total` | REAL | | Sum of all penalties applied |

## Indexes

```sql
CREATE INDEX idx_job_video ON job(video_id);
CREATE INDEX idx_job_status ON job(status);
CREATE INDEX idx_clip_video ON clip(video_id);
CREATE INDEX idx_clip_tier ON clip(tier);
CREATE INDEX idx_clip_rank ON clip(rank_pos);
CREATE INDEX idx_stage_job ON stage_status(job_id);
```

## Seed / Migration

MVP uses schema auto-creation on startup (Spring Boot + SQLite JDBC). No migration tool needed yet. Schema DDL lives in `backend/src/main/resources/schema.sql`.

When moving to PostgreSQL, add Flyway migrations at that point.
