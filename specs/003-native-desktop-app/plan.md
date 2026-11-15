# Implementation Plan: Sorot Native Desktop App

**Branch**: `003-native-desktop-app` | **Date**: 2026-11-15 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/003-native-desktop-app/spec.md`

## Summary

Replace the Next.js web UI with a native desktop app for Windows, macOS and Linux, built on Rune,
the GPU-rendered Rust UI framework the owner chose. The app ships at full parity (FR-020), and
that release removes `frontend/` (FR-019).

**Approach** (research R1): the app is a thin client of the existing engine HTTP API. It starts
the engine (`bun build --compile` of `backend/`) as a child process on loopback, with a
per-launch token, and polls it the way the web UI does today. No pipeline logic moves; the
engine gains only config-gated launch, auth, lifetime and readiness pieces (R12).

**Rune gaps we fill ourselves**: Linux video playback (an ffmpeg pipe player, R3); packaging and
updates (cargo-packager, R8); and a handful of OS shims (R4).

**Design**: the visual direction is in [design.md](design.md): graphite and bone with one
tungsten "beam" accent that marks where attention is, Instrument Sans, and spring motion with
the running job as the one choreographed moment. Dials are ENERGY 2 / RHYTHM 2 / MOTION 2, and
antislop runs in during mode.

## Technical Context

**Language/Version**:
- Rust 1.99.1 (pinned to Rune's toolchain) for `desktop/`.
- TypeScript on Bun for `backend/` changes.
- Python 3.12 (uv-managed at runtime; `ai-pipeline/` unchanged).

**Primary Dependencies**:
- Rune pinned at `73b7dec`, plus `rune-kit`, `rune-motion`, `rune-fx`, `rune-i18n` and
  `rune-notify`.
- `ureq` (HTTP), `serde`/`serde_json`, `cpal` (Linux preview audio), `notify-rust` (Linux),
  `windows` (taskbar, Job Object), `objc2` (macOS open-documents).
- `cargo-packager` + `cargo-packager-updater`.

**Storage**:
- The engine's SQLite in `DATA_DIR`, unchanged.
- App state: `workspace.json` and `rune::prefs::Prefs` JSON in the OS app data folder.
- Preview cache files (data-model.md).

**Testing**:
- `cargo test` with Rune's headless runtime against a `FakeEngine`; `cargo llvm-cov` (95%
  lines and functions, `src/platform/*` excluded by name); `cargo clippy -D warnings`.
- Formal verification: Kani proof harnesses (`cargo kani`, run on Linux: CI or WSL2) for every
  state machine and rule in `desktop/core`, a Rune-free crate, so Kani can compile it.
- No real-machine runs in the task list: OS and process effects sit behind traits and are
  unit-tested with fakes.
- `bun test --coverage` for the engine changes.
- Pixel snapshots on lavapipe/WARP for design acceptance.

**Target Platform**: Windows 10 1903+ x64, macOS 13+ (Apple silicon and Intel), Linux x64
(Ubuntu 22.04+/Fedora 39+, X11 and Wayland, Vulkan).

**Project Type**: Desktop app (Rust) plus the existing local engine (Bun + Python) as a child
process.

**Performance Goals**:
- Window visible within 3 s of launch, and visible response to any action within 100 ms
  (SC-002).
- Smooth frame rate (no visible stutter, `motion_gate` passes) on integrated graphics (SC-006).
- Linux preview: A/V in sync over 60 s, seek within 300 ms.

**Constraints**:
- Clipping works offline after the first-run downloads.
- Zero leftover processes after quit or crash (SC-010).
- Keys never in app files or logs.
- Same clip results as today (SC-004).
- Installer contents are listed in R2.

**Scale/Scope**:
- One user per machine.
- 24 screens or sheets (contracts/desktop-screens.md) replacing about 5,200 lines of web UI.
- About 80 existing API routes, plus 3 new ones (readiness list, readiness fix, and
  `exportPath` on export responses).

## Constitution Check

*Checked against constitution v3.0.0 (amended 2026-11-15 for this feature). Re-checked after
Phase 1 design: unchanged.*

| Principle | Check | Status |
|---|---|---|
| I. Local-First, Host-Ready | The engine binds to loopback with a per-launch token. The app uses only the HTTP API, so a remote engine works unchanged (`Workspace.engine`). Clipping runs offline after the first-run downloads the readiness check names. No hard-coded host paths: everything comes from the launch env. Build order untouched. | PASS |
| II. Language Boundaries | Rust holds only views, OS glue, engine start/stop and preview playback. Readiness logic, library discovery, copy and key import (engine startup commands `--find-libraries`, `--copy-library` and `--import-keys`), the disk-space preflight, and every pipeline or publish decision stay in TypeScript and Python. The app reads no engine files. No new Python. | PASS |
| III. Test Gate | `desktop` joins the gate: headless tests against `FakeEngine`, 95% coverage, clippy clean. OS shims are excluded only by name and kept thin. Engine changes are covered with `createApp(config, deps)` fakes. `frontend/` keeps its gate until it is removed. | PASS |
| IV. Optional AI, Rules Fallback | Clipping never checks AI. Generate shows as unavailable with a link to Settings. Keys stay in the SQLite `setting` table, masked, written only through the API, and the diagnostic report redacts them. | PASS |
| V. Stable Contracts | No API shape changes, only additions: `exportPath`, readiness routes, 401 when a token is set. CamelCase types mirror `store.ts`. Schema unchanged. `frontend/` stays a static export with fixes only until the parity release removes it. | PASS |
| VI. Safe Publishing | The publish screen keeps draft, then choices, then post, with the choices required and empty by default. Idempotency stays in the engine. | PASS |
| Platform & Stack | Rune is pinned with its `[patch]` entries copied. Rune gaps are filled by listed modules (R4), and no feature is dropped on one OS silently. Installers come only from `release-desktop.yml`. Docker stays for the engine. | PASS |
| Governance | The amendment needs `AGENTS.md`, `CLAUDE.md` and docs updates in the same change: Phase A, task A1. | PASS (tracked) |

There are no violations, so Complexity Tracking lists only the added complexity the constitution
asks us to justify against Principle I.

## Project Structure

### Documentation (this feature)

```text
specs/003-native-desktop-app/
├── spec.md
├── plan.md                    # this file
├── research.md                # Phase 0: R1-R12, owner inputs
├── design.md                  # design direction (becomes desktop/DESIGN.md)
├── data-model.md              # Phase 1
├── quickstart.md              # Phase 1: validation runs
├── contracts/
│   ├── engine-connection.md   # launch, handshake, auth, lifetime, readiness, paths
│   └── desktop-screens.md     # parity map, behaviours, keyboard map
├── checklists/requirements.md
└── tasks.md                   # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
desktop/                        # NEW: Cargo workspace, own Cargo.lock
├── Cargo.toml                  # workspace [core, app-level crate below]; rune pin + [patch] entries; packager metadata
├── core/                       # sorot-desktop-core: pure logic, NO Rune / OS deps, Kani proofs
│   └── src/  model.rs handshake.rs engine_conn.rs polling.rs redact.rs toast.rs readiness.rs
│             close.rs workspace.rs job.rs clips.rs cache.rs av_clock.rs contrast.rs prefs.rs
│             window.rs palette_search.rs publish_gate.rs availability.rs masked.rs update.rs
│             (each with #[cfg(kani)] proofs + table-driven unit tests)
├── rust-toolchain.toml         # 1.99.1
├── DESIGN.md                   # from specs/003-native-desktop-app/design.md
├── RUNE.md                     # pin, patches, bump log (R11)
├── design/                     # figcraft/Figma exports: tokens.json, frames/*.png (reference only)
├── theme/sorot.json            # dark + light tokens, generated from design/tokens.json
├── i18n/id.json, en.json       # rune-i18n catalogs
├── assets/fonts/               # Instrument Sans (OFL)
├── assets/icon/                # icon set exported from the figcraft Brand page
├── src/
│   ├── main.rs                 # AppSpec, single_instance, argv "open with"
│   ├── app.rs                  # root state, routing, EngineConnection state machine
│   ├── engine/
│   │   ├── mod.rs              # Engine trait (every API call)
│   │   ├── http.rs             # ureq client, bearer token, polling cadence
│   │   └── sidecar.rs          # spawn, SOROT_READY, restart policy, shutdown
│   ├── model/                  # serde types mirroring docs/api-spec.md
│   ├── screens/                # one module per row of contracts/desktop-screens.md
│   │   ├── shell.rs  home.rs  job.rs  clips.rs  editor.rs  publish.rs
│   │   ├── learning.rs  discover.rs  readiness.rs  welcome.rs
│   │   ├── settings/ (connections.rs, generate.rs, general.rs)
│   │   └── generate/ (brief, ideas, facts, storylines, plan, build, verdict, versions, recipes, kit)
│   ├── ui/                     # beam.rs (motif), stage_track.rs, clip_stage.rs, score.rs,
│   │                           # palette.rs (command palette), menu_bar.rs, toast.rs, states.rs
│   ├── preview/
│   │   ├── mod.rs              # Preview trait + cache download
│   │   ├── rune_player.rs      # Windows + macOS
│   │   └── ffmpeg_player.rs    # Linux: ffmpeg pipes + cpal, audio clock
│   └── platform/               # thin OS shims, each listed in desktop/coverage-exclude.txt
│       ├── process_windows.rs  process_unix.rs  tray.rs  reveal.rs  notify_linux.rs
│       ├── taskbar_windows.rs  window_state.rs  open_documents_macos.rs  gpu_probe.rs
│       └── (tests/platform_list.rs fails on any unlisted file or a listed one over 80 lines)
└── tests/
    ├── support/                # FakeEngine (fixtures shared with frontend/test/fakeApi.ts), click/type helpers
    ├── screens_*.rs            # headless behaviour + states per screen
    ├── a11y.rs                 # role + name on every control
    ├── motion.rs               # motion_gate on job and clips
    └── snapshots/              # approved PNGs, dark + light, 2 sizes

backend/src/                    # CHANGED (config-gated, Docker behaviour unchanged)
├── config.ts                   # SERVER_HOST, port 0, SOROT_TOKEN, SOROT_PARENT_PIPE, SOROT_SOLE_OWNER
├── index.ts                    # SOROT_READY line, stdin-close shutdown
├── http.ts                     # bearer check when a token is set
├── jobs.ts                     # sweep cutoff 0 + reason "interrupted" when sole owner
├── readiness/                  # NEW: checks, fixes, manifest.json (pinned URLs + SHA-256)
├── library/                    # NEW: --find-libraries, --copy-library, --import-keys startup commands
└── app.ts                      # /api/readiness routes; exportPath on export responses

cli/src/                        # CHANGED: --token / SOROT_TOKEN
.github/workflows/
├── ci.yml                      # CHANGED: desktop job on windows, macos, ubuntu (lavapipe)
└── release-desktop.yml         # NEW: cargo-packager builds, signed latest.json

frontend/                       # REMOVED in the parity release (FR-019); fixes only until then
```

**Structure Decision**: one new top-level crate `desktop/`, beside the Bun workspace, which it
does not join (Cargo has its own lockfile). The engine stays where it is, and its changes are
config-gated, so Docker, the CLI and hosted mode behave as before when the new env vars are
unset.

## Delivery Order

Stories set the build order; the single release ships at full parity (FR-020).

- **A. Foundations**:
  - **A1**: land the constitution v3.0.0 amendment together with `AGENTS.md`, `CLAUDE.md` and
    the docs follow-ups.
  - **A2**: engine changes (R12) with tests.
  - **A3**: `desktop/` skeleton with the Rune pin, theme, fonts, i18n and `FakeEngine`, plus
    CI on three OSes.
- **B. Risk checks**: the owner asked for no real runs in the build, so these four are manual
  owner checks before the parity release, not gate steps:
  - **B1**: Linux ffmpeg preview (quickstart 6).
  - **B2**: `BUN_BE_BUN` running HyperFrames from the compiled engine (R2).
  - **B3**: cargo-packager producing the five installers from CI.
  - **B4**: macOS open-documents handler.

  Their logic is unit-tested and proved (`av_clock`, sidecar, packager config). If B1 or B2
  fails, the fallbacks are already chosen: R3 alternatives for B1, shipping the `bun` binary
  for B2.
- **C. US1 + US3**: shell, readiness, welcome/library adoption, engine lifetime, and the design
  system in `ui/`.
- **D. US2**: home, job, clips, editor, preview, export and reveal.
- **E. US4**: command palette, menu bar, shortcuts, window state, open with, notifications,
  taskbar.
- **F. US5**: settings and connections, learning, discover, publish, and every Generate screen.
- **G. US6**: updater, crash recovery, diagnostic report.
- **H. Parity release**:
  - the parity checklist (contracts/desktop-screens.md) is complete and quickstart 1-8 pass;
  - the antislop Delivery Gate report is attached;
  - `frontend/` is removed, along with its gate entry, `STATIC_DIR` serving and the CORS rule
    for `next dev`;
  - the CHANGELOG is updated.

## Complexity Tracking

> Added complexity, justified against Principle I as the constitution's Governance asks.

| Added | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Own Linux preview player (`preview/ffmpeg_player.rs`) | Rune has no Linux video backend, and in-app preview is part of parity | the system player breaks FR-003 parity; GStreamer or libmpv add large system dependencies, and libmpv needs OpenGL while Rune on Linux is Vulkan only |
| Engine readiness downloader (`backend/src/readiness/`) | first run without terminal or scripts (FR-001, FR-007) | bundling everything makes a 3 GB+ installer per GPU variant, and requiring Docker breaks FR-001 |
| Nine OS shims (`desktop/src/platform/`, listed in `coverage-exclude.txt`) | Rune gaps per OS (R4) | dropping the feature on one OS is forbidden by the constitution, and in-app fallbacks are used wherever they are enough |
| Preview cache download instead of a direct URL | Rune's Windows player sends no headers, and remote engines need a local copy | a token in the URL leaks into logs |
