# REST API Specification

Source of truth: [`backend/src/app.ts`](../backend/src/app.ts) (routes) and
[`backend/tests/api.test.ts`](../backend/tests/api.test.ts) (contract tests).
If this file and the code disagree, the code wins — fix this file.

Base URL: `http://localhost:8080/api`. The UI is served from the same origin
(`http://localhost:8080/` is the landing page, `/studio` the app), so browsers need no CORS. CORS is allowed only for
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
{ "url": "https://www.youtube.com/watch?v=...", "localPath": null,
  "startTime": "13:25", "endTime": "25:00" }
```

A non-empty `url` → `YOUTUBE` (downloaded to `data/raw/{videoId}.mp4` by the
IMPORT stage). Otherwise → `LOCAL` with `filePath = localPath`. An empty body
still creates a `LOCAL` row (legacy behavior); its pipeline fails at IMPORT.

`startTime`/`endTime` (optional, both or neither, at least 10 s apart) limit
processing to that part of the source: YouTube downloads only that window
(`yt-dlp --download-sections`), a local file is cut once. Accepted formats:
`85`, `85s`, `1:25`, `01:02:03`, `13m25s`. 400 on a bad or one-sided range.

```json
{ "status": "ok", "data": { "videoId": "uuid", "sourceType": "YOUTUBE",
  "sectionStart": 805, "sectionEnd": 1500 } }
```

### `GET /api/videos`
All videos, newest first: `{ "videos": [Video] }`.

### `GET /api/videos/{videoId}`
`data` is the `Video` row. 404 `Video not found`.

```json
{ "id": "uuid", "sourceUrl": "https://...", "sourceType": "YOUTUBE",
  "title": "Judul", "durationSec": null,
  "filePath": "/app/data/raw/uuid.mp4", "createdAt": "2026-10-27T10:00:00.000Z",
  "sectionStart": null, "sectionEnd": null }
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
{ "videoId": "uuid",
  "options": { "style": "hormozi", "reframe": "face", "silenceTrim": true, "silenceGapSec": 0.6,
               "hookFirst": false, "youtubeCaptions": true, "allowAutoCaptions": false,
               "bgm": "lofi.mp3", "bgmVolume": 0.12 } }
```
`options` is optional; every key is optional and falls back to the server
defaults (`GET /api/options`). Stored on the job (`Job.options`, JSON) and used
by its TRANSCRIBE / RENDER / SUBTITLE stages. 400 on an unknown style or
framing, a non-boolean flag, an out-of-range number, or a `bgm` that isn't a
bare music file name.
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

## Editing options

### `GET /api/options`
Choices and server defaults for the import form and clip editor:
```json
{ "styles": ["default", "hormozi", "storyteller", "cinematic"],
  "reframeModes": ["face", "center", "blur"],
  "defaults": { "style": "default", "reframe": "face", "silenceTrim": false, "silenceGapSec": 0.6,
                "hookFirst": false, "youtubeCaptions": false, "allowAutoCaptions": false,
                "bgm": "", "bgmVolume": 0.12 } }
```

| Option | Effect |
|---|---|
| `style` | Caption preset |
| `reframe` | `face` (crop follows faces), `center`, `blur` (whole frame over a blurred fill) |
| `silenceTrim` / `silenceGapSec` | Cut pauses longer than the gap (0.2–5 s) |
| `hookFirst` | Replay the clip's strongest line (a question/hook, 1.2–6 s, after the first 3 s) before it starts |
| `youtubeCaptions` / `allowAutoCaptions` | Use the video's uploaded (and optionally auto-generated) YouTube captions instead of Whisper when present |
| `bgm` / `bgmVolume` | Music file from `data/music`, looped and ducked under speech; volume 0–1 |

### `GET /api/music`
`{ "tracks": ["lofi.mp3", ...] }` — audio files in `data/music`
(`.mp3 .m4a .aac .wav .ogg .flac`), sorted.

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

Clips also carry `options` (JSON overrides from the editor), `captionWords`
(JSON corrected words) and `updatedAt`. Rendered files live in per-video
folders: `data/renders/{videoId}/clip_{rank}.mp4`,
`data/exports/{videoId}/clip_{rank}_subtitled.mp4` (+ `clip_{rank}.ass`).

`ClipScore` fields: `id`, `clipId`, `hookStrength`, `keywordTrigger`,
`novelty`, `clarity`, `emotionalEnergy`, `textSentiment`, `pauseStructure`,
`facePresence`, `sceneChange`, `topicFit`, `historyScore`, `boostTotal`, `penaltyTotal`.

### `GET /api/clips/{clipId}/captions`
Caption words for the clip editor, in absolute source seconds:
`{ "words": [{ "text": "halo", "start": 30.5, "end": 31.0 }], "edited": false }`.
`edited: true` when the clip has saved corrections (`Clip.captionWords`).
404 unknown clip; 409 `Transcript not available yet`.

### `POST /api/clips/{clipId}/rerender`
Re-renders one clip (render + captions) with new settings. All keys optional:
```json
{ "startTime": 29.5, "endTime": "0:57",
  "options": { "style": "hormozi", "silenceTrim": true },
  "captionWords": [{ "text": "Mongol", "start": 32.0, "end": 32.4 }] }
```
- `startTime`/`endTime` — new range (same formats as import); length 3–180 s.
- `options` — replaces the clip's saved overrides (`{}` clears them); layered
  over the job's options and the server defaults.
- `captionWords` — corrected words (empty text drops a word); `null` clears a
  saved edit and regenerates captions from the transcript; omitted keeps it.

Returns `{ "clip": Clip }` with `updatedAt` set — append it to the preview /
download URL (`?v=…`) to bypass the browser cache. Errors: 400 validation,
404 unknown clip, 409 `Clip is already re-rendering` /
`Video is still processing…`, 500 `Re-render failed: …` (the clip's statuses
are set to `FAILED`).

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
Record the real metrics of a posted clip. The viral score is velocity-based (normalized by
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
`viralScore` (0-1, `backend/src/learning.ts`): views per day, log-scaled (35%),
interactions per view (25%), saves per view (20%), comments per view (20%).
400 `postedAt is required (…)` · `postedAt must be ISO-8601 (…)` ·
`postedAt is in the future: …` · `Clip not found: {id}`.

### `POST /api/feedback/train`
Re-weights all 13 features from the clips that have a real viral score (at
least 5): each feature's weight moves toward its Pearson correlation with the
real scores (floored at 0.05), blended 70/30 with the current weights. The
result is written to `data/weights.json`, which the scorer reads before the
shipped `ai-pipeline/weights.json`.

```json
{ "status": "ok", "data": {
  "status": "trained", "version": 4, "trained_on": 6,
  "weight_changes": { "hookStrength": { "from": 0.17, "to": 0.18 } },
  "new_weights": { "hookStrength": 0.18, "…": 0.05 } } }
```
With too few results: `{ "status": "insufficient_data", "version": 0, "trained_on": 0,
"message": "Need at least 5 records with actual scores, got 2" }`.

### `GET /api/feedback`
Logged results for posted clips, newest post first, with the clip's title (the Learning app lists them).
```json
{ "status": "ok", "data": { "results": [ { "clipId": "…", "videoId": "…", "title": "Gaji pertama cuma 3 juta?",
  "viralScore": 0.7037, "views": 12000, "likes": 900, "comments": 40, "shares": 20, "saves": 15,
  "postedAt": "2026-10-25T10:00:00Z" } ] } }
```

### `GET /api/feedback/weights`
```json
{ "status": "ok", "data": { "version": 3, "trained_on": 0,
  "last_updated": "2026-04-21T00:00:00Z", "total_feedback": 0,
  "with_actual_scores": 0, "weights": { "hookStrength": 0.17 } } }
```

---

## Discovery

Candidates are persisted in `discovered_video`, keyed by YouTube id. After a
search, the top 10 new candidates are enriched in the background (3 at a time):
their whole captions are scored in 45 s windows (`backend/src/captionAnalysis.ts`).
`transcriptScore` is the mean of the 5 best windows, `strongMoments` counts
windows ≥ 0.55, `topMoments` lists the best ones, and `predictedScore` =
40% transcript + 15% strong moments per 10 captioned minutes + 10% speech
density + 20% view velocity + 15% length fit (hand-set weights).

Candidate object (every list below returns these):
```json
{ "id": "uuid", "youtubeId": "abcdefghijk", "videoId": "abcdefghijk",
  "url": "https://…", "title": "…", "channel": "…", "duration": 300,
  "viewCount": 1000, "uploadDate": "20260401", "ageHours": 12.5,
  "relevanceScore": 0.75, "transcriptScore": 0.6, "predictedScore": 0.7,
  "status": "NEW", "jobId": null, "sourceMode": "search", "sourceQuery": "…",
  "channelId": "UC…", "contentType": "PODCAST", "speechDensityWpm": 136,
  "isLikelyClipped": false, "strongMoments": 3,
  "topMoments": [{ "start": 278, "score": 0.7, "text": "…" }],
  "reason": "Hot topic this week (agent picks only)", "pickedBy": null,
  "why": ["3 strong moments, best at 4:38", "Steady talk (136 wpm)", "Long-form (63 min)"] }
```
`why` gives plain-language reasons for the rank (agent reason, caption analysis,
length, view velocity, known source channel, a channel you've clipped before).
`contentType` is a regex guess (`PODCAST`, `TALKSHOW`, `STANDUP`, `LIVESTREAM`,
`NEWS`, `STORYTELLING`, `REVIEW`, `GAMING`, `OTHER`). Searches already drop titles that look re-clipped
("clip", "highlight", "best of"…) and defaults to uploads from the last 90 days.
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
Merges YouTube hashtag feeds (`viralindonesia`, `viral`, …) with a few niche
searches; a failing feed is skipped, so this never fails as a whole.
`region` is kept for compatibility (hashtag feeds are not regional).

### `POST /api/discover/channel`
`{ "channelUrl": "https://youtube.com/@x", "maxResults": 20, "minDuration": 0, "maxDuration": 0 }`
→ `{ "mode": "channel", … }`. 400 `channelUrl is required`.

### `POST /api/discover/auto`
Starts auto-discover in the background (one run at a time; 409
`Auto-discover already running: {id}`).
`{ "goal": "drama artis", "maxResults": 10 }` (both optional; at most 20 picks) → the run:
```json
{ "id": "uuid", "status": "RUNNING", "goal": "drama artis", "maxResults": 10,
  "mode": null, "model": null, "startedAt": "…", "finishedAt": null,
  "steps": [], "notes": null, "llmError": null, "error": null, "count": 0, "videos": [] }
```
With an LLM (`LLM_BASE_URL` + `LLM_MODEL`), an agent calls tools at temperature
0.8 — `web_search` (`WEB_SEARCH`: `bing`, a SearXNG URL, or `off`),
`youtube_search`, `analyze_video`, `channel_videos`, `source_channels` — and
answers with picks and reasons; only videos its tools returned are accepted.
Without an LLM, or if it fails (`llmError` says why), the algorithm runs: 3
random anchor queries (the goal first), every new result analyzed, best
predicted scores kept, at most 2 per channel. Picks are stored as candidates
with `sourceMode: "auto"` and `pickedBy`: the LLM's model name, or `"algorithm"`
(picks from before this field read `"LLM"`). The UI shows it as a badge.

### `GET /api/discover/auto` · `GET /api/discover/auto/{id}`
The latest run / a run by id (404 when none). `status`: `RUNNING`, `DONE`,
`FAILED`; `mode`: `agent` or `algorithm`; `steps`: `[{ "tool", "args", "result" }]`
(e.g. `"predicted 0.81, 3 strong moments"`); when `DONE`, `videos` holds the picks
as Candidates and `notes` the agent's one-line read on what's trending.

### `GET /api/discover/candidates?status=QUEUED`
Without `status`: `NEW` + `QUEUED` of known age up to 90 days, without channels
the crawler rejected, ranked by `predictedScore` (else `relevanceScore`) plus
0.05 for a profiled source channel and 0.05 for a channel you've clipped
before (`rankScore`); rows of unknown age stay hidden. With `status`: that
status, ranked by predicted then relevance score. Returns `{ "count": n, "videos": [Candidate] }`.

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

### Source channels

The crawler (`backend/src/channels.ts`) finds long-form source channels (podcasts, talk shows,
stand-up, livestream VODs) with 12 Indonesian anchor queries, then profiles each
from its last 30 uploads. Channels averaging under 15 min, or flagged as clip
farms (≥ 70 % short or clip-titled uploads), are stored as `REJECTED`.

Channel object:
```json
{ "id": "uuid", "youtubeChannelId": "UC…", "channelName": "…", "channelUrl": "https://…",
  "primaryCategory": "PODCAST", "avgDurationSec": 3600, "medianViewCount": 50000,
  "uploadsPerWeek": 2.5, "subscriberCount": 0, "isLikelyClipperChannel": false,
  "trustScore": 0.5, "trustSamples": 0, "pollCadenceHours": 24, "status": "ACTIVE",
  "firstSeenAt": "…", "lastCrawledAt": null, "lastProfileRefreshAt": "…" }
```

#### `GET /api/discover/channels?status=REJECTED`
Without `status`: `ACTIVE` channels by trust, then median views. Returns `{ "count": n, "channels": [Channel] }`.

#### `POST /api/discover/channels/reseed`
Runs the anchor queries (about a minute) and stores unseen channels →
`{ "upserted": n, "alreadyKnown": n, "queued": n }`. Profiling runs in the
background, 6 at a time; known channels that were never profiled are queued again.

#### `POST /api/discover/channels/{id}/refresh`
Profiles one channel now → `{ "channel": Channel, "rejected": bool }`. 404 `not found`.

#### `POST /api/discover/channels/{id}/status`
`{ "status": "paused" }` (`ACTIVE`, `PAUSED`, `REJECTED`) → the updated Channel. 400 on any other value, 404 `not found`.
