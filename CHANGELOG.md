# Changelog

What changed in each Sorot release. Versions follow [Semantic Versioning](https://semver.org/);
[docs/release.md](docs/release.md) says what counts as major, minor or patch, and how to cut a release.
Each version is also a Docker image tag: `v1.0.0` → `ghcr.io/raufimusaddiq/sorot:1.0.0` (CPU) and `:1.0.0-cuda` (NVIDIA).

## [Unreleased]

## [1.0.0] — 2026-10-29

First release. Sorot turns long YouTube or local videos into vertical 9:16 clips with word-timed captions,
built for Indonesian and running on your own machine. Jev, an LLM and Tebar are optional: without them,
rules decide.

Images: `ghcr.io/raufimusaddiq/sorot:1.0.0` (CPU) · `:1.0.0-cuda` (NVIDIA GPU). `:latest` and `:latest-cuda`
now point here.

![Sorot landing page](https://raw.githubusercontent.com/raufimusaddiq/sorot/v1.0.0/docs/screenshots/landing.png)

| Studio: import with options | Settings: LLM, Jev and Tebar |
|---|---|
| ![Studio import window](https://raw.githubusercontent.com/raufimusaddiq/sorot/v1.0.0/docs/screenshots/studio.png) | ![Settings windows](https://raw.githubusercontent.com/raufimusaddiq/sorot/v1.0.0/docs/screenshots/settings.png) |

Timings below were each measured once, on the machine named in `docs/journal/`; yours will differ.

### Import and transcription
- YouTube URL or local file, whole or a time range (`--from 13:25 --to 25:00`). A short range is copied
  out of the stream (no re-encode); a range of at least 10% of the video downloads the whole video and
  cuts it locally, which is faster than YouTube's throttled section download (13:25–25:00: 356 s → 199 s).
- faster-whisper `large-v3-turbo` with per-word timestamps, or the video's uploaded YouTube captions.
  Progress shows as "Transcribing 37%". A retry reuses the saved transcript.
- If Whisper stops writing punctuation partway through a video, Sorot re-runs it from that point and
  keeps the re-run only if it is better punctuated and close in word count ("Re-transcribing
  (punctuation lost) n%").

### Finding and scoring clips
- 13 weighted signals (hook, keywords, novelty, clarity, energy, sentiment, pauses, faces, scene changes,
  topic fit, history, motion, audio onsets) rank every moment PRIMARY (≥ 0.78) / BACKUP (≥ 0.63) / SKIP.
  Viral keywords count at word starts, with Indonesian affixes (`rahasianya`, `berbahaya`), so `lu` no
  longer counts inside `selalu` or `dulu`.
- **Jev first** (optional, [TypeSafe](https://docs.typesafe.ai)): Jev judges a window at every sentence
  start and keeps the best 40. Each pick is then re-cut to ~40 s and ~55 s, and the longest cut Jev still
  rates within 0.05 of the best wins, so picks are not all ~25 s. The candidates Jev scores (up to 200)
  get half Jev, half formula. Clips that render get Jev's hook line and a title quoted from the clip.
- **LLM director** when Jev is off: reads the transcript, writes a brief, picks its own moments and hooks.
- **Direction** at import ("only the funny parts", ≤ 500 characters) steers Jev or the LLM.
- **Quality gate** before render: PASS / REVIEW (content risk, you decide) / FAIL (held back, renderable on
  request). Jev answers when connected, text rules otherwise.

### Render, captions, editing
- One encode per clip: 9:16 crop, captions and music burned in together; NVENC on NVIDIA GPUs.
- Face-tracking crop that follows the speaker and cuts on scene changes (`face`, `center`, `blur`).
- Karaoke captions in 4 styles: `default`, `hormozi`, `storyteller`, `cinematic`.
- Silence trim (video, audio and captions), hook replayed first, background music that ducks under speech.
- Edit a clip's timing, a word or its style, and re-render just that clip.
- On a CPU: the 10 best clips render (`MAX_RENDER_CLIPS`), the rest are one **Render** click away, and
  one video is processed at a time. A GPU renders every PRIMARY/BACKUP clip, two videos at a time.

### Publishing and learning
- Publish through [Tebar](https://tebar.app) (paid plan) from the studio or `sorot publish`.
  - Pick accounts, grouped by Tebar workspace. The LLM writes copy per platform, Jev checks it, and you
    edit it.
  - You choose the TikTok privacy level (or send the clip as a TikTok draft) and YouTube's title and
    "made for kids". These are never filled in automatically.
  - Post now or schedule. Retry only the failed accounts, or cancel a scheduled post.
- Views, likes, comments, shares and saves sync from Tebar every 6 h (`TEBAR_SYNC_HOURS`), or you type
  them in. After 5+ results, **Retrain** re-fits the scoring weights (`data/weights.json`).

### Finding source videos
- Auto-discover: an LLM agent reads what is trending, searches YouTube (web search via Bing by default),
  reads captions and picks long-form sources with reasons. Without an LLM it falls back to scored
  searches.
- Whole-video caption scoring, search, trending, and a channel crawler that rejects clip farms.

### Studio, CLI, API
- Studio at `http://localhost:8080/studio` (UI and API on one port); landing page at `/`.
- **Settings** (studio) and `sorot connect` / `sorot connect setup` hold the LLM, Jev and Tebar connections.
  They are saved in the database, override `.env`, take effect without a restart, and keys are always
  masked.
- `sorot` CLI: import, clips, download, re-render, discover, connect, accounts, publish, posts, sync,
  up/down/logs, doctor. `--json` for scripts, `--url` / `SOROT_URL` for another machine.
  `sorot --version` prints `1.0.0`.
- HTTP API: [docs/api-spec.md](docs/api-spec.md).

### Install
- Images on GHCR: CPU (`:latest`) and NVIDIA CUDA (`:latest-cuda`), `linux/amd64`.
- Windows: one-line installer, Docker Desktop or native (no Docker). Linux: `scripts/install.sh`, Docker
  or native with systemd. Docker Compose by hand on any OS. macOS via Homebrew (manual, CPU). CLI-only
  binary.

### Since the pre-release image
Installs made before this release ran a `:latest` built by hand from PR #15 (`sha-1d5e964`, 2026-10-28).
1.0.0 adds:
- #17 — Faster CPU rendering.
  - One-pass render with captions and music.
  - Whisper on every core.
  - ffmpeg killed on cancel.
  - 4-core benchmark: a 30 s clip took 168 s before, 46 s after.
- #18 — Usable on 4 vCPU or fewer.
  - Visual signals are sampled at keyframes. One hour of video: 121 s before (visual signals silently
    lost), 32 s after.
  - On a CPU: the 10 best clips render, and one pipeline runs at a time.
  - Transcript reuse, transcription progress, and range imports copied instead of re-encoded.
- #19 — Jev-first creative loop, LLM director, quality gate, Tebar publishing, connection settings in
  the studio and CLI.
- #20 — Publishing from the CLI, Tebar account picker by workspace, TikTok draft or direct post,
  retry/cancel posts, `sorot connect setup`, `sorot doctor` checks connections.
- #21 — Long YouTube range imports download whole and cut locally.
- #22 — Jev picks can run to 60 s; a ≥ 0.6 s pause ends a sentence.
- #23, #24 — Whisper re-run where a transcript lost its punctuation, with a word-count guard and its
  own progress line.
- #25 — Fixes found by checking the docs against the code:
  - Keyword matching (above), with the tier cutoffs recalibrated to 0.78 / 0.63.
  - A trained LightGBM model gets its features in the order it was trained with.
  - `sorot restart` (Docker) applies `.env.docker` changes.
  - The Linux installer keeps the installed mode on a re-run.
  - `WHISPER_MODEL` defaults to `large-v3-turbo` when unset.
- #16 — README.

### Upgrading
- **Docker on Windows:** `.\scripts\start.ps1 -Update`, or re-run the installer.
- **Linux installer** (Docker or native): `git pull && scripts/install.sh`.
- **Docker by hand:** `docker compose --env-file .env.docker pull backend && docker compose --env-file .env.docker up -d backend`.
- **Native Windows:** re-run the installer with `-Mode native`. **macOS:** `git pull`, re-run `pip install` and
  `bun install && bun run build`, restart.
- **CLI:** the Linux installer rebuilds it; elsewhere `cd cli && bun run build`.
- Your `data/` folder, database and learned weights are kept. The database schema migrates itself on
  start. The Whisper model stays in the `hf-cache` volume.
- To stay on this version, set `SOROT_VERSION=1.0.0` in `.env.docker`.
- Clip scores come out a little lower, and the tier cutoffs moved with them: PRIMARY ≥ 0.78 and BACKUP ≥
  0.63 (were 0.80 / 0.65). The keyword signal used to match nearly every sentence (`lu` inside `selalu`),
  and fixing it lowered rule scores by 0.024 on average. On the 175 segments of the scoring test videos, the
  new cutoffs give the same tier mix as before (121 SKIP, 49 BACKUP, 5 PRIMARY); 171 of 175 keep their
  tier. With Jev connected the score drop is halved, so tiers there come out slightly more generous.
- New optional settings since the pre-release image. All have defaults, so nothing is required:
  - Connections: `JEV_API_KEY`, `JEV_MODEL`, `JEV_URL`, `JEV_DIRECTOR`, `LLM_DIRECTOR`, `LLM_MAX_TOKENS`,
    `TEBAR_API_KEY`, `TEBAR_SYNC_HOURS`.
  - CPU tuning: `MAX_RENDER_CLIPS`, `WHISPER_THREADS`, `WHISPER_BEAM_SIZE`, `X264_PRESET`.
  - `MAX_CONCURRENT_PIPELINES` now defaults to 1 on a CPU.
  - `VARIATIONS` now defaults to off: the zoom-preset copies are no longer made.
  - API keys go in the gitignored `.env.llm`, never in `.env.docker`.

### Known limitations
- The native Windows installer and the macOS steps have not been tested on real machines.
- Images are `linux/amd64` only. On Apple Silicon, use Homebrew.
- Jev's 0.7 / 0.3 thresholds are not calibrated for Indonesian. Answers move about 0.04 between runs, so
  clips near a cutoff can flip.
- The punctuation re-run's ±20% word-count check has not yet been measured on real Whisper output.
- Clip variations (`VARIATIONS`, off by default) are not shown in the studio.
- Tebar is polled; there is no webhook. Its comment inbox is not supported yet.
- The clip score is a hand-tuned formula; a trained model (LightGBM) is only worth it after 200+ real
  results.
- Downloading or clipping videos is subject to platform terms and creators' rights.

[Unreleased]: https://github.com/raufimusaddiq/sorot/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/raufimusaddiq/sorot/releases/tag/v1.0.0
