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

- [ ] T060 [US6] Add the step library and recipe routes `GET /api/generate/steps`, `GET/POST /recipes`, `GET/PUT/DELETE /recipes/:id` (409 on an example), `POST /recipes/validate`, `POST /recipes/import` (never imports commands or connections), `GET /recipes/:id/export` and `POST /projects/:id/steps/:stepId/approve` in `backend/src/app.ts` and `backend/src/generate/service.ts`, with tests in `backend/tests/generate/api.test.ts`
- [ ] T061 [P] [US6] Build `RecipeEditor.tsx` (step list with add / remove / drag to reorder, a settings form generated from each step's schema, gate and `when` pickers, prompt append/replace, shared rules, creative criteria, a JSON tab, live validation errors and question-lint warnings) and a Recipes window in `frontend/src/components/generate/RecipeEditor.tsx`, with tests in `frontend/src/components/generate/__tests__/recipes.test.tsx`
- [ ] T062 [P] [US6] Add `sorot gen steps|recipes|recipe show|new|copy|edit|validate|export|import` and `approve-step` in `cli/src/generate.ts`, with tests in `cli/tests/generate.test.ts`

### 7B: Voice steps (FR-018, FR-018a)

- [ ] T063 [US6] Add the `voice` connection (`engine: elevenlabs | fish | openai | local`, voice id per language, masked keys; `local` accepted only when `WHISPER_DEVICE` is a GPU, else 409 "the local voice needs a GPU install"; `/api/settings/voice/test`) in `backend/src/settings.ts`, with tests in `backend/tests/generate/voice.test.ts`
- [ ] T064 [US6] Implement voice engines in `backend/src/generate/narration.ts`: ElevenLabs (`POST /v1/text-to-speech/{voice_id}`, `xi-api-key`, `model_id`, `/with-timestamps`), Fish (model sent as an HTTP header, a zero balance not an error), OpenAI-compatible `/audio/speech`, and `local` through `runScript` only on GPU installs; cache by `hash(script, engine, voice, model)`; `failClosed` stops the run; with request/response tests in `backend/tests/generate/voice.test.ts`
- [ ] T065 [P] [US6] Implement `ai-pipeline/tts.py` (local GPU TTS → wav, JSON envelope, `PROGRESS` on stderr) with `ai-pipeline/requirements-tts.txt`, tested in `ai-pipeline/tests/test_tts.py`
- [ ] T066 [P] [US6] Install local-TTS packages only with `--build-arg LOCAL_TTS=1` in `backend/Dockerfile`, set `LOCAL_TTS=1` only for `:latest-cuda` in `.github/workflows/release-image.yml`, and install them only in GPU mode in `scripts/install.ps1` and `scripts/install.sh`
- [ ] T067 [US6] Spike S3: listen-test local Indonesian candidates (MMS-TTS first) on the RTX 4060 and record ElevenLabs and Fish fixtures in `backend/tests/fixtures/voice/`; record the choice in `specs/001-2d-video-generator/research.md` (R9)
- [ ] T068 [US6] Implement the steps `script` (director call: lines `[{id, text}]`, `spellNumbers`, `maxWords`) and `voice` (Settings per language, optional override) in `backend/src/generate/steps/script.ts` and `backend/src/generate/steps/voice.ts`, plus the `script` director call in `backend/src/generate/director.ts`, with tests in `backend/tests/generate/steps.test.ts`
- [ ] T069 [US6] Implement the `align` step (`source: auto | engine | whisper`; Whisper via `transcribe.py` on the voiceover, aligned word by word to the script; caption track for the composer; `plan.timingFrom: voice` snaps shots to line ends) in `backend/src/generate/steps/align.ts`, with tests in `backend/tests/generate/steps.test.ts`
- [ ] T070 [US6] Add TECHNICAL measures `speechMatch` (local `transcribe.py` on the render, mono 16 kHz, word error rate ≤ the step's `maxWordErrorRate`, each missed line named with its time; never a paid service), `voiceRoute` and caption drift (> 0.3 s) to `backend/src/generate/technical.ts`, with tests in `backend/tests/generate/technical.test.ts`
- [ ] T071 [P] [US6] Add voice settings (engines shown by compute, voices per language, narration toggle disabled with a hint when there's no engine) to `frontend/src/components/ConnectionsPanel.tsx`, with tests in `frontend/src/components/__tests__/social.test.tsx`

### 7C: Visual steps

- [ ] T072 [P] [US6] Extend `planSchema.ts` for `numeric: true` (hex colours; font, weight, px and tracking per role; shadow; easing curve per role; durations and staggers in frames; shot `frames` covering `[0, totalFrames)` with no gaps; `heroMove`, `reads`, `handoff`; `motionPlan` using only spec tokens), with tests in `backend/tests/generate/planSchema.test.ts`, and write `MOTION_PLAN.md` in `backend/src/generate/mirror.ts`
- [ ] T073 [US6] Implement the `concept` step (mechanism + bolt-on test; novelty against the last `lastN` concepts of the same recipe by normalised text plus an LLM "same idea?" check; ask once more on a repeat, then fail; `CONCEPT.txt`) in `backend/src/generate/novelty.ts` and `backend/src/generate/steps/concept.ts`, with tests in `backend/tests/generate/steps.test.ts`
- [ ] T074 [US6] Implement the `look` step (vision required or `when: connection:vision`; `snapshot --review` + `--at` each beat + `beatOffsetSec`; separate `look` call: stranger description, objects, unexplained objects → must-fix, match with `reads`/`heroMove`, `rules.defaultsAudit` items seen; scene fixes for ≤ `rounds` 0..5) in `backend/src/generate/look.ts` and `backend/src/generate/steps/look.ts`, with tests in `backend/tests/generate/steps.test.ts`
- [ ] T075 [P] [US6] Add the `image` connection (OpenAI-compatible `/images/generations`) and the `images` step (fetch once, `assets/gen-<shot>-<hash>.png`, `gen_asset.origin: generated`, reused unless the prompt changes, fallback visual + polish finding on failure, user swap) in `backend/src/settings.ts`, `backend/src/generate/assets.ts` and `backend/src/generate/steps/images.ts`, with tests in `backend/tests/generate/assets.test.ts`
- [ ] T076 [P] [US6] Implement the `music` step (pick a track or use an upload, `duckUnderVoiceDb`) in `backend/src/generate/steps/music.ts`, with tests in `backend/tests/generate/steps.test.ts`

### 7D: Custom commands and examples

- [ ] T077 [US6] Add the `commands` settings group (`{name, cmd, args[], timeoutSec}`, off in hosted installs unless enabled) and the `command` step (gets `--project-dir` and `--version-dir`, parses `{"success":true,"data":{"findings":[...]}}`, findings join `technical` or `creative`; an unknown command makes the recipe unavailable) in `backend/src/settings.ts`, `backend/src/generate/commands.ts` and `backend/src/generate/steps/command.ts`, with tests in `backend/tests/generate/commands.test.ts`
- [ ] T078 [P] [US6] Write the `narrated-explainer` (order `… storylines → concept → plan …`) and `story` example recipes per `specs/001-2d-video-generator/contracts/recipe.md` (no personal values) in `generator/recipes/narrated-explainer.json` and `generator/recipes/story.json`, validated by a test in `backend/tests/generate/recipe.test.ts`

**Checkpoint**: users build and share their own pipelines; voice works by API everywhere and
locally on GPU installs only.

---

## Phase 8: User Story 7: Facts with sources (Priority: P2)

**Goal**: factual projects hold sourced facts; claims are verified against sources; every shown
or spoken number must match a verified fact.

**Independent Test**: three sourced facts, one wrong: it is corrected or flagged, and an
unsourced number fails TECHNICAL (quickstart §9 step 1 to 3).

- [ ] T079 [P] [US7] Implement number extraction and matching (digits and spelled-out Indonesian/English numbers; `1,5%` = `1.5 %` = "satu koma lima persen") in `backend/src/generate/numbers.ts`, with table-driven tests in `backend/tests/generate/numbers.test.ts`
- [ ] T080 [US7] Add the `data` settings group (read-only SQLite sources `{name, kind: "sqlite", path}`) in `backend/src/settings.ts`, with tests in `backend/tests/generate/facts.test.ts`
- [ ] T081 [US7] Implement the `facts` step: `verify` (fetch the source with `webSearch.ts`, the `facts.verify` director call quoting evidence, no new facts, headline-only sources → unverifiable) and `research` (`Llm.runTools` with read-only `fetch_url`, `search_web` and `query_data` (SELECT only, row cap), ≤ `maxSteps`, every added fact sourced), plus `facts.md`, in `backend/src/generate/facts.ts` and `backend/src/generate/steps/facts.ts`, with tests in `backend/tests/generate/facts.test.ts`
- [ ] T082 [US7] Add TECHNICAL `sourcedNumbers` (optional) and `forbiddenNumbers` (always on whenever the brief has such a flag, for example "no market data") and blocking `judge` content rules (Jev Noul, LLM fallback) as must-fix, and refuse completing `plan`/`script` while a number lacks a verified fact, in `backend/src/generate/technical.ts` and `backend/src/generate/steps/plan.ts`, with tests in `backend/tests/generate/technical.test.ts`
- [ ] T083 [US7] Add fact routes `GET/POST /projects/:id/facts`, `PATCH/DELETE /facts/:id` (an edit resets status to `unverified`) and `POST /projects/:id/facts/verify` in `backend/src/app.ts`, with tests in `backend/tests/generate/api.test.ts`
- [ ] T084 [P] [US7] Build `FactsPanel.tsx` (claims, sources, status, evidence, original value when corrected) in `frontend/src/components/generate/FactsPanel.tsx`, with tests in `frontend/src/components/generate/__tests__/facts.test.tsx`
- [ ] T085 [P] [US7] Add `sorot gen facts|facts verify` and `--facts facts.md` on `gen new` in `cli/src/generate.ts`, with tests in `cli/tests/generate.test.ts`

**Checkpoint**: factual recipes can gate every number on a source.

---

## Phase 9: User Story 5: Ready-made formats (Priority: P3)

**Goal**: start from a format preset instead of a blank brief.

**Independent Test**: start from "2D story" and see its defaults in the plan; "data highlight"
gives a chart shot with the exact numbers entered.

- [ ] T086 [P] [US5] Define presets (`motion-graphic`, `story`, `explainer`, `card`, `data`, `promo`: length, pacing, block tags, plan hints) in `generator/presets.json`, loaded and passed to the `plan` call in `backend/src/generate/director.ts`, with tests in `backend/tests/generate/director.test.ts`
- [ ] T087 [P] [US5] Add the preset picker to `BriefForm.tsx` and `--preset` to `sorot gen new`, with tests in `frontend/src/components/generate/__tests__/plan.test.tsx` and `cli/tests/generate.test.ts`

---

## Phase 10: User Story 8: Unattended runs and outside agents (Priority: P3)

**Goal**: an idea bank feeds unattended runs that stop at a checked final video; outside agents
drive it through the CLI and API.

**Independent Test**: two ideas; a run takes the first and moves the cursor; the next run takes
the second; resuming the first by name doesn't move the cursor (quickstart §9).

- [ ] T088 [US8] Implement the idea bank and the `idea` step (next `new` idea per recipe cursor → `used`; a named idea resumes its project without moving the cursor; statuses `built`/`posted` updated from versions and posts) in `backend/src/generate/ideas.ts` and `backend/src/generate/steps/idea.ts`, with tests in `backend/tests/generate/ideas.test.ts`
- [ ] T089 [US8] Add `import-history` for the documented JSON shape (past concepts → novelty history, past ideas → bank) in `backend/src/generate/ideas.ts`, with the shape documented in `docs/generate.md` and tests in `backend/tests/generate/ideas.test.ts`
- [ ] T090 [US8] Add routes `GET/POST /api/generate/ideas`, `PATCH/DELETE /ideas/:id` and `POST /api/generate/run` (`{recipeId, ideaId?}`) in `backend/src/app.ts`, with tests in `backend/tests/generate/api.test.ts`
- [ ] T091 [P] [US8] Build `IdeaBank.tsx` (ideas with status, run, resume) in `frontend/src/components/generate/IdeaBank.tsx`, with tests in `frontend/src/components/generate/__tests__/ideas.test.tsx`
- [ ] T092 [P] [US8] Add `sorot gen idea add|ideas|idea show`, `sorot gen run --recipe <id> [--idea <ID>] [--json]`, `sorot gen files` and `sorot gen import-history <file.json>` in `cli/src/generate.ts`, with tests in `cli/tests/generate.test.ts`

**Checkpoint**: unattended runs work and outside agents can drive Sorot.

---

## Phase 11: Polish and cross-cutting concerns

- [ ] T093 [P] Write `docs/generate.md` (design, step library, recipes, the two rules, verdict rules, measurements from S2/S3/S4, voice compute rule) and update `docs/api-spec.md`, `docs/cli.md` and `docs/data-model.md`
- [ ] T094 [P] Write the guides "Build your own pipeline" and "Porting an agent pipeline", with the placeholder example `docs/examples/recipes/agent-explainer.json`
- [ ] T095 Spike S6 / SC-012: rebuild one video made by an existing agent pipeline as a recipe from `docs/examples/recipes/agent-explainer.json` with local Settings; time the setup (< 30 min, no code) and compare TECHNICAL numbers with that pipeline's own checks; record in `specs/001-2d-video-generator/research.md`
- [ ] T096 Spike S2 (final) and S5: measure delivery renders for a 60 s narrated recipe (SC-013) and the vision look review; record in `specs/001-2d-video-generator/research.md`
- [ ] T097 [P] Add Generate rules to `AGENTS.md` (pointers to `docs/generate.md`, the two rules, the voice compute rule, `generator/` holds no Sorot logic) and a user-facing entry under `## [Unreleased]` in `CHANGELOG.md`
- [ ] T098 [P] Add a journal entry for the feature in `docs/journal/`
- [ ] T099 Extend the CI smoke test to check that the CPU image has Node and HyperFrames but no local-TTS packages, in `.github/workflows/ci.yml`
- [ ] T100 Run every scenario in `specs/001-2d-video-generator/quickstart.md` and fix what fails
- [ ] T101 Run the full gate with `/test` (backend, frontend, CLI, ai-pipeline: 100% pass, ≥ 95% coverage, zero type errors) and fix until the verdict is OPEN

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
