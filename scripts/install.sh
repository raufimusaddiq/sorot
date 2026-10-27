#!/usr/bin/env bash
# Viral Clipper installer for Linux (Debian / Ubuntu and derivatives).
#
#   scripts/install.sh                  Docker install (recommended)
#   scripts/install.sh --mode native    Bun + Python venv + systemd, no Docker
#   scripts/install.sh --uninstall      remove the service, CLI and config
#
# Run it from a checkout of the repo as a normal user; it uses sudo for the
# system parts. Re-running it is safe (it updates the install in place).
set -euo pipefail

BUN_VERSION=1.3.12
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF_DIR=/etc/viralclip
BIN=/usr/local/bin/vclip
SERVICE=viralclip
UNIT=/etc/systemd/system/$SERVICE.service

MODE=docker
PORT=8080
CPU=0
START=1
SERVICE_WANTED=1
SKIP_MODEL=0
UNINSTALL=0
PURGE=0
YES=0

usage() {
  cat <<'EOF'
Usage: scripts/install.sh [options]

  --mode docker|native   docker (default): the app runs in a container with
                         the GPU passed through. native: Bun + Python on the host,
                         run by a systemd service.
  --port N               port for the web UI and API (default 8080)
  --cpu                  don't use the NVIDIA GPU even if one is present
  --no-start             install everything but don't start the app
  --no-service           (native) don't install the systemd service
  --skip-model           (native) don't pre-download the Whisper model
  --uninstall            remove the service / container, CLI and config
  --purge                with --uninstall: also delete data/ (videos, clips,
                         database), the Python venv and the Docker image
  -y, --yes              don't ask for confirmation
  -h, --help             this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="${2:-}"; shift ;;
    --mode=*) MODE="${1#*=}" ;;
    --port) PORT="${2:-}"; shift ;;
    --port=*) PORT="${1#*=}" ;;
    --cpu) CPU=1 ;;
    --no-start) START=0 ;;
    --no-service) SERVICE_WANTED=0 ;;
    --skip-model) SKIP_MODEL=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --purge) PURGE=1 ;;
    -y|--yes) YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# --- helpers --------------------------------------------------------------------

if [ -t 1 ]; then BOLD=$'\e[1m'; RED=$'\e[31m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RESET=$'\e[0m'
else BOLD=""; RED=""; GREEN=""; YELLOW=""; RESET=""; fi
step() { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$*"; }
ok()   { printf '%s ✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%s !%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die()  { printf '%s ✗ %s%s\n' "$RED" "$*" "$RESET" >&2; exit 1; }

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
  RUN_USER="${SUDO_USER:-root}"
else
  command -v sudo >/dev/null || die "sudo is required (or run as root)"
  SUDO="sudo"
  RUN_USER="$(id -un)"
fi
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"

# Repo files (venv, node_modules, build output, data/) stay owned by the user.
as_user() {
  if [ "$(id -u)" -eq 0 ] && [ "$RUN_USER" != root ]; then
    sudo -u "$RUN_USER" -H "$@"
  else
    "$@"
  fi
}

confirm() {
  [ "$YES" -eq 1 ] && return 0
  if [ ! -t 0 ]; then die "$1 — re-run with --yes to confirm non-interactively"; fi
  read -r -p "$1 [y/N] " reply
  [[ "$reply" =~ ^[Yy] ]]
}

have() { command -v "$1" >/dev/null 2>&1; }
has_systemd() { [ -d /run/systemd/system ]; }

APT_UPDATED=0
apt_install() {
  have apt-get || die "No apt-get: install these yourself and re-run: $*"
  if [ "$APT_UPDATED" -eq 0 ]; then
    $SUDO apt-get update -qq
    APT_UPDATED=1
  fi
  DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq --no-install-recommends "$@"
}

# ID / codename for vendor apt repos; derivatives (Mint, Pop!_OS…) use their base.
os_release() {
  # shellcheck disable=SC1091
  . /etc/os-release
  OS_ID="$ID"
  OS_CODENAME="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"
  case " ${ID_LIKE:-} " in *" ubuntu "*) OS_ID=ubuntu ;; *" debian "*) [ "$ID" = debian ] || OS_ID=debian ;; esac
  if [ -n "${UBUNTU_CODENAME:-}" ]; then OS_ID=ubuntu; fi
}

gpu_present() {
  [ "$CPU" -eq 0 ] && have nvidia-smi && nvidia-smi -L >/dev/null 2>&1
}

version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]; }

write_root_file() { # path, content on stdin
  $SUDO mkdir -p "$(dirname "$1")"
  $SUDO tee "$1" >/dev/null
}

write_cli_conf() {
  write_root_file "$CONF_DIR/cli.conf" <<EOF
# Written by scripts/install.sh — read by the vclip CLI.
VCLIP_MODE=$MODE
VCLIP_APP_DIR=$APP_DIR
VCLIP_URL=http://localhost:$PORT
VCLIP_SERVICE=$SERVICE
EOF
  ok "CLI config: $CONF_DIR/cli.conf"
}

# vclip is one self-contained binary built with Bun (from a Bun container
# when Bun isn't installed on the host, as in Docker mode).
install_cli() {
  step "Building the vclip CLI"
  local out="$APP_DIR/cli/dist/vclip"
  if have bun; then
    (cd "$APP_DIR/cli" && as_user bun build --compile --minify src/main.ts --outfile dist/vclip >/dev/null)
  else
    $SUDO docker run --rm -v "$APP_DIR/cli:/cli" -w /cli "oven/bun:$BUN_VERSION" \
      bun build --compile --minify src/main.ts --outfile dist/vclip >/dev/null
  fi
  $SUDO install -m 0755 "$out" "$BIN"
  ok "vclip → $BIN ($("$BIN" --version))"
}

wait_healthy() {
  local url="http://localhost:$PORT/api/health"
  for _ in $(seq 1 120); do
    if curl -fsS "$url" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

finish() {
  echo
  if [ "$START" -eq 1 ]; then
    if wait_healthy; then
      ok "Viral Clipper is running: ${BOLD}http://localhost:$PORT${RESET}"
    else
      warn "The app didn't answer on :$PORT yet — check: vclip logs"
    fi
  fi
  cat <<EOF

Try:
  vclip import "https://www.youtube.com/watch?v=…"   # make clips
  vclip videos | vclip clips <video> | vclip download --video <video>
  vclip up | down | logs -f | doctor                 # manage the app
  vclip --help
EOF
}

# --- docker mode --------------------------------------------------------------------

COMPOSE_MIN=2.24   # docker-compose.override.yml uses !override / !reset

ensure_docker() {
  os_release
  local need_engine=0 need_compose=0 v=""
  have docker || need_engine=1
  if [ "$need_engine" -eq 0 ]; then
    v="$(docker compose version --short 2>/dev/null || $SUDO docker compose version --short 2>/dev/null || true)"
    v="${v#v}"
    if [ -z "$v" ] || ! version_ge "$v" "$COMPOSE_MIN"; then need_compose=1; fi
  fi
  if [ "$need_engine" -eq 0 ] && [ "$need_compose" -eq 0 ]; then
    ok "Docker $(docker --version | awk '{print $3}' | tr -d ,) with compose $v"
    return
  fi
  case "$OS_ID" in ubuntu|debian) ;; *) die "Install Docker Engine with the compose plugin (>= $COMPOSE_MIN) for your distro, then re-run" ;; esac
  step "Installing Docker from Docker's apt repository"
  apt_install ca-certificates curl gnupg
  $SUDO install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$OS_ID/gpg" | $SUDO gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$OS_ID $OS_CODENAME stable" \
    | write_root_file /etc/apt/sources.list.d/docker.list
  APT_UPDATED=0
  if [ "$need_engine" -eq 1 ]; then
    apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  else
    # Keep the distro's engine (docker.io); just add a current compose plugin.
    apt_install docker-compose-plugin docker-buildx-plugin
  fi
  if has_systemd; then $SUDO systemctl enable --now docker >/dev/null; fi
  ok "Docker $(docker --version | awk '{print $3}' | tr -d ,) with compose $(docker compose version --short)"
}

ensure_nvidia_runtime() {
  if $SUDO docker info 2>/dev/null | grep -qi 'runtimes:.*nvidia'; then
    ok "NVIDIA container runtime"
    return
  fi
  step "Installing the NVIDIA Container Toolkit (GPU inside Docker)"
  apt_install ca-certificates curl gnupg
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
    | $SUDO gpg --dearmor --yes -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
    | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
    | write_root_file /etc/apt/sources.list.d/nvidia-container-toolkit.list
  APT_UPDATED=0
  apt_install nvidia-container-toolkit
  $SUDO nvidia-ctk runtime configure --runtime=docker >/dev/null
  if has_systemd; then $SUDO systemctl restart docker; fi
  ok "NVIDIA container runtime"
}

# Machine-local compose settings; the repo's docker-compose.yml stays shared.
write_compose_override() {
  local f="$APP_DIR/docker-compose.override.yml"
  {
    echo "# Written by scripts/install.sh for this machine (gitignored)."
    echo "services:"
    echo "  backend:"
    echo "    restart: unless-stopped"
    echo "    ports: !override"
    echo "      - \"$PORT:8080\""
    if [ "$GPU" -eq 0 ]; then
      echo "    deploy: !reset {}   # no NVIDIA GPU: run on the CPU"
      echo "    environment:"
      echo "      WHISPER_DEVICE: cpu"
    fi
  } | as_user tee "$f" >/dev/null
  ok "Compose settings: docker-compose.override.yml (port $PORT, $([ "$GPU" -eq 1 ] && echo GPU || echo CPU))"
}

install_docker() {
  ensure_docker
  if gpu_present; then GPU=1; ensure_nvidia_runtime; else GPU=0; warn "No NVIDIA GPU in use: transcription and encoding run on the CPU (slower: roughly 1 h per hour of video on 12 cores)"; fi
  write_compose_override
  as_user mkdir -p "$APP_DIR/data/input" "$APP_DIR/data/music"
  if [ "$RUN_USER" != root ] && ! id -nG "$RUN_USER" | grep -qw docker; then
    $SUDO usermod -aG docker "$RUN_USER"
    warn "Added $RUN_USER to the docker group — log out and back in before using vclip up/down/logs"
  fi
  step "Building the app image (first time: ~10 min, downloads the Whisper model)"
  (cd "$APP_DIR" && $SUDO docker compose --env-file .env.docker build backend)
  install_cli
  write_cli_conf
  if [ "$START" -eq 1 ]; then
    step "Starting"
    (cd "$APP_DIR" && $SUDO docker compose --env-file .env.docker up -d backend)
  fi
  finish
}

# --- native mode --------------------------------------------------------------------

ensure_bun() {
  if have bun && [ "$(bun --version)" = "$BUN_VERSION" ]; then ok "Bun $BUN_VERSION"; return; fi
  step "Installing Bun $BUN_VERSION"
  local arch tmp
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=aarch64 ;; *) die "Unsupported CPU: $(uname -m)" ;; esac
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/bun.zip" "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-linux-$arch.zip"
  unzip -q "$tmp/bun.zip" -d "$tmp"
  $SUDO install -m 0755 "$tmp/bun-linux-$arch/bun" /usr/local/bin/bun
  rm -rf "$tmp"
  ok "Bun $(bun --version)"
}

python_venv() {
  local venv="$APP_DIR/ai-pipeline/.venv"
  step "Python environment (ai-pipeline/.venv)"
  python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))' || die "Python 3.9+ required"
  [ -x "$venv/bin/python3" ] || as_user python3 -m venv "$venv"
  as_user "$venv/bin/pip" install -q --upgrade pip
  as_user "$venv/bin/pip" install -q -r "$APP_DIR/ai-pipeline/requirements.txt"
  CUDA_LIBS=""
  if [ "$GPU" -eq 1 ]; then
    # faster-whisper's GPU path needs cuBLAS + cuDNN 9 for CUDA 12; pip ships both.
    as_user "$venv/bin/pip" install -q nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*"
    CUDA_LIBS="$(as_user "$venv/bin/python3" -c 'import os, nvidia.cublas.lib as b, nvidia.cudnn.lib as c; print(os.path.dirname(b.__file__) + ":" + os.path.dirname(c.__file__))')"
  fi
  ok "Python $("$venv/bin/python3" -c 'import platform; print(platform.python_version())'), yt-dlp $("$venv/bin/yt-dlp" --version)"
}

write_native_env() {
  local env="$CONF_DIR/$SERVICE.env" venv="$APP_DIR/ai-pipeline/.venv"
  if [ -f "$env" ]; then
    $SUDO sed -i "s|^SERVER_PORT=.*|SERVER_PORT=$PORT|" "$env"
    ok "Kept your settings in $env (port set to $PORT)"
    return
  fi
  {
    echo "# Written by scripts/install.sh — settings for the $SERVICE service."
    echo "# Edit, then: vclip restart. Options are described in README.md / .env.docker."
    # Same pipeline defaults as Docker, minus its container paths. CRs dropped:
    # a checkout made on Windows has CRLF lines, and "id\r" is no language code.
    tr -d '\r' < "$APP_DIR/.env.docker" | grep -E '^[A-Z_]+=' \
      | grep -vE '^(PYTHON_PATH|PIPELINE_DIR|DATA_DIR|SERVER_PORT|FFMPEG_PATH|YTDLP_PATH|WHISPER_DEVICE|FRONTEND_URL)='
    echo "SERVER_PORT=$PORT"
    echo "PYTHON_PATH=$venv/bin/python3"
    echo "PIPELINE_DIR=$APP_DIR/ai-pipeline"
    echo "DATA_DIR=$APP_DIR/data"
    echo "STATIC_DIR=$APP_DIR/frontend/out"
    echo "FFMPEG_PATH=ffmpeg"
    echo "YTDLP_PATH=$venv/bin/yt-dlp"
    echo "WHISPER_DEVICE=$([ "$GPU" -eq 1 ] && echo cuda || echo cpu)"
    echo "PATH=$venv/bin:/usr/local/bin:/usr/bin:/bin"
    if [ -n "$CUDA_LIBS" ]; then echo "LD_LIBRARY_PATH=$CUDA_LIBS"; fi
  } | write_root_file "$env"
  ok "Settings: $env"
}

write_unit() {
  write_root_file "$UNIT" <<EOF
[Unit]
Description=Viral Clipper (web UI + API on :$PORT)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR/backend
EnvironmentFile=$CONF_DIR/$SERVICE.env
ExecStart=/usr/local/bin/bun run src/index.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable "$SERVICE" >/dev/null 2>&1
  ok "systemd service: $SERVICE"
}

install_native() {
  os_release
  if gpu_present; then GPU=1; else GPU=0; warn "No NVIDIA GPU in use: transcription and encoding run on the CPU (slower: roughly 1 h per hour of video on 12 cores)"; fi
  step "System packages"
  apt_install ffmpeg python3 python3-venv python3-pip curl ca-certificates unzip fonts-dejavu-core
  ok "ffmpeg $(ffmpeg -version | head -n1 | awk '{print $3}')"
  ensure_bun
  python_venv
  step "Web UI"
  (cd "$APP_DIR" && as_user bun install --frozen-lockfile >/dev/null && as_user bun run build >/dev/null)
  ok "frontend/out"
  as_user mkdir -p "$APP_DIR/data/input" "$APP_DIR/data/music"
  if [ "$SKIP_MODEL" -eq 0 ]; then
    step "Downloading the Whisper model (large-v3-turbo, ~1.6 GB)"
    as_user "$APP_DIR/ai-pipeline/.venv/bin/python3" -c \
      "from faster_whisper import WhisperModel; WhisperModel('large-v3-turbo', device='cpu', compute_type='int8')" >/dev/null
    ok "Whisper model cached in $RUN_HOME/.cache/huggingface"
  fi
  write_native_env
  install_cli
  write_cli_conf
  if [ "$SERVICE_WANTED" -eq 1 ] && has_systemd; then
    write_unit
    if [ "$START" -eq 1 ]; then $SUDO systemctl restart "$SERVICE"; fi
  else
    START=0
    [ "$SERVICE_WANTED" -eq 1 ] && warn "No systemd here — no service installed."
    cat <<EOF
Run the app yourself with:
  cd $APP_DIR/backend && set -a && . $CONF_DIR/$SERVICE.env && set +a && bun run src/index.ts
EOF
  fi
  finish
}

# --- uninstall --------------------------------------------------------------------

uninstall() {
  local mode=""
  if [ -f "$CONF_DIR/cli.conf" ]; then mode="$(sed -n 's/^VCLIP_MODE=//p' "$CONF_DIR/cli.conf")"; fi
  if [ "$PURGE" -eq 1 ]; then
    confirm "Delete $APP_DIR/data (all videos, clips and the database), the venv and the Docker image?" || die "Cancelled"
  fi
  step "Uninstalling"
  if [ -f "$UNIT" ]; then
    $SUDO systemctl disable --now "$SERVICE" >/dev/null 2>&1 || true
    $SUDO rm -f "$UNIT"
    $SUDO systemctl daemon-reload
    ok "Removed the $SERVICE service"
  fi
  if [ "$mode" = docker ] || [ -f "$APP_DIR/docker-compose.override.yml" ]; then
    if have docker; then
      local down=(down)
      if [ "$PURGE" -eq 1 ]; then down+=(--rmi all --volumes); fi
      (cd "$APP_DIR" && $SUDO docker compose --env-file .env.docker "${down[@]}" >/dev/null 2>&1) || true
      ok "Stopped the container"
    fi
    rm -f "$APP_DIR/docker-compose.override.yml"
  fi
  $SUDO rm -f "$BIN" "$CONF_DIR/cli.conf" "$CONF_DIR/$SERVICE.env"
  $SUDO rmdir "$CONF_DIR" 2>/dev/null || true
  rm -rf "$APP_DIR/cli/dist"
  ok "Removed vclip and $CONF_DIR"
  if [ "$PURGE" -eq 1 ]; then
    $SUDO rm -rf "$APP_DIR/data" "$APP_DIR/ai-pipeline/.venv"
    ok "Deleted data/ and the venv"
  else
    echo "Kept data/ (videos, clips, database). Use --uninstall --purge to delete it."
  fi
  echo "Docker, Bun, ffmpeg and other system packages were left installed."
}

# --- main --------------------------------------------------------------------

[ "$(uname -s)" = Linux ] || die "This installer is for Linux (on Windows use scripts\\start.ps1)"
if [ "$UNINSTALL" -eq 1 ]; then uninstall; exit 0; fi
case "$MODE" in docker|native) ;; *) die "--mode must be docker or native" ;; esac
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then die "--port must be 1-65535"; fi

printf '%sViral Clipper installer%s — %s mode, port %s, from %s\n' "$BOLD" "$RESET" "$MODE" "$PORT" "$APP_DIR"
confirm "Install system packages with sudo as needed and set up the app?" || die "Cancelled"
if [ "$MODE" = docker ]; then install_docker; else install_native; fi
