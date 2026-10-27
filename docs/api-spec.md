# REST API Specification

Source of truth: [`backend/src/app.ts`](../backend/src/app.ts) (routes) and
[`backend/tests/api.test.ts`](../backend/tests/api.test.ts) (contract tests).
If this file and the code disagree, the code wins — fix this file.

Base URL: `http://localhost:8080/api`. The UI is served from the same origin
(`http://localhost:8080/`), so browsers need no CORS. CORS is allowed only for
`http://localhost:3000`, `http://127.0.0.1:3000` and `FRONTEND_URL` (for `next dev`).

## Conventions

Every JSON response uses one envelope:

```json
{ "status": "ok", "data": { } }
{ "status": "error", "error": "Human-readable message" }
```

| HTTP | Meaning |
|------|---------|
| 200 | Success |
| 204 | CORS preflight |
| 206 | Partial content (video Range request) |
| 400 | Bad input, or an invalid state transition (retry/cancel) |
| 404 | Resource or route not found |
| 405 | Route exists, wrong method |
| 409 | Can't start a pipeline (video missing, already active, queue full) |
| 416 | Unsatisfiable Range |
| 500 | Pipeline/subprocess failure or unexpected error |

Request bodies are JSON objects; an empty body is treated as `{}`. Malformed
JSON → 400 `Invalid JSON body`; a non-object (e.g. an array) → 400.

Row objects (`Video`, `Job`, `StageStatus`, `Clip`, `ClipScore`) use the
camelCase form of their SQLite columns, with `null` for unset values. Their
TypeScript shapes are in [`backend/src/types.ts`](../backend/src/types.ts) and
[`frontend/src/types.ts`](../frontend/src/types.ts). Timestamps are ISO-8601 UTC strings.

---

## Health

### `GET /api/health`
```json
{ "status": "ok", "data": { "healthy": true } }
```

---

## Videos

### `POST /api/import`
Register a video. Does **not** start processing — call `POST /api/process` next.

```json
{ "url": "https://www.youtube.com/watch?v=...", "localPath": null }
```

A non-empty `url` → `YOUTUBE` (downloaded to `data/raw/{videoId}.mp4` by the
IMPORT stage). Otherwise → `LOCAL` with `filePath = localPath`. An empty body
still creates a `LOCAL` row (legacy behavior); its pipeline fails at IMPORT.

```json
{ "status": "ok", "data": { "videoId": "uuid", "sourceType": "YOUTUBE" } }
```

### `GET /api/videos`
All videos, newest first: `{ "videos": [Video] }`.

### `GET /api/videos/{videoId}`
`data` is the `Video` row. 404 `Video not found`.

```json
{ "id": "uuid", "sourceUrl": "https://...", "sourceType": "YOUTUBE",
  "title": "Judul", "durationSec": null,
  "filePath": "/app/data/raw/uuid.mp4", "createdAt": "2026-10-27T10:00:00.000Z" }
```

### `DELETE /api/videos/{videoId}`
Deletes the video, its clips and clip scores, its jobs and stage rows, and the
media files (raw, audio, transcript, segments, analytics, renders, exports).
`clip_feedback` rows are **kept** because they are the scorer's training data.
Always 200, even for an unknown id.

```json
{ "status": "ok", "data": { "deleted": true, "videoId": "uuid" } }
```

---

## Jobs / pipeline

Stages, in order: `IMPORT`, `AUDIO_EXTRACT`, `TRANSCRIBE`, `SEGMENT`, `SCORE`,
`RENDER`, `SUBTITLE`, `VARIATION`, `ANALYTICS`.

Job status: `QUEUED` → `RUNNING` → `COMPLETED` | `FAILED` | `CANCELLED`.
Stage status: `PENDING`, `IN_PROGRESS`, `COMPLETED`, `FAILED`.

At most 2 pipelines run at once and up to 50 wait in a FIFO queue. A job left
`RUNNING`/`QUEUED` with no live pipeline is marked `FAILED` by the orphan sweep
(30 min stale on startup, 10 min stale on the periodic 5-min sweep).

### `POST /api/process`
```json
{ "videoId": "uuid" }
```
```json
{ "status": "ok", "data": { "jobId": "uuid", "status": "QUEUED", "currentStage": "" } }
```
- 400 `videoId required`
- 409 `Video not found: {id}` · `Video already has an active job: {jobId}` ·
  `Pipeline queue is full; try again later` (the rejected job is saved as `FAILED`)

### `GET /api/jobs`
All jobs, newest first: `{ "jobs": [Job] }`.

### `GET /api/jobs/{jobId}`
```json
{
  "status": "ok",
  "data": {
    "job": { "id": "uuid", "videoId": "uuid", "status": "RUNNING", "currentStage": "SCORE",
             "errorMessage": null, "createdAt": "…", "updatedAt": "…" },
    "stages": [
      { "id": "uuid", "jobId": "uuid", "stage": "IMPORT", "status": "COMPLETED",
        "startedAt": "…", "completedAt": "…", "errorMessage": null,
        "outputPath": "/app/data/raw/uuid.mp4" }
    ]
  }
}
```
`stages` are in pipeline order. For `RENDER` and `SUBTITLE`, `outputPath` holds
progress text such as `"Rendering 3/8 clips"`, then `"7 rendered, 1 failed"` or
`"8 burned, 0 failed"`. A failed job's `errorMessage` reads
`Stage {STAGE} failed: {reason}`. 404 `Job not found`.

### `POST /api/jobs/{jobId}/retry`
Re-queues a `FAILED` job; all stages run again (a finished download is reused).
`{ "jobId": "uuid", "status": "QUEUED" }`. 400 `Can only retry failed jobs` / `Job not found: {id}`.

### `POST /api/jobs/{jobId}/cancel`
Cancels a `RUNNING` or `QUEUED` job and kills its running subprocess.
`{ "jobId": "uuid", "status": "CANCELLED" }`.
400 `Can only cancel running or queued jobs, current: {status}` / `Job not found: {id}`.

---

## Clips

Tiers: `PRIMARY` (≥ 0.80), `BACKUP` (≥ 0.65), `SKIP` (< 0.65). Only PRIMARY
and BACKUP clips are rendered and subtitled. Render/export status values are
`PENDING`, `COMPLETED` or `FAILED`.

### `GET /api/videos/{videoId}/clips`
`{ "clips": [Clip] }`, sorted by `score` descending (ties broken by `rankPos`).
An unknown video returns `[]`.

```json
{ "id": "uuid", "videoId": "uuid", "rankPos": 1, "score": 0.87, "tier": "PRIMARY",
  "title": "Ternyata… #fyp", "description": "…", "startTime": 45.2, "endTime": 72.8,
  "durationSec": 27.6, "textContent": "Ternyata ada rahasia…",
  "renderStatus": "COMPLETED", "renderPath": "/app/data/renders/clip_1.mp4",
  "exportStatus": "COMPLETED", "exportPath": "/app/data/exports/clip_1_subtitled.mp4",
  "createdAt": "…" }
```

### `GET /api/clips/{clipId}`
`{ "clip": Clip, "scoreBreakdown": ClipScore }`. `scoreBreakdown` is omitted
when no score row exists. 404 `Clip not found`.

`ClipScore` fields: `id`, `clipId`, `hookStrength`, `keywordTrigger`,
`novelty`, `clarity`, `emotionalEnergy`, `textSentiment`, `pauseStructure`,
`facePresence`, `sceneChange`, `topicFit`, `historyScore`, `boostTotal`, `penaltyTotal`.

### `POST /api/clips/export`
```json
{ "clipIds": ["uuid", "uuid"] }
```
Copies each clip's best file (the subtitled export if present, otherwise the
render) to `data/exports/{clipId}_final.mp4` and marks it `COMPLETED`.
Unrendered clips are skipped. Returns `{ "exported": [Clip] }`.
400 `clipIds required`; 500 `Clip not found: {id}`.

### `GET /api/clips/{clipId}/preview`
Streams the export (or else the render) as `video/mp4` with
`Accept-Ranges: bytes`. `Range: bytes=a-b`, `bytes=a-` and `bytes=-n`
return 206 with `Content-Range`; out-of-range requests → 416. No envelope on
success. 404 `Clip not found` / `No rendered file available` /
`File not found or empty: {name}`.

### `GET /api/clips/{clipId}/export`
Downloads the export as `application/octet-stream` with
`Content-Disposition: attachment; filename="…"`. Range is supported.
404 `No exported file available`.

---

## Feedback / self-learning

### `POST /api/clips/{clipId}/feedback`
Record real TikTok metrics. The viral score is velocity-based (normalized by
hours since posting), so `postedAt` is required.

```json
{ "postedAt": "2026-10-20T10:00:00Z", "views": 12000, "likes": 800,
  "comments": 40, "shares": 25, "saves": 60 }
```
Metrics accept numbers or numeric strings; missing values count as 0.
`postedAt` must be ISO-8601 with `Z` or a `±hh:mm` offset, and not in the
future. The first submit snapshots the clip's score features for training;
later submits update the same row.

```json
{ "status": "ok", "data": { "clipId": "uuid", "viralScore": 0.42, "views": 12000,
  "likes": 800, "postedAt": "2026-10-20T10:00:00Z" } }
```
`viralScore` is `null` if `feedback.py` failed; the metrics are still saved.
400 `postedAt is required (…)` · `postedAt must be ISO-8601 (…)` ·
`postedAt is in the future: …` · `Clip not found: {id}`.

### `POST /api/feedback/train`
Exports scored feedback to `data/feedback/feedback_export.json` and runs
`learn_weights.py --action train --min-samples 5`.

```json
{ "status": "ok", "data": {
  "status": "trained", "version": 4, "trained_on": 6,
  "weight_changes": { "hookStrength": { "from": 0.17, "to": 0.18 } },
  "new_weights": { "hookStrength": 0.18 },
  "message": "…" } }
```
`weight_changes`, `new_weights` and `message` appear only when the script returns them.

### `GET /api/feedback/weights`
```json
{ "status": "ok", "data": { "version": 3, "trained_on": 0,
  "last_updated": "2026-04-21T00:00:00Z", "total_feedback": 0,
  "with_actual_scores": 0, "weights": { "hookStrength": 0.17 } } }
```

---

## Discovery

Candidates are persisted in `discovered_video`, keyed by YouTube id. After a
search, the top 10 new candidates are enriched in the background (3 at a time)
with a transcript sample and `transcriptScore` / `predictedScore`.

Candidate object (every list below returns these):
```json
{ "id": "uuid", "youtubeId": "abcdefghijk", "videoId": "abcdefghijk",
  "url": "https://…", "title": "…", "channel": "…", "duration": 300,
  "viewCount": 1000, "uploadDate": "20260401", "ageHours": 12.5,
  "relevanceScore": 0.75, "transcriptScore": 0.6, "predictedScore": 0.7,
  "status": "NEW", "jobId": null, "sourceMode": "search", "sourceQuery": "…" }
```
`videoId` is a legacy alias of `youtubeId`. Status values: `NEW`, `QUEUED`,
`SKIPPED`, `IMPORTED` (any uppercase string is accepted). Re-running a search
keeps a status the user set; candidates already in the library come back as `IMPORTED`.

### `POST /api/discover/search`
```json
{ "query": "fakta unik", "maxResults": 20, "minDuration": 0, "maxDuration": 0 }
```
→ `{ "mode": "search", "query": "…", "count": n, "videos": [Candidate] }`.
400 `query is required`. Durations of 0 mean no filter.

### `POST /api/discover/trending`
`{ "maxResults": 20, "region": "ID" }` (body optional) →
`{ "mode": "trending", "query": "ID", "count": n, "videos": [...] }`.

### `POST /api/discover/channel`
`{ "channelUrl": "https://youtube.com/@x", "maxResults": 20, "minDuration": 0, "maxDuration": 0 }`
→ `{ "mode": "channel", … }`. 400 `channelUrl is required`.

### `GET /api/discover/candidates?status=QUEUED`
Without `status`: `NEW` + `QUEUED`, ranked by `predictedScore` (else
`relevanceScore`). With `status`: that status, ranked by predicted then
relevance score. Returns `{ "count": n, "videos": [Candidate] }`.

### `POST /api/discover/candidates/{id}/status`
`{ "status": "skipped" }` → the updated Candidate. 400 `status is required`, 404 `not found`.

### `POST /api/discover/queue`
`{ "ids": ["uuid"] }` marks candidates `QUEUED`; `IMPORTED` and unknown ids are
skipped. Returns `{ "count": n, "videos": [Candidate] }`.
400 `ids[] is required` / `ids[] is empty`.

### `POST /api/discover/queue/drain`
For every `QUEUED` candidate: imports the video, starts a job, and marks the candidate `IMPORTED`.
```json
{ "status": "ok", "data": {
  "started": [{ "discoveredId": "uuid", "jobId": "uuid", "videoId": "uuid" }],
  "failed":  [{ "discoveredId": "uuid", "error": "Pipeline queue is full; try again later" }] } }
```
