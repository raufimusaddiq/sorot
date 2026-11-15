<!--
Sync Impact Report (remove before committing)
- Version: 2.2.0 -> 3.0.0 (MAJOR: Principle V's frontend rule and Principle I's same-origin
  rule are redefined; owner decision 2026-11-15, spec 003-native-desktop-app Q1=C, Q2=A)
- Modified principles:
  - I. Local-First, Host-Ready: "UI stays same-origin" -> the UI reaches the engine over a
    defined, authenticated connection; local mode is the native desktop app
  - II. Language Boundaries: adds Rust (`desktop/`) as UI-only
  - III. Test Gate: adds the `desktop` package (cargo test, coverage, clippy) and the rule for
    thin OS shims
  - V. Stable Contracts: Next.js static-export rule replaced by the native-app rule, with a
    transition clause for `frontend/` until the first native release
- Added sections: none (Platform & Stack Constraints expanded: desktop app, Rune pin, installers,
  macOS)
- Removed sections: none
- Follow-up TODOs (same change, per Governance): update AGENTS.md (Rules: API/UI/DB, Docker,
  release, scripts; Commands; Gate), CLAUDE.md test gate wording, docs/architecture.md,
  docs/folder-structure.md, docs/release.md, README.md, CHANGELOG.md [Unreleased]
- Templates: .specify/templates read the constitution at runtime; no template changes needed
-->
# Sorot Constitution

## Core Principles

### I. Local-First, Host-Ready

Sorot turns YouTube or local videos into 9:16 short clips with Indonesian auto-subtitles. It
runs on the owner's own machine today and is planned to also run hosted, on a server whose
hardware is good enough for clipping (transcribe + render at a practical speed).

- Local mode is the primary target: the native desktop app (`desktop/`) on Windows, macOS and
  Linux, running the engine (`backend/` + `ai-pipeline/`) on the same machine. It MUST keep
  working fully offline from cloud services, except optional integrations (Principle IV), video
  download, and first-run downloads of components the readiness check names.
- Hosted mode is a deployment of the same engine, not a fork, used through the same desktop app
  pointed at a remote engine. New work MUST NOT add assumptions that block it: no hard-coded
  `localhost` or absolute host paths, paths and limits come from config, long jobs stay queued
  and cancellable, and the app reaches the engine only over its defined connection (the HTTP
  API in `docs/api-spec.md`), never by reading engine files or the database directly.
- The engine MUST refuse requests without the connection token when one is configured. In local
  mode it binds to loopback only, with a token generated per launch.
- Hosting is gated on hardware: it is enabled only on machines that pass the clipping workload
  (e.g. GPU via `WHISPER_DEVICE`), and CPU defaults stay tuned for a local laptop.
- A hosted instance MUST NOT be exposed beyond localhost without authentication, HTTPS, and
  secrets kept server-side; until those exist, hosted mode is not shipped.
- Designs MUST still pick the simplest thing that works. Multi-tenant features (accounts,
  per-user data isolation, billing, quotas) are out of scope until this constitution is amended.
- Clipping pipeline work MUST respect the build order: Video -> Audio -> Transcribe -> Segment
  -> Score -> Render -> Subtitle -> Variation -> Analytics -> Preview -> Export. Generate runs the
  steps of its recipe in the recipe's order and MUST keep its two fixed rules: an approved plan
  before building, and both verdicts after rendering.

Rationale: local use is what works now; one engine behind one connection serves the desktop app
today and a hosted engine later, without another UI rewrite, while scope stays small until
hosting is real.

### II. Language Boundaries

- Python (`ai-pipeline/`) is for media and ML only: Whisper, media features, render, subtitle,
  variation, captions, reframe, LightGBM. New non-media logic MUST NOT be written in Python.
- Segmenting, scoring, hooks, analytics, learning, discovery, and LLM/Jev/Tebar logic MUST
  live in Bun/TypeScript (`backend/`).
- Rust (`desktop/`) is for the desktop app only: views, interaction, theme, OS integration,
  starting and stopping the local engine, and clip preview playback. Pipeline, scoring,
  publishing and Generate decisions MUST NOT be written in Rust; the app shows what the engine
  decides.
- Python scripts MUST print a JSON envelope `{"success": bool, "data": {}}` and exit 0 on
  success, non-zero on failure. The backend MUST call them through `runner.ts` with per-script
  timeouts and whole-process-tree cancel.
- Python logic ported to Bun MUST keep golden fixtures produced by the Python original.

Rationale: one orchestration language keeps logic testable, the Python surface replaceable, and
the UI a thin client that a hosted engine can serve unchanged.

### III. Test Gate (NON-NEGOTIABLE)

- Every change MUST pass 100% of tests, keep line and function coverage at or above 95%, and
  have zero type errors in every touched package (backend, cli, ai-pipeline, desktop, and
  frontend until it is removed). For `desktop`, zero type errors means `cargo check` and
  `cargo clippy -- -D warnings` are clean.
- `desktop` views and state MUST be tested headless (Rune runtime: state, element tree, scripted
  input, accessibility tree). OS shims that cannot run headless (file manager reveal, taskbar,
  notifications, installers) MAY be left out of coverage only if each is a thin module listed in
  the package's coverage config.
- The gate is checked with `/test` (test-runner subagent); its verdict is OPEN or BLOCKED,
  and BLOCKED changes MUST NOT be merged.
- Tests MUST stay compact: one test per behaviour, table-driven cases, shared fakes
  (`backend/tests/helpers.ts`, `frontend/test/fakeApi.ts`, and the desktop app's fake engine),
  and no assertion that re-proves another.
- External effects (exec, Python scripts, HTTP) MUST be injected through `createApp(config,
  deps)` so tests never hit real services; desktop tests MUST run against a fake engine, never a
  real one.

Rationale: a high, enforced gate lets an AI-assisted solo project move fast without regressions;
compact tests keep that gate cheap to maintain.

### IV. Optional AI, Rules Fallback

- Jev, the LLM, and Tebar MUST each be optional. With any of them off or failing, the pipeline
  MUST still produce clips using rules (`ruleAnswers()`, rule hooks, rule copy).
- **AI-only modes**: a mode whose core job cannot be done without AI (e.g. Generate, where an AI
  director writes and judges the video) MAY require a configured AI connection, if: it is a
  separate mode that clipping and every other feature never depend on; with no connection it
  shows as unavailable with a link to Settings; on failure it keeps the user's work and allows a
  retry; and its spec names it as AI-only. Optional extras inside a mode (generated images,
  synthetic voice) MUST degrade gracefully when their provider is missing.
- Every LLM path MUST fall back to rules on `LlmError`; Jev failures MUST fall back per clip.
- When Jev is on it is the director and its verdicts are final; results MUST NOT be re-asked
  or averaged to chase stability.
- Secrets (`LLM_API_KEY`, `JEV_API_KEY`, `TEBAR_API_KEY`) MUST live only in the gitignored
  `.env.llm` or the SQLite `setting` table, MUST be masked wherever shown, and MUST NOT be
  committed, logged, or included in diagnostic reports. The desktop app MUST NOT keep its own
  copy; it reads and writes them through the engine.

Rationale: AI services are useful but unreliable and paid; the clipping tool must never depend on
them. A mode that only exists because of AI may need it, but must never take the rest of Sorot
down with it.

### V. Stable Contracts

- API JSON keys MUST be the camelCase of SQLite columns; the desktop app (and the CLI) depend on
  them.
- The SQLite schema MUST auto-create and auto-migrate in `db.ts` and stay compatible with
  existing databases, including the Java-era schema.
- The desktop app (`desktop/`, Rust on Rune pinned to an exact commit) is the user interface.
  It MUST use only the engine's HTTP API and the files the API names (exports, previews), and
  MUST work against a local or a remote engine.
- Transition: the web UI (`frontend/`) stays a Next.js static export (no API routes, rewrites,
  server actions, or `next/image` optimization), served same-origin, with fixes only, until the
  first desktop release reaches full parity; that release removes it and its tests.
- Breaking a contract (API shape, CLI flags, schema, script envelope) MUST be called out in the
  change and migrated in the same change.

Rationale: engine, desktop app, CLI, and Python evolve together in one repo, so their seams must
hold.

### VI. Safe Publishing

- Publishing MUST follow draft -> user choices -> upload + post. Choices the platform makes
  the user own (TikTok privacy or draft mode, YouTube title, made-for-kids) MUST NOT be
  auto-filled, in the desktop app or the CLI.
- Every post MUST be saved (`social_post` row + exact body) before it is sent and MUST carry an
  `Idempotency-Key`, so a retry can never double-post.
- A post MUST stay inside one Tebar workspace (profile) end to end.

Rationale: posting is outward-facing and irreversible; mistakes there cost the owner's accounts.

## Platform & Stack Constraints

- Stack: Bun workspace (`backend/`, `cli/`, `frontend/` until removed) with one root lockfile,
  Python 3 in `ai-pipeline/`, SQLite, Docker, and a Rust crate `desktop/` with its own
  `Cargo.lock`. Windows, macOS and Linux are first-class for the desktop app; Windows
  (PowerShell) and Linux stay first-class for scripts and Docker.
- Rune MUST be pinned to an exact commit of its `dev` branch, with its `[patch]` entries copied
  as its README requires. A Rune bump is its own change, re-running the full gate on all three
  OSes.
- Platform gaps in Rune (for example video playback on Linux, notifications on Linux, the
  Windows menu bar) MUST be filled by thin, listed modules in `desktop/` or an in-app
  equivalent, never by dropping the feature on one OS silently.
- Desktop installers (Windows, macOS, Linux) are built only by the release workflow on a
  published release or manual run, alongside the existing images.
- Docker MUST always run with `--env-file .env.docker`. `docker-compose.yml` stays CPU-only;
  GPU and machine-specific settings go in the gitignored override file or `/etc/sorot/`,
  never in tracked files. Docker is for the engine (servers, hosted mode, CI).
- CPU and GPU behaviour key off `WHISPER_DEVICE`; CPU defaults MUST keep a run practical on a
  laptop (limited render tier, one pipeline).
- PowerShell scripts MUST be ASCII-only and PS 5.1 compatible; `install.ps1` MUST NOT `exit`.
  `scripts/install.sh` MUST stay shellcheck-clean.
- Release images are built only by `release-image.yml` on a published release or manual run.

## Development Workflow

- `master` is stable. Work happens on `feat/...` or `fix/...` branches, uses Conventional
  Commits, and merges with `--no-ff`. Shared branches MUST NOT be rebased.
- The test gate (Principle III) MUST pass before any commit; secrets MUST never be committed.
- Executable source is the source of truth over plan documents. Design notes live in `docs/`
  (`docs/creative-loop.md`, `docs/api-spec.md`); history lives in `docs/journal/`.
- Feature specs produced with Spec Kit (`specs/`) MUST be checked against this constitution in
  `/speckit-plan` and `/speckit-analyze`; any violation MUST be justified in the plan's
  complexity tracking or the design changed.

## Governance

- This constitution states Sorot's non-negotiable principles. `AGENTS.md` holds the detailed
  operational rules and MUST stay consistent with it; where they conflict, this constitution
  wins until `AGENTS.md` or the constitution is amended.
- Amendments are made by the owner through a normal branch and merge that updates this file,
  states the reason, and updates `AGENTS.md` and dependent docs in the same change.
- Versioning follows semver: MAJOR for removing or redefining a principle, MINOR for adding a
  principle or section or materially expanding guidance, PATCH for wording and clarifications.
- Every review (`/review`, `/speckit-analyze`) MUST check compliance with these principles;
  added complexity MUST be justified against Principle I.

**Version**: 3.0.0 | **Ratified**: 2026-10-31 | **Last Amended**: 2026-11-15
