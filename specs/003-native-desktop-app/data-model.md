# Data Model: Sorot Native Desktop App

**Feature**: `003-native-desktop-app` | **Date**: 2026-11-15

The engine's SQLite schema (`backend/src/db.ts`) is unchanged and stays the source of truth.
The desktop app holds no copy of engine data. It keeps API responses in memory, plus a few
files of its own for app state. API types in `desktop/src/model/` mirror the camelCase JSON in
`docs/api-spec.md` (constitution V) and are deserialized with `serde(rename_all =
"camelCase")`. An unknown field is ignored, and a missing required field is an engine error
shown in the UI.

## App-owned state (files in the OS app data folder)

### Workspace

Where the engine's data lives; one per app instance (FR-015).

| Field | Type | Rule |
|---|---|---|
| `dataDir` | absolute path | default `<appData>/data`, or an existing library chosen at first run (R10) |
| `source` | `new` \| `adopted` \| `copied` | how it was set up |
| `adoptedFrom` | path \| null | the original location when `adopted`/`copied` |
| `engine` | `local` | only `local` in this feature. A remote engine is a later feature; the enum leaves room for it, but no token is stored anywhere yet |

Stored in `<appData>/workspace.json`. Written once at first run; changed only from Settings.

### WindowState (FR-013)

`{ x, y, width, height, maximized, monitorId, lastView, lastJobId? }`, stored through
`rune::prefs::Prefs`. On restore, a position outside every current monitor snaps to the primary
monitor at its default size.

### Preferences

`{ language: "id" | "en" | "system", theme: "system" | "dark" | "light", shortcuts: {action:
chord}, closeBehaviour: "ask" | "background" | "quit", notifications: bool }`, stored through
`Prefs`. Shortcuts are validated so that no chord is bound twice.

### PreviewCache

Files at `<appData>/cache/previews/{clipId}-{updatedAt}.mp4`. An entry is valid while the clip's
`updatedAt` matches; older versions are deleted when a newer one downloads. The cache is
capped at 2 GB, least recently played first out.

## Runtime state (in memory, desktop/src/app.rs)

### EngineConnection

```
Starting -> Ready{port, version} -> (Lost -> Restarting -> Ready) | Stopping -> Stopped
                 \-> Failed{reason}   (engine exited before SOROT_READY or within 10 s)
```

- `Lost`: 3 failed `/api/health` calls in a row.
- `Restarting`: at most 2 automatic restarts per session, then `Failed`, with "Restart
  engine" and "Export diagnostic report" actions.

### ReadinessItem (FR-007)

From `GET /api/readiness`:
`{ id: "ffmpeg"|"python"|"whisperModel"|"gpu"|"generateBrowser", ok, required, detail, fixable,
progress? }`.

```
Unknown -> Checking -> Ok
                    -> Missing{fixable} -> Fixing{progress} -> Ok | FixFailed{reason}
```

- `required` items block clipping until they are Ok.
- `generateBrowser` blocks only Generate.
- `gpu` is informational: it is never required.

### Job (view of the engine `job` + `job_stage` rows)

Engine states plus one the app shows. `interrupted` is a FAILED job whose `errorMessage` is
the engine's `interrupted` sweep reason (R9). The UI shows it as Interrupted with Retry.

```
QUEUED -> RUNNING{stage, percent, label} -> COMPLETED
                                          -> FAILED{error} | CANCELLED
RUNNING --(engine restart)--> FAILED{interrupted}
```

### Clip

The engine `clip` row as served (`score`, `verdict`, `rankPos`, `title`, `hookStart`,
`hookEnd`, `options`, `exportStatus`, `exportPath`, `updatedAt`). The list is ordered by
`rankPos` (AGENTS.md). Edit options layer as config, then job options, then clip options; the
app sends only the clip layer it changed.

### Connection (Jev, LLM, Tebar)

`{ kind, configured, healthy, maskedKey, model?, profiles? }`, from `/api/settings`. Keys are
written through the API and never held after the request (constitution IV).

### Toast and Notification

`{ kind: info|done|failed, text, action?: {label, target} }`. A toast lasts 6 s and pauses on
hover. Done and failed jobs also raise an OS notification when the window is not focused and
notifications are on.

## Engine additions (backend, config-gated)

No schema change. New config and endpoints, detailed in
[contracts/engine-connection.md](contracts/engine-connection.md):

- config: `SERVER_HOST`, `SERVER_PORT=0`, `SOROT_TOKEN`, `STATIC_DIR=""`, `SOROT_PARENT_PIPE`,
  `SOROT_SOLE_OWNER`;
- startup commands `--find-libraries`, `--copy-library <from> <to>` and `--import-keys <from>`
  (the Workspace candidates come only from these);
- a 507 disk-space answer on import and process;
- the `SOROT_READY` stdout line;
- `GET /api/readiness` and `POST /api/readiness/:id/fix`;
- `exportPath` on clip and Generate export responses (the column already exists:
  `clip.export_path`).
