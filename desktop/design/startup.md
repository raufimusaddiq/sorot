# Startup evidence (T114)

antislop active: AFTER (session override). This file records measurements; it changes no app code.

## Build

`desktop/Cargo.toml` had no `[profile.perf]` in this project. The one Rune 73b7dec uses lives in
Rune's own checkout, and Rune's README ("Startup") says to build `target/perf` with `--profile perf`.
T-31 added the same profile verbatim to `desktop/Cargo.toml` (manager approval 2026-11-20), with a
one-line comment naming its source.

Build command (alone, no other cargo job competing; `CARGO_BUILD_JOBS=4` from `desktop/.cargo/config.toml`):

```
cd desktop
CARGO_BUILD_JOBS=4 cargo build --profile perf --features headless,rune/keys-overlay --bin sorot-desktop
```

`headless` gives the agent tooling (`--first-pixels`, `--script`, `--tree`, `--snap`); `rune/keys-overlay`
gives `--keys` and `--pointer`. A perf build without those features exits 2 with "this build has no
agent tooling" (resolved 2026-11-20 during T-31).

Build wall time: the full perf build (no tooling) took 280 s (cargo: "Finished `perf` profile ... in
4m 40s"); the incremental rebuild adding `headless` took 108.1 s. The later incremental rebuild adding
`rune/keys-overlay` was not timed, so no number is claimed for it. Peak RAM was not measured (no cheap
sampler on this machine). Both recorded timings used `CARGO_BUILD_JOBS=4`, nothing else compiling.

## --first-pixels timing

Method mirrors Rune's `scripts/bench-startup.py`: one warmup launch, then seven fresh processes, each
`target/perf/sorot-desktop.exe --first-pixels --frames 1`, reading the flushed
`rune-first-pixels {json}` line from stdout. Reproduce with
`bun scripts/headless/bench-startup.mjs design/perf-startup`; it writes the parsed result to
`desktop/design/perf-startup/results.json`. Raw per-run logs were not kept — `results.json` holds every
run.

Results (median over seven runs, median absolute deviation in parentheses), all in ms except
`pixel_bytes`:

| Field | median | mad |
|---|---|---|
| process (spawn to first-pixels marker, external wall clock) | 336.161 | 7.319 |
| headless (process start to first frame, Rune's own clock) | 323.541 | 7.151 |
| gpu_init | 306.125 | 6.824 |
| state | 0.532 | 0.016 |
| runtime | 1.499 | 0.037 |
| frame_cpu | 11.020 | 0.279 |
| readback | 1.545 | 0.075 |

`pixel_bytes` = 12,672,000 (one 1280x800 RGBA frame at scale 1), mad 0. GPU init dominates; app state
and Rune runtime are about 2 ms together. These are process-cold startup numbers with warm OS/driver
caches, measured on this Windows machine. The marker fires after the first offscreen GPU readback.

**This measures process-cold startup to first pixels, not window display.** It does not include creating or
mapping an OS window, compositing it on screen, or scanout. **SC-002 ("the app window appears within 3 seconds
of launch") is not claimed from this number**; it needs a real machine and remains an owner manual check
(`specs/003-native-desktop-app/spec.md`, `quickstart.md` section 2).

## Release-PR video

The task names `--script desktop/scripts/headless/us2-review-export.json --video desktop/design/demo-clip-flow.mp4
--keys --pointer`. The named script and MP4 did not exist in the base; T-31 added
`desktop/scripts/headless/us2-review-export.json` and produced `desktop/design/demo-clip-flow.mp4` by the
run below. `--video` is an *output* path: Rune streams frames into ffmpeg, which encodes the MP4. ffmpeg is
on PATH here (winget Gyan.FFmpeg 8.1 full build), so this ran rather than being skipped.

The script performs a real review → preview → export with input actions that have bindings in the source:

1. `j` — `NextClip`: moves the selection to the next clip.
2. tap `clips/row/c3` — selecting a clip row calls `State::select` → `load_preview` → `Cmd::Preview`,
   i.e. `Engine::download_preview(c3)` per `design/clickthrough.md`. This is the preview action.
3. tap `clips/export` — `State::export_selected` → `Cmd::Export` → the "Terekspor. Berkasnya siap." toast.

`mark` events only label timeline instants for frame extraction; they are not actions. The earlier draft of
this script used a space key for "preview" even though the app binds space to PlayPause, not to preview;
that was replaced with the row tap.

Command (from `desktop/`):

```
target/perf/sorot-desktop.exe --scene clips-ranked \
  --script scripts/headless/us2-review-export.json \
  --video design/demo-clip-flow.mp4 --keys --pointer --fps 20 --scale 1
```

Recorded result (final binary, `headless,rune/keys-overlay`): exit 0; stdout
`rune: wrote design/demo-clip-flow.mp4 (61 frames at 20 fps)`; stderr: 61 frames in 2.94 s wall, gpu init
433.2 ms, first frame 2407.42 ms. `ffprobe`: duration 3.05 s, size 57,140 bytes. File:
`desktop/design/demo-clip-flow.mp4`.

Three frames were extracted with ffmpeg into `desktop/design/demo-frames/` and looked at:

```
ffmpeg -y -v error -i design/demo-clip-flow.mp4 -vf "select='eq(n,12)'" -frames:v 1 design/demo-frames/01-review.png
ffmpeg -y -v error -i design/demo-clip-flow.mp4 -vf "select='eq(n,28)'" -frames:v 1 design/demo-frames/02-preview.png
ffmpeg -y -v error -i design/demo-clip-flow.mp4 -vf "select='eq(n,48)'" -frames:v 1 design/demo-frames/03-exported.png
```

What the frames show: `01-review.png` — clip 2 "Bagian lucu" (REVIEW) is selected, `j` keycap visible bottom-left;
`02-preview.png` — clip 3 "Pembuka lambat" (SKIP) row is highlighted (the row tap selected it and triggered
preview); `03-exported.png` — the toast "Terekspor. Berkasnya siap." is visible at the bottom-right and the
`Ekspor (Ctrl+E)` button is disabled (it has just exported). All three frames are 1100x720. This is the
release-PR headless evidence; it is not a windowed run.
