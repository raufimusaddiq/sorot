# Viral Clipper

AI-powered video clip maker for Indonesian TikTok content. Imports YouTube/local videos, transcribes with Whisper (GPU), segments into clips, scores for viral potential with self-learning weights, renders 9:16 vertical clips with auto-subtitles and TikTok-ready title/description.

## Stack

| Component | Tech |
|-----------|------|
| Backend API | Bun + TypeScript (`bun:sqlite`, zero runtime deps) |
| AI Pipeline | Python 3 + faster-whisper (CUDA) + OpenCV + NumPy |
| Frontend | Next.js 14, static export served by the backend |
| Database | SQLite |
| Repo | Bun workspace monorepo (`backend` + `frontend`, one `bun.lock`) |
| Deployment | Docker Compose (single app image) + NVIDIA GPU |

## Architecture

```
YouTube URL ──► Backend API ──► 11-Stage Pipeline
                                     │
                     1. Import Video (yt-dlp)
                     2. Extract Audio (ffmpeg)
                     3. Transcribe (Whisper medium, CUDA)
                     4. Segment (gap-based)
                     5. Score (11-feature multimodal formula)
                     6. Render 9:16 (face-tracking crop, optional silence trim)
                     7. Karaoke Captions (word-timed ASS, libass)
                     8. Generate Variations (zoom/crop presets)
                     9. Analytics (distribution, recommendations)
                                    │
                              Frontend UI ◄── polling
```

## Prerequisites

- Docker Desktop with WSL2 backend
- NVIDIA GPU + [Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)
- PowerShell 5.1+

## Quick Start

```powershell
# 1. Clone
git clone https://github.com/<your-user>/viral-clipper.git
cd viral-clipper

# 2. Copy env template (defaults work for Docker)
copy .env.example .env

# 3. Start everything
.\scripts\start.ps1 -Build

# 4. Open in browser — UI and API share one port
# App:    http://localhost:8080
# Health: http://localhost:8080/api/health
```

## Commands

```powershell
.\scripts\start.ps1              # start app on :8080 (cached image)
.\scripts\start.ps1 -Build       # start (rebuild image)
.\scripts\start.ps1 -Dev         # + hot-reload UI on :3000
.\scripts\stop.ps1               # stop all services
.\scripts\verify-env.ps1         # check dependencies
.\scripts\e2e-test.ps1           # run E2E test suite
```

Native dev without Docker (needs Bun 1.3+, the Python venv, ffmpeg):

```powershell
bun install                 # backend + frontend deps, one lockfile
bun run build               # static UI → frontend/out
bun run start               # backend on :8080, serves the UI
bun run dev:web             # optional: hot-reload UI on :3000
cd backend; bun test --coverage
```

## Usage

1. Open http://localhost:8080
2. Paste a YouTube URL → **Import & Process**
3. Pipeline runs all 9 stages automatically
4. Browse clips grouped by video, filter by tier (PRIMARY / BACKUP / SKIP)
5. Preview clips in-app, copy TikTok title/description, download or export with subtitles
6. Submit TikTok performance data via the **FB** button on each clip
7. After 5+ feedback records, retrain weights from the **Learning** tab

## Scoring Engine v4

Clips are scored on 11 weighted multimodal features with Indonesian keyword heuristics:

| Feature | Weight | Signal |
|---------|--------|--------|
| Hook Strength | 18% | Question/hook phrase in opening |
| Keyword Trigger | 9% | Indonesian viral keywords |
| Novelty | 9% | Numbers, proper nouns, step/surprise words |
| Clarity | 10% | Duration + context words |
| Emotional Energy | 9% | Audio RMS energy (60%) + text emotion (40%) |
| Text Sentiment | 5% | Indonesian positive/negative word polarity |
| Pause Structure | 7% | Actual silence gaps from transcript |
| Face Presence | 10% | Face (majority of 5 full-res frames) + smile detection |
| Scene Change | 8% | Histogram diff + color brightness/saturation |
| Topic Fit | 8% | Niche keyword match |
| History Score | 7% | Similar past clips via feedback lookup |

Boosts: sharp questions, opinion conflicts, numbered lists, emotional moments, conversational tone
Penalties: slow openings, excessive silence, generic content, no face

Tiers: **PRIMARY** (>= 0.80), **BACKUP** (>= 0.65), **SKIP** (< 0.65)

### Self-Learning

Weights are externalized in `weights.json`. The system learns from real TikTok performance data:

1. Post a clip to TikTok, enter views/likes/comments/shares/saves via the feedback form
2. System calculates a viral score from your metrics
3. After 5+ feedback records, click **Retrain Weights** in the Learning tab
4. Pearson correlation per feature + EMA blending (alpha=0.3) updates weights
5. Next scoring run uses the improved weights automatically

## Captions & Framing

- **Karaoke captions**: Whisper word timestamps → ASS captions where the
  spoken word lights up. Presets `default`, `hormozi`, `storyteller`,
  `cinematic` (`SUBTITLE_STYLE`). Each export keeps its `clip_N.ass` so
  misheard names can be fixed by hand and re-burned.
- **Face-tracking crop**: the 9:16 window follows the people on screen and
  cuts cleanly when the shot changes; falls back to a centre crop when no face
  is found. `REFRAME_MODE=blur` shows the whole frame over a blurred fill.
- **Silence trim** (opt-in, `SILENCE_TRIM=true`): pauses are cut out of video
  and audio in one pass, and captions are re-timed to match.

## Title & Description Generation

Every scored clip gets auto-generated TikTok-ready copy:

- **Title**: First question or hook phrase + relevant hashtags (max 100 chars)
- **Description**: Hook line + content summary + 7 hashtags + CTA

One-click **Copy** button on each clip card for pasting directly into TikTok.

## Project Layout

```
├── backend/             Bun/TS API + pipeline orchestrator + static UI host
│   ├── src/             app (routes), orchestrator, jobs, runner, store, db
│   ├── tests/           bun test suites (fakes for Python/ffmpeg/yt-dlp)
│   └── Dockerfile       CUDA base + Bun + Python + ffmpeg + built UI
├── ai-pipeline/         Python CLI scripts (stages 1-9)
│   ├── transcribe.py    Whisper transcription
│   ├── segment.py       Gap-based segmentation
│   ├── score.py         11-feature multimodal scoring + title/description
│   ├── render.py        9:16 render (face-tracking crop, silence trim)
│   ├── reframe.py       Face track → per-frame crop / blur fill
│   ├── subtitle.py      Karaoke caption burn (ASS + libass)
│   ├── captions.py      Word timing, ASS presets, silence intervals
│   ├── variation.py     Zoom/crop variation generator
│   ├── analytics.py     Distribution + recommendations
│   ├── feedback.py      Viral score calculation from TikTok metrics
│   ├── learn_weights.py Pearson correlation + EMA weight training
│   ├── weights.json     Externalized scoring weights
│   └── tests/           175 tests
├── frontend/            Next.js 14 web UI (output: 'export' → frontend/out)
│   └── src/app/         Video grouping, clip cards, feedback, learning tab
├── scripts/             PowerShell automation
├── docs/                Architecture & API specs
├── package.json         Bun workspace root
├── docker-compose.yml   App service (+ dev/test/lint profiles)
└── AGENTS.md            AI agent instructions & conventions
```

## Configuration

Copy `.env.example` to `.env` for local overrides. Docker uses `.env.docker` (committed defaults).

| Variable | Default | Description |
|----------|---------|-------------|
| `WHISPER_MODEL` | medium | Whisper model size |
| `WHISPER_DEVICE` | cuda | cuda or cpu |
| `WHISPER_LANGUAGE` | id | Language code (Indonesian) |
| `NICHE_KEYWORDS` | rahasia,penting,trik,solusi,tip | Scoring keywords |
| `SUBTITLE_STYLE` | default | Caption preset: default, hormozi, storyteller, cinematic |
| `SILENCE_TRIM` | false | Cut pauses out of clips (video, audio and captions stay in sync) |
| `SILENCE_GAP_SEC` | 0.6 | Pause length that gets cut when `SILENCE_TRIM=true` |
| `REFRAME_MODE` | face | 9:16 framing: `face` (crop follows faces), `center`, or `blur` (whole frame over a blurred fill) |

## API

| Method | Path | Purpose |
|--------|------|---------|
| GET | /api/health | Health check |
| POST | /api/import | Import video |
| POST | /api/process | Start pipeline |
| GET | /api/jobs | List all jobs |
| GET | /api/jobs/{id} | Job + stage statuses |
| GET | /api/videos | List all videos |
| GET | /api/videos/{id}/clips | Clips for video |
| GET | /api/clips/{id} | Clip + score breakdown |
| POST | /api/clips/{id}/feedback | Submit TikTok performance data |
| POST | /api/feedback/train | Retrain scoring weights |
| GET | /api/feedback/weights | Current weights + learning stats |
| GET | /api/clips/{id}/preview | Stream rendered clip |
| GET | /api/clips/{id}/export | Download exported clip |

## License

Private project. All rights reserved.
