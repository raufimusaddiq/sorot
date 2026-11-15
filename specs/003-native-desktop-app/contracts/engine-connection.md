# Contract: Desktop App to Engine Connection

**Feature**: `003-native-desktop-app` | **Date**: 2026-11-15

This is the only seam between `desktop/` and `backend/` (constitution I, V). Everything else is
the existing HTTP API in `docs/api-spec.md`, unchanged.

## 1. Launch (local engine)

The app spawns `<resources>/engine/sorot-engine`. In development it runs
`bun run backend/src/index.ts` instead.

| Env | Value | Effect |
|---|---|---|
| `SERVER_HOST` | `127.0.0.1` | bind to loopback only (default stays `0.0.0.0` for Docker) |
| `SERVER_PORT` | `0` | the OS picks a free port |
| `SOROT_TOKEN` | 32 random bytes, base64url, new each launch | enables auth (section 3) |
| `STATIC_DIR` | empty | no web UI is served |
| `SOROT_PARENT_PIPE` | `1` | the engine exits when stdin closes (section 4) |
| `SOROT_SOLE_OWNER` | `1` | startup sweep marks every RUNNING job FAILED with reason `interrupted` |
| `DATA_DIR` | Workspace `dataDir` | same layout as today (`data/`) |
| `PIPELINE_DIR`, `GENERATOR_DIR` | bundled resource paths | as today |
| `PYTHON_PATH` | `<appData>/runtime/venv/{Scripts\|bin}/python` | the uv-managed environment |
| `FFMPEG_PATH` | `<appData>/runtime/ffmpeg/ffmpeg[.exe]` | the downloaded ffmpeg |
| `WHISPER_DEVICE` | `cuda` when the readiness check found an NVIDIA GPU, else `cpu` | as today |

`.env.llm` is not read in desktop mode. Keys live in the SQLite `setting` table only.

## 2. Ready handshake

The engine prints exactly one line on stdout once it is listening:

```
SOROT_READY {"port":54321,"version":"1.9.0","api":1}
```

- The app waits up to 30 s (the first run on slow disks).
- If the process exits first, or the 30 s pass, the connection goes to `Failed`, showing the
  last 50 stderr lines in the diagnostic report with secrets removed.
- `api` is a contract version. The app refuses a newer major version with "This engine is
  newer than the app. Update Sorot."

## 3. Authentication

- When `SOROT_TOKEN` is set, every `/api/*` request must carry
  `Authorization: Bearer <token>`. Otherwise the engine answers
  `401 {"status":"error","error":"unauthorized"}` (the existing `fail()` envelope, `backend/src/http.ts`).
- `/api/health` is also covered.
- CORS stays as today; the app sends no `Origin`.
- With `SOROT_TOKEN` unset (Docker, CLI against a dev server), behaviour is unchanged.
- The token is never logged by either side, and never put in a URL.
- The CLI (`sorot --url`) gets `--token` / `SOROT_TOKEN` for an authenticated engine.

## 4. Lifetime

- The app holds the engine's stdin open. When the app exits or crashes, stdin closes, and the
  engine runs its normal shutdown: it cancels running jobs (whole process tree, `runner.ts`),
  closes the database, and exits.
- Windows: the engine runs in a Job Object with kill-on-close.
- POSIX: its own process group. On quit the app sends `SIGTERM` to the group, then `SIGKILL`
  after 5 s.
- **Keep running in background** (US1-3) keeps the app process alive with no window (tray on
  Windows and Linux, Dock on macOS), so the engine stays up. Full quit always stops it.

## 5. Readiness

`GET /api/readiness` returns:

```json
{ "status": "ok", "data": { "items": [
  { "id": "ffmpeg", "required": true, "ok": false, "fixable": true,
    "detail": "ffmpeg not found at <path>" },
  { "id": "python", "required": true, "ok": true, "fixable": true, "detail": "Python 3.12, packages up to date" },
  { "id": "whisperModel", "required": true, "ok": false, "fixable": true, "detail": "large-v3-turbo not downloaded (1.6 GB)" },
  { "id": "gpu", "required": false, "ok": true, "fixable": false, "detail": "NVIDIA RTX 4060, CUDA 12" },
  { "id": "generateBrowser", "required": false, "ok": false, "fixable": true, "detail": "needed for Generate only" }
] } }
```

`POST /api/readiness/:id/fix` starts the download or install as a background task and returns
`202 {"taskId"}`.

- Progress comes from `GET /api/readiness` (each item gets
  `"progress": {"percent": 0-100, "label": "..."}`). Polled at 1 s.
- A fix runs with pinned versions and SHA-256 checksums from
  `backend/src/readiness/manifest.json`. A checksum mismatch fails the fix with `"checksum
  mismatch"` and deletes the file.
- A fix that needs the network while offline fails with `"offline"`. The UI shows that as
  "Needs internet once".

The readiness logic is TypeScript in the engine (constitution II: Rust only shows it).

## 6. File paths

Clip export and Generate export responses include `exportPath` (absolute, on the engine's
machine).

- The app uses it for "Show in folder" only when the engine is local.
- With a remote engine, "Export" downloads the file over HTTP to a folder the user picks.
- Previews are always downloaded over HTTP (with the token) into the preview cache (research
  R3); the app never reads engine paths for playback.

## 7. Library commands (first run, before the server starts)

The app runs `sorot-engine <command>` with no server env. The engine prints one JSON envelope (the HTTP one: `{"status":"ok","data"}` or
`{"status":"error","error"}`) on stdout and exits (0 on success, non-zero on failure). All the logic is TypeScript; the app
only shows the result.

| Command | `data` | Notes |
|---|---|---|
| `--find-libraries` | `{ candidates: [{ path, ok, videos, clips, hasKeys, problem? }] }` | `problem` = the database won't open, or a schema it can't read; still listed |
| `--copy-library <from> <to>` | `{ copied, skipped: [path] }` | `PROGRESS <n>` lines on stderr; the source is never changed |
| `--import-keys <from>` | `{ imported: [{ key, masked }] }` | reads `<from>/.env.llm` into the `setting` table of `DATA_DIR`; values only ever printed masked |

## 8. Disk space

`POST /api/import` and `POST /api/process` answer
`507 {"status":"error","error":"not enough disk space","data":{"needBytes","freeBytes"}}` (`fail()` gains an optional `data`) before
any work starts when `DATA_DIR` lacks the space the job needs.

## 9. Errors the app must handle

| Case | App behaviour |
|---|---|
| 401 | the connection is broken (token mismatch): restart the engine once, then `Failed` |
| network error, 3 health checks in a row | `Lost`, then auto-restart (max 2 per session) |
| `{"status":"error","error":...}` on an action | inline error at that control, naming what failed and the next step (R-27) |
| engine `api` major version is newer | blocking notice to update the app |
