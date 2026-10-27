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
                  [Worker Thread]
                        |
           +------------+------------+
           |            |            |
    [yt-dlp/ffmpeg] [Python CLI] [ffmpeg/OpenCV]
           |            |            |
      media files  transcripts   rendered clips
           |            |            |
           +------ data/ folder -----+
```

## Component Responsibilities

### Bun Backend (`backend/`)
- REST API (`src/app.ts`) + static host for `frontend/out` with SPA fallback
- Job orchestration (`src/orchestrator.ts`, `src/jobs.ts`): 9 stages, 2 pipelines
  in flight, FIFO queue (cap 50), cancel = abort signal that kills the child
  process, orphan sweep on startup + every 5 min
- Calls Python CLI scripts as subprocess with per-script timeouts (`src/runner.ts`)
- Calls yt-dlp and ffmpeg as subprocess
- SQLite for all metadata (`src/db.ts` schema + migrations, `src/store.ts` repo)
- Streams clip previews with HTTP Range support

### In the backend (Bun)
- Segmenting, clip scoring (13 weighted signals, tiers, titles; `scoring.ts`,
  `textRules.ts`), the optional LLM review (`llm.ts`, `clipReview.ts`),
  analytics, feedback learning (`learning.ts`)
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

### CLI (`cli/`)
- `sorot`: a client of the same HTTP API (import, jobs, clips, download,
  discovery) plus `up/down/logs` for the local install; compiled to one binary
  with `bun build --compile`. See [cli.md](cli.md), [integration.md](integration.md).

## Deployment

| Where | How |
|---|---|
| Windows | Docker Desktop + `scripts\start.ps1` |
| Linux, Docker | `scripts/install.sh` — compose app container, GPU via NVIDIA Container Toolkit, `restart: unless-stopped` |
| Linux, native | `scripts/install.sh --mode native` — Bun + venv on the host, systemd `sorot.service` |

See [linux-install.md](linux-install.md).

## Data Flow (Happy Path)

```
1. User pastes YouTube URL in UI
2. Frontend → POST /api/import { url }
3. Backend creates Job (status=QUEUED), saves to SQLite
4. Backend starts worker:
   a. yt-dlp downloads video → data/raw/{videoId}.mp4
   b. ffmpeg extracts audio → data/audio/{videoId}.wav
   c. Python transcribe.py → data/transcripts/{videoId}.json (or the video's YouTube captions)
   d. Bun segments the transcript → data/segments/{videoId}.json
   e. Python media_features.py measures each segment; Bun scores it (+ optional LLM review)
   f. Python render.py crops + renders each top clip → data/renders/{videoId}/clip_{rank}.mp4
   g. Python subtitle.py burns captions → data/exports/{videoId}/clip_{rank}_subtitled.mp4
   h. variations, then the analytics report (Bun)
5. Backend updates Job status=COMPLETED
6. Frontend polls GET /api/jobs/{id} and shows results
7. User previews clips, picks favorites, exports
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
| Clip editing | One-clip re-render through the same render.py/subtitle.py (`backend/src/editor.ts`) | Caption fixes and timing nudges without re-running the pipeline; edits stored on the clip (`options`, `captionWords`) |
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
| 3. Transcribe | audio WAV | faster-whisper (CUDA) | `data/transcripts/{videoId}.json` |
| 4. Segment | transcript JSON | Python segment logic | `data/segments/{videoId}.json` |
| 5. Score | segments JSON | Python scoring | updates segments JSON |
| 6. Render | raw video + segments (+ transcript) | ffmpeg: face-tracking crop / centre / blur, optional silence trim | `data/renders/clip_{rank}.mp4` |
| 7. Subtitle | render + transcript | ASS karaoke captions (libass) | `data/exports/clip_{rank}_subtitled.mp4` + `clip_{rank}.ass` |

## Error Handling

- Any pipeline stage failure → Job status = FAILED, error message stored
- Frontend shows error with retry option
- Python scripts write errors to stderr (not stdout) to keep JSON output clean
- Backend captures subprocess stdout/stderr separately

## Concurrency

- MVP: one job at a time (sequential pipeline)
- Job queue is in-memory, FIFO
- Future: could add parallel clip rendering if needed
