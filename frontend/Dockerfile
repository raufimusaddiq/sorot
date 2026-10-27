# Frontend dev / test / lint images. Production doesn't use this file: the UI
# is a static export baked into backend/Dockerfile and served by the backend.
# Build from the repo root (Bun workspace):  docker build -f frontend/Dockerfile --target dev .

FROM node:20-slim AS base
COPY --from=oven/bun:1.3.12 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /repo
COPY package.json bun.lock bunfig.toml ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
COPY cli/package.json cli/
RUN bun install --frozen-lockfile
COPY frontend/ frontend/
WORKDIR /repo/frontend
ENV NEXT_TELEMETRY_DISABLED=1

# Hot-reload UI on :3000 against the backend on :8080 (.env.development).
FROM base AS dev
EXPOSE 3000
CMD ["bun", "run", "dev"]

FROM base AS test
RUN bun run test
