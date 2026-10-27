# 🎬 Sorot

> **Drop in a 2-hour podcast. Get back the 60 seconds people will actually watch.** ✂️🔥

**Sorot** (Indonesian for *spotlight*) turns long YouTube or local videos into vertical **9:16 short-form clips** for any social platform — transcribed, scored for viral potential, framed on the speaker, captioned word by word, and given a ready-to-paste title and description. Built for **Indonesian** content, runs **100% locally** on your own machine. No uploads, no subscriptions, no watermark. 🏠

```
📺 YouTube / local video  →  🎙️ Whisper  →  🧠 clip scoring (+ optional LLM)  →  📱 9:16 render  →  💬 karaoke captions  →  🚀 post-ready clips
```

---

## ✨ What it does

| | |
|---|---|
| 🎙️ **Hears every word** | faster-whisper (`large-v3-turbo`) with per-word timestamps — or the video's own YouTube captions when they're better |
| 🧠 **Finds the gold** | 13 hand-weighted signals from the words, the audio and the picture (hooks, keywords, energy, faces, motion…) rank every moment into **PRIMARY / BACKUP / SKIP** |
| 🤖 **Optional LLM** | Point it at Ollama, Groq, OpenRouter or OpenAI and it reviews each clip, writes titles and runs an auto-discover agent — off by default, everything works without it |
| 🎯 **Keeps the speaker in frame** | Face tracking moves the 9:16 crop with whoever's talking and switches exactly on scene cuts |
| 💬 **Captions that pop** | Karaoke-style ASS captions — the spoken word lights up. Four looks: `default`, `hormozi`, `storyteller`, `cinematic` |
| 🪝 **Hook first** | Optionally replays the clip's strongest line at the very start — stop the scroll |
| 🤫 **Kills dead air** | Optional silence trim cuts pauses out of video, audio *and* captions in one pass |
| 🎵 **Background music** | Drop tracks in `data/music`; they loop under the clip and duck while people talk |
| ✏️ **Fix anything** | Clip editor: nudge start/end, fix a misheard word, change style — re-renders just that clip in ~20 s |
| 🔎 **Finds source videos** | ✨ Auto-discover researches what's trending, reads whole videos' captions and picks sources with a reason for each; plus search, trending and a crawler for the channels clippers harvest from |
| 📈 **Learns what works** | Feed back real views and likes from your posts — after 5+ results the feature weights are re-fitted to what actually performed |
| ⌨️ **Scriptable** | `sorot` CLI and a plain HTTP API for cron jobs, watched folders and your own tools |

---

## 🚀 Install

The whole app ships as a ready-made Docker image, **`ghcr.io/raufimusaddiq/sorot`**, published by the [release workflow](.github/workflows/release-image.yml) for every Sorot release — no 10-minute build on your machine. It comes in two variants: **`:latest`** (CPU, plain Ubuntu, the smaller download) and **`:latest-cuda`** (NVIDIA GPU: CUDA 12 + cuDNN). The installers pick the right one for your machine. Pick the path that fits:

| | Path | GPU | Effort |
|---|---|---|---|
| 🪟 | [**Windows** — Docker Desktop](#-windows--docker-desktop) | NVIDIA or CPU | one command |
| 🪟 | [**Windows** — native, no Docker](#-windows--native-no-docker) | NVIDIA or CPU | one command |
| 🐧 | [**Linux** — installer](#-linux--installer) | NVIDIA or CPU | one command |
| 🐳 | [**Docker** — any OS, by hand](#-docker--any-os) | NVIDIA or CPU | a few commands |
| 🍎 | [**macOS** — Homebrew, from source](#-macos--homebrew) | CPU | manual steps |
| ⌨️ | [**CLI only** — `sorot` on any machine](#%EF%B8%8F-cli-only--sorot-anywhere) | — | build one binary |

Whichever you choose, the app ends up on **http://localhost:8080** 🌐 — UI and API on one port. The front page introduces Sorot; the studio, where you make clips, is **http://localhost:8080/studio**.

### 🪟 Windows — Docker Desktop

Paste into PowerShell (no git needed):

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/raufimusaddiq/sorot/master/scripts/install.ps1 | iex"
```

It downloads Sorot into `%LOCALAPPDATA%\Sorot`, installs Docker Desktop with winget if it's missing (start it once, then run the command again), pulls the image, uses your NVIDIA GPU when the driver is there (else the CPU), starts the app and opens the studio. **Sorot** and **Stop Sorot** appear in the Start menu; the app comes back whenever Docker Desktop starts. Re-run the same command to update.

GPU: only the normal NVIDIA Windows driver is needed — Docker Desktop's WSL2 backend passes the GPU through. If Docker can't use it, the installer falls back to the CPU.

Already have a clone? `.\scripts\install.ps1` does the same from it. Day to day:

| Command | |
|---|---|
| `.\scripts\start.ps1` | ▶️ start on :8080 (pulls the image the first time) |
| `.\scripts\start.ps1 -Update` | ⬇️ pull the newest image and restart |
| `.\scripts\start.ps1 -Build` | 🔨 build the image from source instead (~10 min) |
| `.\scripts\start.ps1 -Dev` | 🔥 + hot-reload UI on :3000 |
| `.\scripts\stop.ps1` | ⏹️ stop everything |
| `.\scripts\verify-env.ps1` | 🩺 check dependencies |
| `.\scripts\e2e-test.ps1` | 🧪 end-to-end tests |

Running `.ps1` files by hand needs `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once (the Start menu shortcuts don't).

### 🪟 Windows — native (no Docker)

No Docker Desktop, no WSL — Bun, Python and ffmpeg straight on Windows:

```powershell
powershell -ExecutionPolicy Bypass -c "& ([scriptblock]::Create((irm https://raw.githubusercontent.com/raufimusaddiq/sorot/master/scripts/install.ps1))) -Mode native"
```

It installs what's missing with winget (ffmpeg, Python 3.12), puts Bun in `.tools\bun`, creates the Python venv (plus the cuBLAS/cuDNN wheels faster-whisper needs when there's an NVIDIA GPU — no CUDA toolkit install), builds the UI, pre-downloads the Whisper model, starts the app and opens the studio. It starts at logon (Startup folder) and has the same **Sorot** / **Stop Sorot** Start menu entries; `scripts\start.ps1` and `scripts\stop.ps1` work too. Settings: `.env.native` · logs: `data\logs\sorot.log`. Re-run to update.

*The native Windows path is new and not yet tested on a real Windows machine — feedback welcome.*

Installer options (either mode): `-Port 8090` · `-Cpu` (ignore the GPU) · `-Dir D:\Sorot` · `-Build` (Docker: build locally) · `-SkipModel` · `-NoStart` · `-Uninstall [-Purge]` (`-Purge` also deletes `data\`, the venv and the image).

### 🐧 Linux — installer

Debian, Ubuntu and derivatives. One command does everything:

```bash
git clone https://github.com/raufimusaddiq/sorot.git
cd sorot
scripts/install.sh                 # 🐳 Docker mode (recommended) — pulls the image
scripts/install.sh --mode native   # 🧩 or: Bun + Python + systemd, no Docker
```

It installs what's missing (Docker + compose, the NVIDIA Container Toolkit — or ffmpeg, Python, Bun for native), detects the GPU (falls back to CPU), pulls the image (`--build` builds it locally instead), starts the app so it survives reboots, and installs the `sorot` CLI. Re-run to update; `--uninstall` to remove.

👉 Options, file locations, troubleshooting: **[docs/linux-install.md](docs/linux-install.md)**

### 🐳 Docker — any OS

Docker with Compose v2.24+. On Linux an NVIDIA GPU also needs the [Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html); Docker Desktop on Windows needs only the driver.

```bash
git clone https://github.com/raufimusaddiq/sorot.git
cd sorot
docker compose --env-file .env.docker up -d backend      # pulls ghcr.io/raufimusaddiq/sorot:latest (CPU)
```

🎮 **NVIDIA GPU?** Create `docker-compose.override.yml` next to `docker-compose.yml` first (it's gitignored) — it switches to the `-cuda` image and hands the GPU to the container:

```yaml
services:
  backend:
    restart: unless-stopped        # come back after reboots
    image: ghcr.io/raufimusaddiq/sorot:${SOROT_VERSION:-latest}-cuda
    build:
      args:
        BASE_IMAGE: nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04   # for --build
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

Day to day: `docker compose --env-file .env.docker logs -f backend` 📜 · `… down` ⏹️ · `… up -d backend` ▶️ · update: `… pull backend` then `… up -d backend` ⬇️. Settings live in `.env.docker`; `SOROT_VERSION` there pins a release tag (default `latest` = the newest release). Rather build it yourself? `… up -d --build backend` 🔨.

The Whisper model isn't in the image: the first import downloads it (`large-v3-turbo`, ~1.6 GB) into the `hf-cache` volume, where it stays across restarts and image updates. The installers fetch it up front; by hand, you can do the same once with `docker compose --env-file .env.docker run --rm --entrypoint /app/ai-pipeline/.venv/bin/python3 backend -c "from faster_whisper import WhisperModel; WhisperModel('large-v3-turbo', device='cpu', compute_type='int8')"`.

Both images are `linux/amd64`. On Apple Silicon they would run under emulation, so use [Homebrew](#-macos--homebrew) there.

### 🍎 macOS — Homebrew

Macs have no NVIDIA GPU, so everything runs on the CPU (Apple Silicon and Intel). This path is manual: no installer or native image for macOS yet. *Not tested on a Mac yet — feedback welcome.*

```bash
brew install oven-sh/bun/bun ffmpeg python@3.12
git clone https://github.com/raufimusaddiq/sorot.git
cd sorot
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

Bun reads `backend/.env` automatically; every option from `.env.docker` works there too. To update: `git pull`, re-run the `pip install` and `bun install && bun run build` lines, then restart.

### ⌨️ CLI only — `sorot` anywhere

`sorot` is one self-contained binary that talks to any Sorot over HTTP — handy on your laptop while the app runs on a GPU box. The Linux installer installs it for you; anywhere else, build it:

```bash
cd cli && bun run build                          # with Bun → cli/dist/sorot (sorot.exe on Windows)
```

No Bun? Cross-compile from Docker for your OS — `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-arm64` (Apple Silicon), `bun-darwin-x64` (Intel Mac) or `bun-windows-x64`:

```bash
docker run --rm -v "$PWD/cli:/cli" -w /cli oven/bun:1.3.12 \
  bun build --compile --minify --target=bun-darwin-arm64 src/main.ts --outfile dist/sorot
```

Put it on your `PATH` (`sorot`, the old name, works as an alias), then point it at the app: `SOROT_URL=http://gpu-box:8080 sorot health` (default `http://localhost:8080`). 📖 [docs/cli.md](docs/cli.md)

### 💻 No graphics card? No problem

Everything runs on the **CPU** — the Linux and Windows installers switch automatically (or `--cpu` / `-Cpu`), Docker by hand uses the CPU image unless you add the GPU override above, and macOS is CPU by default. Only **NVIDIA** GPUs are used for acceleration (CUDA + NVENC).

Measured on a 12-core CPU, no GPU: transcribing 54 s of speech took **24 s** with `large-v3-turbo` and **14 s** with `small` — so a 1-hour video transcribes in roughly half an hour (or ~15 min with `small`), and rendering 45 clips adds ~25 min. For comparison, on an RTX 4060 a 54-minute video took ~22 min end to end (measured before caption burning moved to the GPU, so it's faster now).

---

## 🎞️ Making clips

1. 🌐 Open the studio: **http://localhost:8080/studio** (or **Open the studio** on the front page)
2. 🔗 Paste a YouTube URL (or pick a local file) → **Import & Process**
   - ⚙️ **Options** under the URL box: caption style, framing, silence trim, hook first, YouTube captions, music, and **only process 13:25 → 25:00** of a long video
3. ⏳ Watch the 9 stages tick by
4. 🏆 Browse clips by video, filter **PRIMARY / BACKUP / SKIP**, preview in the browser
5. 📋 Copy the auto-written title + description, download the `.mp4`
6. ✏️ Not perfect? **Edit** → fix timing or a word → re-render that one clip
7. 📊 After posting, enter how it did (**FB** button: views, likes, comments, shares, saves); after 5+ results, **Retrain** in the Learning tab

---

## ⌨️ `sorot` — the command line

```bash
sorot import "https://youtu.be/…" --style hormozi --trim --hook   # 🎬 import, wait, list clips
sorot import ~/Videos/talk.mp4 --from 13:25 --to 25:00            # ✂️ a local file, one section
sorot clips <video> --tier PRIMARY                                # 🏆 the best clips
sorot download --video <video> -o ~/clips                         # 💾 grab the .mp4s
sorot rerender <clip> --start 61 --end 100                        # ✏️ fix one clip's timing
sorot discover auto "podcast bisnis"                             # ✨ let the agent find source videos
sorot discover search "podcast indonesia"                         # 🔎 or search yourself
sorot up | down | logs -f | doctor                                # 🛠️ run the app
```

Every command takes `--json` for scripts and `--url` / `SOROT_URL` to drive another machine. Getting it: [⌨️ CLI only](#%EF%B8%8F-cli-only--sorot-anywhere).
📖 Full reference: **[docs/cli.md](docs/cli.md)**

### 🔌 Integrate it

Batch-import a list of URLs, auto-process a watched folder, run nightly discovery from a systemd timer, call the HTTP API from Python, or feed post results back to train the scorer — recipes in **[docs/integration.md](docs/integration.md)**.

---

## 🧠 How it works

```
YouTube URL / file ──► Bun API ──► 9-stage pipeline
                                     │
                     1. 📥 Import        yt-dlp (or just a time range)
                     2. 🔊 Audio         ffmpeg
                     3. 🎙️ Transcribe    faster-whisper large-v3-turbo, word timestamps
                     4. ✂️ Segment       gap-based candidate clips
                     5. 🧠 Score         13 weighted signals + optional LLM review, title/description
                     6. 📱 Render 9:16   face-tracking crop, silence trim, hook first
                     7. 💬 Captions      word-timed ASS burned in with libass
                     8. 🔁 Variations    zoom / crop presets of the top clips
                     9. 📊 Analytics     distribution + recommendations
                                     │
              Web UI · sorot · your scripts ◄── HTTP API (same origin, port 8080)
```

### 🏅 Scoring

Each clip is scored on 13 weighted signals (weights from `ai-pipeline/weights.json`, or your learned `data/weights.json`):

| Feature | Weight | Signal |
|---------|--------|--------|
| 🪝 Hook Strength | 17% | Question / hook phrase in the opening |
| 🔑 Keyword Trigger | 8% | Indonesian viral keywords (TF-IDF when `data/corpus` has texts) |
| 💡 Novelty | 8% | Numbers, proper nouns, step / surprise words |
| 🔍 Clarity | 9% | Duration + context words |
| ⚡ Emotional Energy | 8% | Audio RMS energy (60%) + text emotion (40%) |
| 😊 Text Sentiment | 5% | Indonesian positive / negative word polarity |
| ⏸️ Pause Structure | 6% | Actual silence gaps from the transcript |
| 🙂 Face Presence | 9% | Faces (Haar cascade on sampled frames) + smiles |
| 🎬 Scene Change | 7% | Histogram diff + colour brightness / saturation |
| 🎯 Topic Fit | 7% | `NICHE_KEYWORDS` match |
| 📚 History Score | 6% | Similar past clips via your feedback |
| 🏃 Motion | 5% | Optical flow between frames |
| 🥁 Onset Density | 5% | Audio onsets per second (laughs, claps, fast talk) |

➕ **Boosts:** sharp questions, opinion clashes, numbered lists, emotional moments, conversational tone
➖ **Penalties:** slow openings, too much silence, generic content, no face

🏆 **PRIMARY** ≥ 0.80 · 🥈 **BACKUP** ≥ 0.65 · 💤 **SKIP** < 0.65

With an LLM configured, each clip's final score is 50% this formula and 50% the LLM's judgement of the excerpt, and the LLM writes the title and description; if the LLM is unreachable the formula alone decides. Every clip records which one scored it and why.

### 🔬 What's actually "AI" here?

Honestly: the speech-to-text is a neural network (Whisper), and the LLM is one when you add it. Face detection is classic machine learning (OpenCV Haar cascades). The clip score itself is a **hand-tuned weighted formula** over rule-based and signal-processing features — fast, explainable and works offline, but not a trained model. A LightGBM model can take over once you've fed back 200+ real results. Details: **[docs/ai-audit.md](docs/ai-audit.md)**.

### 📈 Learning from your posts

The shipped weights are in `ai-pipeline/weights.json`; what you learn goes to `data/weights.json` (survives updates):

1. 📤 Post a clip, enter its views / likes / comments / shares / saves
2. 🧮 A viral score is computed from your numbers (time-normalised)
3. 🔄 After 5+ results, **Retrain Weights** — each feature re-weighted by how well it correlated with real results (Pearson + EMA blend, α = 0.3)
4. ✅ The next import scores with the improved weights

### 🔎 Discovery

Finds **long-form source material** (podcasts, talk shows, stand-up, livestream VODs) — not other people's clips: re-clipped titles are filtered out, 30–180 min videos score highest, and only uploads from the last 90 days show by default.

- ✨ **Auto-discover** — with an LLM, an agent searches the web for what Indonesians are talking about now, turns it into YouTube searches, reads the captions of promising videos and picks the best with a reason for each. Without one, the algorithm samples a few anchor queries at random and keeps the best-scoring videos (≤ 2 per channel).
- 🧾 **Whole-video scoring** — every candidate's captions are scored in 45 s windows: strong moments, best timestamps, how much talking there is.
- 🗣️ **Reasons** — each candidate says why it ranks where it does ("3 strong moments, best at 4:38", "Known source channel").
- 📡 A channel crawler profiles source channels and rejects clip farms. Queue the best candidates and process them in one go.

### 📝 Titles & descriptions

Every clip gets post-ready copy: a **title** (first question or hook + hashtags, ≤ 100 chars) and a **description** (hook line + summary + 7 hashtags + call to action), one click to copy.

---

## ⚙️ Configuration

Docker reads `.env.docker` (committed defaults); native Linux installs use `/etc/sorot/sorot.env`, native Windows installs `.env.native`; `.env` holds local overrides for development. Every option can also be changed per import in the UI or with `sorot import` flags.

| Variable | Default | What it does |
|----------|---------|--------------|
| `WHISPER_MODEL` | `large-v3-turbo` (Docker) | Whisper model — `small` / `medium` are faster on CPU |
| `WHISPER_DEVICE` | `cuda` | `cuda` or `cpu` |
| `WHISPER_LANGUAGE` | `id` | Transcription language (Indonesian) |
| `NICHE_KEYWORDS` | `rahasia,penting,trik,solusi,tip` | Topic-fit keywords |
| `SUBTITLE_STYLE` | `default` | `default`, `hormozi`, `storyteller`, `cinematic` |
| `REFRAME_MODE` | `face` | `face` (follow speakers), `center`, `blur` (whole frame over a blurred fill) |
| `SILENCE_TRIM` / `SILENCE_GAP_SEC` | `false` / `0.6` | Cut pauses longer than the gap |
| `HOOK_FIRST` | `false` | Replay the best line at the start |
| `YOUTUBE_CAPTIONS` / `YOUTUBE_AUTO_CAPTIONS` | `false` / `false` | Use the video's uploaded (and auto-generated) captions |
| `BGM_FILE` / `BGM_VOLUME` | none / `0.12` | Default background music from `data/music` |
| `LLM_BASE_URL` / `LLM_MODEL` | empty (off) | Any OpenAI-compatible endpoint, e.g. Ollama `http://host.docker.internal:11434/v1` + `qwen2.5:7b` |
| `LLM_API_KEY` | empty | For hosted LLMs — put it in `.env.llm` (gitignored), not `.env.docker` |
| `WEB_SEARCH` | `bing` | Auto-discover web search: `bing` (no key), a SearXNG URL, or `off` |

---

## 🧰 Tech stack

| Part | Tech |
|-----------|------|
| 🟨 Backend | Bun + TypeScript (`bun:sqlite`, zero runtime deps): API, orchestration, scoring, discovery, LLM agent — also serves the UI |
| 🐍 Media pipeline | Python 3 · faster-whisper (CUDA) · OpenCV · NumPy · ffmpeg / libass · yt-dlp |
| 🤖 LLM (optional) | Any OpenAI-compatible endpoint: Ollama, LM Studio, Groq, OpenRouter, OpenAI |
| ⚛️ Frontend | Next.js 14, static export |
| 🗄️ Database | SQLite |
| ⌨️ CLI | `sorot` — one compiled Bun binary |
| 📦 Repo | Bun workspace monorepo (`backend` + `frontend` + `cli`, one `bun.lock`) |
| 🐳 Runs on | Docker Compose (image from `ghcr.io/raufimusaddiq/sorot`) + NVIDIA GPU, native Linux (systemd), native Windows, macOS via Homebrew, or CPU-only |

### 🗂️ Project layout

```
├── backend/        🟨 Bun/TS API, orchestrator, scoring, discovery + agent, static UI host (+ Dockerfile)
├── ai-pipeline/    🐍 Python media scripts: transcribe, media_features, render, reframe,
│                      subtitle, captions, variation, train_scorer / predict_supervised
├── frontend/       ⚛️ Next.js web UI (static export → frontend/out)
├── cli/            ⌨️ sorot command-line client
├── scripts/        🛠️ install.sh (Linux) · install/start/stop/verify/e2e .ps1 (Windows)
├── docs/           📚 architecture, API, CLI, install, integration, scoring specs
└── data/           💾 your videos, clips and database (gitignored)
```

### 🧑‍💻 Development

```bash
bun install                        # one lockfile for backend + frontend + cli
bun run build                      # static UI → frontend/out
bun run start                      # backend on :8080, serves the UI
cd backend && bun test --coverage  # 🧪 backend
cd cli && bun test --coverage      # 🧪 CLI
cd frontend && bun run test        # 🧪 UI (jest)
cd ai-pipeline && .venv/bin/python -m pytest tests   # 🧪 ~200 media pipeline tests
```

Quality gate: 100% passing, ≥ 95% coverage, zero type errors. ✅

### 📦 CI and the published image

- [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs the Bun, UI and Python tests on every push to `master` and every PR. When a change can affect the image (anything except docs and the host-side install/start scripts), it also builds the **CPU** image — reusing cached layers, not pushed — and smoke-tests it: the API answers, the UI is served, the pipeline's Python packages, ffmpeg and yt-dlp load. The CUDA variant runs the same Dockerfile steps on another base, so it's left to releases.
- [`.github/workflows/release-image.yml`](.github/workflows/release-image.yml) builds `backend/Dockerfile` twice — on `ubuntu:22.04` (CPU) and, through the `BASE_IMAGE` build arg, on `nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04` (GPU) — and pushes both. It runs only:
  - when a **GitHub release** is published: `v1.2.3` → `:1.2.3`, `:1.2`, `:latest`, `:sha-<commit>` and the same with `-cuda` (a pre-release doesn't move `:latest`);
  - **by hand**: Actions → *Release image* → *Run workflow* on any branch → `:sha-<commit>`(`-cuda`), plus `:latest`(`-cuda`) unless you untick *latest*.

  Layers are cached in the registry (`:buildcache-cpu`, `:buildcache-cuda`), so a code-only release re-uploads only the small top layers.

To ship: merge to `master`, then create a release (GitHub → Releases → *Draft a new release*, tag `v1.2.3`). Until the first release or manual run there is no image to pull.

GitHub may create the package as **private** on the first publish: if anonymous `docker pull` fails, make it public once (your GitHub profile → Packages → `sorot` → Package settings → Change visibility).

---

## 📚 Docs

| | |
|---|---|
| 🐧 [linux-install.md](docs/linux-install.md) | Installer modes, files, updating, uninstalling, troubleshooting |
| ⌨️ [cli.md](docs/cli.md) | Every `sorot` command and flag |
| 🔌 [integration.md](docs/integration.md) | Scripts, timers, watched folders, remote use, HTTP API, Python |
| 🌐 [api-spec.md](docs/api-spec.md) | HTTP API reference |
| 🏗️ [architecture.md](docs/architecture.md) | How the pieces fit |
| 🏅 [scoring-spec.md](docs/scoring-spec.md) | Scoring formula in depth |
| 🔬 [ai-audit.md](docs/ai-audit.md) | What is a model, what is a rule, what the LLM does |
| 🐍 [python-pipeline.md](docs/python-pipeline.md) | Each pipeline script's inputs and outputs |

---

## 🗺️ Roadmap

- 🔗 **Social media connectors** — publish clips straight to your accounts and pull their views / likes back in automatically, so the scorer keeps learning without manual entry

---

## 📄 License

[MIT](LICENSE) © 2026 Raufi Musaddiq — free to use, modify and share, including commercially; keep the copyright notice. 🔓

Sorot calls tools that keep their own licenses: ffmpeg (LGPL/GPL, depending on the build), yt-dlp (Unlicense), faster-whisper and the Whisper models (MIT), OpenCV (Apache-2.0), LightGBM (MIT). The Docker image bundles some of them, so redistributing that image means following their terms too. Downloading or clipping videos is subject to the platforms' terms and the creators' rights.
