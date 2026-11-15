# Quickstart: Validating the Sorot Desktop App

**Feature**: `003-native-desktop-app` | **Date**: 2026-11-15

These are run guides that prove the feature works end to end. Contracts:
[engine-connection.md](contracts/engine-connection.md),
[desktop-screens.md](contracts/desktop-screens.md). Design acceptance:
[design.md](design.md).

## Prerequisites (development)

- Rust toolchain `1.99.1` (`desktop/rust-toolchain.toml` installs it through rustup).
  - Windows: MSVC build tools.
  - Linux: `libvulkan1 mesa-vulkan-drivers libasound2-dev libdbus-1-dev`.
- Bun (repo root `bun install`) for the engine.
- `cargo install cargo-llvm-cov cargo-packager`.

## 1. Gate (every change)

```
cd backend;  bun test --coverage; bun run typecheck
cd desktop;  cargo clippy --all-targets -- -D warnings
cd desktop;  cargo llvm-cov --fail-under-lines 95 --fail-under-functions 95
```

`/test` runs these through the test-runner subagent; the verdict is OPEN or BLOCKED.

**Expected**: all tests pass, coverage is at least 95% with `src/platform/*` excluded by name,
and there are no warnings.

## 2. Engine connection (local, dev)

```
cd desktop; cargo run
```

**Expected**:
- The window opens on Home within 3 s (SC-002), and the engine log shows `SOROT_READY`.
- A `curl http://127.0.0.1:<port>/api/health` without the token returns 401.
- From another machine on the LAN the port is closed.

## 3. First run on a clean machine (each OS)

1. Install the artifact from `release-desktop.yml`: `.exe` (Windows), `.dmg` (macOS),
   `.AppImage` or `.deb` (Linux).
2. Open Sorot from the OS launcher.
3. The readiness screen lists ffmpeg, Python, the Whisper model and GPU. Choose "Fix all".

**Expected**:
- Home is usable with no terminal, in under 5 minutes plus download time (SC-001).
- Unplugging the network during the fix shows "Needs internet once" with Retry.

## 4. Existing library

On a machine with a Docker or native install that has data, open the app for the first time.

**Expected**:
- "Use it here" lists the found library.
- After choosing it, every video, clip, setting and post appears (SC-005).
- The old web version still opens the same data.

## 5. Clipping parity (SC-004)

Run the fixed parity set (the `scripts/e2e-test.ps1` videos) through the desktop app and
through the engine API directly, with the same settings.

**Expected**: identical clip order (`rankPos`), scores, verdicts and export file hashes.

## 6. Preview on Linux (research R3)

On Ubuntu 24.04, open a finished clip, play it, seek to the hook, and pause.

**Expected**:
- Picture and sound stay in sync (no drift you can see or hear across a 60 s clip).
- A seek shows its frame within 300 ms.

## 7. Lifetime (SC-009, SC-010)

1. Start a job, then kill the app process from the OS task manager.
2. Check that no `sorot-engine`, `python` or `ffmpeg` process is left.
3. Reopen the app.

**Expected**:
- No processes are left after the kill.
- The job shows Interrupted with Retry, and Retry runs it to completion.

## 7b. Headless UI verification (no window, what the task list uses)

```
cd desktop; cargo build
target/debug/sorot-desktop --list-scenes
target/debug/sorot-desktop --scene clips-ranked --theme dark --size 1280x800 --snap out.png
target/debug/sorot-desktop --scene home-empty --script scripts/headless/us2-drop-import.json --tree tree.json --at mark:end
cargo test --test suite headless_flows:: snapshots:: clickthrough::
```

**Expected**:
- Headless mode never starts the engine; it uses `FakeEngine` scenes.
- `tree.json` shows the job screen with its stage track.
- Every flow row, every snapshot and the click-through pass.

## 8. Design acceptance (US3, SC-006 to SC-008)

- Headless snapshots of every screen in `desktop/tests/snapshots/`, in dark and light, at
  1280x800 and 1920x1080, compared against the approved images.
- `rune::motion_gate` passes on the job and clips screens.
- Accessibility: the `accessibility_json` test asserts a role and a name on every control.
  A manual pass with NVDA (Windows), VoiceOver (macOS) and Orca (Linux) reaches every control.
- Keyboard: import, review and export one clip with no mouse (US4).
- The antislop Delivery Gate report (core, plus the UI checklist), with a click-through list
  of every control, is attached to the release PR.
- Five-viewer check (SC-007): record what each viewer says, word for word, in
  `docs/journal/`.
