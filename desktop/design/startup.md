# Startup evidence (T114)

antislop active: AFTER (session override). This file records measurements; it changes no app code.

## Build

`desktop/Cargo.toml` has no `[profile.perf]` in this project. The one Rune 73b7dec uses is in
`~/.cargo/git/checkouts/rune-c9b805e9ed8a3730/73b7dec/Cargo.toml`, and Rune's README (`crates/rune/README.md`,
"Startup") says to build `target/perf` with `--profile perf`. T-31 added the same profile verbatim to
`desktop/Cargo.toml` (manager approval 2026-11-20), with a one-line comment naming its source.

Build command (alone, no other cargo job competing; `CARGO_BUILD_JOBS=4` from `desktop/.cargo/config.toml`):

```
cd desktop
CARGO_BUILD_JOBS=4 cargo build --profile perf --features headless,rune/keys-overlay --bin sorot-desktop
```

`headless` gives the agent tooling (`--first-pixels`, `--script`, `--tree`, `--snap`); `rune/keys-overlay` gives
`--keys` and `--pointer`. A perf build without these features exits 2 with "this build has no agent tooling"
(resolved 2026-11-20 during T-31).

Build wall time: first full perf build (no tooling) 280 s (cargo: "Finished `perf` profile ... in 4m 40s");
incremental rebuild adding `headless` 108.1 s; incremental rebuild adding `rune/keys-overlay` recorded in
`desktop/build-perf-result.txt`. Peak RAM was not measured (no cheap sampler available on this machine).
Both timings are from `CARGO_BUILD_JOBS=4`, nothing else compiling.

## --first-pixels timing

Method mirrors Rune's `scripts/bench-startup.py`: one warmup launch, then seven fresh processes, each
`target/perf/sorot-desktop.exe --first-pixels --frames 1`, reading the flushed
`rune-first-pixels {json}` line from stdout. Script: `desktop/scripts/headless/bench-startup.mjs`.
Raw runs: `desktop/design/perf-startup/settings-{0..7}.log`; parsed result: `desktop/design/perf-startup/results.json`.

Results (median over seven runs, mad in parentheses):

| Field | ms (median) | mad |
|---|---|---|
| process (spawn to first-pixels marker, external wall clock) | 336.2 | see `results.json` |
| headless (process start to first frame, Rune's own clock) | 323.5 | see `results.json` |
| gpu_init | 306.1 | see `results.json` |
| state | 0.53 | see `results.json` |
| runtime | 1.50 | see `results.json` |
| frame_cpu | 11.02 | see `results.json` |
| readback | 1.54 | see `results.json` |

`pixel_bytes` = 12,672,000 (one 1280x800 RGBA frame at scale 1). GPU init dominates; app state and
Rune runtime are about 2 ms together. These are process-cold startup numbers with warm OS/driver caches,
measured on this Windows machine. The marker fires after the first offscreen GPU readback.

**This measures process-cold startup to first pixels, not window display.** It does not include creating or
mapping an OS window, compositing it on screen, or scanout. **SC-002 ("the app window appears within 3 seconds
of launch") is not claimed from this number**; it needs a real machine and remains an owner manual check
(`specs/003-native-desktop-app/spec.md`, `quickstart.md` section 2).

## Release-PR video

The task names `--script desktop/scripts/headless/us2-review-export.json --video desktop/design/demo-clip-flow.mp4
--keys --pointer`. The named script and MP4 did not exist in the base; T-31 added
`desktop/scripts/headless/us2-review-export.json` (review a ranked clip, preview it, export it, end) and
produced `desktop/design/demo-clip-flow.mp4` by the run below. `--video` is an *output* path: Rune streams
frames into ffmpeg, which encodes the MP4. ffmpeg is on PATH here (winget Gyan.FFmpeg 8.1 full build),
so this ran rather than being skipped.

Command (from `desktop/`):

```
target/perf/sorot-desktop.exe --scene clips-ranked \
  --script scripts/headless/us2-review-export.json \
  --video design/demo-clip-flow.mp4 --keys --pointer --fps 20 --scale 1
```

Recorded result (final binary, `headless,rune/keys-overlay`): exit 0; stdout
`rune: wrote design/demo-clip-flow.mp4 (65 frames at 20 fps)`; stderr reports 65 frames in 2.63 s wall,
gpu init 296.8 ms. `ffprobe`: duration 3.25 s, size 60,325 bytes. File: `desktop/design/demo-clip-flow.mp4`.
Raw stdout/stderr: `desktop/design/verify-logs/t114-video.{out,err}`. This is the release-PR headless evidence;
it is not a windowed run.
