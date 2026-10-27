# Installing on Linux

`scripts/install.sh` sets up Sorot on Debian, Ubuntu and their
derivatives (Mint, Pop!_OS…). Run it from a clone of the repo as your normal
user — it calls `sudo` for the system parts and keeps the repo files owned by you.

```bash
git clone https://github.com/raufimusaddiq/sorot.git
cd sorot
scripts/install.sh                     # Docker mode (recommended)
scripts/install.sh --mode native       # or: no Docker, systemd service
```

Upgrading an install from before the rename (Viral Clipper)? Re-run the
installer: it moves your settings from `/etc/viralclip` to `/etc/sorot`,
replaces the `viralclip` service with `sorot`, and keeps `vclip` as an alias
of the new `sorot` command. Your `data/` (and its `viralclipper.db`) is untouched.

When it finishes the app is on `http://localhost:8080` (the studio at `/studio`) and `sorot` is on your
PATH (see [cli.md](cli.md)).

## Before you start

- **NVIDIA GPU (optional, strongly recommended).** Install the NVIDIA driver
  yourself first — `nvidia-smi` must work. The installer never touches the
  driver. Without a GPU everything runs on the CPU: on a 12-core machine a
  1-hour video takes roughly an hour (transcription ~30 min with
  `large-v3-turbo`, ~15 min with `WHISPER_MODEL=small`; rendering ~25 min).
- **Disk:** ~15 GB for Docker mode (CUDA image + Whisper model), ~6 GB for
  native, plus your videos.
- Other distros: install Docker Engine with the compose plugin (≥ 2.24) and the
  NVIDIA Container Toolkit yourself, then run the installer — it skips what is
  already there.

## Options

| Option | Effect |
|---|---|
| `--mode docker` / `--mode native` | How the app runs (default: docker) |
| `--port N` | Port for the UI and API (default 8080) |
| `--cpu` | Ignore the GPU |
| `--build` | Docker: build the image from source instead of pulling it |
| `--no-start` | Install, don't start |
| `--no-service` | Native: no systemd unit (you run the app yourself) |
| `--skip-model` | Native: don't pre-download the Whisper model (it downloads on first use) |
| `-y`, `--yes` | No confirmation prompts (for scripts / provisioning) |
| `--uninstall [--purge]` | Remove the install; `--purge` also deletes `data/`, the venv and the image |

## What each mode installs

### Docker mode

1. **Docker Engine + compose plugin** from Docker's apt repository if Docker is
   missing or its compose is older than 2.24 (a distro `docker.io` engine is
   kept; only the compose plugin is added).
2. **NVIDIA Container Toolkit** from NVIDIA's apt repository when a GPU is
   present, and registers it with Docker.
3. Adds you to the `docker` group — **log out and back in** before using
   `sorot up/down/logs` without sudo.
4. Writes `docker-compose.override.yml` (gitignored) for this machine: your
   port, `restart: unless-stopped` (the app comes back after a reboot), and on
   GPU machines the `-cuda` image, the GPU reservation and `WHISPER_DEVICE=cuda`.
5. Pulls the ready-made image (published by `.github/workflows/ci.yml`):
   `ghcr.io/raufimusaddiq/sorot:latest` on CPU-only machines, `:latest-cuda`
   with a GPU, and starts it. `--build` builds that variant from source instead (~10 min).

Settings: `.env.docker` in the repo (shared with Windows) — edit, then `sorot restart`.

### Native mode

1. apt: `ffmpeg python3 python3-venv python3-pip curl unzip fonts-dejavu-core`.
2. **Bun 1.3.12** from its GitHub release into `/usr/local/bin/bun` (skipped if
   that version is already installed).
3. **Python venv** `ai-pipeline/.venv` with `requirements.txt`; on a GPU also the
   cuBLAS + cuDNN 9 wheels faster-whisper needs (their path goes into
   `LD_LIBRARY_PATH`, no system CUDA install needed).
4. `bun install` + builds the UI into `frontend/out`.
5. Downloads the Whisper model (`large-v3-turbo`, ~1.6 GB) into `~/.cache/huggingface`.
6. `/etc/sorot/sorot.env` — the service's settings (pipeline defaults
   from `.env.docker` plus absolute paths). Kept on re-install; edit, then `sorot restart`.
7. systemd unit `sorot.service`, running as you, enabled at boot.

Without systemd (containers, WSL without systemd) no unit is installed; the
installer prints the command to run the app by hand.

### Both modes

- `sorot` → `/usr/local/bin/sorot` (one compiled binary; built in a Bun
  container in Docker mode, so Bun isn't needed on the host).
- `/etc/sorot/cli.conf` — tells `sorot` the mode, repo path and URL.
- `data/input/` and `data/music/` created and owned by you.

## Files

| Path | What |
|---|---|
| `<repo>/data/` | Videos, clips, database — everything you make |
| `<repo>/data/music/` | Background music tracks (`.mp3`, `.m4a`, …) |
| `<repo>/docker-compose.override.yml` | Docker mode: this machine's port / GPU / restart |
| `/etc/sorot/cli.conf` | `sorot` config |
| `/etc/sorot/sorot.env` | Native mode: service settings |
| `/etc/systemd/system/sorot.service` | Native mode: the service |
| `/usr/local/bin/sorot`, `/usr/local/bin/bun` | CLI; Bun (native mode) |

## Updating

```bash
git pull
scripts/install.sh            # same mode/options as before; pulls the newest image (or rebuilds native) and restarts
```

## Uninstalling

```bash
scripts/install.sh --uninstall          # keeps data/
scripts/install.sh --uninstall --purge  # also deletes data/, the venv and the Docker image
```

Docker, Bun, ffmpeg and other system packages stay installed.

## Troubleshooting

Start with `sorot doctor` — it checks the config, GPU, Docker or the service,
ffmpeg and the API, and says what to do about each failure.

| Symptom | Fix |
|---|---|
| `permission denied … docker.sock` | Log out and in (docker group), or use `sudo sorot …` once |
| `sorot up` says the app didn't answer | `sorot logs` — first start in Docker can take a minute |
| Very slow, `doctor` shows no GPU | Install the NVIDIA driver, then re-run the installer (it adds the container toolkit / CUDA wheels) |
| Native: transcription fails with `metadata_errors` | An old checkout without the `av<19` pin: `git pull`, re-run the installer |
| Port in use | `scripts/install.sh --port 8090` |
| Copied the repo from Windows | Fine — the installer strips Windows line endings from `.env.docker` |
