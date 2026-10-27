# AGENTS.md

## What
YouTube/local video → 9:16 TikTok clips with auto-subtitles. Indonesian language. Local-only.

## Stack
Bun workspace monorepo: Bun/TypeScript backend + Python 3 CLI + Next.js 14 (static export) + SQLite + Docker

## Layout
`backend/` Bun/TS API, orchestration, scoring, discovery, LLM (also serves the UI) · `ai-pipeline/` Python media/ML only · `frontend/` Next.js static export · `cli/` `vclip` client · `data/` media · `docs/` specs

## Build Order (strict)
1.Video → 2.Audio → 3.Transcribe → 4.Segment → 5.Score → 6.Render → 7.Subtitle → 8.Variation → 9.Analytics → 10.Preview → 11.Export

## Commands
### Start/Stop (user runs these)
```
.\scripts\start.ps1          # start app on :8080 (cached image)
.\scripts\start.ps1 -Build   # start app (rebuild image)
.\scripts\start.ps1 -Dev     # + hot-reload UI on :3000
.\scripts\stop.ps1           # stop all services
```

### Linux install / CLI
```
scripts/install.sh                 # Docker install (or --mode native: systemd); --uninstall [--purge]
vclip import <url|file> | clips <video> | download --video <video> | up | down | logs -f | doctor
cd cli; bun test --coverage        # CLI tests (95% gate); bun run build → cli/dist/vclip
```

### Verify
```
.\scripts\verify-env.ps1     # check all dependencies
```

### E2E Testing
```
.\scripts\e2e-test.ps1       # run full E2E suite
```

### Docker
```
docker compose --env-file .env.docker build --no-cache backend   # API + static UI + pipeline
docker compose --env-file .env.docker up -d
docker compose --env-file .env.docker --profile dev up -d         # + dev UI on :3000
docker compose --env-file .env.docker --profile dev down
docker compose --env-file .env.docker logs -f backend
```

### Backend / Frontend (Bun workspace, run from repo root)
```
bun install                          # one lockfile for backend + frontend
cd backend; bun test --coverage      # backend tests (95% line/func threshold)
cd backend; bun run typecheck        # tsc --noEmit
cd frontend; bun run test            # jest
bun run build                        # static UI → frontend/out
bun run start                        # backend on :8080, serves frontend/out
```

### Python Tests
```
cd ai-pipeline
.venv\Scripts\python.exe -m pytest tests\test_pipeline.py -v --cov=. --cov-report=term-missing
```

### Slash Commands
/research · /plan · /execute · /review · /verify · /test

## Key Rules
- Python scripts: JSON stdout envelope `{"success":bool,"data":{}}`, exit 0/non-zero
- When code exists, prefer executable source over plan docs
- Keep it personal-use simple
- **KEEP MEMORY LEAN**: details → journal, memory = pointers only
- Python is only for media/ML (Whisper, `media_features.py`, render/subtitle/variation, captions/reframe, LightGBM); segmenting, scoring rules, analytics, feedback learning, discovery and the LLM live in Bun. Don't add new Python for non-media logic
- Ports from Python keep golden fixtures (`backend/tests/fixtures/*.json`, generated from the Python originals); `pyCompat.ts` reproduces Python rounding/splitting
- LLM is optional: any OpenAI-compatible endpoint via `LLM_BASE_URL` + `LLM_MODEL`; every LLM path must fall back to the rules on `LlmError`. Secrets (`LLM_API_KEY`) go in gitignored `.env.llm`, never `.env.docker`
- Web search for auto-discover defaults to Bing HTML (`WEB_SEARCH`): DuckDuckGo is blocked by Indonesian ISPs
- Learned feature weights are written to `data/weights.json` (wins over shipped `ai-pipeline/weights.json`)
- Backend shells out to Python via `backend/src/runner.ts` (per-script timeouts, abort-on-cancel); tests inject fakes via `createApp(config, deps)` (`exec`, `runScript`, `fetch`)
- UI is same-origin in prod (backend serves `frontend/out`); CORS in `backend/src/app.ts` allows `localhost:3000` only for `next dev`
- `frontend` must stay static-exportable: no API routes, rewrites, server actions or `next/image` optimization
- API JSON keys = camelCase of SQLite columns (`backend/src/store.ts`); the frontend depends on them
- `docker-compose.yml` uses `.env.docker` — always pass `--env-file .env.docker`
- PowerShell scripts: `$ErrorActionPreference = "Continue"` (NOT "Stop" — docker stderr crashes it)
- Use `-UseBasicParsing` on all `Invoke-WebRequest` calls in PowerShell
- Capture docker output to variable, check `$LASTEXITCODE` after, not via pipe
- `clip.rank_pos` not `rank` (SQL reserved word)
- Whisper model: `large-v3-turbo` in Docker (`WHISPER_MODEL`); transcripts keep per-word timestamps (`segment.words`)
- `opencv-python-headless` must stay `<5` — OpenCV 5 dropped the Haar `CascadeClassifier` used by face scoring and `reframe.py`
- Render/export folders are per video (`data/renders/{videoId}/`): clip files are named by rank, so a shared folder overwrote other videos' clips
- Editing options layer config defaults ← job options (import) ← clip options (editor); see `backend/src/options.ts`
- Captions/framing env: `SUBTITLE_STYLE`, `SILENCE_TRIM`, `SILENCE_GAP_SEC`, `REFRAME_MODE` (see README); render.py and subtitle.py must get the same silence flags
- Python venv at `ai-pipeline/.venv`
- `scripts/install.sh` must stay shellcheck-clean; Linux machine settings go in the gitignored `docker-compose.override.yml` (Docker) or `/etc/viralclip/` (native), never in tracked files
- Schema auto-creates + migrates in `backend/src/db.ts` (compatible with the old Java-era DB file)
- SQLite TEXT for UUIDs

## Gate Policy
100% pass + ≥95% coverage + zero type errors. `/test` delegates to test-runner (zen/minimax-m2.5). Binary: OPEN or BLOCKED.

## Workflow
1. User imports YouTube URL → backend downloads → runs 9-stage pipeline
2. User sees progress in real-time (polling `/api/jobs/{id}`)
3. Completed clips shown grouped by source video
4. User can preview, download, export individual clips
5. All state persists in SQLite — refresh does not lose data
6. Frontend loads history on mount from `GET /api/jobs` and `GET /api/videos`

## API Endpoints
| Method | Path | Purpose |
|--------|------|---------|
| GET | /api/health | Health check |
| POST | /api/import | Import video (url or localPath) |
| POST | /api/process | Start pipeline for videoId |
| GET | /api/jobs | List all jobs |
| GET | /api/jobs/{id} | Job detail + stage statuses |
| POST | /api/jobs/{id}/retry | Retry failed job |
| GET | /api/videos | List all videos |
| GET | /api/videos/{id} | Video detail |
| DELETE | /api/videos/{id} | Delete video |
| GET | /api/videos/{id}/clips | List clips for video |
| GET | /api/clips/{id} | Clip detail + score breakdown |
| POST | /api/clips/export | Export clips by IDs |
| GET | /api/clips/{id}/captions | Caption words for the editor |
| POST | /api/clips/{id}/rerender | Re-render one clip (timing, options, caption fixes) |
| GET | /api/options | Editing choices + defaults |
| GET | /api/music | Tracks in data/music |
| GET | /api/clips/{id}/preview | Stream rendered clip |
| GET | /api/clips/{id}/export | Download exported clip |
| POST | /api/discover/auto | ✨ Auto-discover run (LLM agent or algorithm), background |
| GET | /api/discover/auto[/{id}] | Auto-discover progress / picks |
| GET | /api/discover/candidates | Ranked candidates with `why` reasons |

## Git Strategy
- **Repo**: `raufimusaddiq/viral-clipper` (private monorepo)
- **Branch**: `master` stable. Feature: `feat/short-description`
- **Commit**: Conventional — `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`
- **Merge**: `--no-ff` always. Never rebase shared branches.
- **NEVER** commit/push unless user asks. **ALWAYS** test first. **NEVER** commit secrets.
- Git skill installed (`mastering-git-cli`) — use it for all git operations.

## See journal for: architecture, stack, docker, scoring, decisions, session history
