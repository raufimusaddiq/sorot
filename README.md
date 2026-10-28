# 🎬 Sorot

> **Drop in a 2-hour podcast. Get back the 60 seconds people will actually watch.** ✂️🔥

**Sorot** (Indonesian for *spotlight*) turns long YouTube or local videos into vertical **9:16 clips** — transcribed, scored, framed on the speaker, captioned word by word, with a ready-to-paste title. Built for **Indonesian**, runs **100% locally**. No uploads, no subscriptions, no watermark. 🏠

```
📺 video  →  🎙️ Whisper  →  🧠 scoring (+ optional LLM)  →  📱 9:16 render  →  💬 karaoke captions  →  🚀 post-ready clips
```

---

## ✨ What it does

| | |
|---|---|
| 🎙️ **Hears every word** | faster-whisper `large-v3-turbo` with word timestamps — or the video's own YouTube captions |
| 🧠 **Finds the gold** | 13 weighted signals (hooks, keywords, energy, faces, motion…) rank every moment **PRIMARY / BACKUP / SKIP** |
| 🤖 **Optional LLM** | Ollama, Groq, OpenRouter or OpenAI writes copy per platform and runs auto-discover; without Jev it also directs — reads the whole video, picks its own moments and hooks, follows your direction ("only the funny parts") — off by default |
| 🚦 **Jev picks and gates** | [Jev](https://docs.typesafe.ai) answers fixed yes/no questions about every candidate moment (hook, needs context, ending, filler, payoff, risks, fits your direction), then picks the hook line and a title quoted from the clip — in seconds. Without it the LLM director (if any) or the rules decide |
| 🚀 **Publish via Tebar** | Post to TikTok, Instagram, YouTube, Threads… through [Tebar](https://tebar.app) and pull views/likes back into learning |
| 🎯 **Speaker in frame** | Face tracking moves the crop with whoever's talking, cutting on scene changes |
| 💬 **Captions that pop** | Karaoke ASS captions in 4 looks: `default`, `hormozi`, `storyteller`, `cinematic` |
| 🪝 **Hook first** | Replays the strongest line up front — stop the scroll |
| 🤫 **Kills dead air** | Silence trim cuts pauses from video, audio *and* captions |
| 🎵 **Background music** | Tracks in `data/music` loop under the clip and duck under speech |
| ✏️ **Fix anything** | Nudge timing, fix a word, change style — re-renders one clip in ~20 s |
| 🔎 **Finds source videos** | ✨ Auto-discover reads what's trending and picks sources with reasons; plus search and a channel crawler |
| 📈 **Learns what works** | Views and likes come back (from Tebar, or typed in) — after 5+ results the weights re-fit to reality |
| ⌨️ **Scriptable** | `sorot` CLI + plain HTTP API |

---

## 🚀 Install

Ready-made images on **`ghcr.io/raufimusaddiq/sorot`**, published per release — no 10-minute build. 📦 **`:latest`** = CPU (smaller) · **`:latest-cuda`** = NVIDIA GPU. The installers pick for you.

| | Path | GPU | Effort |
|---|---|---|---|
| 🪟 | [**Windows** — Docker Desktop](#-windows--docker-desktop) | NVIDIA or CPU | one command |
| 🪟 | [**Windows** — native, no Docker](#-windows--native-no-docker) | NVIDIA or CPU | one command |
| 🐧 | [**Linux** — installer](#-linux--installer) | NVIDIA or CPU | one command |
| 🐳 | [**Docker** — any OS, by hand](#-docker--any-os) | NVIDIA or CPU | a few commands |
| 🍎 | [**macOS** — Homebrew](#-macos--homebrew) | CPU | manual steps |
| ⌨️ | [**CLI only**](#%EF%B8%8F-cli-only--sorot-anywhere) | — | one binary |

Then open 🌐 **http://localhost:8080/studio** (UI + API on one port).

### 🪟 Windows — Docker Desktop

Paste into PowerShell — no git needed:

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/raufimusaddiq/sorot/master/scripts/install.ps1 | iex"
```

Installs into `%LOCALAPPDATA%\Sorot`, gets Docker Desktop via winget if missing (start it once, re-run), pulls the right image, starts the app and opens the studio. 🎮 GPU needs only the normal NVIDIA driver; if Docker can't use it, it falls back to CPU. **Sorot** / **Stop Sorot** land in the Start menu. Re-run to update. 🔄

From a clone: `.\scripts\install.ps1`. Day to day:

| Command | |
|---|---|
| `.\scripts\start.ps1` | ▶️ start (pulls the image the first time) |
| `.\scripts\start.ps1 -Update` | ⬇️ pull the newest image |
| `.\scripts\start.ps1 -Build` | 🔨 build from source (~10 min) |
| `.\scripts\start.ps1 -Dev` | 🔥 + hot-reload UI on :3000 |
| `.\scripts\stop.ps1` | ⏹️ stop |
| `.\scripts\verify-env.ps1` · `e2e-test.ps1` | 🩺 check deps · 🧪 E2E tests |

Running `.ps1` by hand needs `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once.

### 🪟 Windows — native (no Docker)

Bun, Python and ffmpeg straight on Windows — no Docker, no WSL:

```powershell
powershell -ExecutionPolicy Bypass -c "& ([scriptblock]::Create((irm https://raw.githubusercontent.com/raufimusaddiq/sorot/master/scripts/install.ps1))) -Mode native"
```

winget brings ffmpeg + Python 3.12, Bun goes in `.tools\bun`, then the venv (+ cuBLAS/cuDNN wheels on NVIDIA — no CUDA toolkit), UI build and Whisper model. Starts at logon. ⚙️ Settings `.env.native` · 📜 logs `data\logs\sorot.log`. *New and untested on real Windows — feedback welcome.* 🙏

Options (both modes): `-Port 8090` · `-Cpu` · `-Dir D:\Sorot` · `-Build` · `-SkipModel` · `-NoStart` · `-Uninstall [-Purge]`.

### 🐧 Linux — installer

Debian / Ubuntu and friends:

```bash
git clone https://github.com/raufimusaddiq/sorot.git && cd sorot
scripts/install.sh                 # 🐳 Docker (recommended) — pulls the image
scripts/install.sh --mode native   # 🧩 or Bun + Python + systemd
```

Installs what's missing (Docker, NVIDIA Container Toolkit — or ffmpeg, Python, Bun), picks GPU or CPU, survives reboots, adds the `sorot` CLI. Re-run to update · `--build` to build locally · `--uninstall` to remove. 👉 [docs/linux-install.md](docs/linux-install.md)

### 🐳 Docker — any OS

Compose v2.24+ (Linux GPU also needs the [Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)):

```bash
git clone https://github.com/raufimusaddiq/sorot.git && cd sorot
docker compose --env-file .env.docker up -d backend      # CPU image
```

🎮 **NVIDIA GPU?** Add a `docker-compose.override.yml` (gitignored) first:

```yaml
services:
  backend:
    restart: unless-stopped
    image: ghcr.io/raufimusaddiq/sorot:${SOROT_VERSION:-latest}-cuda
    build:
      args:
        BASE_IMAGE: nvidia/cuda:12.6.3-cudnn-runtime-ubuntu24.04   # for --build
    environment:
      WHISPER_DEVICE: cuda
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
```

📜 `… logs -f backend` · ⏹️ `… down` · ⬇️ `… pull backend && … up -d backend` · 🔨 `… up -d --build backend`. Settings in `.env.docker`; `SOROT_VERSION` pins a release (default `latest`).

🧠 The Whisper model (~1.6 GB) isn't in the image — it downloads once into the `hf-cache` volume and survives updates. Installers fetch it up front; by hand:
`docker compose --env-file .env.docker run --rm --entrypoint /app/ai-pipeline/.venv/bin/python3 backend -c "from faster_whisper import WhisperModel; WhisperModel('large-v3-turbo', device='cpu', compute_type='int8')"`

Images are `linux/amd64` — on Apple Silicon use [Homebrew](#-macos--homebrew).

### 🍎 macOS — Homebrew

CPU only, manual, *untested on a Mac — feedback welcome*:

```bash
brew install oven-sh/bun/bun ffmpeg python@3.12
git clone https://github.com/raufimusaddiq/sorot.git && cd sorot
python3.12 -m venv ai-pipeline/.venv
ai-pipeline/.venv/bin/pip install -r ai-pipeline/requirements.txt
bun install && bun run build                     # UI → frontend/out
cat > backend/.env <<EOF
PYTHON_PATH=$PWD/ai-pipeline/.venv/bin/python3
PIPELINE_DIR=$PWD/ai-pipeline
YTDLP_PATH=$PWD/ai-pipeline/.venv/bin/yt-dlp
DATA_DIR=$PWD/data
STATIC_DIR=$PWD/frontend/out
WHISPER_DEVICE=cpu
WHISPER_MODEL=small
EOF
cd backend && bun run src/index.ts               # 🌐 http://localhost:8080
```

Any `.env.docker` option works in `backend/.env`. 🔄 Update: `git pull`, re-run `pip install` and `bun install && bun run build`, restart.

### ⌨️ CLI only — `sorot` anywhere

One binary that drives any Sorot over HTTP — e.g. your laptop → a GPU box. The Linux installer adds it; elsewhere:

```bash
cd cli && bun run build                          # → cli/dist/sorot (.exe on Windows)
# no Bun? cross-compile (bun-linux-x64|-arm64, bun-darwin-arm64|-x64, bun-windows-x64):
docker run --rm -v "$PWD/cli:/cli" -w /cli oven/bun:1.3.12 \
  bun build --compile --minify --target=bun-darwin-arm64 src/main.ts --outfile dist/sorot
```

Put it on `PATH`, then `SOROT_URL=http://gpu-box:8080 sorot health`. 📖 [docs/cli.md](docs/cli.md)

### 💻 No graphics card? No problem

Everything runs on the **CPU** — installers switch automatically (`--cpu` / `-Cpu` to force). Only **NVIDIA** GPUs accelerate (CUDA + NVENC).

🧠 On a CPU, Sorot renders only the **10 best clips** per video — the rest are listed with scores and titles, one **Render** click away (`MAX_RENDER_CLIPS`). It also runs one video at a time, shows how far Whisper has got (**Transcribing 37%**), and a retry reuses the transcript instead of running Whisper again. Importing a time range copies that section instead of re-encoding it. A GPU renders every PRIMARY/BACKUP clip.

⏱️ 12-core CPU: a 1-hour video transcribed in ~30 min (`large-v3-turbo`) or ~15 min (`small`), plus ~25 min to render 45 clips. RTX 4060: a 54-min video took ~22 min end to end. Both were measured before the CPU speed-ups (one-pass render with captions, `veryfast`, Whisper on every core) — in a 4-core benchmark a 30 s clip went from 168 s to 46 s, so expect much less now. On 4 cores, a 40 s clip with face framing and captions renders in ~22 s; scoring an hour of video takes ~35 s. 🐢 Whisper is the slow part: try `WHISPER_BEAM_SIZE=1` or `WHISPER_MODEL=small`, or `YOUTUBE_CAPTIONS=true` to skip it when a video has uploaded captions.

---

## 🎞️ Making clips

1. 🌐 Open **http://localhost:8080/studio**
2. 🔗 Paste a YouTube URL or pick a file → **Import & Process** (⚙️ **Options**: caption style, framing, silence trim, hook first, music, or just **13:25 → 25:00**)
3. ⏳ Watch the 9 stages tick by
4. 🏆 Filter **PRIMARY / BACKUP / SKIP**, preview (on a CPU, **Render** the clips past the top 10)
5. 📋 Copy the title + description, download the `.mp4`
6. ✏️ **Edit** timing or a word → re-render that clip
7. 📊 Post, then log the results (**FB**); after 5+, **Retrain** in Learning

---

## ⌨️ `sorot` — the command line

```bash
sorot import "https://youtu.be/…" --style hormozi --trim --hook   # 🎬 import, wait, list clips
sorot import ~/Videos/talk.mp4 --from 13:25 --to 25:00            # ✂️ one section of a file
sorot clips <video> --tier PRIMARY                                # 🏆 the best clips
sorot download --video <video> -o ~/clips                         # 💾 grab the .mp4s
sorot rerender <clip> --start 61 --end 100                        # ✏️ fix one clip's timing
sorot discover auto "podcast bisnis"                              # ✨ agent finds source videos
sorot discover search "podcast indonesia"                         # 🔎 or search yourself
sorot up | down | logs -f | doctor                                # 🛠️ run the app
```

`--json` for scripts, `--url` / `SOROT_URL` for another machine. 📖 [docs/cli.md](docs/cli.md) · 🔌 Recipes (batch import, watched folders, timers, Python): [docs/integration.md](docs/integration.md)

---

## 🧠 How it works

```
YouTube URL / file ──► Bun API ──► 9-stage pipeline
                     1. 📥 Import        yt-dlp (or a time range)
                     2. 🔊 Audio         ffmpeg
                     3. 🎙️ Transcribe    faster-whisper, word timestamps
                     4. ✂️ Segment       gap-based candidates + Jev-judged sentence windows (or the LLM director)
                     5. 🧠 Score         13 signals + Jev (or LLM review), quality gate, hook + title
                     6. 📱 Render 9:16   crop, silence trim, hook, captions + music — one encode
                     7. 💬 Captions      (re-burns only clips rendered the old way)
                     8. 🔁 Variations    zoom / crop presets
                     9. 📊 Analytics     distribution + recommendations
              Web UI · sorot · scripts ◄── HTTP API (port 8080)
```

### 🏅 Scoring

13 weighted signals (`ai-pipeline/weights.json`, or your learned `data/weights.json`):

| Feature | Weight | Signal |
|---------|--------|--------|
| 🪝 Hook Strength | 17% | Question / hook phrase in the opening |
| 🔑 Keyword Trigger | 8% | Indonesian viral keywords (TF-IDF with `data/corpus`) |
| 💡 Novelty | 8% | Numbers, proper nouns, step / surprise words |
| 🔍 Clarity | 9% | Duration + context words |
| ⚡ Emotional Energy | 8% | Audio RMS (60%) + text emotion (40%) |
| 😊 Text Sentiment | 5% | Indonesian word polarity |
| ⏸️ Pause Structure | 6% | Real silence gaps |
| 🙂 Face Presence | 9% | Haar-cascade faces + smiles |
| 🎬 Scene Change | 7% | Histogram diff + brightness / saturation |
| 🎯 Topic Fit | 7% | `NICHE_KEYWORDS` match |
| 📚 History Score | 6% | Similar past clips via feedback |
| 🏃 Motion | 5% | Optical flow |
| 🥁 Onset Density | 5% | Audio onsets/s (laughs, claps, fast talk) |

➕ sharp questions, clashes, lists, emotion, conversational tone · ➖ slow openings, silence, generic, no face
🏆 **PRIMARY** ≥ 0.80 · 🥈 **BACKUP** ≥ 0.65 · 💤 **SKIP** < 0.65

With Jev (or else an LLM), the score is 50% formula + 50% its judgement; if it's unreachable, the formula decides. Each clip records who scored it and why.

### 🎬 LLM director, 🚦 quality gate, 🚀 publishing

- 🎬 **Director** — **Jev first**: code proposes a window at every sentence start, Jev judges them all and keeps the best 40 next to the rule windows, scores every candidate, and picks the hook line and a quoted title for the clips that render. On 10 min of a real transcript, segmenting + scoring took ~10 s with Jev (about $0.01 at TypeSafe's listed price) vs 6.5-9 min with a reasoning LLM as director. Without Jev (or `JEV_DIRECTOR=false`), the **LLM director** reads the video, writes a brief and picks moments + hooks. Either way, overlaps keep the better clip; give a **direction** at import to steer it.
- 🚦 **Gate** before render: PASS / REVIEW (content risk — you decide) / FAIL (held back, renderable on request). Jev when connected, text rules otherwise. Measure the questions with `bun run jev-eval`.
- 🤖 **The LLM** is for writing: post copy per platform, and the ✨ auto-discover agent that searches for new videos.
- 🚀 **Publish** (Tebar): LLM copy per platform → you edit and choose (TikTok privacy, YouTube "made for kids") → post or schedule → metrics sync every 6 h into learning.

👉 [docs/creative-loop.md](docs/creative-loop.md) — the design, the questions and their sources.

### 🔬 What's actually "AI" here?

Whisper is a neural network, and so is the LLM if you add one. Faces use classic ML (Haar cascades). The clip score is a **hand-tuned formula** — fast, explainable, offline — not a trained model; LightGBM can take over after 200+ real results. 👉 [docs/ai-audit.md](docs/ai-audit.md)

### 📈 Learning from your posts

📤 Views / likes / comments / shares / saves — synced from Tebar, or logged by hand → 🧮 a time-normalised viral score → 🔄 after 5+, **Retrain Weights** (Pearson + EMA, α = 0.3) → ✅ next import uses them. Learned weights live in `data/weights.json` and survive updates.

### 🔎 Discovery

Finds **long-form sources** (podcasts, talk shows, stand-up, VODs), not other people's clips: re-clips filtered, 30–180 min favoured, last 90 days by default.

- ✨ **Auto-discover** — the LLM agent reads what Indonesians talk about now, searches YouTube, reads captions, picks with reasons. No LLM? Random anchor queries, best scores, ≤ 2 per channel.
- 🧾 **Whole-video scoring** in 45 s caption windows — strong moments, best timestamps, talk ratio.
- 🗣️ **Reasons** like "3 strong moments, best at 4:38".
- 📡 **Channel crawler** profiles sources and rejects clip farms; queue the best in one go.

### 📝 Titles & descriptions

Every clip gets a **title** (hook + hashtags, ≤ 100 chars) and a **description** (hook + summary + 7 hashtags + CTA) — one click to copy.

---

## ⚙️ Configuration

`.env.docker` (Docker) · `/etc/sorot/sorot.env` (native Linux) · `.env.native` (native Windows) · `.env` (dev overrides). Most options can also be set per import in the UI or with `sorot import` flags.

| Variable | Default | What it does |
|----------|---------|--------------|
| `WHISPER_MODEL` | `large-v3-turbo` | `small` / `medium` are faster on CPU |
| `WHISPER_DEVICE` | `cpu` (`cuda` on GPU installs) | `cuda` or `cpu` |
| `WHISPER_LANGUAGE` | `id` | Transcription language |
| `NICHE_KEYWORDS` | `rahasia,penting,trik,solusi,tip` | Topic-fit keywords |
| `SUBTITLE_STYLE` | `default` | `default`, `hormozi`, `storyteller`, `cinematic` |
| `REFRAME_MODE` | `face` | `face`, `center`, `blur` (frame over blurred fill) |
| `SILENCE_TRIM` / `SILENCE_GAP_SEC` | `false` / `0.6` | Cut pauses longer than the gap |
| `HOOK_FIRST` | `false` | Replay the best line first |
| `YOUTUBE_CAPTIONS` / `YOUTUBE_AUTO_CAPTIONS` | `false` / `false` | Use uploaded (and auto) captions |
| `BGM_FILE` / `BGM_VOLUME` | none / `0.12` | Default music from `data/music` |
| `X264_PRESET` | `veryfast` | CPU encoder preset (`fast`: slightly better quality, ~2x slower) |
| `WHISPER_THREADS` | all cores | CPU threads for Whisper |
| `WHISPER_BEAM_SIZE` | `5` | `1` = faster on CPU, a little less accurate — try it on your videos |
| `MAX_RENDER_CLIPS` | `10` on CPU, all on GPU | Best clips rendered per video; the rest render on request. `0` = all |
| `MAX_CONCURRENT_PIPELINES` | `1` on CPU, `2` on GPU | Videos processed at once (more wait in a queue) |
| `VARIATIONS` | `false` | Also make zoom-preset copies of the top clips (not shown in the app yet) |
| `LLM_BASE_URL` / `LLM_MODEL` | empty (off) | OpenAI-compatible endpoint, e.g. Ollama `http://host.docker.internal:11434/v1` + `qwen2.5:7b` |
| `LLM_API_KEY` | empty | Hosted LLMs — in `.env.llm` (gitignored), never `.env.docker` |
| `LLM_DIRECTOR` | `true` | With an LLM: brief + own moment picks + hook. `false` = review and copy only |
| `LLM_TIMEOUT` / `LLM_MAX_TOKENS` | `120` / `4000` | Seconds and output tokens per call. Reasoning models (Kimi, DeepSeek-R1…) think before they answer: give them `300` s and room in the budget |
| `JEV_API_KEY` | empty (off) | Jev quality gate ([TypeSafe](https://docs.typesafe.ai)) — in `.env.llm`. Off = the rules answer the gate's questions |
| `JEV_MODEL` / `JEV_URL` | `jev-1.14.0` / TypeSafe's `/v1/systemone` | Pinned model; OpenRouter works too (`https://openrouter.ai/api/alpha/decisions` + its model id) |
| `JEV_DIRECTOR` | `true` | With Jev: it finds the moments, scores them, picks hooks and quote titles (the LLM director and review are skipped). `false` = Jev only gates |
| `TEBAR_API_KEY` | empty (off) | Publishing via [Tebar](https://docs.tebar.app/api) (paid plan) — in `.env.llm` |
| `TEBAR_SYNC_HOURS` | `6` | Pull posted clips' metrics into learning every N hours (`0` = only on request) |
| `WEB_SEARCH` | `bing` | `bing` (no key), a SearXNG URL, or `off` |
| `SOROT_VERSION` | `latest` | Image tag to run, e.g. `1.0.0` |

🔌 LLM, Jev and Tebar can also be set in the app (**Settings** in the dock) or with `sorot connect` — saved in the database, they win over these variables; *Use .env* / `sorot connect <name> --reset` goes back.

---

## 🧰 Tech stack

| Part | Tech |
|-----------|------|
| 🟨 Backend | Bun + TypeScript (`bun:sqlite`, zero runtime deps) — API, scoring, discovery, LLM agent, serves the UI |
| 🐍 Media | Python 3 · faster-whisper · OpenCV · NumPy · ffmpeg / libass · yt-dlp |
| 🤖 LLM | Any OpenAI-compatible endpoint (optional) |
| ⚛️ Frontend | Next.js 14, static export |
| 🗄️ Database | SQLite |
| ⌨️ CLI | `sorot`, one compiled Bun binary |
| 🐳 Runs on | Docker (GHCR images, CPU or CUDA) · native Linux · native Windows · macOS via Homebrew |

### 🗂️ Project layout

```
├── backend/        🟨 Bun/TS API, orchestrator, scoring, discovery, UI host (+ Dockerfile)
├── ai-pipeline/    🐍 Python media scripts (transcribe, render, reframe, subtitle, …)
├── frontend/       ⚛️ Next.js UI (static export → frontend/out)
├── cli/            ⌨️ sorot client
├── scripts/        🛠️ install.sh (Linux) · install/start/stop/verify/e2e .ps1 (Windows)
├── docs/           📚 specs and guides
└── data/           💾 your videos, clips, database (gitignored)
```

### 🧑‍💻 Development

```bash
bun install                        # one lockfile for backend + frontend + cli
bun run build && bun run start     # UI → frontend/out, backend on :8080
cd backend && bun test --coverage  # 🧪 backend
cd cli && bun test --coverage      # 🧪 CLI
cd frontend && bun run test        # 🧪 UI (jest)
cd ai-pipeline && .venv/bin/python -m pytest tests   # 🧪 ~200 pipeline tests
```

✅ Gate: 100% passing, ≥ 95% coverage, zero type errors.

### 📦 CI & releases

- 🧪 [`ci.yml`](.github/workflows/ci.yml) — tests on every push and PR; image-affecting changes also build the **CPU** image (cached, not pushed) and smoke-test it.
- 🚀 [`release-image.yml`](.github/workflows/release-image.yml) — builds + pushes **CPU and CUDA** images only on a **GitHub release** (`v1.2.3` → `:1.2.3`, `:1.2`, `:latest`, + `-cuda`; pre-releases keep `:latest`) or a **manual run** (Actions → *Release image*).

To ship: merge to `master` → *Draft a new release* tagged `v1.2.3`. 🔓 If anonymous `docker pull` fails after the first publish, set the GHCR package to public (profile → Packages → `sorot` → settings).

---

## 📚 Docs

| | |
|---|---|
| 🐧 [linux-install.md](docs/linux-install.md) | Installer modes, files, updating, troubleshooting |
| ⌨️ [cli.md](docs/cli.md) | Every `sorot` command and flag |
| 🔌 [integration.md](docs/integration.md) | Scripts, timers, watched folders, HTTP API, Python |
| 🌐 [api-spec.md](docs/api-spec.md) | HTTP API reference |
| 🏗️ [architecture.md](docs/architecture.md) | How the pieces fit |
| 🏅 [scoring-spec.md](docs/scoring-spec.md) | Scoring in depth |
| 🔬 [ai-audit.md](docs/ai-audit.md) | Model vs rule vs LLM |
| 🎬 [creative-loop.md](docs/creative-loop.md) | Jev director, LLM director, Jev quality gate, Tebar publishing |
| 🐍 [python-pipeline.md](docs/python-pipeline.md) | Each pipeline script's inputs and outputs |

---

## 🗺️ Roadmap

- 🎯 **Calibrate the gate** on real labelled clips (`bun run jev-eval`) and feed its answers to training as features
- 💬 **Comments** — Tebar comment inbox with LLM-drafted replies you approve

---

## 📄 License

[MIT](LICENSE) © 2026 Raufi Musaddiq — use, modify, share, even commercially; keep the notice. 🔓

Bundled tools keep their own licenses: ffmpeg (LGPL/GPL), yt-dlp (Unlicense), faster-whisper + Whisper models (MIT), OpenCV (Apache-2.0), LightGBM (MIT) — redistributing the image means following them too. Downloading or clipping videos is subject to platform terms and creators' rights.
