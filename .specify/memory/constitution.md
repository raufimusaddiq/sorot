# Sorot Constitution

## Core Principles

### I. Local-First, Host-Ready

Sorot turns YouTube or local videos into 9:16 short clips with Indonesian auto-subtitles. It
runs on the owner's own machine today and is planned to also run hosted, on a server whose
hardware is good enough for clipping (transcribe + render at a practical speed).

- Local mode is the primary target: it MUST keep working fully offline from cloud services,
  except optional integrations (Principle IV) and video download.
- Hosted mode is a deployment of the same app, not a fork. New work MUST NOT add assumptions
  that block it: no hard-coded `localhost` or absolute host paths, paths and limits come from
  config, long jobs stay queued and cancellable, and the UI stays same-origin.
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

Rationale: local use is what works now; keeping the code host-ready costs little and avoids a
rewrite once suitable hardware is available, while scope stays small until hosting is real.

### II. Language Boundaries

- Python (`ai-pipeline/`) is for media and ML only: Whisper, media features, render, subtitle,
  variation, captions, reframe, LightGBM. New non-media logic MUST NOT be written in Python.
- Segmenting, scoring, hooks, analytics, learning, discovery, and LLM/Jev/Tebar logic MUST
  live in Bun/TypeScript (`backend/`).
- Python scripts MUST print a JSON envelope `{"success": bool, "data": {}}` and exit 0 on
  success, non-zero on failure. The backend MUST call them through `runner.ts` with per-script
  timeouts and whole-process-tree cancel.
- Python logic ported to Bun MUST keep golden fixtures produced by the Python original.

Rationale: one orchestration language keeps logic testable and the Python surface replaceable.

### III. Test Gate (NON-NEGOTIABLE)

- Every change MUST pass 100% of tests, keep line and function coverage at or above 95%, and
  have zero type errors in every touched package (backend, frontend, cli, ai-pipeline).
- The gate is checked with `/test` (test-runner subagent); its verdict is OPEN or BLOCKED,
  and BLOCKED changes MUST NOT be merged.
- Tests MUST stay compact: one test per behaviour, table-driven cases, shared fakes
  (`backend/tests/helpers.ts`, `frontend/test/fakeApi.ts`), and no assertion that re-proves
  another.
- External effects (exec, Python scripts, HTTP) MUST be injected through `createApp(config,
  deps)` so tests never hit real services.

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
  committed.

Rationale: AI services are useful but unreliable and paid; the clipping tool must never depend on
them. A mode that only exists because of AI may need it, but must never take the rest of Sorot
down with it.

### V. Stable Contracts

- API JSON keys MUST be the camelCase of SQLite columns; the frontend depends on them.
- The SQLite schema MUST auto-create and auto-migrate in `db.ts` and stay compatible with
  existing databases, including the Java-era schema.
- The frontend MUST remain a Next.js static export: no API routes, rewrites, server actions,
  or `next/image` optimization. The backend serves it same-origin.
- Breaking a contract (API shape, CLI flags, schema, script envelope) MUST be called out in the
  change and migrated in the same change.

Rationale: backend, UI, CLI, and Python evolve together in one repo, so their seams must hold.

### VI. Safe Publishing

- Publishing MUST follow draft -> user choices -> upload + post. Choices the platform makes
  the user own (TikTok privacy or draft mode, YouTube title, made-for-kids) MUST NOT be
  auto-filled, in the UI or the CLI.
- Every post MUST be saved (`social_post` row + exact body) before it is sent and MUST carry an
  `Idempotency-Key`, so a retry can never double-post.
- A post MUST stay inside one Tebar workspace (profile) end to end.

Rationale: posting is outward-facing and irreversible; mistakes there cost the owner's accounts.

## Platform & Stack Constraints

- Stack: Bun workspace (`backend/`, `cli/`, `frontend/`) with one root lockfile, Python 3 in
  `ai-pipeline/`, SQLite, Docker. Windows (PowerShell) and Linux are both first-class.
- Docker MUST always run with `--env-file .env.docker`. `docker-compose.yml` stays CPU-only;
  GPU and machine-specific settings go in the gitignored override file or `/etc/sorot/`,
  never in tracked files.
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

**Version**: 2.2.0 | **Ratified**: 2026-10-31 | **Last Amended**: 2026-10-31
