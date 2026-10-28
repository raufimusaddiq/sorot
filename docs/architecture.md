# Architecture

## Overview

Minimal local architecture: one Bun process serves the API **and** the
statically-exported UI on :8080, and runs the pipeline in-process (bounded
async queue), shelling out to Python / ffmpeg / yt-dlp.

```
[Static Next.js UI] ─┐
[sorot CLI]  ────────┼─ HTTP ─→  [Bun API :8080]  →  [SQLite (bun:sqlite)]
[scripts / other apps]┘
                        |
                  [Pipeline queue]
                        |
           +------------+------------+
           |            |            |
    [yt-dlp/ffmpeg] [Python CLI] [ffmpeg/OpenCV]
           |            |            |
      media files  transcripts   rendered clips
           |            |            |
           +------ data/ folder -----+
```

Optional HTTP services, called only by the Bun process (each is off until it
has its URL/model/key): an **LLM** (any OpenAI-compatible endpoint), **Jev**
(TypeSafe `/v1/systemone`) and **Tebar** (`api.tebar.app/v1`). Without them
the pipeline falls back to rules and clips are posted by hand. Design:
[creative-loop.md](creative-loop.md).

## Component Responsibilities

### Bun Backend (`backend/`)
- REST API (`src/app.ts`) + static host for `frontend/out` with SPA fallback
- Job orchestration (`src/orchestrator.ts`, `src/jobs.ts`): 9 stages, 1 pipeline
  in flight on a CPU / 2 on a GPU (`MAX_CONCURRENT_PIPELINES`), FIFO queue
  (cap 50), cancel = abort signal that kills the child process, orphan sweep
  on startup + every 5 min
- Calls Python CLI scripts as subprocess with per-script timeouts (`src/runner.ts`)
- Calls yt-dlp and ffmpeg as subprocess
- SQLite for all metadata (`src/db.ts` schema + migrations, `src/store.ts` repo)
- Streams clip previews with HTTP Range support

### In the backend (Bun)
- Segmenting, clip scoring (13 weighted signals, tiers, titles; `scoring.ts`,
  `textRules.ts`), analytics, feedback learning (`learning.ts`)
- Jev first (`jev.ts`, `jevDirector.ts`; Jev connected and `JEV_DIRECTOR` on):
  judges a window per sentence start in SEGMENT, scores the candidates 50/50
  with the rules in SCORE (the same answers give the gate verdict), and picks
  hook lines and quote titles for the clips that render
- LLM (`llm.ts`): when Jev isn't directing, the director (`director.ts`: video
  brief + its own moments, `LLM_DIRECTOR`) and the review blended 50/50 with
  the rules (`clipReview.ts`); in both cases the post copy and ✨ auto-discover
- Quality gate (`clipGate.ts`): PASS / REVIEW / FAIL before render, from Jev or
  the same questions answered by text rules; FAIL → tier SKIP, ranked last
- Hooks (`hooks.ts`): every clip's `hookStart`/`hookEnd` is decided here;
  render.py / subtitle.py only replay it
- Publishing (`publisher.ts`, `tebar.ts`): drafts copy, posts through Tebar,
  and every `TEBAR_SYNC_HOURS` pulls post metrics into `clip_feedback`
- Connections (`settings.ts`): LLM / Jev / Tebar URL, model, key and on/off,
  saved in the `setting` table over the env from the studio's Settings or
  `sorot connect`; applied without a restart
- Discovery: yt-dlp feeds (`youtube.ts`), whole-caption scoring
  (`captionAnalysis.ts`), channel crawler (`channels.ts`), auto-discover agent
  with web search (`discoveryAgent.ts`, `webSearch.ts`)

### Python media pipeline (`ai-pipeline/`)
- Only what needs Python's media/ML libraries: `transcribe.py` (faster-whisper),
  `media_features.py` (audio energy/onsets, faces, scene change, motion),
  `render.py`, `subtitle.py`, `variation.py`, `captions.py`, `reframe.py`, and
  the optional LightGBM model (`train_scorer.py`, `predict_supervised.py`)
- Called by the Bun backend as subprocesses (`backend/src/runner.ts`)
- **Input**: file paths as args · **Output**: JSON envelope on stdout · exit 0 = success
- Uses CUDA for faster-whisper and NVENC when available

What is a model and what is a rule: [ai-audit.md](ai-audit.md).

### Next.js Frontend (`frontend/`)
- `output: 'export'` → plain HTML/JS in `frontend/out`, served by the backend
  (same origin, no CORS). `next dev` on :3000 is optional for hot reload.
- `/` is the landing page (what Sorot is, a live caption demo, install facts);
  `/studio` is the app below. Both share the brand tokens in `tailwind.config.js`.
- Video input (paste URL or upload file)
- Job status display
- Clip list with scores and ranking
- Video preview player
- Export/download controls
- Settings (LLM / Jev / Tebar connections) and a Publish panel per clip

### CLI (`cli/`)
- `sorot`: a client of the same HTTP API (import, jobs, clips, download,
  discovery) plus `up/down/logs` for the local install; compiled to one binary
  with `bun build --compile`. See [cli.md](cli.md), [integration.md](integration.md).

## Deployment

| Where | How |
|---|---|
| Windows, Docker | `scripts\install.ps1` — Docker Desktop pulls `ghcr.io/raufimusaddiq/sorot`; `scripts\start.ps1` / `stop.ps1` |
| Windows, native | `scripts\install.ps1 -Mode native` — Bun + Python venv + winget ffmpeg, Startup-folder autostart, settings in `.env.native` |
| Linux, Docker | `scripts/install.sh` — compose app container, GPU via NVIDIA Container Toolkit, `restart: unless-stopped` |
| Linux, native | `scripts/install.sh --mode native` — Bun + venv on the host, systemd `sorot.service` |

See [linux-install.md](linux-install.md).

## Data Flow (Happy Path)

```
1. User pastes YouTube URL in UI
2. Frontend → POST /api/import { url }
3. Backend creates Job (status=QUEUED), saves to SQLite
4. Backend starts worker:
   a. yt-dlp downloads video → data/raw/{videoId}.mp4 (a time range: only that section, stream-copied)
   b. ffmpeg extracts audio → data/audio/{videoId}.wav
   c. Python transcribe.py → data/transcripts/{videoId}.json (or the video's YouTube captions;
      a retry reuses a transcript made with the same model and language)
   d. Bun segments the transcript → data/segments/{videoId}.json (rule windows, plus Jev's
      or the LLM director's picks when connected)
   e. Python media_features.py measures each segment; Bun scores it (50/50 with Jev, or with
      the LLM review), runs the quality gate and decides each clip's hook line
   f. Python render.py crops, renders and burns captions + music in one encode per top clip
      (every PRIMARY/BACKUP clip on a GPU, the best MAX_RENDER_CLIPS = 10 on a CPU; the rest
      render on request)
      → data/exports/{videoId}/clip_{rank}_subtitled.mp4 (+ clip_{rank}.ass)
   g. SUBTITLE: subtitle.py re-burns only clips rendered without captions (old jobs, retried)
   h. variations, then the analytics report (Bun)
5. Backend updates Job status=COMPLETED
6. Frontend polls GET /api/jobs/{id} and shows results
7. User previews clips, picks favorites, exports
8. Optional: publishes a clip through Tebar; the metrics sync feeds clip_feedback
```

## Tech Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Architecture | One Bun process (API + UI + queue) | Personal use, one container, simplest to build and debug |
| Backend runtime | Bun + TypeScript | Same language as the UI, zero runtime deps, built-in SQLite; replaced Spring Boot (JVM) |
| Repo layout | Bun workspace monorepo | One lockfile + install for backend and frontend |
| Backend↔Python bridge | CLI subprocess + JSON | No extra service, no network dependency, simple |
| DB | SQLite | Zero config, local-only, file-based |
| GPU | CUDA | Available; significantly speeds up transcription |
| Transcription | faster-whisper | Best local Whisper implementation, CUDA support |
| Frontend | Next.js | User preference, good DX for interactive UIs |
| Video download | yt-dlp | Standard tool, handles all YouTube formats |
| Video processing | FFmpeg + OpenCV | FFmpeg for codec/crop, OpenCV for face detection/crop |
| Subtitle burn-in | ASS + libass (`ffmpeg -vf ass=`) | Real per-word timing from Whisper, active-word highlight, editable `.ass` kept next to each export |
| 9:16 framing | Face track (Haar/MediaPipe at 2 fps) → hysteresis → per-frame `crop` x-expression; `blur` fill option | Follows the speaker on podcasts and cuts cleanly between shots; centre-crop fallback keeps renders safe (`ai-pipeline/reframe.py`) |
| OpenCV version | `opencv-python-headless>=4.8,<5` | OpenCV 5 removed the Haar `CascadeClassifier`; unpinned rebuilds silently lost face detection |
| Output folders | `data/renders/{videoId}/`, `data/exports/{videoId}/` | Clip files are named by rank; the old shared folder let every new video overwrite older videos' clips |
| Clip editing | One-clip re-render through the same one-pass render.py (`backend/src/editor.ts`) | Caption fixes and timing nudges without re-running the pipeline; edits stored on the clip (`options`, `captionWords`) |
| Silence trim | ffmpeg `select`/`aselect` from transcript gaps | One pass, no re-transcribe; render and subtitle derive identical keep-intervals (`ai-pipeline/captions.py`) |
| Content language | Indonesian | Target audience is Indonesian short-form viewers |
| CLI | Bun-compiled single binary over the HTTP API | No runtime to install; same API as the UI, so scripts and the UI never disagree |
| Linux install | One bash script, Docker or native | Docker is the reproducible default; native avoids Docker on small/headless boxes |

## Pipeline Stages

Each stage reads from `data/` subfolder and writes output to the next subfolder. A job tracks which stage it's on.

| Stage | Input | Process | Output |
|-------|-------|---------|--------|
| 1. Import | URL or file path | yt-dlp / file copy | `data/raw/{videoId}.mp4` |
| 2. Audio | raw video | ffmpeg extract | `data/audio/{videoId}.wav` |
| 3. Transcribe | audio WAV | faster-whisper (CUDA or CPU) | `data/transcripts/{videoId}.json` |
| 4. Segment | transcript JSON | Bun rule windows (`segments.ts`) + Jev or LLM director picks | `data/segments/{videoId}.json` |
| 5. Score | segments JSON | `media_features.py`, then Bun: rules (+ Jev or LLM review), quality gate, hooks | updates segments JSON, `clip` rows |
| 6. Render | raw video + segments + transcript | ffmpeg, one encode: face-tracking crop / centre / blur, silence trim, ASS karaoke captions, music | `data/exports/{videoId}/clip_{rank}_subtitled.mp4` + `clip_{rank}.ass` |
| 7. Subtitle | old-style renders only | re-burns captions on clips rendered without them | same |

## Error Handling

- Any pipeline stage failure → Job status = FAILED, error message stored
- Frontend shows error with retry option
- Python scripts write errors to stderr (not stdout) to keep JSON output clean
- Backend captures subprocess stdout/stderr separately

## Concurrency

- `MAX_CONCURRENT_PIPELINES` jobs at a time (default 1 on a CPU, 2 on a GPU)
- Job queue is in-memory, FIFO (`PIPELINE_QUEUE_CAPACITY`, default 50)
- Future: could add parallel clip rendering if needed
