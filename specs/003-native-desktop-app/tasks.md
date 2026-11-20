---
description: "Task list for the Sorot native desktop app (Rune)"
---

# Tasks: Sorot Native Desktop App

**Input**: Design documents from `specs/003-native-desktop-app/` (plan.md, spec.md, research.md,
design.md, data-model.md, contracts/, quickstart.md); constitution v3.0.0.

**Owner instructions for this list (2026-11-15)**:
1. **Design first, in figcraft.** Phase 1 builds the design through the figcraft MCP (server `figcraft-cli`: headless
   `figcraft-cli mcp`, no app window, file writes confined to this repo) before any code. The
   design file is `desktop/design/sorot-desktop.figcraft`, saved with `file.saveAs` / `file.save`.
2. **Verify with formal verification, no real runs, just unit tests.** Every rule and state
   machine lives in the Rune-free crate `desktop/core` and is proved with Kani
   (`#[cfg(kani)] #[kani::proof]` harnesses, run with `cargo kani` on Linux: CI or WSL2). It is
   also covered by unit tests. OS, process, network and GPU effects sit behind traits and are
   unit-tested with fakes. No task runs the app in a window, builds an installer, or uses a real
   machine; the manual runs in quickstart.md stay documentation.
   **UI verification uses Rune's headless agent tooling** (`crates/rune/README.md`, "Agent
   tooling"): debug builds take `--snap out.png [--scene S] [--theme dark|light] [--size WxH]
   [--at T]`, `--tree tree.json [--at T]` (every element's key, role, label, text, presented
   rect, colours, hover/press) and `--script flow.json` (timestamped `tap`/`key`/`type`/`drag`/
   `resize`/`drop_files`/`file-dialog`/`menu-pick` events at an element `key`, plus `mark`s), on a
   fixed virtual clock with no window. In headless mode the app never spawns the engine: it loads a
   `FakeEngine` scene. Integration tests run the built binary
   (`env!("CARGO_BIN_EXE_sorot-desktop")`) with a script, then assert on the `--tree` JSON. That
   is the evidence for every screen behaviour and for the antislop click-through (R-35).
3. **Tests follow AGENTS.md / CLAUDE.md**:
   - one test per behaviour, asserting only what proves it;
   - a new case is a table row before it is a new test (`test.each` in Bun; a `const CASES: &[..]`
     table looped in one `#[test]` in Rust);
   - shared fakes only: `backend/tests/helpers.ts` (`makeEnv`, `procOk`, ...) and
     `desktop/tests/support/` (`FakeEngine`, `FakeProc`, `click`, `type_text`);
   - no assertion that re-proves another (constitution III). Each behaviour is tested at
     **exactly one level**:
     - **L1, `desktop/core`**: invariants are Kani proofs. Unit tables only hold concrete cases a
       proof does not imply (mappings, defaults, exemptions). A Kani proof is never repeated as a
       unit test. Two exceptions: `contrast.rs` (floating-point `powf`, which Kani handles poorly) is a unit
       table only, and `redact.rs` (heap string building) and `cache.rs` (Vec eviction logic), which exceeded 10 min or
       the 4 GB Kani memory cap, are exhaustive bounded unit tests over the same bound a proof would
       use. Kani always runs one harness at a time under `ulimit -v 4194304`.
     - **L2, in-process Rune `Runtime` tests inside each screen task**: that screen's own wiring,
       meaning control → engine call and body, and its empty/loading/error states. They don't
       re-check a rule L1 proved; they check only that the screen shows L1's answer.
     - **L3, binary headless flows (`desktop/tests/headless_flows.rs`)**: only journeys across
       two or more screens, or input only the binary has (`drop_files`, `file-dialog`,
       `menu-pick`, `resize`, argv forwarding, scenes). They assert the journey's end state and
       its cross-screen effects, never a per-control call that an L2 test already asserts;
   - gate: 100% pass, at least 95% line and function coverage, zero type errors (Rust:
     `cargo check` + `cargo clippy -- -D warnings`); `/test` (test-runner) verdict OPEN or BLOCKED.

**Format**: `- [ ] T### [P?] [US?] Description with file path`. `[P]` = can run in parallel
(different files, no dependency on an unfinished task).

**Manual owner checks (outside the gate, not run by the implementing agent)**: the four risk
checks from plan.md (Linux A/V preview sync and seek, the compiled engine running HyperFrames
with `BUN_BE_BUN`, the installers building from `release-desktop.yml`, the macOS open-documents
handler) and the real-run success criteria (SC-001 install time, SC-002 window within 3 s,
SC-008 screen-reader passes, SC-010 no leftover processes, and the close-while-running dialog re-showing the window, since Rune has no close veto) are run by the owner from
quickstart.md sections 2, 3, 6, 7 and 8 before the parity release (T115 waits for them). The
results are recorded in the journal (T116). Unit tests and Kani cover their logic; only these
manual runs cover their real-machine behaviour.

**antislop**: during mode for every UI and copy task. Each UI task follows `design.md` and the
antislop core and UI rules; the Delivery Gate report closes Phase 10.

---

## Phase 1: Design (figcraft first)

**Purpose**: the approved design the code follows. Tokens, components and every screen, in dark
and light, built in figcraft (headless) from `specs/003-native-desktop-app/design.md`.

- [x] T001 Using the figcraft MCP, create the figcraft file `desktop/design/sorot-desktop.figcraft` (`file.saveAs`) with pages `Foundations`, `Brand`, `Components`, `Screens: dark`, `Screens: light`, `Motion notes`; record the file path and how to open it (`figcraft-cli info`, or the figcraft app) in `desktop/design/README.md`
- [x] T002 Using figcraft, create variable collections `color` (modes `dark`, `light`) with exactly the tokens in design.md (`bg`, `surface`, `raised`, `divider`, `edge`, `text`, `muted`, `beam`, `beamText`, `steel`, `pass`, `review`, `skip`, hex values verbatim), `space` (4/8/12/16/24/40/64) and `radius` (2/6/10) on the `Foundations` page
- [x] T003 Using figcraft, create text styles in Instrument Sans: 12/13/15/19/26/40, weights 400/500/600, tabular figures on the `numeric` styles, sentence case only (no wide-tracked uppercase, R-06), on the `Foundations` page
- [x] T004 Using figcraft, draw the beam motif component (light falloff from `beam` at 100% to 0%, head glow) in variants `stage`, `clip`, `hook`, `action`, with the reason line from design.md in the component description, on the `Components` page
- [x] T005 Using figcraft, build components with hover, pressed, focused, disabled and error variants (R-39): Button (primary, secondary, quiet), TextField, TextArea, Select, Switch, Checkbox, Radio, verdict mark (PASS/REVIEW/SKIP with the word), score bar, stage track, clip row, clip stage (9:16), transport bar (blur, one of the two glass surfaces), command palette (blur, the other), menu bar, rail, toast, dialog, empty/loading/error state block, on the `Components` page
- [x] T006 Using figcraft, design every screen in `contracts/desktop-screens.md` (shell, readiness, welcome/library, home, job, clips, editor, publish, learning, discover, settings ×3, generate ×10) at 1280×800 in dark on `Screens: dark`. Each screen has one beam focal point per the design.md table, and its empty, loading and error states name the cause and the next action (R-27). Copy is in Indonesian, with English in the layer notes, and has no em dashes or buzzwords (R-02, R-16)
- [x] T007 Using figcraft, duplicate every screen into `Screens: light` bound to the `light` mode; add 1920×1080 frames for home, job, clips and editor (resizing behaviour, US3-5)
- [x] T008 Using figcraft, annotate the motion on the `Motion notes` page: beam travel on `PROGRESS`, clip rank spring, shared-element move clips→editor, hover 120 ms, toast 6 s with pause on hover, reduced-motion equivalents (instant moves, 0.15 s fades); no endless loops (R-19)
- [x] T009 Using figcraft, design the app icon and the wordmark on a new page `Brand` (the owner asked for this on 2026-11-15, so it is an instructed asset under R-23, approved at the Phase 1 checkpoint). Concept from design.md: the beam, a single tungsten light cone (`beam` `#F0B44C`, falloff to transparent) cutting across a graphite (`bg` `#0E0F11`) rounded square, with the cone's head at the upper left like a stage light, and no letters inside the icon. Requirements:
  - it reads at 16 px, so the cone stays one solid wedge with no thin rays;
  - variants: macOS (full-bleed square, 22% radius, the OS adds the mask), Windows (transparent corners, 16/24/32/48/256 px), Linux (512 px), and a one-colour version for the Linux tray and the macOS template image;
  - the wordmark is "Sorot" in Instrument Sans 600 with a hand-adjusted `S`.

  Record the one-line reason for each choice (R-31) in the component descriptions.
- [x] T010 Using figcraft, export the variables to `desktop/design/tokens.json` with `variable.export {format: "json", path}` (figcraft variables JSON), every screen frame to `desktop/design/frames/{screen}-{dark|light}-{w}x{h}.png`, and the `Brand` page to `desktop/assets/icon/` (`icon-1024.png`, `icon.icns` source PNGs at 16-1024, `icon.ico` source PNGs at 16/24/32/48/256, `icon-512.png`, `tray-template.svg`) and `desktop/assets/wordmark.svg`
- [x] T011 Run the antislop Delivery Gate Blocks 1-4 and the UI Skill Checklist against the exported frames by inspection, and write the PASS/FAIL report with evidence per item to `desktop/design/antislop-gate-design.md`. Fix every FAIL via figcraft and re-export (T010) before Phase 2

**Checkpoint**: the owner approves the design file, including the icon and wordmark on `Brand`.
Tokens and frames are committed under `desktop/design/`, and the icon set under
`desktop/assets/icon/`.

---

## Phase 2: Setup

- [x] T012 Land the constitution v3.0.0 follow-ups in one change. In `AGENTS.md`: Stack line adds `desktop/`; Commands add `cd desktop; cargo test; cargo clippy --all-targets -- -D warnings; cargo llvm-cov ...; cargo kani -p sorot-desktop-core`; Gate names desktop and Kani; Rules "API, UI, DB" replaces the Next.js rule with the desktop rule and the transition clause. In `CLAUDE.md`: the test gate line. Also update `docs/architecture.md`, `docs/folder-structure.md`, `docs/release.md`, `README.md`, and add an `## [Unreleased]` entry in `CHANGELOG.md`. Then remove the Sync Impact Report comment from `.specify/memory/constitution.md`
- [x] T013 Create the Cargo workspace `desktop/Cargo.toml` (members `.` = package `sorot-desktop`, `core` = `sorot-desktop-core`) with `rune`, `rune-kit`, `rune-motion`, `rune-fx`, `rune-i18n`, `rune-notify` from `git = "https://github.com/anomalyco/rune", rev = "73b7dec296e6c1284ebdf8af53f544444611c0ae"`; copy Rune's `[patch]` entries (winit, wgpu-hal, parley_engine, accesskit_windows, accesskit_macos) verbatim from the Rune repo `Cargo.toml` at that rev; add the crate feature `headless = ["rune/tooling"]` (debug builds already have the tooling; the feature lets CI run it in release too, and release installers build without it); add `desktop/rust-toolchain.toml` with `channel = "1.99.1"`
- [x] T014 [P] Create `desktop/core/Cargo.toml` with only `serde`, `serde_json` and `thiserror`, plus `kani` config (`[package.metadata.kani] flags = { default-unwind = "8" }`). **No Rune and no OS crates**, so Kani compiles it; add `desktop/core/src/lib.rs` declaring the modules listed in plan.md
- [x] T015 [P] Write `desktop/RUNE.md`: the pin, why each `[patch]` exists, the bump procedure (own change, full gate on three OSes), and an empty bump log
- [x] T016 [P] Add `desktop/assets/fonts/InstrumentSans-*.ttf` (OFL, with `OFL.txt`); build `icon.icns` and `icon.ico` from the exported PNGs of the figcraft `Brand` page (T009, T010) and reference them, plus `icon-512.png` and `tray-template.svg`, from `desktop/Cargo.toml` packager metadata and the tray shim; `desktop/assets/icon/README.md` names the design source
- [x] T017 [P] Create `desktop/i18n/id.json` and `desktop/i18n/en.json` catalogs (rune-i18n format) seeded with the shell and readiness strings from the design frames; Indonesian is the default
- [x] T018 Write `tokens_to_theme(tokens_json) -> theme_json` in `desktop/core/src/theme_gen.rs` (figcraft `variable.export` JSON, modes `dark`/`light` → Rune `Theme::from_json` format), with a unit table (each token kind, a missing mode → error), and `desktop/build.rs` calling it to write `desktop/theme/sorot.json` from `desktop/design/tokens.json`; the theme is generated, never hand-edited
- [x] T019 Add a `desktop` job to `.github/workflows/ci.yml` on `windows-latest`, `macos-14`, `ubuntu-24.04` (`mesa-vulkan-drivers libasound2-dev libdbus-1-dev`): `cargo clippy --all-targets -- -D warnings`, `cargo llvm-cov --workspace --fail-under-lines 95 --fail-under-functions 95 --ignore-filename-regex "$(cat desktop/coverage-exclude.txt | paste -sd'|')"`; plus a Linux-only step `cargo kani -p sorot-desktop-core`
- [x] T020 Create `desktop/coverage-exclude.txt` listing, one path per line, exactly the thin OS shims allowed out of coverage (constitution III: "each is a thin module listed in the package's coverage config"): `src/platform/process_windows.rs`, `src/platform/process_unix.rs`, `src/platform/tray.rs`, `src/platform/reveal.rs`, `src/platform/notify_linux.rs`, `src/platform/taskbar_windows.rs`, `src/platform/window_state.rs`, `src/platform/open_documents_macos.rs`, `src/platform/gpu_probe.rs`. Add `desktop/tests/platform_list.rs`: it fails if `src/platform/` holds a file not on the list, if a listed file is missing, or if a listed file is over 80 lines
- [x] T021 Update `.claude/agents/test-runner.md`: add a **Desktop** suite (`cd desktop && cargo clippy --all-targets -- -D warnings`, `cargo llvm-cov --workspace --fail-under-lines 95 --fail-under-functions 95 --ignore-filename-regex` built from `desktop/coverage-exclude.txt`, `cargo kani -p sorot-desktop-core` through `wsl` on Windows), a Desktop row in the report table, and Kani "proofs verified / failed" in the gate criteria (any failed proof = BLOCKED)

---

## Phase 3: Foundational (blocks every story)

**Purpose**: the engine seam (contracts/engine-connection.md), the core types and the test
support every screen needs.

### Engine (backend, config-gated; Docker behaviour unchanged when unset)

- [x] T022 Add `serverHost` (`SERVER_HOST`, default `"0.0.0.0"`), `token` (`SOROT_TOKEN`, default unset), `parentPipe` (`SOROT_PARENT_PIPE`), `soleOwner` (`SOROT_SOLE_OWNER`) to `backend/src/config.ts`; let `SERVER_PORT=0` pass through; `STATIC_DIR=""` disables static serving. Add a `test.each` row per variable to the existing config test in `backend/tests/api.test.ts`
- [x] T023 In `backend/src/http.ts`, when `config.token` is set, every `/api/*` request without `Authorization: Bearer <token>` returns `401 {"status":"error","error":"unauthorized"}` through the existing `fail()`, including `/api/health`. Never log the header. Test as one `test.each` table (no header, wrong token, right token, token unset) in `backend/tests/api.test.ts` using `makeEnv`
- [x] T024 In `backend/src/index.ts`: bind to `config.serverHost`; print exactly one stdout line `SOROT_READY {"port":<n>,"version":"<pkg version>","api":1}` once listening; when `parentPipe`, run the existing `stop()` on stdin `end`/`close`. Move the logic into an exported `startServer(config, deps)` so `backend/tests/api.test.ts` tests the ready line and the stdin-close shutdown with a fake stdin stream
- [x] T025 In `backend/src/jobs.ts`, when `config.soleOwner`, the startup sweep uses cutoff 0 and reason `"interrupted"`; one table row added to the existing sweep test in `backend/tests/pipeline.test.ts`
- [x] T026 Create `backend/src/readiness/manifest.json` (per OS and arch: ffmpeg static build URL + SHA-256, uv-managed Python 3.12, Whisper `large-v3-turbo`, CUDA wheel list) and `backend/src/readiness/checks.ts` exporting `readinessItems(config, deps)` → `{id, required, ok, fixable, detail, progress?}[]` for `ffmpeg`, `python`, `whisperModel`, `gpu` (`required: false`, `fixable: false`), `generateBrowser` (`required: false`); all exec and filesystem access goes through `deps`
- [x] T027 Create `backend/src/readiness/fix.ts`: `startFix(id)` runs as a background task, reports `progress {percent, label}`, verifies the SHA-256 and deletes the file on `"checksum mismatch"`, fails with `"offline"` on network errors, and installs Python packages with `uv pip install -r ai-pipeline/requirements.txt` (plus CUDA wheels when the GPU check finds NVIDIA) through `runner.ts`-style injected exec
- [x] T028 Add routes `GET /api/readiness` and `POST /api/readiness/:id/fix` (`202 {"taskId"}`, `404` for an unknown id, `409` while a fix for that id runs) to `backend/src/app.ts`. Test checks, fixes and routes in one new file `backend/tests/readiness.test.ts` with tables (each item missing/ok, checksum mismatch, offline, 404, 409) and fakes from `helpers.ts`
- [x] T029 Include the absolute `exportPath` in clip export and Generate export responses in `backend/src/app.ts` (the column `clip.export_path` exists); one row each in the existing export tests in `backend/tests/editing.test.ts` and `backend/tests/generate/`
- [x] T030 Library commands in the engine (constitution I, II, V: the app never reads engine files). Create `backend/src/library/` and handle three startup commands in `backend/src/index.ts`, each of which prints one JSON envelope on stdout (the HTTP one from `ok()`/`fail()`) and exits, without starting the server:
  - `--find-libraries`: candidates from the `install.ps1`/`install.sh` install folders, `/etc/sorot/`, and a repo checkout's `data/`. Each is `{path, ok, videos, clips, hasKeys, problem?}`; `problem` reports a database that won't open or a schema it can't read, so a corrupt library is listed, not hidden.
  - `--copy-library <from> <to>`: reports `PROGRESS <n>` on stderr, skips and lists unreadable files, and never deletes the source.
  - `--import-keys <from>`: reads the `.env.llm` next to that library into the `setting` table of `DATA_DIR`, and prints only masked values.

  All filesystem access goes through injected deps. Test it in `backend/tests/library.test.ts` with one `test.each` table per command (found, none, corrupt, copy with an unreadable file, keys present and absent)
- [x] T031 Disk-space preflight in `backend/src/app.ts` for `POST /api/import` and `/api/process`: estimate the space a job needs (source size × factor from `config`, plus the render tier) against free space in `DATA_DIR` through injected deps. When short, return `507 {"status":"error","error":"not enough disk space","data":{"needBytes","freeBytes"}}` (add an optional `data` argument to `fail()`) before any work starts (spec Edge Cases). One `test.each` table in `backend/tests/api.test.ts`
- [x] T032 [P] Add `--token` / `SOROT_TOKEN` to `cli/src/config.ts` and send `Authorization: Bearer` from `cli/src/api.ts`; one table row in the existing CLI config test; document it in `docs/cli.md`
- [x] T033 Update `docs/api-spec.md` with the token rule, the readiness routes, `exportPath`, the 507 disk-space answer, the library startup commands and the `SOROT_READY` line (link to contracts/engine-connection.md)

### Core crate (pure logic; every module gets Kani proofs + compact unit tests)

- [x] T034 [P] Create `desktop/core/src/model.rs`: serde types mirroring `docs/api-spec.md` with `#[serde(rename_all = "camelCase")]` for Job, JobStage, Clip (`score`, `verdict`, `rankPos`, `title`, `hookStart`, `hookEnd`, `options`, `exportStatus`, `exportPath`, `updatedAt`), Settings/Connection (`kind`, `configured`, `healthy`, `maskedKey`, `model?`, `profiles?`), ReadinessItem, the Generate types and the envelope `{status: "ok"|"error", data?, error?}` (`backend/src/http.ts` `ok()`/`fail()`). Unknown fields are ignored. Unit test: one table of JSON fixtures loaded from `frontend/test/fakeApi.ts`'s payloads (copied to `desktop/core/tests/fixtures/api/*.json`) that must all deserialize
- [x] T035 [P] Create `desktop/core/src/handshake.rs`: `parse_ready(line: &str, supported_api: u32) -> Result<Ready{port, version}, HandshakeError>`, where `api` with a newer major version is `TooNew`. Kani: for any byte string up to 64 bytes it never panics, and `Ok` implies `1 <= port <= 65535`. Unit test table: valid line, junk, port 0, `api` 2
- [x] T036 [P] Create `desktop/core/src/engine_conn.rs`: the state machine `Starting → Ready{port,version} → (Lost → Restarting → Ready) | Stopping → Stopped`, with `Failed{reason}` when the engine exits before `SOROT_READY` or within 10 s; `Lost` after 3 failed health checks in a row; "at most 2 automatic restarts per session, then Failed"; a 401 restarts once, then `Failed`. Kani: over any event sequence of length ≤ 8, restarts ≤ 2, `Ready` is never entered from `Stopping` or `Stopped`, and `Stopped` is terminal. Unit test: one table of event sequences → final state
- [x] T037 [P] Create `desktop/core/src/polling.rs`: `next_poll(any_running: bool) -> Duration` (1 s while a job runs, else 5 s) plus a readiness-fix poll of 1 s. Kani: the result is always 1 s or 5 s, and is 1 s iff something is running
- [x] T038 [P] Create `desktop/core/src/redact.rs`: `redact(text, secrets: &[&str]) -> String` replaces every occurrence of each secret (token, keys) with `•••`, plus `Bearer \S+`. Kani: for strings up to 16 bytes and one secret up to 4 bytes, the output never contains the secret. Unit test table: token in a URL, in a header, repeated
- [x] T039 Create `desktop/src/engine/fake.rs` (`#[cfg(any(test, feature = "headless", debug_assertions))]`) with `FakeEngine`, which implements the app's `Engine` trait from a scene folder `desktop/scenes/{scene}/*.json` (canned API responses copied from `frontend/test/fakeApi.ts` payloads), records calls, and plays scripted failures and progress steps. Then create `desktop/tests/support/mod.rs` reusing it, plus `FakeProc` (spawn/stdout/stdin/exit for the sidecar), `FakeClock`, and `click(rt, key)`, `type_text(rt, key, s)`, `press(rt, chord)` helpers over Rune's headless `Runtime` (`crates/rune/tests/inert.rs` pattern)

### App crate foundations

- [x] T040 Create `desktop/src/engine/mod.rs` with the `Engine` trait (one method per route used in contracts/desktop-screens.md, returning `core::model` types) and `desktop/src/engine/http.rs` (`ureq`, bearer header, base URL, envelope errors mapped to `EngineError`). Unit test against a local `tiny_http` stub in-process: one table of status → `EngineError`
- [x] T041 Create `desktop/src/engine/sidecar.rs`: build the launch env exactly as the contracts/engine-connection.md §1 table; spawn through a `Proc` trait; read stdout until `SOROT_READY` (30 s, `FakeClock`); keep stdin open; on quit close stdin, then terminate after 5 s through `platform::process`. Also create the thin shims `desktop/src/platform/process_windows.rs` (Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`) and `desktop/src/platform/process_unix.rs` (own process group, `killpg` SIGTERM then SIGKILL after 5 s) behind the `Proc` trait. Add `run_library_command(args) -> Envelope` for the T030 startup commands, run through the same `Proc`. Drive `core::engine_conn` with the results. Unit test with `FakeProc`: one table (ready, early exit, timeout, 401 restart, library command output)
- [x] T042 Create `desktop/src/app.rs` and `desktop/src/main.rs`: `AppSpec` with fonts from `desktop/assets/fonts`, theme from `desktop/theme/sorot.json` (dark/light follow `system_dark` unless Preferences says otherwise), i18n, `single_instance`, routing between screens, `rune::task` workers applying engine results with `AppHandle::update`, poll cadence from `core::polling`
- [x] T043 Create `desktop/core/src/toast.rs` (`{kind: info|done|failed, text, action?}`, lasts 6 s, the timer pauses while hovered; Kani: a toast hovered for its whole life never expires, and an unhovered one always expires by 6 s), then `desktop/src/ui/states.rs` (the shared empty/loading/error block taking cause + next action, R-27) and `desktop/src/ui/toast.rs` driven by `core::toast`. Headless test: one table of the three states, asserting the role and name in `accessibility_json`

- [x] T044 Headless mode in `desktop/src/app.rs`: when `rune::tooling::headless_run()` is `Some`, use `FakeEngine` with the scene from `--scene` (default `home-empty`), skip the sidecar, the tray, notifications and updates, and register every folder in `desktop/scenes/` as a Rune scene (so `--list-scenes` lists them). Every interactive element gets a stable `.key()` named `{screen}/{control}` (for example `clips/export`), which scripts and tree assertions address. Create the first scenes `desktop/scenes/home-empty/`, `readiness-missing/`, `engine-failed/`
- [x] T045 Create `desktop/tests/support/headless.rs`: `run(scene, script: Option<&str>, args) -> Tree` runs `env!("CARGO_BIN_EXE_sorot-desktop")` with `--scene`, `--script desktop/scripts/headless/{name}.json`, and `--tree <tmp> --at mark:end`, then parses the tree JSON; plus `snap(scene, theme, size) -> PathBuf`, `node(&tree, key)`, `assert_text(&tree, key, s)`, `assert_role_label(&tree, key)`, `overlaps(&tree) -> Vec<(key, key)>`, `clipped_text(&tree) -> Vec<key>`. Create `desktop/tests/headless_flows.rs` as one table-driven test `(scene, script, expectations)` that later stories add journey rows to (L3 only). The foundation check here is a separate smoke test: `--list-scenes` lists the three scenes from T044

**Checkpoint**: the engine seam is unit-tested end to end with fakes, and headless mode renders
from scenes; stories can start.

---

## Phase 4: User Story 1 — Install and launch on any desktop OS (P1) 🎯 MVP

**Goal**: open the app, see readiness, fix what is missing, adopt an existing library, and leave
no stray processes.

**Independent test (unit level)**: with `FakeEngine` + `FakeProc`, a headless run from launch
reaches Home after readiness shows all required items Ok; the close dialog's three choices
lead to the right engine calls; adoption writes `workspace.json`.

- [x] T046 [P] [US1] Create `desktop/core/src/readiness.rs`: the item state machine `Unknown → Checking → Ok | Missing{fixable} → Fixing{progress} → Ok | FixFailed{reason}`; `clipping_allowed(items)` is true iff every `required` item is Ok; `generate_allowed(items)` also needs `generateBrowser`. Kani: for any 5 items, `gpu` never changes `clipping_allowed`, and `clipping_allowed` implies every required item is Ok. Unit test: one table of item lists → (clipping, generate)
- [x] T047 [P] [US1] Create `desktop/core/src/close.rs`: `on_close(running_jobs, pref: ask|background|quit) -> CloseAction{AskDialog, HideKeepRunning, Quit, QuitCancelJobs}`; `quit` with running jobs never quits silently, it asks once unless the pref is set. Kani: no input leads to `Quit` while jobs run and the pref is `ask`. Unit test table
- [x] T048 [P] [US1] Create `desktop/core/src/workspace.rs`: `Workspace { dataDir, source: new|adopted|copied, adoptedFrom, engine: local }` with serde to `workspace.json` (remote engines are out of scope for this feature; the enum keeps room for them without a token field), and `rank_candidates(list)`, which orders the engine's `--find-libraries` result (ok first, then the most clips; a `problem` is never ranked first). The app reads no engine files: candidates come only from the engine (T030). Unit test table of candidate lists
- [x] T049 [US1] Create `desktop/src/screens/readiness.rs` per the design readiness frames: list of items with plain-language status, per-item Fix/Retry, "Fix all", progress from polling, "Needs internet once" for `offline`. L2 test with `FakeEngine`: one table of item states (fixing with progress, offline text, checksum mismatch → error with Retry) → visible state and the fix calls
- [x] T050 [US1] Create `desktop/src/screens/welcome.rs` (first run only): show the engine's `--find-libraries` candidates (ranked by `core::workspace`, with a `problem` shown in plain words) with **Use it here** / **Copy it** / **Start fresh**. Copy runs `--copy-library` with its progress and then lists skipped files; keys are imported only by `--import-keys`, so the app never reads `.env.llm` or copies engine files itself. L2 test with `FakeProc`: one table of the three choices → `workspace.json` contents and the engine commands run
- [x] T051 [US1] Create `desktop/src/screens/shell.rs`: the left rail (only existing screens, R-24), the content area, the toast region, the connection-state banner for `Lost`/`Failed` with "Restart engine" and "Export diagnostic report". Headless test: one table of `EngineConnection` states → banner shown or not
- [x] T052 [US1] Wire the close flow in `desktop/src/app.rs` with `core::close`: the dialog (keep running in background / wait / cancel jobs and quit), the tray on Windows and Linux, the Dock on macOS (`platform::tray`). Headless test: one table of the three answers → `Engine::cancel_job` calls and sidecar shutdown
- [x] T053 [P] [US1] Create the thin shim `desktop/src/platform/tray.rs` behind a `Tray` trait (listed in `desktop/coverage-exclude.txt`; under 80 lines, no logic beyond the OS call)

- [x] T054 [US1] L3 journey for US1: scene `first-run` (one candidate library, readiness missing the Whisper model) and script `desktop/scripts/headless/us1-first-run.json` (tap `welcome/use-here` → readiness → tap `readiness/fix-all` → progress steps → `mark` end). One row in `desktop/tests/headless_flows.rs` asserting only the journey: Home is visible at the end, and `workspace.json` says `adopted`

**Checkpoint**: US1 is green in `/test`, Kani proofs pass, and headless flows cover launch to
Home.

---

## Phase 5: User Story 2 — Make clips end to end (P1)

**Goal**: import (drop, pick, paste), watch stages, browse ranked clips, preview, edit,
re-render, export, show in folder, and get notified.

**Independent test (unit level)**: with `FakeEngine`, a headless script drops a file → job runs
to COMPLETED → clips list in `rankPos` order → editor change → rerender call → export → reveal
called with `exportPath`.

- [x] T055 [P] [US2] Create `desktop/core/src/job.rs`: map engine job rows to the view state, where `interrupted` iff status FAILED and `errorMessage` is the sweep reason `interrupted`; `retry_offered` iff FAILED or CANCELLED; the stage list is in pipeline build order (Video → Audio → Transcribe → Segment → Score → Render → Subtitle → Variation → Analytics → Preview → Export). Kani: the stage percent stays within 0..=100 and the active stage index never decreases across a monotone progress sequence of length ≤ 6. Unit test table of rows → view
- [x] T056 [P] [US2] Create `desktop/core/src/clips.rs`: order by `rankPos` (never by `rank`), and `edit_layer(config, job, clip, change)` returns only the clip-layer delta to send (options layering config ← job ← clip). Kani: sorting is a permutation and is non-decreasing on `rankPos` for lists up to 5. Unit test table of layering cases
- [x] T057 [P] [US2] Create `desktop/core/src/cache.rs`: preview cache entries `{clipId}-{updatedAt}.mp4`; valid while `updatedAt` matches; an older version of the same clip is removed on insert; total capped at 2 GB, least recently played first out. Kani: after any insert sequence of length ≤ 5 the total is ≤ the cap, and the just-inserted entry is never evicted. Unit test table
- [x] T058 [P] [US2] Create `desktop/core/src/av_clock.rs` (Linux preview pacing): `pick_frame(frames_pts: &[i64], audio_clock: i64) -> Option<usize>` returns the latest frame with `pts <= audio_clock`; `seek_restart(t)` gives the `-ss` value. Kani: for any sorted pts list up to 6 frames, the result's pts is ≤ the clock, and no later frame also satisfies it. Unit test: one table including the empty list and a clock before the first frame
- [x] T059 [US2] Create `desktop/src/preview/mod.rs`: the `Preview` trait (load, play, pause, seek, set_muted(false) on load, time, duration) plus the cache download through `Engine::download_preview` into `core::cache`; `desktop/src/preview/rune_player.rs` (Windows and macOS) wraps Rune `Player`. Unit test the cache download path with `FakeEngine` and a temp dir
- [x] T060 [US2] Create `desktop/src/preview/ffmpeg_player.rs` (Linux): spawn ffmpeg for RGBA video at preview size into a Rune `NativeSurface::push_bytes`, and ffmpeg for `s16le` PCM into `cpal`, paced by `core::av_clock`; seek restarts both. Every process and audio-device call goes through `Proc` and `AudioOut` traits; unit test with `FakeProc` feeding canned frames and a fake audio clock (one table: play, seek, pause, ffmpeg exit → error state)
- [x] T061 [US2] Create `desktop/src/screens/home.rs` per the design home frames: a drop field (`on_drop_files`, `accepts_extensions` mp4/mov/mkv/webm), "Choose file" (native dialog, the Wayland path), link paste, a direction field (≤ 500 chars, counter shown), and the import options sheet (`/api/options`, `/api/music`). A 507 from the engine shows "Not enough disk space: needs X GB, Y GB free" with the next action. L2 test: one table (paste link; direction 501 chars rejected; Indonesian text with diacritics "Ringkas bagian yang lucu, pakai gaya santai" typed into the direction field reaches the import body unchanged; 507 → disk message) → `Engine::import` calls
- [x] T062 [US2] Create `desktop/src/ui/stage_track.rs` and `desktop/src/screens/job.rs`: the stage track with the beam on the active stage (moves only on reported `PROGRESS`), "label n%", Cancel, the Interrupted state with Retry, elapsed time instead of a spinner. Headless test with `FakeEngine` progress script: one table of job states → visible state and buttons
- [x] T063 [US2] Create `desktop/src/ui/clip_stage.rs`, `desktop/src/ui/score.rs` and `desktop/src/screens/clips.rs`: the ranked list (virtualized rows) beside the 9:16 clip stage with preview; verdict marks always show their word; J/K moves the selection; empty state "No clips yet" plus the next action. Headless test: list order equals `core::clips` order, and selection moves with J/K
- [x] T064 [US2] Create `desktop/src/screens/editor.rs`: options (captions/subtitle style, silence trim, reframe, music, hook) with the timeline hook marker; Re-render sends only `core::clips::edit_layer`'s delta; the previous export stays until the user exports again. Headless test: one table of edits → `Engine::rerender` bodies
- [x] T065 [US2] Add export and reveal to `desktop/src/screens/clips.rs` and `editor.rs`: Export calls `Engine::export`, then "Show in folder" calls `platform::reveal(exportPath)` for a local engine, or a save-as download for a remote one. Headless test: one table (local vs remote) → reveal vs download
- [x] T066 [P] [US2] Create thin shim `desktop/src/platform/reveal.rs` behind a `Reveal` trait: `explorer /select,<path>` (Windows), `open -R <path>` (macOS), D-Bus `org.freedesktop.FileManager1.ShowItems` with fallback `xdg-open <dir>` (Linux)
- [x] T067 [US2] Job finished/failed notifications in `desktop/src/app.rs` through a `Notifier` trait: an OS notification only when the window is unfocused and Preferences `notifications` is true; clicking it opens the job. Rune `rune-notify` on Windows and macOS; `desktop/src/platform/notify_linux.rs` (`notify-rust`, thin shim). Headless test: one table (focused/unfocused × pref) → notifier calls

- [x] T068 [US2] L3 journeys for US2 (binary-only input plus cross-screen effects):
  - scene `home-empty` with a `FakeEngine` progress script through every stage;
  - script `desktop/scripts/headless/us2-drop-to-export.json`: `drop_files` an `.mp4` on `home/drop` → job screen → completed → clips → J → tap `clips/export` → tap `clips/reveal`;
  - script `us2-pick-file.json`: tap `home/choose-file`, then `file-dialog` with a path → job screen.

  Two rows in `desktop/tests/headless_flows.rs`, asserting only the journey: the screen reached at each `mark`, and one reveal call at the end (per-control calls are already L2)

**Checkpoint**: US2 is green in `/test`; clipping works headless against `FakeEngine` from import to
export.

---

## Phase 6: User Story 3 — Sophisticated, futuristic look and feel (P1)

**Goal**: the design design, implemented and held by tests: one shared language, the beam motif,
spring motion, reduced motion, contrast in both themes, clean reflow.

**Independent test (unit level)**: token contrast table passes; headless snapshots match the
approved images; `motion_gate` passes; every control has a role and a name.

- [x] T069 [P] [US3] Create `desktop/core/src/contrast.rs`: `ratio(fg, bg) -> f64` (WCAG 2.1 relative luminance) and `check_theme(theme) -> Vec<Failure>` for the text pairs (≥ 4.5:1) and `edge` vs surfaces (≥ 3:1). No Kani (floating-point `powf`; see the test levels). Unit test: one table of the design.md pairs with their measured ratios, run against the generated `desktop/theme/sorot.json`
- [x] T070 [US3] Weak or no GPU (FR-010): create the thin shim `desktop/src/platform/gpu_probe.rs`, which reports whether Rune runs on its CPU renderer. When it does, the app shows one dismissible notice ("This machine has no graphics acceleration, so effects are reduced and previews open in your video player"), turns off blur and the beam's glow, and previews through `platform::reveal`'s open-file path. L2 test with a fake probe: one table (GPU, CPU renderer) → notice shown, blur count 0, preview route
- [x] T071 [US3] Create `desktop/src/ui/beam.rs`: the beam motif as one component (light-falloff gradient with grain on the beam fill only; head = `rune_fx::Fx::glow` with `GlowParams::heat` fed by a `Heat` light that warms on `PROGRESS` and cools when idle), variants `stage`/`clip`/`hook`/`action`, springs from `rune-motion`, every fx layer `.reduced()` under reduce-motion; at most one beam per screen (debug assert). Also `desktop/src/ui/fx_moments.rs`: stage-done `Fx::pulse` one-shot (0.6 s, `OneShots`), job-done sparkle burst once, motion blur on the clip rank spring, fluted glass (`FlutedGlassParams { frost }`) for the palette and transport, per the rune-fx table in design.md; no layer loops. Headless test: one table (normal vs reduced motion) → position after `rt.frame(dt)` steps
- [x] T072 [US3] Implement clip rank spring and the shared-element move clips→editor in `desktop/src/screens/clips.rs` and `editor.rs` per the `Motion notes` page; hover 120 ms, press 1 px. Add `desktop/tests/motion.rs` running `rune::motion_gate` over the job and clips screens with `FakeClock`
- [x] T073 [US3] Limit glass (`backdrop_blur` and fluted glass) to the command palette and transport bar, glow to the beam head and the primary-action focus ring, and one-shot fx (pulse, sparkle) to their two moments, with no layer animating when idle (`layer.is_animating()` false at rest) (R-10, R-13, R-19): add a headless test in `desktop/tests/design_rules.rs` that walks the element tree of every screen and counts blur and glow uses (≤ 2 each, never on rail, panels, cards or dialogs)
- [x] T074 [US3] Add `desktop/tests/snapshots.rs`: one table over every scene in `desktop/scenes/` × `--theme dark|light` at `--size 1280x800`, plus home/job/clips/editor at `--size 1920x1080`, rendered with the headless tooling (`support::headless::snap`, `--snap`, `--at` after motion settles) and compared to `desktop/tests/snapshots/*.png` within a small per-pixel tolerance. A mismatch writes a diff PNG next to the snapshot. Approved images are produced once by the look-and-fix review (T077), then fixed. Runs locally (the owner's GPU) and in CI on lavapipe/WARP
- [x] T075 [US3] Add `desktop/tests/a11y.rs`: for every screen's `accessibility_json`, every interactive node has a role and a non-empty name, verdict marks expose their word, and focus order follows visual order (one table of screens)
- [x] T076 [US3] Add reflow rows to the `desktop/tests/headless_flows.rs` table: script `desktop/scripts/headless/us3-resize.json` (`{"type":"resize","dw":-320,"dh":-160,"dur":0.5}` from 1280×800 down to the 960×640 minimum set in `app.rs`, then back up) for each main scene, asserting with `overlaps(&tree)` and `clipped_text(&tree)` at both ends that no text node is clipped and no two controls overlap
- [x] T077 [US3] Look-and-fix review against the design: for every scene and theme, render `--snap` and put it beside the matching design frame in `desktop/design/frames/`. Fix the drift in code: spacing, type, tokens, beam placement (one per screen), blur and glow limits. Use `--tree` colours to confirm that the token values are what is drawn. Repeat until each screen matches; then commit the approved PNGs to `desktop/tests/snapshots/` and log each screen's verdict and the fixes in `desktop/design/look-and-fix.md`

**Checkpoint**: US3 is green; the design tests guard the look from here on.

---

## Phase 7: User Story 4 — Keyboard, drag-and-drop and OS integration (P2)

**Goal**: command palette, menu bar, editable shortcuts, window state, Open with Sorot,
taskbar/dock progress, full keyboard use.

**Independent test (unit level)**: a headless keyboard-only script imports, reviews and exports a
clip; window-state restore clamps correctly; argv forwarding opens the import dialog.

- [x] T078 [P] [US4] Create `desktop/core/src/prefs.rs`: Preferences `{language: id|en|system, theme: system|dark|light, shortcuts: {action: chord}, closeBehaviour: ask|background|quit, notifications: bool}`, where `set_shortcut` refuses a chord already bound (no chord bound twice) and defaults are the contracts/desktop-screens.md keyboard map. Kani: after any sequence of up to 4 `set_shortcut` calls over 4 actions, no two actions share a chord. Unit test: defaults per OS (one table)
- [x] T079 [P] [US4] Create `desktop/core/src/window.rs`: `restore(saved: WindowState, monitors: &[Rect]) -> Rect`, which snaps "a position outside every current monitor" to the primary monitor at the default size. Kani: for up to 3 monitors with bounded coordinates, the result always intersects a monitor, with width/height ≥ the minimum 960×640. Unit test table: same monitor, unplugged monitor, mixed scaling
- [x] T080 [P] [US4] Create `desktop/core/src/palette_search.rs`: `rank(query, actions) -> Vec<ActionId>` (prefix > word start > substring, case- and diacritic-insensitive for Indonesian). Kani: the result is a subset of the actions with no duplicates (≤ 5 actions). Unit test table of queries
- [x] T081 [US4] Create `desktop/src/ui/palette.rs` (rune-kit `Combobox`-based command palette, glass surface 1 of 2) listing every action of rail + menu, and `desktop/src/ui/menu_bar.rs` (the macOS native menu through Rune; an in-app `Menu` bar on Windows and Linux) with the same destinations. Headless test: Ctrl/Cmd+K opens, typing filters via `core::palette_search`, Enter runs, Escape closes and returns focus
- [x] T082 [US4] Create `desktop/src/screens/settings/general.rs`: language, theme, close behaviour, notifications, and the shortcut recorder (rune-kit `ShortcutRecorder`, refusals from `core::prefs` shown inline). Headless test: one table of shortcut edits → saved prefs or inline refusal

- [x] T083 [US4] Window state in `desktop/src/platform/window_state.rs` (thin: `rune::prefs::Prefs` read/write + `AppHandle::set_position`; `rune_mac::remember_frame` on macOS) using `core::window::restore`; restore `lastView` and `lastJobId` in `desktop/src/app.rs`. Headless test of the `lastView` restore only (the shim is excluded)
- [x] T084 [US4] Open with Sorot: `desktop/src/main.rs` reads video paths from argv and forwards them through `single_instance` to the running window, which opens the import sheet for that file; `desktop/src/platform/open_documents_macos.rs` (thin `objc2` Apple Event open-documents handler feeding the same channel). Headless test: forwarded path → import sheet with the file
- [x] T085 [P] [US4] Taskbar/dock progress through a `Taskbar` trait: `desktop/src/platform/taskbar_windows.rs` (`ITaskbarList3::SetProgressValue`, thin), the Rune dock badge with percent text on macOS, a no-op on Linux; `desktop/src/app.rs` feeds it the running job percent. Headless test with a fake `Taskbar`: one table of job states → calls
- [x] T086 [US4] Keyboard-only journey as a headless script `desktop/scripts/headless/us4-keyboard-only.json` (only `key`/`type` events: Tab/Shift+Tab, Enter/Space, Escape, through import → job → clips → export, with a `mark` after each step) plus a row in `desktop/tests/headless_flows.rs` that reads the tree at each mark (`--at mark:<step>`) and asserts the focused element and its visible focus ring
- [x] T087 [US4] L3 rows for binary-only input in US4 (the palette and the shortcut recorder are L2 in T081/T082):
  - `us4-menu.json`: open the menu bar, then `menu-pick` the Settings id, landing on Settings;
  - an argv-forwarded video path while a window is open: the import sheet shows that file.

  Two rows in `desktop/tests/headless_flows.rs`

**Checkpoint**: US4 is green.

---

## Phase 8: User Story 5 — Settings, AI connections, publishing, learning, discover, Generate (P2)

**Goal**: every remaining web UI capability in the parity table, with the constitution's AI-only,
masked-key and safe-publishing rules.

**Independent test (unit level)**: with `FakeEngine`, connections save masked; publish stays
disabled until user-owned choices are set; Generate shows as unavailable without AI; each
Generate step's actions call the right routes.

- [x] T088 [P] [US5] Create `desktop/core/src/publish_gate.rs`: `can_post(draft, choices)` is true only when every user-owned choice is set: TikTok privacy **or** draft mode (unless `video_public_only`), YouTube title non-empty and made-for-kids chosen; choices start empty and are never pre-filled. Kani: for any choices with an unset required field, `can_post` is false. Unit test: only the cases the proof does not imply (the `video_public_only` exemption; draft mode standing in for privacy)
- [x] T089 [P] [US5] Create `desktop/core/src/availability.rs`: `generate_available(connections, readiness)` needs an AI connection (LLM or Jev configured and healthy) plus `generateBrowser`; `clipping_available` ignores connections entirely. Kani: no connection state changes `clipping_available`. Unit test table
- [x] T090 [P] [US5] Create `desktop/core/src/masked.rs`: `KeyField` shows the engine's `maskedKey` until the user types; it sends only user-typed values and never displays a value it did not just receive from the user. Kani: the displayed text is always the masked value or the user's own input. Unit test table
- [x] T091 [US5] Create `desktop/src/screens/settings/connections.rs` (LLM, Jev, Tebar: base URL, model, key via `core::masked`, test-connection, Tebar profiles) per `ConnectionsPanel.tsx` parity; changes take effect on the next action with no restart. L2 test: one table (save, test ok, test fail, clear) → engine calls and visible state (the masked display is proved in L1 `core::masked`, not re-checked here)
- [x] T092 [US5] Create `desktop/src/screens/settings/generate.rs` per `GenerateConnections.tsx` (`generate/status`, `generate/models`, calibrate, model level, `GEN_*` budgets and per-role models). Headless test: one table of the actions → routes
- [x] T093 [US5] Create `desktop/src/screens/publish.rs` per `PublishPanel.tsx`: draft per platform, Jev copy check, platform limits, the user-owned choices block (the beam focal point, empty by default), Post enabled by `core::publish_gate`, posts list with retry (`POST /posts/{id}/retry` via engine) and cancel; one Tebar profile end to end. L2 test: the Post control's enabled state follows `can_post` (one row each way, not re-checking the rule), and the post call carries the profile
- [x] T094 [US5] Create `desktop/src/screens/learning.rs` per `LearningPanel.tsx` (feedback, train, weights); only real numbers from the engine, with an empty state when there is no feedback (R-17). Add the feedback sheet from `ResultsForm.tsx` to `desktop/src/screens/clips.rs`. Headless test: one table (no feedback, feedback, train error)
- [x] T095 [US5] Create `desktop/src/screens/discover.rs` (`discover/search`, `trending`, `channel`, `candidates`, status, `queue`, `queue/drain`, `auto`). Headless test: one table of actions → routes, and import from a candidate → `Engine::import`
- [x] T096 [US5] Create `desktop/src/screens/generate/mod.rs` (project list, step rail, unavailable state "Generate needs an AI connection" with a link to `settings/connections` from `core::availability`) and `brief.rs`, `ideas.rs` per `GenerateWindow.tsx`, `BriefForm.tsx`, `IdeaBank.tsx`. Headless test: one table (no AI → unavailable; AI → brief create → `generate/projects`)
- [x] T097 [US5] Create `desktop/src/screens/generate/facts.rs` and `storylines.rs` per `FactsPanel.tsx` and `StorylineCards.tsx` (facts, verify, delete; storylines, pick). Headless test: one table of actions → routes
- [x] T098 [US5] Create `desktop/src/screens/generate/plan.rs` per `PlanEditor.tsx`: plan edit and **Approve** (plan before building: Build stays disabled until approved). Headless test: Build disabled before approve, enabled after
- [x] T099 [US5] Create `desktop/src/screens/generate/build.rs` per `BuildPanel.tsx` + `DirectorLog.tsx`: version build, director log, cancel, "Continue from the failed step" (`POST /api/generate/versions/:id/retry`; 409 → "The plan changed since this run. Start a new version."). Headless test: one table (running, failed → retry ok, retry 409)
- [x] T100 [US5] Create `desktop/src/screens/generate/verdict.rs` and `versions.rs` per `VerdictPanel.tsx` + `VersionHistory.tsx`: both verdicts shown (TECHNICAL, CREATIVE), accept, draft, export (with `exportPath` reveal), restore. Headless test: one table of actions → routes
- [x] T101 [US5] Create `desktop/src/screens/generate/recipes.rs` and `kit.rs` per `RecipeEditor.tsx` + `KitPanel.tsx`: recipes (list, import, mine, export, shared, validate; shipped examples read-only), kit parts and export. Headless test: one table (validate errors shown inline, shipped recipe has no edit control)

- [x] T102 [US5] L3 journeys for US5 (the rules themselves are L1/L2 in T088–T101):
  - `us5-connect-then-generate.json`: scene `generate-no-ai` → tap the Settings link → save an LLM key → back to Generate, which is now available;
  - `us5-generate-end-to-end.json`: brief → storyline pick → plan approve → build completes → accept version;
  - `us5-clip-to-post.json`: clips → publish → set the choices → post → the posts list shows it.

  Three rows in `desktop/tests/headless_flows.rs`, asserting the screen at each `mark` and the end state only

**Checkpoint**: every row in contracts/desktop-screens.md has a screen with green headless tests.

---

## Phase 9: User Story 6 — Stay current and recoverable (P3)

**Goal**: non-blocking updates, a safe restart after a crash, and a redacted diagnostic report.

**Independent test (unit level)**: an update check with a fake feed offers the update and declining
never blocks; the diagnostic report contains no secret; interrupted jobs show Retry.

- [x] T103 [P] [US6] Create `desktop/core/src/update.rs`: `decide(current, feed, signature_valid: bool) -> Offer | UpToDate | Ignore` (the app crate verifies the minisign signature and passes the result; core stays crypto-free), where an invalid signature or malformed feed gives `Ignore` (never blocks, never installs). Kani: an invalid signature never yields `Offer`. Unit test table (newer, same, older, bad signature)
- [x] T104 [US6] Wire `cargo-packager-updater` in `desktop/src/update.rs` behind an `UpdateFeed` trait: check at launch and every 24 h, a non-blocking offer toast, install on the user's click only. Unit test with a fake feed: one table (offer → install called only on click; decline → no further prompt this session)
- [x] T105 [US6] Create `desktop/src/diagnostics.rs`: a report of app version, OS, the Rune pin, readiness items, the connection state, and the last 50 engine stderr lines, all through `core::redact` with the token and masked keys as secrets; saved through the native save dialog. Unit test: a fixture containing the token and a key → the report contains neither
- [x] T106 [US6] Show interrupted jobs on launch in `desktop/src/screens/home.rs` (a "Last session stopped while these were running" block with Retry each, from `core::job`). L2 test: `FakeEngine` with one interrupted job → block shown, and Retry calls `POST /api/jobs/:id/retry`
- [x] T107 [P] [US6] Add `[package.metadata.packager]` to `desktop/Cargo.toml` (NSIS, app+dmg, AppImage+deb; `CFBundleDocumentTypes` and Linux `MimeType=video/*` for Open with; resources: the compiled engine, `ai-pipeline/`, `generator/`, `uv`), and write `.github/workflows/release-desktop.yml` (on a published release or `workflow_dispatch`; matrix of three OSes; `bun build --compile backend/src/index.ts`; `cargo packager --release`; a minisign-signed `latest.json` with the key from secrets). Configuration only: no task here runs a build

- [x] T108 [US6] L3 journey for US6: scene `home-interrupted` (one interrupted job) and script `us6-retry-interrupted.json` (tap `home/retry/<job>` → job screen running → completed → clips). One row in `desktop/tests/headless_flows.rs` asserting the screen at each `mark`

**Checkpoint**: US6 is green.

---

## Phase 10: Polish, parity release and cross-cutting

- [x] T109 [P] Fill `desktop/i18n/en.json` and `id.json` for every string in every screen; add a test in `desktop/tests/i18n.rs` asserting both catalogs have the same keys and no value contains an em dash (R-02)
- [ ] T110 [P] Copy pass on all UI strings per antislop-copywriting (specific action labels such as "Potong video ini" / "Clip this video", no buzzwords, no "Get Started"); record the changes in `desktop/design/copy-review.md`
- [ ] T111 Run `/test`; it must be OPEN: backend, cli, ai-pipeline, frontend, and desktop (clippy clean, ≥ 95% lines/functions, every Kani proof verified). Fix until OPEN
- [x] T112 Click-through script for R-35: `desktop/tests/clickthrough.rs` walks every scene's accessibility tree (the same one the binary's `--tree` dumps), and for every interactive node taps its `key` with an in-process pointer on Rune's headless `Runtime` against `FakeEngine`. It records the tree/state diff, `FakeEngine` call log and the platform requests the headless runtime latches (file dialog, pop-up menu, URL, clipboard, shell, reveal). Focus flags are excluded; focus counts only into a text field. A control whose tap changes nothing is a dead control and fails the test (R-26); genuine no-ops are listed by key with a reason. Native-only inputs — argv forwarding and resize — stay in the L3 journeys in `headless_flows.rs`. The test writes the element-by-element list to `desktop/design/clickthrough.md` (`clips/export -> Engine::export(c1), toast "Diekspor"`)
- [ ] T113 Run the antislop Delivery Gate (core Blocks 1-4 + UI Skill Checklist) on the implemented app with headless evidence (no windowed run, per the owner). Every PASS cites evidence: test names, `--snap` files per scene and theme, `desktop/design/clickthrough.md` for R-26/R-35, `desktop/design/look-and-fix.md`, and the contrast test for R-25. Write it to `desktop/design/antislop-gate-app.md`
- [ ] T114 [P] Headless evidence for the release PR: `--script desktop/scripts/headless/us2-review-export.json --video desktop/design/demo-clip-flow.mp4 --keys --pointer` (needs ffmpeg on PATH; the readiness-managed ffmpeg is fine) and `--first-pixels` startup timing in a `--profile perf` build, recorded in `desktop/design/startup.md`. This measures process-cold startup to first pixels, not window display (say so; SC-002 is not claimed from it)
- [ ] T115 Parity release cleanup: delete `frontend/`; remove it from the root `package.json` workspaces, `.github/workflows/ci.yml`, `.claude/agents/test-runner.md`, AGENTS.md Commands/Gate, the backend static serving default (`STATIC_DIR` default becomes empty) and the CORS rule for `next dev` (keep `FRONTEND_URL` handling only if hosted mode still needs it, otherwise remove it from `backend/src/config.ts` and its test row). Amend constitution V's transition clause as fulfilled and replace `frontend/test/fakeApi.ts` in constitution III's shared-fakes list with `desktop/src/engine/fake.rs` (PATCH bump, with `AGENTS.md` in the same change). Add a `CHANGELOG.md` entry. Precondition: the manual owner checks (see the top of this file) are recorded as passed
- [ ] T116 Record the session in `docs/journal/` (decisions, the Rune pin, Kani proof list, the results of the manual owner checks, what is left for the owner: Apple Developer account, Windows certificate)

---

## Dependencies & Execution Order

- **Phase 1 (Design)** has no dependencies and comes first (owner instruction). Its checkpoint
  (owner approval, including the icon from T009) blocks T018 (theme generation), T016 (icon
  assets) and every UI task.
- **Phase 2 (Setup)**: T012 can start any time. T013 → T014-T021. T016 and T018 need T010; T018
  also needs T014 (it lives in `core`). T020 (coverage list) comes before T019 is first run.
- **Phase 3 (Foundational)**: engine tasks T022-T033 are independent of the Rust tasks
  T034-T043. T039 needs T034; T040-T042 need T034-T039; headless mode T044 needs T039 + T042,
  and the headless harness T045 needs T044. The welcome screen T050 needs the engine library
  commands T030. **This phase blocks all stories.**
- **Headless flow tasks** (T054, T068, T087, T102, T108) and the click-through T112 need T045,
  plus the screens of their story. T077 (look-and-fix) produces the approved images that T074
  (snapshots) compares against, so T074's test can be written first, but it is accepted only
  after T077.
- **Stories**: US1 (Phase 4) → US2 (Phase 5) is the MVP path. US3 (Phase 6) needs the screens of
  US1 and US2 to snapshot, but T069-T071 can start right after Phase 3. US4 and US5 can run in
  parallel after US2. US6 can start after Phase 3 (T103-T105, T107) except T106 (needs T061).
- **Phase 10** needs every story done. T115 is last before T116.

### Within each story

The core module and its Kani proofs (the `[P]` core tasks) come first, then the screens that use
them, then the headless tests in the same task. Proofs and tests are written with the module, not
afterwards.

### Parallel examples

```text
# Phase 3, two lanes at once:
Lane A (engine): T022 → T023 → T024 → T025 → T026 → T027 → T028 → T029 → T030 → T031; T032, T033 alongside
Lane B (core):   T034, T035, T036, T037, T038 together → T039 → T040 → T041 → T042 → T044 → T045; T043

# US1 core in parallel:
T046, T047, T048 (different files in desktop/core/src/)

# US2 core in parallel:
T055, T056, T057, T058, then T066 alongside the screens

# US5 core in parallel:
T088, T089, T090
```

## Implementation Strategy

- **MVP**: Phases 1-5 (design, setup, foundations, US1, US2). That gives a launchable,
  unit-verified clipping app against the engine. It is not released on its own: FR-020 ships
  only at full parity.
- **Then**: US3 (design held by tests), US4 and US5 (parity), US6, and Phase 10 (parity release,
  `frontend/` removed).
- At each checkpoint `/test` must be OPEN (including Kani) before moving on, and commits follow
  AGENTS.md (feature branch, Conventional Commits, `--no-ff`).
