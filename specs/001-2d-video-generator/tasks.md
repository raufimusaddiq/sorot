---
description: "Task list for the 2D Video Generator (Studio)"
---

# Tasks: 2D Video Generator (Studio)

**Input**: Design documents from `specs/001-2d-video-generator/`: [plan.md](plan.md),
[spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md),
[contracts/](contracts/), [quickstart.md](quickstart.md); constitution v2.1.0.

**Tests**: required by the constitution's gate (Principle III: 100% pass, ≥ 95% line/func
coverage, zero type errors). The owner dislikes test bloat, so tests are **not separate tasks**:
each task that adds code also adds its test in the named test file. One test per behaviour, new
cases as table rows (`test.each` / `it.each` / `parametrize`), shared fakes in
`backend/tests/helpers.ts` and `frontend/test/fakeApi.ts`, and every external effect injected
through `createApp(config, deps)` (`exec`, `runScript`, `fetch`).

**Organization**: by user story, in priority order: P1 (US1, US2) → P2 (US3, US4, US6, US7) →
P3 (US5, US8). US6 is split into four sub-phases because the step library is large.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: the user story a task belongs to (US1 to US8)
- Paths are repo-relative. Backend tests live in `backend/tests/generate/`, CLI tests in
  `cli/tests/`, frontend tests next to components in `__tests__/`, Python tests in
  `ai-pipeline/tests/`.

---

## Phase 1: Setup (shared infrastructure and spikes)

**Purpose**: the new workspace package, the runtime, and the spikes that can change later choices.

- [X] T001 Create the `generator/` workspace package: `generator/package.json` pinning `hyperframes` to an exact version, added to the root `package.json` workspaces; run `bun install` so the root `bun.lock` locks it
- [X] T002 [P] Add bundled OFL fonts with Indonesian glyph coverage (Plus Jakarta Sans, Inter, Bebas Neue, one serif) under `generator/fonts/` with a `generator/fonts/LICENSES.md`
- [X] T003 [P] Write the condensed HyperFrames authoring contract (root/sub-composition structure, `class="clip"` + `data-*` timing, `assets/` paths, one paused GSAP timeline on `window.__timelines`, determinism rules: no `Date.now`, unseeded `Math.random`, network, timers or `repeat: -1`), with Apache-2.0 attribution, in `generator/prompts/authoring.md`
- [X] T004 [P] Write storyline and plan guidance (N different films: world, device, form; first 2 s; hook frame never black or logo-only; title lines ≤ 6 words; beat shares) in `generator/prompts/story.md`
- [X] T005 Add Node 22, Chrome system libraries and `hyperframes browser ensure` to the runtime stage of `backend/Dockerfile`, keeping the CPU image otherwise unchanged
- [X] T006 [P] Add a Node ≥ 22 check/install for native mode to `scripts/install.ps1` (ASCII only, PS 5.1, never `exit`, `-UseBasicParsing`) and `scripts/install.sh` (shellcheck-clean)
- [X] T007 Spike S1: run the pinned CLI natively on Windows and in Docker; save real `lint --json`, `check --json`, `snapshot --review --json`, `render` and `doctor --json` outputs as fixtures in `backend/tests/fixtures/hyperframes/`; record the Windows answer and the finding field names in `specs/001-2d-video-generator/research.md` (R5)
- [X] T008 Spike S2 (first pass): time draft and delivery renders of a 30 s 1080×1920 sample on the RTX 4060 (`--gpu`) and in CPU Docker; record seconds-per-second factors in `specs/001-2d-video-generator/research.md` (R11)

**Checkpoint**: HyperFrames runs in both modes, fixtures exist, render speed is known.

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: config, schema, the HyperFrames wrapper, the recipe model, validator and runner, and
availability. No user story can start before this phase ends.

- [X] T009 Add `HYPERFRAMES_VERSION`, `GEN_CONCURRENCY` (default 1), `GEN_KEEP_VERSIONS` (default 10) and the generate data dir (`data/generate`) to `backend/src/config.ts`, with tests in `backend/tests/generate/config.test.ts`
- [X] T010 Create the `gen_project`, `gen_plan`, `gen_version`, `gen_verdict`, `gen_asset`, `gen_export`, `gen_event`, `gen_recipe`, `gen_fact` and `gen_idea` tables exactly as in `specs/001-2d-video-generator/data-model.md` (for example `brief` "≤ 2,000 chars", `target_sec` "5 to 90", `format` "`9:16` · `16:9` · `1:1`", `language` "`id` · `en`", version `status` "`QUEUED` · `BUILDING` · `BUILT` · `FAILED` · `CANCELLED`", verdict `kind` "`TECHNICAL` · `CREATIVE`" with UNIQUE(version_id, kind), fact `status` "`unverified` · `verified` · `corrected` · `unverifiable`", idea `status` "`new` · `used` · `built` · `posted`") in `backend/src/db.ts`, auto-created and migrated so old databases open unchanged, with tests in `backend/tests/db.test.ts`
- [X] T011 Add gen_* row types to `backend/src/types.ts` and camelCase store methods (save/get/list/update per table; `gen_event.response` "truncated to 20,000 chars", no secrets) to `backend/src/store.ts`, with tests in `backend/tests/generate/store.test.ts`
- [X] T012 [P] Implement the HyperFrames exec wrapper (`init`, `add --no-clipboard`, `catalog --json`, `lint --json`, `check --json`, `snapshot --review|--at --json`, `render` with quality/fps/workers/`--gpu`/output, `doctor --json`; `HYPERFRAMES_AGENT=1`; per-command timeouts with `render` scaled by length × fps; process-tree cancel; exit codes 0/1/2 mapped to errors; the CLI version recorded) in `backend/src/generate/hyperframes.ts`, with tests against the T007 fixtures in `backend/tests/generate/hyperframes.test.ts` and a `fakeHyperframes` added to `backend/tests/helpers.ts`
- [X] T013 [P] Implement the director-log helper (one `gen_event` per LLM/Jev/tool/command call: kind, model, request, response, ok, ms, tokens) in `backend/src/generate/events.ts`, with tests in `backend/tests/generate/events.test.ts`
- [X] T014 Implement recipe validation per `specs/001-2d-video-generator/contracts/recipe.md`: shape and per-step settings schemas, ranges ("≤ 30 steps; `output` within 360..4096 px, 12..60 fps, 5..90 s; ≤ 20 audit items, 20 content rules and 8 criteria; each prompt ≤ 4,000 chars"), the dependency rules (including `concept` after `storylines` and before `plan`), the two fixed rules (a `plan` with `gate: owner | director` before `author`; `technical` and `creative` after `render`), and the always-on TECHNICAL measures that can't be turned off, returning `{ok, errors[], warnings[]}` that name the steps, in `backend/src/generate/recipe.ts`, with table-driven tests in `backend/tests/generate/recipe.test.ts`
- [X] T015 Create the step registry (each step type exports its settings schema, defaults, gate options, dependencies and `run(ctx)`), with an empty module per type of the library, in `backend/src/generate/steps/index.ts`
- [X] T016 Implement the runner: walk a project's **frozen** recipe in order; a project segment (steps before `author`) and a build segment (`author` … `export`) per `gen_version`; gates (`owner` → `WAITING`, `director` → decision + reason in `step_state`, `none`); `when: "connection:*"` skips; per-step cache by `inputHash` so unchanged steps are reused; failure keeps work and sets `error_message`; retry resumes at the failed step; on restart `BUILDING` → `FAILED` ("interrupted") in `backend/src/generate/runner.ts`, with tests using stub steps in `backend/tests/generate/runner.test.ts`
- [X] T017 Seed read-only example recipes from `generator/recipes/*.json` into `gen_recipe` at startup (`built_in = 1`, never edited, version kept) and freeze a copy onto each new project (FR-024) in `backend/src/generate/recipe.ts`, with tests in `backend/tests/generate/recipe.test.ts`
- [X] T018 [P] Write the `quick` example recipe (storylines owner → plan owner, blocks allowed → author → check → render draft → technical → creative → export rerender) in `generator/recipes/quick.json`
- [X] T019 Implement `GenerateService` availability (`available` false without an LLM or with failing required `doctor --json` check (`Node.js`, `FFmpeg`, `Chrome`; the top-level `ok` is false when optional tools are missing, see R5); per-recipe `available` + `reasons[]`; `compute: "cpu" | "gpu"` from `WHISPER_DEVICE`) and wire it into `createApp` in `backend/src/generate/service.ts` and `backend/src/app.ts`, with tests in `backend/tests/generate/service.test.ts`
- [X] T020 Add `GET /api/generate/status` per `specs/001-2d-video-generator/contracts/api.md` in `backend/src/app.ts`, with a route test in `backend/tests/generate/api.test.ts`
- [X] T021 [P] Add the Generate window to the studio dock, showing "connect an LLM" with a link to Settings when unavailable (FR-016), plus the generate client in `frontend/src/lib/api.ts`, in `frontend/src/app/studio/page.tsx` and `frontend/src/components/generate/GenerateWindow.tsx`, with tests in `frontend/src/components/generate/__tests__/GenerateWindow.test.tsx` and fakes in `frontend/test/fakeApi.ts`
- [X] T022 [P] Add `sorot gen status` (and the `gen` command group with `--json`) in `cli/src/generate.ts`, registered in `cli/src/commands.ts`, with tests in `cli/tests/generate.test.ts`

**Checkpoint**: recipes validate and freeze, the runner walks stub steps, and Generate shows
whether it's available. Clipping is unaffected.

---

## Phase 3: User Story 1: Idea to approved plan (Priority: P1) 🎯 MVP

**Goal**: a brief becomes storyline options and then a shot-by-shot plan the user can edit and
approve, with nothing rendered.

**Independent Test**: submit a brief, get 3 storylines, pick one, edit one shot, approve, and
see that building is refused before approval (quickstart §1 to §2).

- [X] T023 [P] [US1] Implement plan validation and normalisation per `specs/001-2d-video-generator/data-model.md`: "1 to 20 shots; each `durationSec` between 1 and 15; the sum within ± 10% of `target_sec`; each title line ≤ 6 words and each text value ≤ 120 chars; fonts must be bundled or uploaded"; `generatedImage` stripped (keeping `fallbackVisual`) when no image connection; brief numbers kept unchanged, and anything else listed in `assumptions` (FR-007); all limits read from the frozen recipe, in `backend/src/generate/planSchema.ts`, with table-driven tests in `backend/tests/generate/planSchema.test.ts`
- [X] T024 [P] [US1] Implement director calls `storylines`, `plan`, `revise` and `gate` per `specs/001-2d-video-generator/contracts/director.md` (JSON out via `parseJson`; closing `task` field; the step's `prompt` appended or replacing Sorot's instructions but never the output format; one repair call on a validation error; `LlmError` keeps state) in `backend/src/generate/director.ts`, with tests using fake `fetch` replies in `backend/tests/generate/director.test.ts`
- [X] T025 [US1] Implement the `storylines` step (count 1..5, `skipUnderSec` → straight to a plan, `requireBold`, exactly one `recommended`, owner gate → `WAITING`, director gate → pick + one-clause reason) in `backend/src/generate/steps/storylines.ts`, with tests in `backend/tests/generate/steps.test.ts`
- [X] T026 [US1] Implement the `plan` step (calls `plan`, validates with `planSchema`, stores a `gen_plan` revision, required owner/director gate; `revise` diffs revisions and rejects changes outside the requested shots once) in `backend/src/generate/steps/plan.ts`, with tests in `backend/tests/generate/steps.test.ts`
- [X] T027 [US1] Add project actions to `GenerateService`: create (`brief`, `recipeId`, `format`, `targetSec`, `language`, `styleNotes`, `narration`, `buildWithoutStopping`), new storylines, pick, PUT plan (new revision), revise, approve (`planId` must be the current revision), and a refused build without an approved plan (409, FR-006) in `backend/src/generate/service.ts`, with tests in `backend/tests/generate/service.test.ts`
- [X] T028 [P] [US1] Implement asset uploads (`logo`, `image`, `font`, `music`; stored under the project's `assets/`; `gen_asset.origin: upload`) in `backend/src/generate/assets.ts`, with tests in `backend/tests/generate/assets.test.ts`
- [X] T029 [P] [US1] Implement the mirrored files `BRIEF.md`, `STORYLINES.md` and `SPEC.md` written from the database after each step in `backend/src/generate/mirror.ts`, with tests in `backend/tests/generate/mirror.test.ts`
- [X] T030 [US1] Add routes `GET/POST /api/generate/projects`, `GET/PATCH/DELETE /projects/:id`, `/storylines`, `/storylines/:index/pick`, `PUT /plan`, `/plan/revise`, `/plan/approve`, `POST /projects/:id/assets`, `DELETE /assets/:id`, `/projects/:id/events` and `/projects/:id/files/:name` per `specs/001-2d-video-generator/contracts/api.md` in `backend/src/app.ts`, with route tests in `backend/tests/generate/api.test.ts`
- [X] T031 [P] [US1] Build `BriefForm.tsx` (brief ≤ 2,000 chars, format, length 5 to 90 s, language, style notes, assets, recipe picker) and `StorylineCards.tsx` (pick / change note) in `frontend/src/components/generate/`, with tests in `frontend/src/components/generate/__tests__/plan.test.tsx`
- [X] T032 [P] [US1] Build `PlanEditor.tsx` (shot table, direct edits, "Ask the director" box showing each request and change summary, approve) and `DirectorLog.tsx` in `frontend/src/components/generate/`, with tests in `frontend/src/components/generate/__tests__/plan.test.tsx`
- [X] T033 [P] [US1] Add `sorot gen new|list|show|storylines|pick|plan [--edit]|revise|approve|asset` per `specs/001-2d-video-generator/contracts/cli.md` in `cli/src/generate.ts`, with tests in `cli/tests/generate.test.ts`

**Checkpoint**: US1 works end to end in the UI and CLI with the `quick` recipe.

---

## Phase 4: User Story 2: Build a draft and get two verdicts (Priority: P1)

**Goal**: an approved plan builds into a playable draft with separate TECHNICAL and CREATIVE
verdicts; export is blocked while TECHNICAL is FAIL.

**Independent Test**: approve a plan, build, play the draft, see both verdicts with findings;
force a 20-word title into a 1 s shot and see TECHNICAL FAIL and accept refused (quickstart §3).

- [X] T034 [P] [US2] Implement the composer: write root `index.html` from the plan (one sub-composition per shot, `data-start`/`data-duration` from the plan or from aligned voice lines, `data-beat` marks, caption and audio tracks), plus plan-lock checks on each scene (planned text present, no own `data-start`/`data-duration`, only existing `assets/` paths, the determinism rules) in `backend/src/generate/composer.ts`, with tests in `backend/tests/generate/composer.test.ts`
- [X] T035 [P] [US2] Add director calls `scene` and `repair` (one `compositions/shot-NN.html` per call; `repair` may return `holds: [{code, reason}]`) to `backend/src/generate/director.ts`, with tests in `backend/tests/generate/director.test.ts`
- [X] T036 [US2] Implement the `author` step (HyperFrames `init` at the recipe's size, copy assets and fonts, `add` blocks only when `plan.blocks` allows, write scenes shot by shot, repair ≤ `repairRounds` (0..5, default 3) per shot) in `backend/src/generate/steps/author.ts`, with tests in `backend/tests/generate/steps.test.ts`
- [X] T037 [US2] Implement the `check` step (`lint` + `check --json` mapped to shots; errors → repair; warnings per `warnings: fix | fix-or-hold | report`; kept warnings saved with `keptReason`) in `backend/src/generate/steps/check.ts`, with tests in `backend/tests/generate/steps.test.ts`
- [X] T038 [US2] Implement the build queue (FIFO, `GEN_CONCURRENCY`, waits while a clip job is in TRANSCRIBE or RENDER, cancel kills the tree → version `CANCELLED`, build-time estimate from past `build_ms`) in `backend/src/generate/queue.ts`, with tests in `backend/tests/generate/queue.test.ts`
- [X] T039 [US2] Implement the `render` step (`quality: draft | standard | delivery` (`standard` is HyperFrames `looks`), fps, workers, `--gpu` when `WHISPER_DEVICE` is a GPU, progress into `gen_version.progress`, `render_kind` set) in `backend/src/generate/steps/render.ts`, with tests in `backend/tests/generate/steps.test.ts`
- [X] T040 [US2] Implement the TECHNICAL verdict per research R6 with the always-on measures `output`, `planText`, `layout`, `readability`, `firstFrame` and `audio` (when the plan has sound), plus the optional `deadStretchSec` (numbers from the frozen recipe), ffprobe through `exec`, FAIL with any must-fix / REVIEW with should-fix only / PASS, checker crash → FAIL "could not verify", kept warnings shown but not counted, in `backend/src/generate/technical.ts` and `backend/src/generate/steps/technical.ts`, with table-driven tests in `backend/tests/generate/technical.test.ts`
- [X] T041 [P] [US2] Add optional image content parts to `ChatMessage` (string content keeps working for every caller) and `llm.vision` / `llm.visionModel` connection fields in `backend/src/llm.ts` and `backend/src/settings.ts`, with tests in `backend/tests/llm.test.ts`
- [X] T042 [US2] Implement the CREATIVE verdict: a fresh-context judge (brief, approved plan, built facts per shot, optional review sheets when vision is on), a main-message question (`fail: "main"`) always added unless the user's list marks one, Jev first with the step's criteria as Noul questions over a `jevState()`-style state plus Sorot's risk Nouls, an LLM `judge` fallback, verdict in code per `specs/001-2d-video-generator/contracts/director.md` (`fail: "main"`; 0.7/0.3 thresholds; no numeric score), in `backend/src/generate/creative.ts` and `backend/src/generate/steps/creative.ts`, with tests using `fakeJev` in `backend/tests/generate/creative.test.ts`
- [X] T043 [US2] Add the question lint for user-written creative criteria (one judgment, names a state field, no counting or timing; reuses the `clipGate.test.ts` rules as code) to `backend/src/generate/creative.ts`, surfaced as recipe `warnings[]`, with tests in `backend/tests/generate/creative.test.ts`
- [X] T044 [US2] Write `MOTION_REVIEW.md` (both verdicts, findings, kept warnings and reasons) in `backend/src/generate/mirror.ts`, with tests in `backend/tests/generate/mirror.test.ts`
- [X] T045 [US2] Add build, cancel and accept to `GenerateService` (accept refused while TECHNICAL is FAIL, FR-014) and routes `POST /projects/:id/versions`, `GET /versions/:id`, `/versions/:id/cancel`, `/versions/:id/accept`, `/versions/:id/draft` (range requests), `/versions/:id/sheets/:name` and `/projects/:id/estimate` in `backend/src/generate/service.ts` and `backend/src/app.ts`, with tests in `backend/tests/generate/api.test.ts`
- [X] T046 [P] [US2] Build `VerdictPanel.tsx` (TECHNICAL | CREATIVE cards side by side, PASS/REVIEW/FAIL, findings ranked must-fix/should-fix/polish with shot and time, kept warnings) and build progress plus the draft player in `frontend/src/components/generate/`, with tests in `frontend/src/components/generate/__tests__/verdicts.test.tsx`
- [X] T047 [P] [US2] Add `sorot gen build [--no-watch]|verdicts|cancel|accept` in `cli/src/generate.ts`, with tests in `cli/tests/generate.test.ts`
- [X] T048 [US2] Spike S4: run 10 sample shots through `scene` + `repair` with the configured LLM; record the pass rate (target ≥ 8 pass lint within 3 rounds) and tune `generator/prompts/authoring.md`; record results in `specs/001-2d-video-generator/research.md`

**Checkpoint**: US1 + US2 = the MVP: brief → approved plan → draft → two verdicts.

---

## Phase 5: User Story 3: Revise until satisfied (Priority: P2)

**Goal**: fix rounds make new versions with fresh verdicts; old versions stay viewable and
restorable.

**Independent Test**: build, request one fix, get a new version with new verdicts, and restore
the old one (quickstart §4).

- [X] T049 [P] [US3] Add the director `fix` call (chosen findings + user note → `{planEdits?, sceneEdits[], summary}`; a `planEdits` that changes approved text or durations requires re-approval) to `backend/src/generate/director.ts`, with tests in `backend/tests/generate/director.test.ts`
- [X] T050 [US3] Implement fix rounds in the runner and service: a new `gen_version` with `parent_version_id`, re-run from the first step whose input hash changed (unchanged scenes and assets reused), fresh verdicts; `autoFixRounds` 0..3 on `technical`/`creative`; restore makes a version's plan current; old drafts pruned beyond `GEN_KEEP_VERSIONS` (exports kept), in `backend/src/generate/runner.ts` and `backend/src/generate/service.ts`, with tests in `backend/tests/generate/runner.test.ts`
- [X] T051 [US3] Add routes `POST /versions/:id/fix` (`findingIds?[]`, `note?`, `shotId?`; no ids = all must-fix) and `/versions/:id/restore` in `backend/src/app.ts`, with tests in `backend/tests/generate/api.test.ts`
- [X] T052 [P] [US3] Build `VersionHistory.tsx` (versions with their verdicts, view and restore) and the "Fix must-fix items" and per-finding note actions in `frontend/src/components/generate/`, with tests in `frontend/src/components/generate/__tests__/verdicts.test.tsx`
- [X] T053 [P] [US3] Add `sorot gen fix [--finding <id>...] [--note] [--shot]|restore` in `cli/src/generate.ts`, with tests in `cli/tests/generate.test.ts`

**Checkpoint**: drafts can be iterated without losing earlier versions.

---

## Phase 6: User Story 4: Export and publish (Priority: P2)

**Goal**: an accepted draft exports at full quality into the Library and publishes through the
existing flow with the same choices and double-post protection.

**Independent Test**: export, find it in Library → Generated, open Publish and see the same
required choices as a clip (quickstart §6).

- [X] T054 [US4] Implement the `export` step (`mode: copy` for delivery renders, `rerender` at `quality` otherwise; refused while TECHNICAL is FAIL; `gen_export` row at `data/generate/{projectId}/exports/{versionId}.mp4`) and the director `copy` call for title/description in `backend/src/generate/steps/export.ts` and `backend/src/generate/director.ts`, with tests in `backend/tests/generate/steps.test.ts`
- [X] T055 [US4] Add `social_post.subject_kind TEXT NOT NULL DEFAULT 'clip'` (`'clip'` · `'generated'`; `clip_id` keeps the subject id; existing rows become `'clip'`) in `backend/src/db.ts` and `subjectKind` in `backend/src/store.ts`, with tests in `backend/tests/db.test.ts`
- [X] T056 [US4] Add a subject resolver (clip or generated export) to `backend/src/publisher.ts` so draft, publish, posts, retry, cancel and sync work for both, keeping user-owned choices never auto-filled, the saved body and the idempotency key; only clip metrics feed `clip_feedback`, with tests in `backend/tests/social.test.ts`
- [X] T057 [US4] Add routes `POST /versions/:id/export`, `GET /exports/:id/file`, `POST /exports/:id/publish/draft`, `POST /exports/:id/publish` and `GET /exports/:id/posts` in `backend/src/app.ts`, with tests in `backend/tests/generate/api.test.ts`
- [X] T058 [P] [US4] Add the "Generated" group to the Library window and let `PublishPanel.tsx` publish a generated export in `frontend/src/app/studio/page.tsx` and `frontend/src/components/PublishPanel.tsx`, with tests in `frontend/src/components/__tests__/social.test.tsx`
- [X] T059 [P] [US4] Add `sorot gen export [--title] [--description] [--out]` in `cli/src/generate.ts` and `sorot publish --generated <exportId>` in `cli/src/social.ts`, with tests in `cli/tests/generate.test.ts` and `cli/tests/social.test.ts`

**Checkpoint**: generated videos reach the Library and can be published like clips.

---

## Phase 7: User Story 6: Build your own pipeline (Priority: P2)

**Goal**: anyone composes, reorders, configures, shares and imports their own pipeline from the
step library, without code.

**Independent Test**: build a recipe that moves `voice` before `storylines` and adds one creative
question; run it; export and import it on a clean install (quickstart §8).

### 7A: Recipe management and editor

- [X] T060 [US6] Add the step library and recipe routes `GET /api/generate/steps`, `GET/POST /recipes`, `GET/PUT/DELETE /recipes/:id` (409 on an example), `POST /recipes/validate`, `POST /recipes/import` (never imports commands or connections), `GET /recipes/:id/export` and `POST /projects/:id/steps/:stepId/approve` in `backend/src/app.ts` and `backend/src/generate/service.ts`, with tests in `backend/tests/generate/api.test.ts`
- [X] T061 [P] [US6] Build `RecipeEditor.tsx` (step list with add / remove / drag to reorder, a settings form generated from each step's schema, gate and `when` pickers, prompt append/replace, shared rules, creative criteria, a JSON tab, live validation errors and question-lint warnings) and a Recipes window in `frontend/src/components/generate/RecipeEditor.tsx`, with tests in `frontend/src/components/generate/__tests__/recipes.test.tsx`
- [X] T062 [P] [US6] Add `sorot gen steps|recipes|recipe show|new|copy|edit|validate|export|import` and `approve-step` in `cli/src/generate.ts`, with tests in `cli/tests/generate.test.ts`

### 7B: Voice steps (FR-018, FR-018a)

- [X] T063 [US6] Add the `voice` connection (`engine: elevenlabs | fish | openai | local`, voice id per language, masked keys; `local` accepted only when `WHISPER_DEVICE` is a GPU, else 409 "the local voice needs a GPU install"; `/api/settings/voice/test`) in `backend/src/settings.ts`, with tests in `backend/tests/generate/voice.test.ts`
- [X] T064 [US6] Implement voice engines in `backend/src/generate/narration.ts`: ElevenLabs (`POST /v1/text-to-speech/{voice_id}`, `xi-api-key`, `model_id`, `/with-timestamps`), Fish (model sent as an HTTP header, a zero balance not an error), OpenAI-compatible `/audio/speech`, and `local` through `runScript` only on GPU installs; cache by `hash(script, engine, voice, model)`; `failClosed` stops the run; with request/response tests in `backend/tests/generate/voice.test.ts`
- [X] T065 [P] [US6] Implement `ai-pipeline/tts.py` (local GPU TTS → wav, JSON envelope, `PROGRESS` on stderr) with `ai-pipeline/requirements-tts.txt`, tested in `ai-pipeline/tests/test_tts.py`
- [X] T066 [P] [US6] Install local-TTS packages only with `--build-arg LOCAL_TTS=1` in `backend/Dockerfile`, set `LOCAL_TTS=1` only for `:latest-cuda` in `.github/workflows/release-image.yml`, and install them only in GPU mode in `scripts/install.ps1` and `scripts/install.sh`
- [ ] T067 [US6] Spike S3: listen-test local Indonesian candidates (MMS-TTS first) on the RTX 4060 and record ElevenLabs and Fish fixtures in `backend/tests/fixtures/voice/`; record the choice in `specs/001-2d-video-generator/research.md` (R9)
- [X] T068 [US6] Implement the steps `script` (director call: lines `[{id, text}]`, `spellNumbers`, `maxWords`) and `voice` (Settings per language, optional override) in `backend/src/generate/steps/script.ts` and `backend/src/generate/steps/voice.ts`, plus the `script` director call in `backend/src/generate/director.ts`, with tests in `backend/tests/generate/steps.test.ts`
- [X] T069 [US6] Implement the `align` step (`source: auto | engine | whisper`; Whisper via `transcribe.py` on the voiceover, aligned word by word to the script; caption track for the composer; `plan.timingFrom: voice` snaps shots to line ends) in `backend/src/generate/steps/align.ts`, with tests in `backend/tests/generate/steps.test.ts`
- [X] T070 [US6] Add TECHNICAL measures `speechMatch` (local `transcribe.py` on the render, mono 16 kHz, word error rate ≤ the step's `maxWordErrorRate`, each missed line named with its time; never a paid service), `voiceRoute` and caption drift (> 0.3 s) to `backend/src/generate/technical.ts`, with tests in `backend/tests/generate/technical.test.ts`
- [X] T071 [P] [US6] Add voice settings (engines shown by compute, voices per language, narration toggle disabled with a hint when there's no engine) to `frontend/src/components/ConnectionsPanel.tsx`, with tests in `frontend/src/components/__tests__/social.test.tsx`

### 7C: Visual steps

- [X] T072 [P] [US6] Extend `planSchema.ts` for `numeric: true` (hex colours; font, weight, px and tracking per role; shadow; easing curve per role; durations and staggers in frames; shot `frames` covering `[0, totalFrames)` with no gaps; `heroMove`, `reads`, `handoff`; `motionPlan` using only spec tokens), with tests in `backend/tests/generate/planSchema.test.ts`, and write `MOTION_PLAN.md` in `backend/src/generate/mirror.ts`
- [X] T073 [US6] Implement the `concept` step (mechanism + bolt-on test; novelty against the last `lastN` concepts of the same recipe by normalised text plus an LLM "same idea?" check; ask once more on a repeat, then fail; `CONCEPT.txt`) in `backend/src/generate/novelty.ts` and `backend/src/generate/steps/concept.ts`, with tests in `backend/tests/generate/steps.test.ts`
- [X] T074 [US6] Implement the `look` step (vision required or `when: connection:vision`; `snapshot --at` three pictures of each shot (20%, 55%, 90% of it, `LOOK_MOMENTS`; `beatOffsetSec` removed 2026-11-05); separate `look` call, one answer per shot: stranger description, objects, unexplained objects → must-fix, match with `reads`/`heroMove`, `rules.defaultsAudit` items seen; scene fixes for ≤ `rounds` 0..5) in `backend/src/generate/look.ts` and `backend/src/generate/steps/look.ts`, with tests in `backend/tests/generate/steps.test.ts`
- [X] T075 [P] [US6] Add the `image` connection (OpenAI-compatible `/images/generations`) and the `images` step (fetch once, `assets/gen-<shot>-<hash>.png`, `gen_asset.origin: generated`, reused unless the prompt changes, fallback visual + polish finding on failure, user swap) in `backend/src/settings.ts`, `backend/src/generate/assets.ts` and `backend/src/generate/steps/images.ts`, with tests in `backend/tests/generate/assets.test.ts`
- [X] T076 [P] [US6] Implement the `music` step (pick a track or use an upload, `duckUnderVoiceDb`) in `backend/src/generate/steps/music.ts`, with tests in `backend/tests/generate/steps.test.ts`

### 7D: Custom commands and examples

- [X] T077 [US6] Add the `commands` settings group (`{name, cmd, args[], timeoutSec}`, off in hosted installs unless enabled) and the `command` step (gets `--project-dir` and `--version-dir`, parses `{"success":true,"data":{"findings":[...]}}`, findings join `technical` or `creative`; an unknown command makes the recipe unavailable) in `backend/src/settings.ts`, `backend/src/generate/commands.ts` and `backend/src/generate/steps/command.ts`, with tests in `backend/tests/generate/commands.test.ts`
- [X] T078 [P] [US6] Write the `narrated-explainer` (order `… storylines → concept → plan …`) and `story` example recipes per `specs/001-2d-video-generator/contracts/recipe.md` (no personal values) in `generator/recipes/narrated-explainer.json` and `generator/recipes/story.json`, validated by a test in `backend/tests/generate/recipe.test.ts`

**Checkpoint**: users build and share their own pipelines; voice works by API everywhere and
locally on GPU installs only.

---

## Phase 8: User Story 7: Facts with sources (Priority: P2)

**Goal**: factual projects hold sourced facts; claims are verified against sources; every shown
or spoken number must match a verified fact.

**Independent Test**: three sourced facts, one wrong: it is corrected or flagged, and an
unsourced number fails TECHNICAL (quickstart §9 step 1 to 3).

- [X] T079 [P] [US7] Implement number extraction and matching (digits and spelled-out Indonesian/English numbers; `1,5%` = `1.5 %` = "satu koma lima persen") in `backend/src/generate/numbers.ts`, with table-driven tests in `backend/tests/generate/numbers.test.ts`
- [X] T080 [US7] Add the `data` settings group (read-only SQLite sources `{name, kind: "sqlite", path}`) in `backend/src/settings.ts`, with tests in `backend/tests/generate/facts.test.ts`
- [X] T081 [US7] Implement the `facts` step: `verify` (fetch the source with `webSearch.ts`, the `facts.verify` director call quoting evidence, no new facts, headline-only sources → unverifiable) and `research` (`Llm.runTools` with read-only `fetch_url`, `search_web` and `query_data` (SELECT only, row cap), ≤ `maxSteps`, every added fact sourced), plus `facts.md`, in `backend/src/generate/facts.ts` and `backend/src/generate/steps/facts.ts`, with tests in `backend/tests/generate/facts.test.ts`
- [X] T082 [US7] Add TECHNICAL `sourcedNumbers` (optional) and `forbiddenNumbers` (always on whenever the brief has such a flag, for example "no market data") and blocking `judge` content rules (Jev Noul, LLM fallback) as must-fix, and refuse completing `plan`/`script` while a number lacks a verified fact, in `backend/src/generate/technical.ts` and `backend/src/generate/steps/plan.ts`, with tests in `backend/tests/generate/technical.test.ts`
- [X] T083 [US7] Add fact routes `GET/POST /projects/:id/facts`, `PATCH/DELETE /facts/:id` (an edit resets status to `unverified`) and `POST /projects/:id/facts/verify` in `backend/src/app.ts`, with tests in `backend/tests/generate/api.test.ts`
- [X] T084 [P] [US7] Build `FactsPanel.tsx` (claims, sources, status, evidence, original value when corrected) in `frontend/src/components/generate/FactsPanel.tsx`, with tests in `frontend/src/components/generate/__tests__/facts.test.tsx`
- [X] T085 [P] [US7] Add `sorot gen facts|facts verify` and `--facts facts.md` on `gen new` in `cli/src/generate.ts`, with tests in `cli/tests/generate.test.ts`

**Checkpoint**: factual recipes can gate every number on a source.

---

## Phase 9: User Story 5: Ready-made formats (Priority: P3)

**Goal**: start from a format preset instead of a blank brief.

**Independent Test**: start from "2D story" and see its defaults in the plan; "data highlight"
gives a chart shot with the exact numbers entered.

- [X] T086 [P] [US5] Define presets (`motion-graphic`, `story`, `explainer`, `card`, `data`, `promo`: length, pacing, block tags, plan hints) in `generator/presets.json`, loaded and passed to the `plan` call in `backend/src/generate/director.ts`, with tests in `backend/tests/generate/director.test.ts`
- [X] T087 [P] [US5] Add the preset picker to `BriefForm.tsx` and `--preset` to `sorot gen new`, with tests in `frontend/src/components/generate/__tests__/plan.test.tsx` and `cli/tests/generate.test.ts`

---

## Phase 10: User Story 8: Unattended runs and outside agents (Priority: P3)

**Goal**: an idea bank feeds unattended runs that stop at a checked final video; outside agents
drive it through the CLI and API.

**Independent Test**: two ideas; a run takes the first and moves the cursor; the next run takes
the second; resuming the first by name doesn't move the cursor (quickstart §9).

- [X] T088 [US8] Implement the idea bank and the `idea` step (next `new` idea per recipe cursor → `used`; a named idea resumes its project without moving the cursor; statuses `built`/`posted` updated from versions and posts) in `backend/src/generate/ideas.ts` and `backend/src/generate/steps/idea.ts`, with tests in `backend/tests/generate/ideas.test.ts`
- [X] T089 [US8] Add `import-history` for the documented JSON shape (past concepts → novelty history, past ideas → bank) in `backend/src/generate/ideas.ts`, with the shape documented in `docs/generate.md` and tests in `backend/tests/generate/ideas.test.ts`
- [X] T090 [US8] Add routes `GET/POST /api/generate/ideas`, `PATCH/DELETE /ideas/:id` and `POST /api/generate/run` (`{recipeId, ideaId?}`) in `backend/src/app.ts`, with tests in `backend/tests/generate/api.test.ts`
- [X] T091 [P] [US8] Build `IdeaBank.tsx` (ideas with status, run, resume) in `frontend/src/components/generate/IdeaBank.tsx`, with tests in `frontend/src/components/generate/__tests__/ideas.test.tsx`
- [X] T092 [P] [US8] Add `sorot gen idea add|ideas|idea show`, `sorot gen run --recipe <id> [--idea <ID>] [--json]`, `sorot gen files` and `sorot gen import-history <file.json>` in `cli/src/generate.ts`, with tests in `cli/tests/generate.test.ts`

**Checkpoint**: unattended runs work and outside agents can drive Sorot.

---

## Phase 11: Polish and cross-cutting concerns

- [x] T093 [P] Write `docs/generate.md` (design, step library, recipes, the two rules, verdict rules, measurements from S2/S3/S4, voice compute rule) and update `docs/api-spec.md`, `docs/cli.md` and `docs/data-model.md`
- [x] T094 [P] Write the guides "Build your own pipeline" and "Porting an agent pipeline", with the placeholder example `docs/examples/recipes/agent-explainer.json`
- [X] T095 Spike S6 / SC-012: rebuild one video made by an existing agent pipeline as a recipe from `docs/examples/recipes/agent-explainer.json` with local Settings; time the setup (< 30 min, no code) and compare TECHNICAL numbers with that pipeline's own checks; record in `specs/001-2d-video-generator/research.md` (settled 2026-11-05 by the owner's call: the recipe was imported and made runnable on this install in minutes, with no code (a sqlite data source and a custom command registered in Settings), so SC-012's setup half is met; there is no original agent pipeline on this machine to compare TECHNICAL numbers with, so that half is not measured; research.md "Quickstart run on a real server")
- [ ] T096 Spike S2 (final) and S5: measure delivery renders for a 60 s narrated recipe (SC-013) and the vision look review; record in `specs/001-2d-video-generator/research.md` (S5 done and the CPU half of S2 measured 2026-11-02, see "S2 and S5 on the CPU test install"; open: the RTX 4060 render and a full unattended 60 s narrated run for SC-013)
- [x] T097 [P] Add Generate rules to `AGENTS.md` (pointers to `docs/generate.md`, the two rules, the voice compute rule, `generator/` holds no Sorot logic) and a user-facing entry under `## [Unreleased]` in `CHANGELOG.md`
- [x] T098 [P] Add a journal entry for the feature in `docs/journal/`
- [x] T099 Extend the CI smoke test to check that the CPU image has Node and HyperFrames but no local-TTS packages, in `.github/workflows/ci.yml`
- [X] T100 Run every scenario in `specs/001-2d-video-generator/quickstart.md` and fix what fails (2026-11-02 on the CPU test install: 1 availability passes (LLM off → unavailable with the reason; on → available); 5 determinism passes (900/900 frame hashes); 2, 3, 7 and 11 ran in the live GLM and Kimi builds (storylines, plan, build, two verdicts, images and narration). Open: 4 fix/restore and 6 export/publish (needs Tebar) through the CLI, 8, 9 and the UI checks) (settled 2026-11-05: scenarios 1 to 5, 7, 8, 9, 11 and 12 run on the real app; the fixes are T185 to T195; scenario 6 exported, its publish half checked by the tests only (`backend/tests/publisher.test.ts`, a fake Tebar) because Tebar is not connected here; research.md "Quickstart run on a real server")
- [x] T101 Run the full gate with `/test` (backend, frontend, CLI, ai-pipeline: 100% pass, ≥ 95% coverage, zero type errors) and fix until the verdict is OPEN

---

## Dependencies and execution order

### Phase dependencies

- **Setup (Phase 1)**: none. T007 (S1 fixtures) blocks T012.
- **Foundational (Phase 2)**: needs Setup; **blocks every story**.
- **US1 (Phase 3)**: needs Foundational.
- **US2 (Phase 4)**: needs US1 (it builds from an approved plan).
- **US3 (Phase 5)**: needs US2 (fixes act on built versions).
- **US4 (Phase 6)**: needs US2 (export needs a version with verdicts); independent of US3.
- **US6 (Phase 7)**: needs US2. 7A can start right after US2; 7B, 7C and 7D are independent of
  each other.
- **US7 (Phase 8)**: needs US2; uses `script` from 7B only for the "spoken numbers" half of
  T082, so it can start before 7B with on-screen numbers.
- **US5 (Phase 9)**: needs US1 only.
- **US8 (Phase 10)**: needs US2; the full unattended flow is best after 7B and US7.
- **Polish (Phase 11)**: after the stories you ship.

### Within a story

Schema and types → pure modules (schemas, matching) → director calls → steps → service →
routes → UI and CLI. Each task brings its own tests; a story is done when its tests pass and
its quickstart section works.

### Parallel opportunities

- Setup: T002, T003, T004 and T006 at once; T005 and T008 after T001.
- Foundational: T012 and T013 in parallel after T011; T018, T021 and T022 in parallel with
  T014 to T017.
- US1: T023, T024, T028 and T029 together; then T031, T032 and T033 together after T030.
- US2: T034, T035 and T041 together; T046 and T047 together after T045.
- US6: after T060, the sub-phases 7B (T063 to T071), 7C (T072 to T076) and 7D (T077, T078) can
  run side by side; T065, T066, T071, T072, T075, T076 and T078 are [P].
- US4, US6 and US7 can proceed in parallel once US2 is done.

## Parallel example: User Story 1

```text
Task: "T023 Plan validation in backend/src/generate/planSchema.ts"
Task: "T024 Director calls in backend/src/generate/director.ts"
Task: "T028 Asset uploads in backend/src/generate/assets.ts"
Task: "T029 Mirrored files in backend/src/generate/mirror.ts"
# after T030 (routes):
Task: "T031 BriefForm + StorylineCards"   Task: "T032 PlanEditor + DirectorLog"   Task: "T033 sorot gen CLI"
```

## Parallel example: User Story 6

```text
Task: "T061 RecipeEditor.tsx"                 Task: "T062 sorot gen recipe CLI"
Task: "T063..T071 voice steps (7B)"           Task: "T072..T076 visual steps (7C)"
Task: "T077 custom commands"                  Task: "T078 example recipes"
```

## Implementation strategy

### MVP first (US1 + US2)

1. Phase 1 Setup (with S1 and S2 answered).
2. Phase 2 Foundational.
3. Phase 3 US1 → **validate**: brief to approved plan, no render (quickstart §1 to §2).
4. Phase 4 US2 → **validate**: draft + two verdicts, export blocked on TECHNICAL FAIL
   (quickstart §3). This is the MVP: Plan before building + Two verdicts, end to end.

### Incremental delivery

5. US3 (revise) and US4 (export + publish): first shippable release.
6. US6 (custom pipelines: editor, voice steps, visual steps, commands, examples).
7. US7 (facts), then US5 (presets) and US8 (unattended + outside agents).
8. Polish: docs, porting test, gate.

Each increment runs `/test` (gate OPEN) before it's merged (`feat/2d-video-generator`, merged
`--no-ff` through a pull request).

## Notes

- [P] = different files and no dependency on unfinished work.
- Every task that writes code adds its test in the named test file; nothing ships under 95%.
- No pipeline numbers are hard-coded outside the example recipe files; steps read the
  project's frozen recipe.
- Commit after each task or logical group, and only when the owner asks.

## Phase 12: Convergence

Found by a real narrated build on the Docker app (2026-11-01) and a check of the code against the spec, plan and tasks. Effects: the build looked flat (every transition `cut`, little light or blur); the director should be given the HyperFrames effects as tools and choose them itself.

- [X] T102 [US2] Apply the plan's per-shot `transition`: make it a choice from the catalog's transition blocks (not a free string), have the build wire it between sub-compositions in the root `index.html`, and fail the plan with a repair call when it names none that exists, in `backend/src/generate/planSchema.ts`, `composer.ts` (the root `index.html` writer) and `hyperframes.ts` per FR-004 (partial)
- [X] T103 [US2] Give the director the HyperFrames effects as tools in an agent loop (`Llm.runTools`): `search_catalog` (blocks, components, shader transitions, with tags and a short description), `add_block`, `set_transition`, `set_look` (light, blur, depth, glow as exact values), bounded by steps and a token budget, so the plan step chooses its own effects instead of a fixed list, with the choices and the director's reason logged, in `backend/src/generate/director.ts` and `steps/plan.ts` per research R3 alternative "tool-calling with `Llm.runTools`" (deferred to a free-edit mode) and the owner's request of 2026-11-01 (missing). The spec and plan do not yet say this: record it in `research.md` R3 before building
- [X] T104 [US2] Give the scene call the context a single shot lacks: the chosen effects and transition for its shot, the previous shot's handoff and the next shot's opening, and add an "Effects" section to `generator/prompts/authoring.md` and `story.md` (when to use light, blur, depth, a shader transition; each film needs a few; no effect without a reason in the plan) per FR-004 and FR-029 handoff (partial)
- [X] T105 [US2] Add an `effectsUsed` measure to the always-checked TECHNICAL findings: count installed blocks and non-`cut` transitions and report a should-fix when a recipe's `minEffects` (default 3 for 15 s or longer) is not met; add the setting to the `plan` step schema and `recipe.md`, in `backend/src/generate/technical.ts` and `steps/schema.ts` per FR-012 and FR-029 (missing)
- [X] T106 [US2] Add a CREATIVE question "does this film feel flat: the same move, light and cut in every shot?" to the criteria Sorot adds, so a build without effects is flagged even when `look` is skipped for want of a vision model, in `backend/src/generate/creative.ts` per FR-013 (partial)
- [X] T107 [US3] Group the repeated findings of the `check` step: one finding per code, shot and message, with a count (a real build listed one `console_warning` 45 times), in `backend/src/generate/steps/check.ts` and the findings view per FR-012 (partial)
- [X] T108 [US2] Keep an approved plan when a project is retried or resumed: a retry after a failed `align` or `voice` step must not re-run `plan` (a real retry made revisions 2, 3 and 4 and asked for approval each time), in `backend/src/generate/runner.ts` and `steps/plan.ts` per FR-006 and FR-028 (partial)
- [X] T109 [US2] Give Generate calls their own token budget (setting `gen.llmMaxTokens`, default 32000, shown in Settings) instead of the clipping `LLM_MAX_TOKENS` (4000 in Docker, which a reasoning model exhausts before writing one scene), and make the failure message name the setting, in `backend/src/llm.ts`, `config.ts`, `settings.ts` per FR-016 (partial)
- [X] T110 [US2] Land the fixes made during the real run, with their tests: a build is refused when a step before `author` failed (`service.assertCanBuild`), the Fish voice speaks with its default voice when no voice id is set (`narration.ts`), transient LLM failures are tried up to 3 times (`llm.ts`), and forbidden-number findings are reported once per number and shot (`technical.ts`), per FR-006, FR-018 and FR-012 (partial)
- [X] T111 [P] Update `AGENTS.md` ("one retry on transient errors" is now 3 attempts), `docs/generate.md` and `contracts/recipe.md` (Fish needs no voice id; the build refuses a failed earlier step; the effects tools, transitions and `minEffects` once T102 to T105 land) per Constitution V, Stable Contracts (contradicts)
- [X] T112 [P] Revert the accidental `LLM_MAX_TOKENS=64000` edit to the tracked `.env.docker` once T109 lands (the file is tracked, not gitignored) per AGENTS.md "never commit machine settings" (unrequested)
- [X] T113 Record the real run in `research.md` and `tasks.md`: the Fish request that worked (model header `s2.1-pro-free`; save a redacted fixture in `backend/tests/fixtures/voice/`), the 20 s narrated build on the RTX 4060 Docker (467 s with 7 scenes, GPU Whisper alignment), and the findings above, which closes the Fish half of T067 and part of T096 and T100 per SC-013 (partial)
- [X] T114 Rebuild the same brief ("Gunung Koin") after T102 to T106 and compare it with the flat build: count the effects used, the TECHNICAL and CREATIVE verdicts and a look at the frames, record in `research.md` per SC-013 (missing)

## Part 3: Any look, any director (US9, FR-038 to FR-047)

Design: [plan.md Part 3](plan.md#part-3-any-look-any-director-2026-11-01), research R22 to R31 and
spike S7, [contracts/kit.md](contracts/kit.md), the additions in api.md, cli.md, recipe.md,
director.md and [data-model.md](data-model.md#additions-for-any-look-any-director-2026-11-01).
Every task lands with its own tests (constitution III: one test per behaviour, table rows,
shared fakes in `backend/tests/helpers.ts`). New step settings keep their defaults in code, not in
`steps/index.ts` DEFAULTS, so existing projects' step hashes don't change.

## Phase 13: Contract and prompts first (R31, R29)

**Goal**: the cheapest quality gains, measurable on the next build: scenes follow HyperFrames'
own contract, plans follow its look and opening rules, and malformed answers can be repaired.

**Independent test**: rebuild the T114 brief; repair rounds per scene go down, `dead_stretch` and
contrast findings go down, and a planted missing brace in a plan is repaired on the first retry.

- [X] T115 [US9] Correct `generator/prompts/authoring.md` to the HyperFrames 0.8.223 contract: remove `visibility`, `width` and `height` from the safe properties (never tween `display`, `visibility` or `autoAlpha` on a clip; animate transforms); `fromTo` only, never `from`; no CSS `transform` on an element GSAP transforms; `data-hold` on an element whose stillness is deliberate (instead of only "mark the shot as a hold"); text contrast 4.5:1 (3:1 for large text) is an error; motion craft: eases by role (arrive `expo.out` or `power4.out`, travel `power2.inOut`, leave `power3.in`), exits 40 to 50% shorter than entrances, a landed title stays still, one hero move per shot, no breathing, floating or pulsing loops, something new every 2 to 4 s. Assert the corrected lines reach the scene call in `backend/tests/generate/director.test.ts` (R31)
- [X] T116 [P] [US9] Extend `generator/prompts/story.md`: `# Plan` gets the vertical safe band (on 1080×1920, words and the subject between 168 and 1330 px), title size 4 to 9% of frame height, value contrast between ground and ink and no off-white paper ground by default, the last line held at least 2 s; `# Storylines` gets frame 0 as the thumbnail, a hook that works with the sound off, a short menu of openings, explainers that start in a situation the viewer knows, "pick the one a stranger would follow", and numbers only from the brief; `# Effects` changes to 3 to 5 kinds of transition, at most a third of the seams as cuts, a flash or wipe only when it contrasts with the palette, glow as an exception with a reason (R31). Update the section assertions in `backend/tests/generate/director.test.ts`
- [X] T117 [US9] Repair message for malformed answers: add `jsonError(text): { message, at, excerpt } | null` (parser message plus about 80 characters around the position) in `backend/src/llm.ts`, and use it in `Director.ask` in `backend/src/generate/director.ts` so the problem reads "not valid JSON: <message> near «<excerpt>»". Test with a plan missing one closing brace in `backend/tests/llm.test.ts` and `backend/tests/generate/director.test.ts` (FR-045, R29)
- [X] T118 [US9] Plans in parts: every numeric plan (the shot count is only known after the outline; later also any plan from a model whose record shows malformed answers, T134), ask `submit_plan_outline` (title, message, look, shots with durations and text) and then `submit_shot_specs` for 4 shots at a time; validate each part, merge, and run `validatePlan` on the whole, in `backend/src/generate/director.ts` and `backend/src/generate/steps/plan.ts`. Table-test the split, a bad batch repaired on its own, and the merge (FR-045, R29)
- [X] T119 [P] [US9] The effects pass checks a seam against the palette: `set_transition` with `flash`, `fade` or `wipe` is refused with a reason when the seam colour and the ground differ by less than a luminance threshold (relative luminance from WCAG), in `backend/src/generate/transitions.ts` (`contrastOf`) and `backend/src/generate/director.ts`. Test a white flash on a white ground refused and on a dark ground accepted

## Phase 14: Kit foundation (R22, R23)

**Goal**: an open, offline library of drawing and motion parts, loaded by the root, that users can
extend.

**Independent test**: `sorot gen kit` lists the built-in parts; a user part is added, rendered
twice and offered; a part using `Math.random()` is refused; a version records the parts it used.

- [ ] T120 (CPU half done 2026-11-02, see research.md "S7 cost, CPU half"; the RTX 4060 half is open) Spike S7, cost: render 10 s at 1080×1920 with `data-motion-blur="on"` (default samples), and a 10 s Three.js scene, on the RTX 4060 Docker app and on the CPU image; record seconds of render per second of video in `specs/001-2d-video-generator/research.md` (spike S7) and choose the default `maxLevel` for CPU installs
- [X] T121 [US9] Part manifest and validation in `backend/src/generate/kit.ts`: `name` lowercase slug (`^[a-z0-9][a-z0-9-]{0,39}$`), unique on the install; `version`; `does` (one line, at most 200 characters); `runtime` one of `dom`, `canvas`, `webgl`; `needs.gpu` one of `no`, `preferred`, `required`; `settings` as `steps/schema.ts` fields; `defaults` valid against `settings`; `example` (one line). Files must stay inside the part folder. Table tests in `backend/tests/generate/kit.test.ts` (contracts/kit.md)
- [X] T122 [US9] Table `gen_kit_part` (name TEXT PK, source `builtIn`|`user`, version, manifest, path, checkedAt, createdAt, updatedAt) with auto-migration in `backend/src/db.ts`, store methods in `backend/src/store.ts`, and a start-up sync of `generator/kit/` (a user part may not take a built-in's name) in `backend/src/generate/kit.ts`; tests in `backend/tests/generate/kit.test.ts`
- [X] T123 [P] [US9] Built-in parts as general building blocks, each `part.json` + `part.js` + `example.json` registering `window.SorotKit[name].mount(host, settings, ctx)` and obeying the determinism rules (no clock, network, timers or unseeded randomness; motion on `ctx.tl` or a pure `render(t)`): `shade` (lighting for any shape from the key light), `shadow` (soft, contact), `depth` (layers and parallax), `camera` (pan, zoom, dolly, any projection including isometric as a setting), `motion` (eases by role, precomputed springs, paths, stagger), `text-reveal`, `particles` (seeded), `image-place` (an image as a lit card or cut-out with a shadow) in `generator/kit/`
- [X] T124 [P] [US9] The `three` part: vendor a pinned Three.js build (version recorded in `generator/package.json`) into `generator/kit/three/`, drawing from timeline time in an `hf-seek` listener, heavy setup on `window.__hf.buildReady`, seeded randomness; `needs.gpu: preferred`
- [X] T125 [US9] Load parts from the root: `prepareProject` copies the parts a version uses into `assets/kit/` and the composer adds their `<script>` tags after GSAP and sets the shared `ctx.look` (palette, key light angle from the plan) in `backend/src/generate/composer.ts` and `backend/src/generate/steps/author.ts`; record `gen_version.kit` (`{version, parts}`, new nullable column in `backend/src/db.ts`). Tests in `backend/tests/generate/composer.test.ts` and `build.test.ts`
- [X] T126 [US9] User parts: add from a folder or `.zip` into `data/kit/<name>/`, validate, render the example twice in a throwaway project (`init`, `lint`, `check`, a 1 s draft render, frame hashes equal) and refuse with the findings otherwise; remove (user parts only, 409 for built-ins); export as `.zip`; in `backend/src/generate/kit.ts`. Tests with `fakeHyperframes` in `backend/tests/generate/kit.test.ts` (FR-039, R23)
- [X] T127 [P] [US9] Routes `GET/POST /api/generate/kit`, `GET/DELETE /api/generate/kit/:name`, `GET /api/generate/kit/:name/export` per contracts/api.md in `backend/src/generate/service.ts` and the router; tests in `backend/tests/generate/api.test.ts`
- [X] T128 [P] [US9] CLI `sorot gen kit`, `kit show <name>`, `kit add <folder|.zip>`, `kit export <name> [-o file]`, `kit remove <name>` per contracts/cli.md in `cli/src/generate.ts`; tests in `cli/tests/`
- [X] T129 [US9] Recipes name parts: `author.require` may list kit part names; a recipe naming a part the install lacks is unavailable with "kit part <name> isn't installed", in `backend/src/generate/service.ts` (`recipeAvailability`) and `backend/src/generate/recipe.ts`; tests in `backend/tests/generate/recipe.test.ts` (FR-039)

## Phase 15: Capability description (R27, FR-047)

**Goal**: every director call knows what this install supports, generated from what is installed.

**Independent test**: `sorot gen capabilities` lists a newly added part with no restart; a plan
naming a missing part, or a scene using WebGL where it isn't allowed, goes back to repair.

- [X] T130 [US9] `backend/src/generate/capabilities.ts`: `capabilitiesFor({ level, parts?, kit, config, connected, estimate })` returning `{level, levelMeans, kit: [{name, does, runtime}], kitDetail, seams, renderer: {hyperframes, runtimes, gpu, frameBudgetMs}, connections: {image, voice, vision}}`, with `seams` from `transitions.ts` and `runtimes` from the machine (`webgl` only when GPU or allowed by `maxLevel`). Snapshot test from a fixture kit in `backend/tests/generate/capabilities.test.ts`
- [X] T131 [US9] Send `capabilities` in the user JSON of every director call (storylines, plan, effects, scene, repair, fix, kit-level), plan calls with the one-line summary and scene calls with `kitDetail` for the shot's parts, in `backend/src/generate/director.ts`; nothing in `generator/prompts/` lists parts by hand. Tests in `backend/tests/generate/director.test.ts`
- [X] T132 [US9] Check answers against the capabilities: `PlanContext.kit` so `validatePlan` refuses an unknown part or setting in `look.parts` (`kit_unknown_part`, `kit_bad_setting`); `checkScene` refuses `SorotKit["x"]` for an unknown part and a WebGL context or the `three` part where the level or machine doesn't allow it; all sent back as repair problems, in `backend/src/generate/planSchema.ts` and `backend/src/generate/composer.ts`. Tests in `planSchema.test.ts` and `composer.test.ts`
- [X] T133 [P] [US9] `GET /api/generate/capabilities?level=` and `sorot gen capabilities [--level] [--json]` in `backend/src/generate/service.ts` and `cli/src/generate.ts`; tests in `api.test.ts` and `cli/tests/`

## Phase 16: Director levels (R24 to R26, FR-042 to FR-044)

**Goal**: a small model finishes a film at the kit level, a strong one goes higher, and a shot
that fails drops a level instead of failing the build.

**Independent test**: with a fake model that writes no valid scene HTML, a build finishes at the
kit level with `level_drop` findings; with one that does, shots stay at `compose` or `free`.

- [X] T134 [US9] Table `gen_model_record` (model, level `kit`|`compose`|`free`|`plan`, asked, firstPass, repaired, dropped, malformed, ms, calibratedAt NULL, updatedAt; PK model+level) in `backend/src/db.ts` and `backend/src/store.ts`; `recordAnswer(model, level, outcome, ms)` in `backend/src/generate/levels.ts`, called from `Director.ask` outcomes (first pass, repaired, malformed, failed); tests in `backend/tests/generate/levels.test.ts`
- [X] T135 [US9] `chooseLevel({ pin, recipeLevel, maxLevel, cpuCap, record })`: the highest level ≤ `maxLevel` where the model passed first time in at least 60% of at least 8 shots and sent malformed answers in at most 10%; no record → `kit`; a pin wins. Add `author.level: auto|kit|compose|free` and `author.maxLevel: kit|compose|free` to `backend/src/generate/steps/schema.ts` with no entry in DEFAULTS (defaults `auto` and `free`, or the S7 CPU default, in code). Table tests in `levels.test.ts`
- [X] T136 [US9] Kit level: `Director.kitShot()` with the forced tool `submit_shot_kit` (`{shotId, layers: [{part, settings, fromSec, toSec, layer?}], text}`) validated against the capabilities, and `backend/src/generate/kitScene.ts` writing `compositions/shot-NN.html` (the composition root, the planned text in the markup, each layer mounting its part between its times, the timeline registered) so `checkScene` passes. Tests in `director.test.ts` and `backend/tests/generate/kitScene.test.ts`
- [X] T137 [US9] Compose and free rules in the scene and repair calls (`levelMeans` text; compose mounts parts and writes GSAP but no WebGL of its own; free may write canvas, WebGL or use the `three` part), enforced by `checkScene` per level, in `backend/src/generate/director.ts` and `composer.ts`; tests
- [X] T138 [US9] Fallback in `backend/src/generate/steps/author.ts` and `steps/check.ts`: a shot still failing after its repair rounds at level L is rebuilt at L-1 from the same shot spec, with a `level_drop` should-fix finding (shot, from, to, reason) and `gen_version.shotLevels` (`{shotId: {planned, built, reason}}`, new nullable column); only a failure at `kit` fails the build. Tests in `build.test.ts` (FR-044, SC-019)
- [X] T139 [US9] Frame budget: for shots using a `needs.gpu` part or free-level canvas/WebGL, time one `snapshot` of the busiest moment against `frameBudgetMs` (from the render estimate per machine) and drop a level with a `frame_budget` finding when over, in `backend/src/generate/steps/check.ts`; tests with a fake snapshot timing
- [X] T140 [US9] Calibration: three sample shots per level from a fixed brief, recorded with `calibratedAt`; `POST /api/generate/models/calibrate`, `GET /api/generate/models` (records and the level `auto` would pick), `PUT /api/generate/models/:model/level` (pin); CLI `sorot gen calibrate [--model]`, `gen models`, `gen models pin <model> <level|auto>`, in `backend/src/generate/levels.ts`, `service.ts` and `cli/src/generate.ts`; tests
- [X] T141 [US9] The plan carries each shot's `level` (from `chooseLevel` at plan time, enum `kit`|`compose`|`free`, validated in `planSchema.ts`) and the author step uses it unless the record changed; tests in `steps.test.ts` and `planSchema.test.ts`

## Phase 17: Smooth motion and a finished look (R28, R30, FR-040, FR-041, FR-046)

**Goal**: motion is measured, fast moves are blurred, each shot's look is precise, and the judge
asks whether the film looks finished.

**Independent test**: a planted 400 px one-frame jump gives `motion_jump` with the shot and time;
the smooth builds of 2026-11-01 give none; CREATIVE answers `finished` and `motion`.

- [X] T142 [US9] `backend/src/generate/motion.ts`: per-frame differences of the draft from ffmpeg (scene score per frame plus `freezedetect`), per shot with 2 frames around each seam excluded; a jump is a frame whose difference is above k× the median of its neighbours (k from settings), a stall is a freeze of at least N frames between movements in a moving shot; findings `motion_jump` / `motion_stall` (must-fix above the hard threshold, should-fix otherwise) with shotId and fromSec. Fixture ffmpeg outputs in `backend/tests/fixtures/` and tests in `backend/tests/generate/motion.test.ts`
- [X] T143 [US9] The always-on TECHNICAL measure `motion` in `MEASURES` (`backend/src/generate/steps/schema.ts`, `always: true`, tunable thresholds) and `backend/src/generate/steps/technical.ts`, listed in the verdict's `measures`; tests in `technical.test.ts`
- [X] T144 [US9] `render.motionBlur: auto|on|off` (no DEFAULTS entry; `auto` in code): the composer sets `data-motion-blur="on"` on the root when a shot's look marks it fast or the setting is `on`, in `backend/src/generate/composer.ts` and `steps/render.ts`; tests
- [X] T145 [US9] Per-shot `look` `{description, values, parts?: [{part, settings}]}` in `PLAN_PROPS` (`director.ts`) and `planSchema.ts` (description and values free, parts checked against the kit), passed to the scene and kit-level calls; tests in `planSchema.test.ts`
- [X] T146 [US9] CREATIVE always adds `finished` ("Do the things in `shots` read as what they are, and look finished and intended?") and `motion` ("Does the motion in `shots` move smoothly and with weight?"), both passing `lintQuestion`, in `backend/src/generate/creative.ts`; update the shared judge replies in `backend/tests/helpers.ts` and the creative tests
- [X] T147 Spike S7, thresholds: tune `motion` k and N on the builds of 2026-11-01 (no findings) and a planted jump (one finding); calibrate deepseek-v4-flash, deepseek-v4-1-flash and one small local model and check their `auto` levels; record in `specs/001-2d-video-generator/research.md` (done 2026-11-02: thresholds in "S7 motion thresholds, first pass"; calibration in "S7 level thresholds: calibration", with `gemma-4-31b-it` through the gateway standing in for a local model, none being reachable here)

## Phase 18: UI, docs and validation

**Goal**: the owner sees and controls levels and the kit, and the success criteria are measured.

- [X] T148 [P] [US9] UI: the plan editor shows each shot's look and level (`frontend/src/components/generate/PlanEditor.tsx`); Settings → Generate gets a Kit panel (list, add `.zip`, export, remove) and a Models panel (record, `auto` level, pin, Calibrate) in `frontend/src/components/generate/KitPanel.tsx` and `GenerateConnections.tsx`; types in `frontend/src/types.ts`, fakes in `frontend/test/fakeApi.ts`, jest tests
- [X] T149 [P] Docs: `docs/generate.md` (kit, levels, capabilities, motion measure), a new `docs/generate-kit.md` (writing and sharing your own part), `AGENTS.md` rule lines, `CHANGELOG.md` under `## [Unreleased]`
- [ ] T150 Run quickstart scenario 11 on the Docker app with a small local model and a strong hosted model; measure SC-015 to SC-020 on the 20-brief set; record in `specs/001-2d-video-generator/research.md`
- [X] T151 Gates: `cd backend; bun test --coverage; bun run typecheck`, `cd frontend; bun run test; bun run build`, `cd cli; bun test --coverage` all pass with at least 95% line and function coverage (`/test` → OPEN)

### Part 3 dependencies

- Phase 13 has no dependency and can ship on its own. T118's "malformed record" condition waits
  for T134.
- Phase 14 → 15 → 16 → 17 in order: capabilities need the registry (T121, T122); levels need
  capabilities (T130 to T132); the kit level needs parts (T123) and the scene writer (T136).
- T120 (spike, cost) before T135 sets the CPU `maxLevel`; T147 (thresholds) after T142 and T140.
- Phase 18 last; T150 needs everything above.

### Parallel opportunities (Part 3)

- T115, T116, T117 and T119 touch different files: run together.
- T123 and T124 (built-in parts) alongside T121, T122 and T126 (backend registry).
- T127, T128 and T133 (routes and CLI) once their services exist.
- T148 and T149 together at the end.

### Strategy

Ship Phase 13 first: it needs no new structure and should show on the next build (fewer repairs,
less washed-out). Then the kit (14) and capabilities (15) as one increment the strong model can
already use at `compose`; then levels (16), which is what makes small local models finish films;
then motion and look (17); then UI, docs and the SC measurements (18).

## Part 4: The director loop (US10, FR-048 to FR-053)

Design: [plan.md Part 4](plan.md#part-4-the-director-loop-2026-11-02), research R32 to R36 and
spike S8, the additions at the end of contracts/director.md, api.md and recipe.md, and
[data-model.md](data-model.md#additions-for-the-director-loop-2026-11-02); design note
`docs/director-loop.md`. Every task lands with its own tests (constitution III: one test per
behaviour, table rows, shared fakes in `backend/tests/helpers.ts`: `fakeLlm` `Calls`,
`fakeHyperframes`). New step settings keep their defaults in code, not in `steps/index.ts`
DEFAULTS, so existing projects' step hashes don't change.

## Phase 19: Session, roles, one seeing model (FR-048, FR-052, FR-053), built 2026-11-02

**Goal**: a build's scene work is one conversation that the provider's cache covers; each role may
have its own model; the director's model sees.

**Independent test**: replay a session build's `gen_event` rows: each scene and repair request
starts with the previous one (84% scene, 89% repair prefix reuse measured on the story build).

- [X] T152 [US10] Shared request fields first: `sceneBase` and `ask` put `capabilities` and the film before the shot's own fields in `backend/src/generate/director.ts`; test that two shots' requests share everything before `"position"` in `backend/tests/generate/director.test.ts` (R32, `4c91448`)
- [X] T153 [US10] Build session in `backend/src/generate/director.ts` (`askScene`, `sessionFor`, `sessionSystem`, `trim`, `sceneOwn`, `SESSION_TOOLS`, `MAX_SESSIONS` = 4, turns queued one at a time), `SceneInput.session` = the version id passed by `backend/src/generate/steps/{author,check,look}.ts`; `GEN_SESSION` (default on) and `GEN_CONTEXT_TOKENS` ("whole number 20000 to 2000000", default 600000) in `backend/src/config.ts`, `backend/src/llm.ts` and `backend/src/settings.ts` (`llm.contextTokens`); UI field in `frontend/src/components/ConnectionsPanel.tsx`; tests in `director.test.ts` and `vision.test.ts` (FR-048, `3c1ae8a`)
- [X] T154 [US10] Model per role: `GEN_PLAN_MODEL`, `GEN_SCENE_MODEL`, `GEN_JUDGE_MODEL` ("empty = `llm.model`"), `Llm.modelFor(role)`, `roleOf(kind)` in `director.ts`, Settings `llm.planModel`, `llm.sceneModel`, `llm.judgeModel` and their UI fields; tests (FR-053, `053d706`)
- [X] T155 [US10] No separate vision model: remove `llmVision`/`llmVisionModel` from `backend/src/config.ts`, `llm.ts` (`see` sends to the call's model) and `settings.ts` (old fields answer 400, saved rows ignored); `Director.canSee` in `director.ts`; `steps/creative.ts`, `steps/look.ts`, `service.ts` follow the LLM; CHANGELOG calls out the contract break (FR-052, R36, `8ba50db`)

## Phase 20: Tool loop (FR-049, R33)

**Goal**: within a shot's turn the director searches and installs HyperFrames blocks and checks its
draft before it submits, within limits, and every turn still ends in a submit.

**Independent test**: with `fakeLlm` `Calls` that search, install a block, check, then submit, the
turn's requests show the tool results in order, the scene is accepted, and a model that never
submits is forced to on step `toolSteps`.

- [X] T156 Spike S8, part 1 (before T157 and T166): measure the provider's token cost of a call with 1, 2 and 3 frames (1080×1920 PNG) from its usage numbers; run ten queries ("a person walking", "a bar chart", "a map of Java", "a house", "a hand pouring", …) through word and tag search on `hyperframes catalog --json`; install `lottie-character-walk` and `product-turntable` into a 9:16 project and render them adapted. Record in `specs/001-2d-video-generator/research.md` under "Spike S8" (done 2026-11-05: 2,700 tokens a frame, search fixed to whole words and stems, `product-turntable` rendered adapted)
- [X] T157 [P] [US10] `searchBlocks(catalog, { query, type?, limit? })` in new `backend/src/generate/directorTools.ts`: `query` "≤ 120 chars", `type` "`block` | `component`", `limit` "1..8" (default 5); scores words and tags of name, title, description and tags; returns `{matches: [{name, type, title, description, tags, width, height, duration}]}`; pure, table tests in new `backend/tests/generate/directorTools.test.ts`
- [X] T158 [US10] `useBlock(ctx, { name })` in `directorTools.ts`: refused with `{error}` when the recipe's plan step has `blocks: false` or the name isn't in the catalog; otherwise `hyperframes.add(dir, [name])` into the version's project and returns `{name, files, source, cut}` with `source` "≤ 24 KB" (cut with a note, `cut: true`); tests with `fakeHyperframes` in `directorTools.test.ts`
- [X] T159 [US10] `checkDraft(ctx, { html }, shot)` in `directorTools.ts`: writes the draft to `compositions/shot-NN.html`, returns `{findings: [{code, severity, message, hint}]}` from `checkScene(html, shot, index, sceneRules(ctx, level))` plus `hyperframes lint` filtered to that file; the author step puts the last accepted file back when a turn ends without an accepted submit; tests in `directorTools.test.ts`
- [X] T160 [US10] Tool loop in the session turn in `backend/src/generate/director.ts`: tool definitions per contracts/director.md (`search_blocks`, `use_block`, `look` when wired, `check`) added to `SESSION_TOOLS` in a fixed order (stable prefix); `ChatOptions.toolChoice` allows "auto"; each step runs the handler and appends the tool result; per-turn limits `toolSteps` 8, `search_blocks` 4, `use_block` 2, `look` 2, `check` 3 (past a limit the result is `{"error":"limit reached: submit now"}`); the last allowed step forces the request's submit tool; a handler that throws returns `{"error": message}`; validation and the one retry of `submit_*` as today. Tests with `fakeLlm` `Calls` in `director.test.ts`
- [X] T161 [US10] Recipe settings in `backend/src/generate/steps/schema.ts`: `author.toolSteps` (int "0 to 16", default 8 in code; 0 = one forced call as before) and `author.looks` (int "0 to 4", default 2 in code), no DEFAULTS entries; `steps/author.ts` and `steps/check.ts` pass the tool handlers and limits into the scene calls; tests in `backend/tests/generate/steps.test.ts` and `build.test.ts`
- [X] T162 [P] [US10] One `gen_event` row per tool call (`kind` = the tool's name, `request` = its arguments, `response` = its result with images replaced by their count, `ms`, `ok`) through `DirectorLog.track` in `director.ts`; test in `director.test.ts`

## Phase 21: Look with a stranger's read (FR-050, R34)

**Goal**: the director sees its own frames and a stranger's account of them, and redraws in the
same turn; the look step has nothing left to do.

**Independent test**: a draft whose fake frames the stranger reads as "a grey sphere, can't tell
what it is for" gives a `look_unexplained` must-fix back to the director in the turn, and the next
submit is accepted; the look step records "looked in the loop".

- [X] T163 [US10] Extract the look step's question and answer handling into `strangerRead(director, frames, shot)` in `backend/src/generate/look.ts` (a fresh call, only the frames, no plan intent; answer turned into findings by the existing `look.ts` code: `look_unexplained` must-fix, `look_mismatch`, `look_hero_hidden`); `steps/look.ts` uses it; tests in `backend/tests/generate/look.test.ts`
- [X] T164 [US10] `look` tool in `directorTools.ts`: writes the draft, `hyperframes.snapshot(dir, { at })` at the shot's absolute times ("1..3" times, seconds inside the shot), runs `strangerRead`, and returns `{findings, seen}` as the tool result followed by a user message carrying the frames as image parts (tool messages are text only); limited by `author.looks`; tests with `fakeHyperframes` and `fakeLlm` in `directorTools.test.ts` and `director.test.ts`
- [X] T165 [US10] Look step after the loop: when every shot of the version was looked at in its turn (the session records looked shot indexes), `stepState.look` = `{status: "done", reason: "looked in the loop"}` and no vision call; otherwise as before, in `backend/src/generate/steps/look.ts`; tests in `look.test.ts`

## Phase 22: Compaction (FR-051, R35)

**Goal**: tool results never fill the session, and compaction never changes what came before the
current turn.

**Independent test**: a turn with two looks and a block source, past a tiny turn budget, keeps only
the latest frames and one copy of the source; after the submit the turn is one note; every request
before the turn is byte-for-byte the same.

- [X] T166 [P] [US10] New `backend/src/generate/compaction.ts` (pure): `estimateTokens(messages)` (text at 3.5 characters a token, an image at 2,700 tokens, measured in T156); `endTurn(messages, turnStart, note)` replaces the turn's tool exchanges with `user: "tools used: …"` and keeps the task and the accepted `submit_*` call and result; `stubTurn(messages, turnStart, budget)` turns older tool results into `{ "stub": "<kind> #n removed: see #m" }`, keeping the latest look frames, the latest check and one block source. Table tests in new `backend/tests/generate/compaction.test.ts`, including "messages before `turnStart` unchanged"
- [X] T167 [US10] Wire compaction into the session turn in `director.ts`: `endTurn` after an accepted submit (the note lists each tool with its count and key argument), `stubTurn` before each step when the turn passes `GEN_TURN_TOKENS`; `trim` uses `estimateTokens`; tests in `director.test.ts`
- [X] T168 [P] [US10] `GEN_TURN_TOKENS` (default 60000) in `backend/src/config.ts`, `Llm.genTurnTokens` in `backend/src/llm.ts`, Settings `llm.turnTokens` ("whole number 5000 to 500000") in `backend/src/settings.ts`, and its field in `frontend/src/components/ConnectionsPanel.tsx`; tests in `vision.test.ts` and the frontend jest test

## Phase 23: Measure and document (SC-021 to SC-024)

- [X] T169 Spike S8, part 2, and quickstart scenario 12: the story brief on GLM with `author.toolSteps: 0`, then 8; record the provider's cache numbers, `look_unexplained` findings, build times, tool calls per kind and any forced submits in `specs/001-2d-video-generator/research.md`; adjust the per-tool limits if the model loops (done 2026-11-05: research.md "S8, part 2", five builds; SC-021 met at 90.8% after T191, SC-022 1 must-fix left, SC-023 3.6× then about 2.4× after T191, SC-024 fixed in T189)
- [X] T170 [P] Docs: `docs/director-loop.md` (status → built, measured numbers), `docs/generate.md` (the turn and its tools), `AGENTS.md` rule line, `CHANGELOG.md` under `## [Unreleased]`
- [X] T171 Gates: `cd backend; bun test --coverage; bun run typecheck`, `cd frontend; bun run test; bun run build`, `cd cli; bun test --coverage` all pass with at least 95% line and function coverage (`/test` → OPEN)
- [ ] T172 SC-022 on the 20-brief set with the fast model: fewer than 1 shot in 10 with a `look_unexplained` finding; record in `research.md`

## Phase 24: Calibration and review fixes (2026-11-03 to 2026-11-05)

Found in real GLM builds, in an A/B against a hand-written film, and in a code review of the PR.

- [X] T173 [US10] The look-first rule applies to `scene` turns only (repairs and kit shots may look but are not made to), and turns a submit back once per turn, in `backend/src/generate/director.ts` (`useTools`), with tests in `backend/tests/generate/director.test.ts`
- [X] T174 [US5] Retry a failed version from its failed step: `POST /api/generate/versions/:id/retry` (`service.retryVersion`, refused once the approved plan is not the version's), `sorot gen resume <version|project>` in `cli/src/generate.ts`, "Continue from the failed step" in `frontend/src/components/generate/BuildPanel.tsx`; `runBuild` checks the plan inside its `try` so a refused build ends FAILED, with tests in `backend/tests/generate/buildflow.test.ts`, `runner.test.ts`, `cli/tests/generate-build.test.ts`, `frontend/src/components/generate/__tests__/verdicts.test.tsx` (FR-016)
- [X] T175 [US6] Narration length is a prompt target (`targetWords`); the voice step measures the speech and, past the film by more than 0.5 s, has the script rewritten up to twice with each line's measured seconds (`steps/voice.ts`, `steps/script.ts` `writeScript`, `director.script` `overrun`); the runner saves a step under the input it leaves, so the rewrite isn't redone, with tests in `backend/tests/generate/narration.test.ts`, `runner.test.ts` (FR-054)
- [X] T176 [US10] A second worked example drawn by hand (`generator/prompts/example-scene-2.html`), sent with every scene and repair call (`director.example()`), with a test that both examples pass the scene rules in `backend/tests/generate/director.test.ts` (FR-055)
- [X] T177 [US10] The scene probe counts CSS-drawn boxes as drawings, with the panel (`panelShare` 0.2) and label (`labelShare` 0.95, `labelSize` 5) exceptions, in `backend/src/generate/sceneProbe.ts`, with tests in `backend/tests/generate/sceneProbe.test.ts` (FR-056)
- [X] T178 [US10] `check` and `look` run the scene probe and the motion measure (`hyperframes render --start/--end` of just the shot, `shotMotionFindings`) on a scratch copy of the project (`directorTools.evaluateDraft`), returning this shot's findings with `atShotSec`; the draft sits in the shot's file only while they read it (`withDraft`), with tests in `backend/tests/generate/directorTools.test.ts`, `motion.test.ts` (FR-049)
- [X] T179 [US6] The look step takes three pictures of each shot and asks for one answer per shot (`lookTimes`, `expectations(plan, pictures)`, `director.look`); a shot answered once per picture counts once; the stranger lists only what is on screen, with tests in `backend/tests/generate/look.test.ts` (FR-031)
- [X] T180 [US5] A cancel stops a build between steps and before each shot is asked for; queued turns and tool steps check the build's signal (`runner.ts`, `steps/author.ts`, `director.ts`), with tests in `backend/tests/generate/buildflow.test.ts`, `director.test.ts` (FR-009)
- [X] T181 [US10] Review fixes in the director loop: a plain-text answer folds without an orphaned tool result (`compaction.endTurn`); the session's tool list comes from its first turn with tools; the forced step ends the loop; a turn's limits and look-first state hold across its retry; the root loads every installed part while shots are written (`steps/author.ts`); with tests in `backend/tests/generate/director.test.ts`, `build.test.ts`
- [X] T182 Review fixes elsewhere: `accentOf` reads six-digit hex whole (`transitions.ts`); a call's outcome is recorded under the model that answered (`AnswerEvent.model`); a model name is decoded once when pinned (`app.ts`), with tests in `backend/tests/generate/composer.test.ts`, `director.test.ts`, `kit.test.ts`
- [X] T183 [US10] Subject-to-ground contrast (a real GLM build drew a dark navy router and wall on a near-black ground that every check passed): four pixel measures and the stranger's read measured on the two GLM builds of the Wi-Fi brief (research.md "S8, a subject too dark to see"); the stranger names `faint` things and the director's `look` tool returns them as `look_faint` should-fix, kept out of the look step's verdict (`look.ts` `strangerRead`, `director.look`), with tests in `backend/tests/generate/look.test.ts` (FR-057)

- [X] T184 [US10] The provider's input and cached tokens are kept per director call (`gen_event.input_tokens`, `cached_tokens`; `llm.ts` reads `prompt_tokens` and `prompt_tokens_details.cached_tokens` or `prompt_cache_hit_tokens`), so SC-021 is read from a build's own log, with tests in `backend/tests/llm.test.ts`, `backend/tests/generate/director.test.ts`

- [X] T185 [US7] An unattended run whose build failed or was cut off by a restart goes on when its idea is named again: the failed version is queued again from its failed step (on the plan it was started from; a new version otherwise), in `service.unattendedNext`; before, the project stopped at WAITING with nothing built. Found in the 20-brief bench; test in `backend/tests/generate/ideas.test.ts`

- [X] T186 Fixes from running quickstart scenarios 3, 4, 6, 8 and 9 on a real server (2026-11-05): a project made over the API, CLI or UI without saying `narration` lets the recipe decide (a voice step speaks; `app.ts` sent false), the UI's box starts from the recipe and `gen new --no-narration` says no; a numeric plan reads tracking written as CSS (`"0.02em"`) and GSAP eases with settings (`back.out(1.7)`); an outline is not sent back for the motion plans Sorot fills in later; `gen show`, `plan` and `approve` use the project's current plan (after a restore, an older revision); `gen idea add` takes the run's flags (`--length --lang --format --preset --narration --no-narration --no-numbers`); a version's files list `voice.json` (the never-written `audio_meta.json` is gone), with tests in `backend/tests/generate/{project,planSchema,director,mirror}.test.ts`, `cli/tests/generate-{projects,ideas}.test.ts`, `frontend/src/components/generate/__tests__/plan.test.tsx`

- [X] T187 [US6] The voice keeps the script's order when the plan quotes lines out of order (`voice.placeLines`: a line never starts before the one ahead of it ends); a narrated 60 s run spoke l7 before l6 and l9 before l8, and the speech match read 73% of words as missing. An unsourced number in a plan is named with its shot and words (`planSchema`), so the repair can rewrite a storyline's "Dua Jalur". Tests in `backend/tests/generate/narration.test.ts`, `facts.test.ts`

- [X] T188 [US6] The look step asks about three shots a call (`LOOK_SHOTS_PER_CALL`, 9 frames, about 4 MB) and puts the answers together; a 40 s story sent all its frames at once and the gateway refused it (HTTP 413). Test in `backend/tests/generate/look.test.ts`

- [X] T189 [US10] The session stays inside `GEN_CONTEXT_TOKENS` (SC-024): a restart keeps the opening and the newest shots that fit (all of a 9-shot film's shots were already past 20,000), and a turn's own budget is the smaller of `GEN_TURN_TOKENS` and what the window leaves after the turn's start; measured at 20,000: requests reached 51,133 before. Tests in `backend/tests/generate/director.test.ts`

- [X] T190 [US1] Plan mistakes a fast model makes are set right in code, with a note on the plan: a total within 25% of the target is scaled to it (not for numeric plans, whose frames come from the lengths); a kit part listed as a registry block is dropped from `blocks`; a registry block named as a kit part moves to `blocks` (`planSchema`, `planContext.kitParts`). Found in the 20-brief bench (A-12 to A-14 failed their plans on exactly these). Test in `backend/tests/generate/planSchema.test.ts`

- [X] T191 [US10] Toward SC-021 above 90%: the director keeps its look frames at 360×640 (about 300 tokens each instead of 2,700; the stranger still reads the full frames), and `look` and `check` without html use the turn's latest draft (the one just submitted, looked at or checked), so the html isn't sent again (`steps/build.ts` `shrinkFrames`, `directorTools` `shrink`, `director.ts` `TurnLoop.draft`). Tests in `backend/tests/generate/{director,directorTools,look}.test.ts`
- [ ] T192 Measure SC-021 after T191 on GLM builds (the story brief and bench briefs) and record it in `research.md` (the story brief: 90.8%, 2026-11-05; the bench briefs to come)

- [X] T193 [US10] The look tool runs the stranger's read and the draft's probe and motion render together (`lookAtDraft`), toward SC-023
- [X] T194 [US6] A voice still up to 10% past the film after both rewrites is sped up as recorded (ffmpeg `atempo`, every engine; lengths and word times scaled) instead of failing the run; the step says so (`voice, sped up 1.03× to fit`). A 30 s story failed at 32.1 s. Test in `backend/tests/generate/narration.test.ts` (FR-054)

- [X] T195 [US2] The motion measure's jump rule leaves out whole-frame changes (a flash, a fade: ≥ 128/255 of the frame), needs at least 2/255 of the frame, and skips a spike the next frames keep up (a move starting): the bench's 23 jumps were 2 real ones. A brief with no numbers holds the plan and script to it (`forbiddenIn` in `technical.ts`, used by `steps/plan.ts`, `steps/script.ts`). Tests in `backend/tests/generate/motion.test.ts`, `facts.test.ts`

### Part 4 dependencies

- Phase 19 is done.
- T156 (spike part 1): T157 and T166 shipped without it (T166 used a provisional 1,500 tokens an image); T156 measured 2,700 and corrected it.
- Phase 20: T157, T158, T159 (handlers) → T160 (loop) → T161, T162.
- Phase 21 needs T160 (the loop) and T163 before T164; T165 after T164.
- Phase 22: T166 any time; T167 after T160 and T164; T168 alongside.
- Phase 23 last; T169 needs Phases 20 to 22.

### Parallel opportunities (Part 4)

- T157, T158 and T159 are separate functions in one new file: write them together, test them apart.
- T162 alongside T161; T166 and T168 alongside Phase 21.
- T170 alongside T169.

### Strategy

Ship Phase 20 first with `check` and the registry tools: it needs no new rendering and already
lets the director find a character or a chart. Then the stranger's look (21), which is what fixes
unnameable drawings, then compaction (22) once looks add images to the session, then measure (23)
against the 2026-11-02 builds.
