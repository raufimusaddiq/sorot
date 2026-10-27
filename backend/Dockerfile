# One image: Bun API + statically-exported Next.js UI + Python AI pipeline.
# Build from the repo root:  docker build -f backend/Dockerfile .

# ---- 1. Static UI (next build → frontend/out) ----
# Next's build needs Node; Bun is copied in for the workspace install.
FROM node:20-slim AS web
COPY --from=oven/bun:1.3.12 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /repo
COPY package.json bun.lock bunfig.toml ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN bun install --frozen-lockfile
COPY frontend/ frontend/
# NEXT_PUBLIC_API_URL stays unset → the UI calls /api on its own origin.
ENV NEXT_TELEMETRY_DISABLED=1
RUN cd frontend && bun run build

# ---- 2. Runtime ----
FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

# Ubuntu 22.04 LTS pins these de facto for the release's lifetime; yt-dlp
# (pip, below) is left unpinned on purpose — YouTube changes break old ones.
# curl is used by the docker-compose healthcheck.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=oven/bun:1.3.12 /usr/local/bin/bun /usr/local/bin/bun

COPY ai-pipeline/requirements.txt /app/ai-pipeline/requirements.txt
RUN python3 -m venv /app/ai-pipeline/.venv \
    && /app/ai-pipeline/.venv/bin/pip install --no-cache-dir -r /app/ai-pipeline/requirements.txt

ARG WHISPER_MODEL=mobiuslabsgmbh/faster-whisper-large-v3-turbo
RUN /app/ai-pipeline/.venv/bin/python3 -c "from faster_whisper import WhisperModel; WhisperModel('${WHISPER_MODEL}', device='cpu', compute_type='int8')"

# The backend has no runtime npm dependencies — Bun runs the TypeScript directly.
COPY backend/package.json backend/tsconfig.json /app/backend/
COPY backend/src /app/backend/src
COPY --from=web /repo/frontend/out /app/frontend/out
COPY ai-pipeline/ /app/ai-pipeline/

WORKDIR /app/backend
EXPOSE 8080

# Venv bin on PATH so the pip-installed `yt-dlp` shim resolves.
ENV PATH=/app/ai-pipeline/.venv/bin:$PATH
ENV PYTHON_PATH=/app/ai-pipeline/.venv/bin/python3
ENV PIPELINE_DIR=/app/ai-pipeline
ENV DATA_DIR=/app/data
ENV STATIC_DIR=/app/frontend/out
# The CUDA base image grants only compute,utility; "video" mounts
# libnvidia-encode so ffmpeg's h264_nvenc works (else render.py falls back to x264).
ENV NVIDIA_DRIVER_CAPABILITIES=compute,utility,video

ENTRYPOINT ["bun", "run", "src/index.ts"]
