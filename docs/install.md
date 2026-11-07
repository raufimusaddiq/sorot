# Install

Every way to run Sorot. The README has the one-line version of each.


Images on **`ghcr.io/raufimusaddiq/sorot`**, published per release (no build): **`:latest`** CPU, **`:latest-cuda`** NVIDIA GPU. The installers pick for you.

| | Path | GPU | Effort |
|---|---|---|---|
| 🪟 | [**Windows**: Docker Desktop](#-windows-docker-desktop) | NVIDIA or CPU | one command |
| 🪟 | [**Windows**: native, no Docker](#-windows-native-no-docker) | NVIDIA or CPU | one command |
| 🐧 | [**Linux**: installer](#-linux-installer) | NVIDIA or CPU | one command |
| 🐳 | [**Docker**: any OS](#-docker-any-os) | NVIDIA or CPU | a few commands |
| 🍎 | [**macOS**: Homebrew](#-macos-homebrew) | CPU | manual |
| ⌨️ | [**CLI only**](#%EF%B8%8F-cli-only-sorot-anywhere) | n/a | one binary |

Then open 🌐 **http://localhost:8080/studio** (UI and API on one port).

## 🪟 Windows: Docker Desktop

In PowerShell, no git needed:

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/raufimusaddiq/sorot/master/scripts/install.ps1 | iex"
```

Installs into `%LOCALAPPDATA%\Sorot`, gets Docker Desktop via winget if missing (start it once, re-run), pulls the image, starts the app, opens the studio. 🎮 GPU needs only the normal NVIDIA driver; if Docker can't use it, it falls back to CPU. **Sorot** / **Stop Sorot** go in the Start menu. Re-run to update. 🔄

From a clone: `.\scripts\install.ps1`. Day to day:

| Command | |
|---|---|
| `.\scripts\start.ps1` | ▶️ start (pulls the image the first time) |
| `.\scripts\start.ps1 -Update` | ⬇️ pull the newest image |
| `.\scripts\start.ps1 -Build` | 🔨 build from source (~10 min) |
| `.\scripts\start.ps1 -Dev` | 🔥 plus hot-reload UI on :3000 |
| `.\scripts\stop.ps1` | ⏹️ stop |
| `.\scripts\verify-env.ps1` · `e2e-test.ps1` | 🩺 check deps · 🧪 E2E tests |

Running `.ps1` by hand needs `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once.

## 🪟 Windows: native (no Docker)

Bun, Python and ffmpeg directly on Windows, no Docker, no WSL:

```powershell
powershell -ExecutionPolicy Bypass -c "& ([scriptblock]::Create((irm https://raw.githubusercontent.com/raufimusaddiq/sorot/master/scripts/install.ps1))) -Mode native"
```

winget brings ffmpeg and Python 3.12, Bun goes in `.tools\bun`, then the venv (cuBLAS/cuDNN wheels on NVIDIA, no CUDA toolkit), UI build and Whisper model. Starts at logon. ⚙️ Settings: `.env.native` · 📜 logs: `data\logs\sorot.log`. *New and untested on real Windows, feedback welcome.* 🙏

Options (both modes): `-Port 8090` · `-Cpu` · `-Dir D:\Sorot` · `-Build` (Docker) · `-SkipModel` · `-NoStart` · `-Uninstall [-Purge]`.

## 🐧 Linux: installer

Debian, Ubuntu and friends:

```bash
git clone https://github.com/raufimusaddiq/sorot.git && cd sorot
scripts/install.sh                 # 🐳 Docker (recommended): pulls the image
scripts/install.sh --mode native   # 🧩 or Bun + Python + systemd
```

Installs what's missing (Docker and NVIDIA Container Toolkit, or ffmpeg, Python, Bun), picks GPU or CPU, survives reboots, adds the `sorot` CLI. Re-run to update · `--build` builds locally · `--uninstall` removes. 👉 [docs/linux-install.md](docs/linux-install.md)

## 🐳 Docker: any OS

Compose v2.24+ (Linux GPU also needs the [Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)):

```bash
git clone https://github.com/raufimusaddiq/sorot.git && cd sorot
docker compose --env-file .env.docker up -d backend      # CPU image
```

🎮 **NVIDIA GPU?** First add a `docker-compose.override.yml` (gitignored):

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

📜 `… logs -f backend` · ⏹️ `… down` · ⬇️ `… pull backend && … up -d backend` · 🔨 `… up -d --build backend`. Settings live in `.env.docker`; `SOROT_VERSION` pins a release.

🧠 The Whisper model (~1.6 GB) is not in the image. It downloads once into the `hf-cache` volume and survives updates. Installers fetch it up front; by hand:
`docker compose --env-file .env.docker run --rm --entrypoint /app/ai-pipeline/.venv/bin/python3 backend -c "from faster_whisper import WhisperModel; WhisperModel('large-v3-turbo', device='cpu', compute_type='int8')"`

Images are `linux/amd64`; on Apple Silicon use [Homebrew](#-macos-homebrew).

## 🍎 macOS: Homebrew

CPU only, manual, *untested on a Mac, feedback welcome*:

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

## ⌨️ CLI only: `sorot` anywhere

One binary that drives any Sorot over HTTP (your laptop → a GPU box). The Linux installer adds it; elsewhere:

```bash
cd cli && bun run build                          # → cli/dist/sorot (.exe on Windows)
# no Bun? cross-compile (bun-linux-x64|-arm64, bun-darwin-arm64|-x64, bun-windows-x64):
docker run --rm -v "$PWD/cli:/cli" -w /cli oven/bun:1.3.12 \
  bun build --compile --minify --target=bun-darwin-arm64 src/main.ts --outfile dist/sorot
```

Put it on `PATH`, then `SOROT_URL=http://gpu-box:8080 sorot health`. 📖 [docs/cli.md](docs/cli.md)

## 💻 No graphics card?

Everything runs on the **CPU**; installers switch automatically (`--cpu` / `-Cpu` forces it). Only **NVIDIA** GPUs accelerate (CUDA, NVENC).

On a CPU, Sorot renders the **10 best clips** per video (`MAX_RENDER_CLIPS`); the rest are listed with scores and titles, one **Render** click away. It runs one video at a time, shows Whisper progress (**Transcribing 37%**), and a retry reuses the transcript. A time-range import copies the section instead of re-encoding. A GPU renders every PRIMARY/BACKUP clip.

⏱️ Measured once, before the CPU speed-ups, so expect less now: 12-core CPU, 1 h video: ~30 min transcribing (`large-v3-turbo`) or ~15 min (`small`), plus ~25 min to render 45 clips. RTX 4060, 54 min video: ~22 min end to end. After the speed-ups, on 4 cores: a 40 s clip with face framing and captions renders in ~22 s, scoring an hour takes ~35 s, and a 30 s clip went from 168 s to 46 s. 🐢 Whisper is the slow part: try `WHISPER_BEAM_SIZE=1`, `WHISPER_MODEL=small`, or `YOUTUBE_CAPTIONS=true` to skip it when a video has uploaded captions.

---
