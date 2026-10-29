# AGENTS.md

**Sorot**: YouTube/local video → 9:16 short clips with auto-subtitles. Indonesian. Local-only, personal-use simple.

**Stack**: Bun workspace — `backend/` Bun/TS (API, orchestration, scoring, discovery, LLM/Jev/Tebar; serves the UI) · `cli/` `sorot` (Bun) · `ai-pipeline/` Python 3, media/ML only · `frontend/` Next.js 14 static export · SQLite · Docker. Specs in `docs/` (design of the creative loop: `docs/creative-loop.md`; API: `docs/api-spec.md`); history in `docs/journal/`.

**Build order (strict)**: 1.Video → 2.Audio → 3.Transcribe → 4.Segment → 5.Score → 6.Render → 7.Subtitle → 8.Variation → 9.Analytics → 10.Preview → 11.Export

## Commands
```
.\scripts\install.ps1 [-Mode native] · .\scripts\start.ps1 [-Update|-Build|-Dev] · .\scripts\stop.ps1   # Windows (user runs these)
scripts/install.sh [--mode native] [--uninstall [--purge]]                                              # Linux
sorot import <url|file> [--direction ".."] | clips | download | connect [setup|llm|jev|tebar] | accounts | publish <clip> | posts | sync | up | down | logs -f | doctor
.\scripts\verify-env.ps1 · .\scripts\e2e-test.ps1
docker compose --env-file .env.docker build --no-cache backend | up -d | --profile dev up -d | logs -f backend
bun install                                           # one lockfile (repo root)
cd backend;  bun test --coverage; bun run typecheck   # 95% line/func gate
cd frontend; bun run test;  bun run build             # jest; static UI → frontend/out (root `bun run start` serves it on :8080)
cd cli;      bun test --coverage; bun run build       # → cli/dist/sorot
cd ai-pipeline; .venv/bin/python -m pytest tests --cov=.   # Windows: .venv\Scripts\python.exe
```
Slash commands: `/research` `/plan` `/execute` `/review` `/verify` `/test`.

## Gate
100% pass, ≥ 95% coverage, zero type errors; `/test` → test-runner subagent, verdict OPEN or BLOCKED.
Tests are on point and compressed (the owner dislikes test bloat): one test per behaviour, asserting only what proves it; a new case is a table row (`test.each` / `it.each` / `parametrize`) or a line in the test that already covers that behaviour before it is a new test; shared fakes (`backend/tests/helpers.ts`: `fakeJev`, `clipAnswer`, `jevReply`, `unknownFields`; `frontend/test/fakeApi.ts`); no assertion that re-proves another.

## Rules
**Boundaries**
- Python = media/ML only (Whisper, `media_features.py`, render/subtitle/variation, captions/reframe, LightGBM); segmenting, scoring, hooks, analytics, learning, discovery, LLM/Jev/Tebar are Bun. No new Python for non-media logic. Scripts print a JSON envelope `{"success":bool,"data":{}}`, exit 0/non-zero.
- Python ports keep golden fixtures (`backend/tests/fixtures/*.json`, made by the Python originals); `pyCompat.ts` reproduces Python rounding/splitting.
- Backend runs Python via `runner.ts`: per-script timeouts (`timeoutFor` scales transcribe/media_features with length), cancel kills the whole process tree (POSIX group / `taskkill /T`). Tests inject fakes through `createApp(config, deps)` (`exec`, `runScript`, `fetch`).
- Prefer executable source over plan docs. Memory = pointers only; details go to the journal.

**Jev, LLM, Tebar** (design + measurements: `docs/creative-loop.md`)
- All optional; secrets (`LLM_API_KEY`, `JEV_API_KEY`, `TEBAR_API_KEY`) only in gitignored `.env.llm`. Also set in UI Settings / `sorot connect` → SQLite `setting` table, overrides env, read per call (no restart), keys always masked. CLI flag is `--base-url` (`--url` is the global server option).
- **Jev first** (`jevDirector.ts`, `JEV_DIRECTOR`, default on with Jev; wins over the LLM director/review): SEGMENT judges one window per sentence start (15-60 s; a sentence ends at `. ! ? …` or a ≥ 0.6 s pause) and adds the best 40 non-FAIL (`source: "jev"`), each re-cut to ~40/~55 s and asked again: the longest non-FAIL cut within 0.05 of the best wins (`growPicks`); SCORE asks the full gate questions per candidate (best 200 by rule score + every Jev pick) — `finalScore` = 0.5 Jev + 0.5 rules, verdict from the same answers; render-tier clips (≤ `MAX_RENDER_CLIPS`, else 40) get Jev's hook line and a title quoted from the clip. A teaser must beat the clip's own opening (opening ≥ 0.7 → none; else best non-ad line ≥ 0.7, or ≥ 0.5 when opening ≤ 0.3); Jev's "none" is final, the rules' hook only fills clips Jev had no line for. Jev failures → rules per clip.
- Jev has no system prompt: build every state with `jevState()` (`clipGate.ts`; `context` = task, viewer, ASR text, the fields sent). Questions: one judgment each, name the state field, no counting/timing, risks as separate Nouls (`clipGate.test.ts` + `unknownFields` enforce; `bun run jev-eval` measures). Thresholds 0.7/0.3 uncalibrated for Indonesian. Answers move ~0.04 between runs, so borderline clips flip — accepted: trust Jev, no re-asks/averaging.
- Gate (`clipGate.ts`, best ≤ 40 render-tier clips, pinned `jev-1.14.0`; `ruleAnswers()` when Jev is off/failing): verdict in code (`verdictFrom`); FAIL → SKIP, ranked last, loses overlaps; REVIEW = content risk, never auto-FAIL.
- LLM: any OpenAI-compatible endpoint; every path falls back to rules on `LlmError`. Used for post copy, auto-discover, and as director when Jev is off (`director.ts`, `LLM_DIRECTOR`: brief + own moments `source: "llm"`, field `hook_line` = line id). Every request ends with a `task` field restating job + format (a reasoning model ignored the system prompt); the review's task states "0 to 100". `LLM_MAX_TOKENS` includes reasoning; an empty answer cut by the budget or a gateway `{"error"}` in HTTP 200 is an `LlmError`; one retry on transient errors; review batches 2 at a time.
- Job option `direction` (≤ 500 chars) reaches screening (`fits_direction`), brief, picks, review and post copy. Overlaps > 50% of the shorter clip keep the better score.
- Publishing (`publisher.ts`, `tebar.ts`; UI Publish panel and `sorot publish`): draft (copy per platform, Jev copy check, platform limits) → user choices (TikTok privacy or draft mode, YouTube title + made-for-kids — never auto-filled, in the CLI too: flags or questions) → upload + `POST /v1/posts` with `Idempotency-Key`; `social_post` row + exact body saved first, so retry can't double-post. A post stays in one Tebar workspace (profile): accounts are listed per profile with the `Tebar-Profile` header (the account object has no documented profile field), and upload/post send the same header (`social_post.profile_id`). TikTok direct posts need privacy unless `video_public_only`, checked before upload. Retry of a post on Tebar = `POST /posts/{id}/retry` (failed accounts only); cancel = `DELETE`. Metrics sync (`TEBAR_SYNC_HOURS`) → `clip_feedback` → training. Polling only.
- Auto-discover web search defaults to Bing HTML (`WEB_SEARCH`); DuckDuckGo is blocked by Indonesian ISPs. Learned weights → `data/weights.json` (wins over `ai-pipeline/weights.json`).

**Pipeline & media**
- Hooks are decided in Bun (`hooks.ts`, golden port of `find_hook`); segments carry `hookStart`/`hookEnd` (absolute s, null = no replay); render.py/subtitle.py run `find_hook` only for files without the keys.
- `clipsForVideo` orders by `rank_pos` (not `rank`: SQL reserved); render.py indexes render-tier segments in file order, so render tiers come first in `scoredSegments`.
- One encode per clip: render.py `--export-dir` burns captions + music with the 9:16 render; SUBTITLE/subtitle.py only re-burn clips rendered without captions, with the same silence flags. Output folders are per video: one-pass clips in `data/exports/{videoId}/` (`data/renders/{videoId}/` only for clips rendered without captions).
- 9:16 framing crops in source pixels before scaling (`reframe.py`). `opencv-python-headless` stays `<5` (Haar `CascadeClassifier`).
- `media_features.py` samples at keyframes (`-skip_frame nokey`; 1 fps decode only for sparse-keyframe files). YouTube range imports are a stream copy (no `--force-keyframes-at-cuts`, except with YouTube captions on); a range ≥ 10% of the video downloads it whole and cuts locally (`cutRange`: copy, libx264 with captions on).
- TRANSCRIBE reuses `data/transcripts/{videoId}.json` when model/language match; scripts report `PROGRESS <n> [label]` on stderr (stage shows "label n%"). Whisper `large-v3-turbo` in Docker, per-word timestamps kept. Punctuation drift: from the first 10-min bucket with < 50% punctuated lines Whisper re-runs with a punctuated `hotwords` prompt; kept only if better punctuated and within ±20% of the words it replaces.
- CPU vs GPU keys off `WHISPER_DEVICE`: CPU renders the best `MAX_RENDER_CLIPS` (10; rest on request) and 1 pipeline; GPU renders all PRIMARY/BACKUP, 2 pipelines. CPU env: `X264_PRESET` (veryfast), `WHISPER_THREADS`, `WHISPER_BEAM_SIZE` (5), `VARIATIONS` (off). Captions/framing env: `SUBTITLE_STYLE`, `SILENCE_TRIM`, `SILENCE_GAP_SEC`, `REFRAME_MODE`.
- Editing options layer config ← job options ← clip options (`options.ts`).

**API, UI, DB**
- API JSON keys = camelCase of SQLite columns (`store.ts`); the frontend depends on them. Schema auto-creates/migrates in `db.ts` (old databases open unchanged); UUIDs as TEXT.
- UI is same-origin in prod (backend serves `frontend/out`); CORS allows only `localhost:3000` / `127.0.0.1:3000` (`next dev`) and `FRONTEND_URL`. `frontend` stays static-exportable: no API routes, rewrites, server actions, `next/image` optimization.

**Docker, release, scripts**
- Always `--env-file .env.docker`. `docker-compose.yml` is CPU-only; GPU settings live in the gitignored `docker-compose.override.yml` (written by `install.sh` / `install.ps1` / `start.ps1`). Linux machine settings: override file or `/etc/sorot/`, never tracked files.
- Image `ghcr.io/raufimusaddiq/sorot` is built by `release-image.yml` only on a published release or manual run (CPU `:latest`, GPU `:latest-cuda`; `v1.2.3` → `1.2.3`, `1.2`, `latest`); `ci.yml` tests and smoke-tests an unpushed CPU image on image-affecting changes. `SOROT_VERSION` picks the tag. Release steps: `docs/release.md`; user-facing changes go under `## [Unreleased]` in `CHANGELOG.md` as they merge.
- PowerShell: ASCII only (PS 5.1); `install.ps1` never `exit`s (runs under `irm | iex`); `$ErrorActionPreference = "Continue"`; `-UseBasicParsing` on every `Invoke-WebRequest`; capture docker output in a variable and check `$LASTEXITCODE`. `scripts/install.sh` stays shellcheck-clean.

## Git
Repo `raufimusaddiq/sorot` (public, MIT). `master` stable; features on `feat/short-description`; Conventional commits; merge `--no-ff`, never rebase shared branches. **Never** commit/push unless asked, **always** test first, **never** commit secrets. Use the `mastering-git-cli` skill.
