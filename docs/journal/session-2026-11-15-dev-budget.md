# 2026-11-15: desktop dev resource budget (T-28)

Budget: ~6 GB RAM, ~35% CPU peak on 6 cores / 12 threads.

- `desktop/.cargo/config.toml`: `[build] jobs = 4`, `[env] RUST_TEST_THREADS = "2"`. Env vars of the same name win, so CI can override; CI does not need to (hosted runners have 3-4 cores).
- Headless journeys share one semaphore in `tests/support/headless.rs`: at most 2 app processes at once. The 30 s deadline starts when a process runs, not while it waits for a slot.
- Local gate: `cargo clippy --all-targets -- -D warnings` and `cargo test --test suite`. Coverage, Linux, macOS and Kani run in CI.
- Measured here (single agent, jobs 4, 2 test threads): cold clippy 70 s; suite 115 tests green twice, 151 s and 155 s of test time.

## sccache: rejected

sccache 0.19.0 (prebuilt release binary) as `RUSTC_WRAPPER`, `cargo test --test suite --no-run`, fresh target dir each time:

| run | time |
|---|---|
| no sccache, cold | 120 s |
| sccache, empty cache | 159 s |
| sccache, warm cache, fresh target dir | 136 s |

Rust cache hits: 0 of 566 (the warm run hit nothing), so it saves nothing and the first run costs 30% more. Not kept. Workspace crates would not be cached anyway.
