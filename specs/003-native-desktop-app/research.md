# Research: Sorot Native Desktop App

**Feature**: `003-native-desktop-app` | **Date**: 2026-11-15 | **Plan**: [plan.md](plan.md)

Sources: the Rune source read at commit `73b7dec296e6c1284ebdf8af53f544444611c0ae` (`dev`,
2026-11-14), read only, nothing built; this repo (`backend/src/index.ts`, `config.ts`, `jobs.ts`,
`app.ts`, `scripts/install.ps1`, `ai-pipeline/requirements*.txt`, `frontend/src`). Rune paths
below are relative to the Rune repo root.

## R1. How the app talks to the engine

**Decision**: The Rune app is a client of the existing engine HTTP API (`docs/api-spec.md`,
about 80 `/api/*` routes the web UI uses today). The app starts the engine as a child process
bound to `127.0.0.1` on a free port with a per-launch bearer token, and talks to it with a
blocking HTTP client (`ureq`) on Rune worker threads (`rune::task::spawn`, results applied with
`AppHandle::update`). Progress is polled: 1 s while a job runs, 5 s otherwise, the same
adaptive rhythm the web UI uses.

**Rationale**: The constitution (v3.0.0, I, II, V) keeps every decision in the engine and asks
the UI to work against a local or a remote engine. Reusing the API means zero pipeline code in
Rust, the CLI and the app share one contract, and a hosted engine later needs no UI work.
Rune has no HTTP client and no async runtime (`crates/rune/README.md:1885`), but it documents
threads plus `AppHandle::update` and `tx.wake_after` for exactly this (`README.md:458-466,
573-588`). The engine already has no server push (polling only), so nothing new is needed.

**Alternatives considered**: linking the engine in-process (impossible: Bun/TypeScript and
Python); a new RPC protocol over stdio (a second contract to keep in step with the CLI, and no
path to a remote engine); `reqwest` + tokio (a runtime the rest of the app does not need).

## R2. Engine packaging and first-run components

**Decision**:
- The installer ships: the `sorot` desktop binary; the engine compiled with
  `bun build --compile` (`sorot-engine`, the same way `cli/` already builds `dist/sorot`);
  `ai-pipeline/` scripts; `generator/` (prompts, recipes, kit, fonts, presets) with the
  `hyperframes` package; and the `uv` binary.
- On first run, the readiness check downloads the rest with pinned versions and checksums
  into the app data folder:
  - ffmpeg (static build per OS);
  - a Python 3.12 runtime and the `ai-pipeline/requirements.txt` packages, via `uv`;
  - CUDA wheels when an NVIDIA GPU is found;
  - the Whisper model.
  Generate's browser (`hyperframes browser ensure`) downloads on first use of Generate.
- HyperFrames runs through the compiled engine acting as Bun (`BUN_BE_BUN=1`), so no
  separate Bun or Node install is needed. **Verify in the packaging spike (T-spike-3)**: if
  `BUN_BE_BUN` cannot run `hyperframes.mjs`, ship the `bun` binary next to the engine instead.

**Rationale**: `install.ps1 -Mode native` already proves the engine runs without Docker (Bun, a
venv, ffmpeg from winget). `uv` installs a Python of its own, so users need no system Python.
Downloading ffmpeg instead of bundling it keeps the installer small and leaves GPL ffmpeg
builds out of the MIT app's installer. The Whisper model is about 1.6 GB and was always a first-run
download.

**Alternatives considered**: bundling everything (installer > 3 GB with CUDA, and two GPU
variants); requiring Docker (contradicts FR-001: no terminal or scripts); PyInstaller-frozen
Python (fragile with faster-whisper/CTranslate2 and CUDA, and hides the per-script JSON envelope
the runner depends on).

## R3. Clip preview playback

**Decision**: A `Preview` trait in `desktop/src/preview/` with two backends:
- Windows and macOS: Rune's `Player` (Media Foundation / AVFoundation, `crates/rune/README.md:
  1948-2026`), unmuted explicitly (clips start muted).
- Linux: our own `ffmpeg_player`, which spawns the downloaded ffmpeg twice: once for video
  decoded to RGBA at preview size, pushed into a Rune `NativeSurface` with `push_bytes`, and
  once for audio as `s16le` PCM played through `cpal`. Video frames are paced on the audio clock.
  Seeking restarts both decoders at `-ss`.
- Previews are fetched over HTTP with the bearer token into `cache/previews/{clipId}-{version}.mp4`
  and played from that local file in both modes.

**Rationale**: Rune has no Linux video backend at all (`crates/rune/src/video/mod.rs:44-52`,
`video/unsupported.rs:7`), and the constitution forbids silently dropping a feature on one OS.
Previews are short H.264 MP4s (15-60 s, 9:16), so a pipe decoder is enough. ffmpeg is already a
dependency, so no new system library is added. Downloading to a cache solves a second gap: Rune's
Windows player cannot send request headers on URLs (`README.md`, Windows notes), so it cannot
play an authenticated URL directly, and remote engines need a local copy anyway.

**Alternatives considered**: GStreamer (a large system dependency with distro-specific
plugins); libmpv (renders through OpenGL, while Rune on Linux is Vulkan only); opening the
system video player on Linux (breaks in-app preview parity, FR-003); a token in the query
string (tokens in URLs end up in logs).

**Risk and spike**: A/V sync and seek latency of the Linux player are the largest unknowns.
The first task in the plan is a spike that plays one exported clip with sound and seeks, on
Ubuntu 24.04, before any screen work depends on it.

## R4. OS integration where Rune has gaps

Rune feature coverage (`crates/rune/src/...`, from the source read) and what we add. Every
"ours" item is a thin module under `desktop/src/platform/`, listed in the coverage config
(constitution III).

| Need (FR) | Windows | macOS | Linux |
|---|---|---|---|
| Notifications (FR-012) | `rune-notify` | `rune-notify` | ours: `notify-rust` (D-Bus); none on the bus = in-app toast only |
| Taskbar/dock progress (FR-012) | ours: `ITaskbarList3::SetProgressValue` via `windows` crate (Rune has only Busy) | Rune dock badge, text = percent | none; in-app progress only |
| Menu (FR-012) | in-app menu bar (rune-kit `Menu`) | Rune native menu bar | in-app menu bar |
| Command palette (FR-012) | ours, built on rune-kit `Combobox` (searchable, virtualized) | same | same |
| Show in folder (US2-4) | ours: `explorer /select,<path>` | ours: `open -R <path>` | ours: D-Bus `org.freedesktop.FileManager1.ShowItems`, fallback `xdg-open <dir>` |
| Drop files in (FR-012) | Rune | Rune | Rune on X11; on Wayland no drop, so the import field's "Choose file" (portal dialog) covers it |
| Open with Sorot (FR-012) | installer file association; file arrives as launch argument, forwarded by Rune `single_instance` | ours: Apple Event open-documents handler (`objc2`), plus `CFBundleDocumentTypes` in the bundle | `.desktop` `MimeType=video/*`; launch argument forwarded by `single_instance` |
| Single instance (FR-015) | Rune `single_instance` (named pipe) | Rune | Rune (Unix socket) |
| Window state (FR-013) | ours on `rune::prefs::Prefs` + `AppHandle::set_position` | `rune_mac::remember_frame` | same as Windows |
| Tray / keep running (US1-3) | Rune tray | no tray in Rune: the Dock icon stays while jobs run, app keeps running with no window (normal macOS behaviour) | Rune tray (StatusNotifierItem); none = keep the window minimized |

**Rationale**: these are the gaps the source read found; each fallback keeps the feature with
an in-app equivalent instead of dropping it (constitution, Platform & Stack Constraints).

## R5. Accessibility, keyboard, text input, i18n

**Decision**: Use Rune's AccessKit integration (UI Automation, NSAccessibility, AT-SPI;
`crates/rune/README.md:2383-2451`), copying its vendored `[patch]` entries. Every control gets
`.role()` and `.label()`; tests assert on `accessibility_json`. Keyboard uses Rune's Tab order,
`focus_group` and modal focus traps. Text fields use rune-kit `TextInput`/`TextArea` (IME on all
three, spellcheck). Strings live in `rune-i18n` JSON catalogs (`desktop/i18n/id.json`, `en.json`)
with compile-time-checked keys; Indonesian is the default, OS language picks English.

**Rationale**: covers FR-011 and FR-018 with built-in parts; Indonesian is Latin script, so
IME risk is low (Linux lacks only reconversion).

## R6. Rendering, theme, motion, weak GPUs

**Decision**: Our own theme JSON (`desktop/theme/sorot.json`, `Theme::from_json`), not Rune's
`themes/opencode` (that is another product's identity; antislop R-30). Dark and light variants
follow the OS through Rune's `system_dark`. Motion uses `rune-motion` springs. Reduced motion
comes from the OS (Rune snaps movement and shortens fades to 0.15 s), and `rune-fx` layers use
`.reduced()`. `backdrop_blur` is used on at most two surfaces (design.md); Rune caps it at 4 per
frame anyway. With no GPU, Windows falls back to Rune's CPU renderer (no blur, no video surface),
and the app shows one notice and plays previews in the system player there. Linux needs Vulkan,
with Mesa lavapipe as the software path.

**Rationale**: FR-009 and FR-010 using built-in parts; the no-GPU path keeps every function.

## R7. Testing and the coverage gate

**Decision**:
- `cargo test` with Rune's headless `Runtime::new(state, view, size, Env)`: `rt.frame(dt)`,
  pointer and key input, `rt.state`, `find(key)`, `accessibility_json`, `resolve_file_dialog`
  (`crates/rune/tests/inert.rs:34-58`).
- All engine calls go through an `Engine` trait. Tests use `FakeEngine` (canned API JSON taken
  from `frontend/test/fakeApi.ts` fixtures, so both UIs are tested against the same shapes).
- Pixel snapshots (`Gpu::headless()` + `Offscreen`) are used only for the design acceptance
  screens, on lavapipe (Linux CI) and WARP (Windows CI).
- `rune::motion_gate` fails janky motion.
- UI verification without a window uses Rune's agent tooling (`crates/rune/README.md`, "Agent
  tooling"): the debug binary takes `--scene`, `--snap`, `--tree` (role, label, text, rect,
  colours per element) and `--script` (tap, key, type, resize, drop_files, file-dialog,
  menu-pick, marks) on a virtual clock. In headless mode the app loads `FakeEngine` scenes
  instead of starting the engine. Integration tests run the built binary and assert on the tree.
  This covers the scripted flows, snapshots, reflow and the antislop click-through.
- Coverage: `cargo llvm-cov --fail-under-lines 95 --fail-under-functions 95`, with
  `desktop/src/platform/*` shims excluded by name.
- Lint: `cargo clippy -- -D warnings`.

**Rationale**: meets constitution III without real services. Rune has no public test crate, so
`desktop/tests/support/` holds our click and type helpers.

## R8. Packaging, signing, updates

**Decision**:
- `cargo-packager` builds NSIS `.exe` (Windows), `.app` + `.dmg` (macOS) and AppImage + `.deb`
  (Linux) from `[package.metadata.packager]` in `desktop/Cargo.toml`.
- `cargo-packager-updater` checks a signed `latest.json` on GitHub Releases. It is
  minisign-signed with a key whose private half lives only in the release workflow's secrets.
- Builds come from a new `release-desktop.yml`, run on a published release or by hand
  (constitution: installers only from the release workflow).
- Signing in v1:
  - Windows unsigned (the SmartScreen "More info, Run anyway" step is documented).
  - macOS ad-hoc signed. Gatekeeper needs System Settings, Open Anyway; this is documented.
  - Developer ID notarization is added when the owner has an Apple Developer account (owner
    input, not blocking).

**Rationale**: Rune bundles nothing (`crates/rune/README.md:656`; only a Mac dev script
exists). cargo-packager covers all three OSes and has an updater from the same project.

**Alternatives considered**: WiX MSI + create-dmg + appimagetool by hand (three toolchains);
Tauri bundler (tied to Tauri's config).

## R9. Process lifetime and no stray processes

**Decision**:
- The app starts the engine with a pipe on stdin. The engine exits when that pipe closes
  (`SOROT_PARENT_PIPE=1`), so an app crash still stops it.
- Windows: the engine runs in a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so its
  Python/ffmpeg children die with it.
- macOS/Linux: the engine is started in its own process group, and the app sends
  `killpg(SIGTERM)`, then `SIGKILL` after 5 s.
- On a normal quit the engine cancels running jobs (the existing whole-tree cancel in
  `runner.ts`) before exiting.
- At startup in desktop mode, the engine marks every job still RUNNING as interrupted at once
  (`sweepOrphans` with cutoff 0; today it uses 30 min, since several hosts could share a
  database). The UI offers retry.

**Rationale**: SC-010 (zero leftover processes) and FR-017/SC-009 (interrupted jobs retryable),
using cancel code that already exists.

## R10. Existing data (FR-004, SC-005)

**Decision**:
- Data lives in the OS app data folder: `%APPDATA%\Sorot`, `~/Library/Application
  Support/Sorot`, `$XDG_DATA_HOME/sorot`.
- On first run the **engine** looks for existing libraries, through the startup command
  `sorot-engine --find-libraries`, which prints JSON and exits without serving. It checks the
  native or Docker install folder from `install.ps1`/`install.sh` (its `data/`), `/etc/sorot/`
  settings, and a repo checkout's `data/`. Each candidate reports `ok`, its video and clip counts,
  `hasKeys`, and a `problem` if the database won't open.
- The app only shows the choices: **Use it here** (the engine's `DATA_DIR` points at it, no
  copy) or **Copy it** (`--copy-library`, with progress, which lists skipped files and never
  deletes the source).
- Keys in the `.env.llm` next to that library are imported by `--import-keys` into the SQLite
  `setting` table. The app never reads engine files (constitution I and V), and all the logic is
  TypeScript (II).
- Schema changes stay additive (`db.ts` already guarantees old databases open), so the web
  version keeps working on the same data until it is retired.

**Rationale**: zero manual steps, no data duplication, and nothing that breaks the current
version (FR-004).

## R11. Rune pin and upgrade cost

**Decision**:
- Pin `rune = { git, rev = "73b7dec296e6c1284ebdf8af53f544444611c0ae" }` (re-checked
  at the start of implementation), plus `rust-toolchain.toml` = `1.99.1` to match Rune.
- Copy Rune's `[patch]` entries for winit, wgpu-hal, parley_engine, accesskit_windows and
  accesskit_macos.
- A bump is its own change running the full gate on all three OSes (constitution).
- `desktop/RUNE.md` records the pin, the patches, and what each bump broke.

**Rationale**: Rune is 0.0.1, pre-release, with about 700 changelog entries in two weeks and
CI only on macOS. Our own CI on Windows and Linux is the only guard against regressions there.

## R12. Engine changes the app needs

All small, in `backend/`, each behind config so Docker and hosted behaviour is unchanged:

| Change | Why |
|---|---|
| `SERVER_HOST` (default `0.0.0.0`; app sets `127.0.0.1`) | loopback only (constitution I) |
| `SERVER_PORT=0` picks a free port; engine prints one line `SOROT_READY {"port":..,"version":..}` on stdout | handshake without port clashes |
| `SOROT_TOKEN`: when set, every `/api/*` request needs `Authorization: Bearer <token>`, else 401 | constitution I |
| `STATIC_DIR=""` serves no web UI | the app is the UI |
| `SOROT_PARENT_PIPE=1`: exit when stdin closes | R9 |
| `SOROT_SOLE_OWNER=1`: startup sweep with cutoff 0, reason `interrupted` | R9 |
| `GET /api/readiness`: ffmpeg, Python env, Whisper model, GPU, HyperFrames browser, each `{id, ok, detail, fixable}`, and `POST /api/readiness/:id/fix` running the download with `PROGRESS` reporting | FR-007 |
| clip and Generate export responses include the absolute `exportPath` | "show in folder" (local engine only) |

Details in [contracts/engine-connection.md](contracts/engine-connection.md).

## Owner inputs still open (not blocking the plan)

1. **App icon and logo** (antislop R-23): the owner asked for them to be designed in figcraft
   (2026-11-15; tasks Phase 1, `Brand` page). The owner approves them at the Phase 1 checkpoint.
2. **Apple Developer account** for notarization (R8).
3. **Windows code-signing certificate** (R8).
