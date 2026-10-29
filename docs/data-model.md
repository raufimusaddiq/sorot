# Data Model

SQLite database: `data/sorot.db` (installs from before the rename keep `data/viralclipper.db`)

API JSON keys are the camelCase of these columns (`backend/src/store.ts`):
`gate_verdict` → `gateVerdict`. Columns marked JSON hold JSON-encoded text.

## Entity-Relationship Diagram

```
Video 1──* Job
Job   1──* StageStatus
Video 1──* Clip
Clip  1──1 ClipScore
Clip  1──* SocialPost
Clip  1──1 ClipFeedback   (only once the clip has posted metrics)
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
| `file_path` | TEXT | NOT NULL | Video file: `data/raw/{id}.mp4` (YouTube download or a cut range), else the local file |
| `created_at` | TEXT | NOT NULL | ISO 8601 timestamp |
| `section_start` / `section_end` | REAL | | Only this range of the source was downloaded (seconds), if set at import |
| `brief` | TEXT | | JSON, written by the LLM director: `{summary, topics[], people[], audience, angle}` |

### `job`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | UUID |
| `video_id` | TEXT | NOT NULL, FK → video.id | |
| `status` | TEXT | NOT NULL | `QUEUED`, `RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED` |
| `current_stage` | TEXT | | Current pipeline stage name |
| `error_message` | TEXT | | Error details if FAILED |
| `created_at` | TEXT | NOT NULL | ISO 8601 |
| `updated_at` | TEXT | NOT NULL | ISO 8601 |
| `options` | TEXT | | JSON pipeline options chosen at import (style, reframe, …, `direction`) |

### `stage_status`

Tracks each pipeline stage within a job.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | UUID |
| `job_id` | TEXT | NOT NULL, FK → job.id | |
| `stage` | TEXT | NOT NULL | `IMPORT`, `AUDIO_EXTRACT`, `TRANSCRIBE`, `SEGMENT`, `SCORE`, `RENDER`, `SUBTITLE`, `VARIATION`, `ANALYTICS` |
| `status` | TEXT | NOT NULL | `PENDING`, `IN_PROGRESS`, `COMPLETED`, `FAILED` |
| `started_at` | TEXT | | ISO 8601 |
| `completed_at` | TEXT | | ISO 8601 |
| `error_message` | TEXT | | |
| `output_path` | TEXT | | Path to stage output file; while running, progress text (`Transcribing 37%`, `Jev judging clips 10/40`) |

Unique constraint: `(job_id, stage)`

### `clip`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | UUID |
| `video_id` | TEXT | NOT NULL, FK → video.id | |
| `rank_pos` | INTEGER | | Rank by score (1 = best); clips the quality gate held back (FAIL) rank last |
| `score` | REAL | | Final score (≤ 1.0): rules, or 50/50 with Jev or the LLM review ([scoring-spec.md](scoring-spec.md)) |
| `tier` | TEXT | NOT NULL | `PRIMARY`, `BACKUP`, `SKIP` |
| `title` | TEXT | | Post title (rules, LLM, or a quote Jev picked) |
| `description` | TEXT | | Post description |
| `start_time` | REAL | NOT NULL | Start time in seconds |
| `end_time` | REAL | NOT NULL | End time in seconds |
| `duration_sec` | REAL | NOT NULL | Clip duration in seconds |
| `text_content` | TEXT | | Transcript text for this clip |
| `render_status` | TEXT | NOT NULL | `PENDING`, `RENDERING` (clip editor), `COMPLETED`, `FAILED` |
| `render_path` | TEXT | | Rendered video. Captions are burned in the same pass, so it is the captioned file in `data/exports/{videoId}/`; `data/renders/{videoId}/` only for clips an older job rendered without captions |
| `export_status` | TEXT | NOT NULL | `PENDING`, `RENDERING` (clip editor), `COMPLETED`, `FAILED` |
| `export_path` | TEXT | | Captioned video: `data/exports/{videoId}/clip_{rank}_subtitled.mp4`, or `data/exports/{id}_final.mp4` after `POST /api/clips/export` |
| `created_at` | TEXT | NOT NULL | ISO 8601 |
| `options` | TEXT | | JSON editing options set in the clip editor (over the job's) |
| `caption_words` | TEXT | | JSON edited caption words (absolute source seconds) |
| `updated_at` | TEXT | | ISO 8601 |
| `reason` | TEXT | | Why it scored as it did; `Held back: …` when the gate failed it |
| `scored_by` | TEXT | | `jev+rules`, `llm+rules` or `rules` |
| `source` | TEXT | | Who found the moment: `rules`, `jev` or `llm` |
| `hook_start` / `hook_end` | REAL | | Hook line to replay first (source seconds); null = no replay |
| `gate_verdict` | TEXT | | `PASS`, `REVIEW`, `FAIL`; null = not gated |
| `gate` | TEXT | | JSON gate result: `{verdict, by: "jev"\|"rules", model, reasons[], answers{}, quality, titleReplaced?}` |

### `clip_score`

Breakdown of scoring features per clip.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | UUID |
| `clip_id` | TEXT | NOT NULL, FK → clip.id, UNIQUE | One score row per clip |
| `hook_strength` | REAL | | 0.0 - 1.0 |
| `keyword_trigger` | REAL | | 0.0 - 1.0 |
| `novelty` | REAL | | 0.0 - 1.0 |
| `clarity` | REAL | | 0.0 - 1.0 |
| `emotional_energy` | REAL | | 0.0 - 1.0 |
| `text_sentiment` | REAL | | 0.0 - 1.0 |
| `pause_structure` | REAL | | 0.0 - 1.0 |
| `face_presence` | REAL | | 0.0 - 1.0 |
| `scene_change` | REAL | | 0.0 - 1.0 |
| `topic_fit` | REAL | | 0.0 - 1.0 |
| `history_score` | REAL | | 0.0 - 1.0 |
| `boost_total` | REAL | | Sum of all boosts applied |
| `penalty_total` | REAL | | Sum of all penalties applied |
| `motion` | REAL | | 0.0 - 1.0 |
| `onset_density` | REAL | | 0.0 - 1.0 |

### `social_post`

A clip sent to social accounts through Tebar (`backend/src/publisher.ts`).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | UUID |
| `clip_id` | TEXT | NOT NULL | |
| `provider` | TEXT | NOT NULL | `tebar` |
| `provider_post_id` | TEXT | | Tebar's post id (null until Tebar accepted it) |
| `status` | TEXT | NOT NULL | `PUBLISHING`, `SCHEDULED`, `PUBLISHED`, `PARTIAL`, `FAILED`, `CANCELLED` (a scheduled post cancelled on Tebar) |
| `scheduled_at` | TEXT | | ISO 8601 |
| `idempotency_key` | TEXT | NOT NULL | Sent as `Idempotency-Key`; a retry re-sends it |
| `request` | TEXT | | JSON body sent to Tebar, saved before sending |
| `targets` | TEXT | | JSON per-account results: accountId, platform, status, permalink, errorCode, errorMessage, publishedAt |
| `error_message` | TEXT | | |
| `created_at` / `updated_at` | TEXT | NOT NULL | ISO 8601 |
| `last_synced_at` | TEXT | | Last status read from Tebar |
| `profile_id` | TEXT | | Tebar workspace (profile) the post was made in, sent again as `Tebar-Profile` on a re-send; null = the default workspace |

### `setting`

LLM / Jev / Tebar connection fields saved from the UI or `sorot connect`
(`backend/src/settings.ts`); a saved field wins over the env, clearing it
(`null`) goes back to the env value. Not exposed as a table through the API: `GET /api/settings`
shows a view with keys masked.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `key` | TEXT | PK | `<connection>.<field>`, e.g. `llm.baseUrl`, `jev.director`, `tebar.apiKey` |
| `value` | TEXT | NOT NULL | JSON value (API keys are stored in plain text) |
| `updated_at` | TEXT | NOT NULL | ISO 8601 |

### Other tables

- `clip_feedback` — posted-clip metrics, a feature snapshot and the viral
  score; written by `POST /api/clips/{id}/feedback` or the Tebar metrics sync
  ([self-learning-scoring.md](self-learning-scoring.md)).
- `discovered_video`, `discovery_query`, `discovery_channel` — discovery
  candidates and source channels ([api-spec.md](api-spec.md#discovery)).

## Indexes

```sql
CREATE INDEX idx_job_video ON job(video_id);
CREATE INDEX idx_job_status ON job(status);
CREATE INDEX idx_clip_video ON clip(video_id);
CREATE INDEX idx_clip_tier ON clip(tier);
CREATE INDEX idx_clip_rank ON clip(rank_pos);
CREATE INDEX idx_stage_job ON stage_status(job_id);
CREATE INDEX idx_social_post_clip ON social_post(clip_id);
```

Plus indexes on `job.updated_at`, `stage_status(stage, status)`, `clip_feedback`
and the discovery tables (`backend/src/db.ts`).

## Seed / Migration

The schema is created on startup by `openDatabase()` in `backend/src/db.ts`
(`CREATE TABLE IF NOT EXISTS`). Columns added later are applied with
`ALTER TABLE` when missing (`LEGACY_COLUMNS`), and the old `tiktok_*` columns
of `clip_feedback` are renamed to `post_*`, so a database from the Java-era
backend opens unchanged. No migration tool.
