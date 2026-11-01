# Implementation Plan: 2D Video Generator (Studio)

**Branch**: `feat/2d-video-generator` | **Date**: 2026-10-31 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-2d-video-generator/spec.md`

## Summary

Add a **Generate** mode next to clipping: a brief becomes a 2D video (motion graphic, 2D story,
explainer, card, data highlight, promo) rendered by **HyperFrames** (HTML + GSAP → MP4). A
**bounded LLM director**, run by a Sorot-coded state machine, writes the storylines, the
shot-by-shot plan and each scene's HTML. Sorot code runs every HyperFrames command and enforces
the two rules:

- **Plan before building**: nothing is built from an unapproved plan, and shot timing is written
  by code from that plan.
- **Two verdicts**: TECHNICAL is computed in code from HyperFrames `lint`/`check`, ffprobe and
  plan-lock checks. CREATIVE comes from a separate fresh-context judge (Jev first, LLM otherwise,
  with optional vision). Export is blocked while TECHNICAL is FAIL.

No LangChain, LangGraph or LangSmith: the existing `Llm` and `Jev` clients, SQLite and a small
queue cover the flow, and a local `gen_event` log replaces hosted tracing
([research R1 to R4](research.md)).

**The pipeline is the user's.** A **recipe** ([contracts/recipe.md](contracts/recipe.md)) is
an ordered list of steps from a step library (idea, facts, script, voice, align, storylines,
plan, concept, images, music, author, check, look, render, command, technical, creative,
export). Each step has its own settings, an optional gate (owner / director / none), and the
user's own prompt text. A **runner** walks the steps. Only the two rules are fixed: a gated plan
before building, and both verdicts after rendering. Anyone running Sorot can compose, tune,
share and import pipelines. Neutral examples ship (`quick`, `narrated-explainer`, `story`) with
no personal values. Users add checks Sorot lacks as their own local commands registered in
Settings. Outside agents and schedulers drive runs through `sorot gen run --json`
([research R14 to R21](research.md#part-2-custom-pipelines)). A real agent pipeline the owner
shared was used as the test case: it must be expressible as a recipe without code (SC-012).

## Technical Context

**Language/Version**: TypeScript on Bun 1.3 (backend, CLI, frontend); Node.js 22+ only as the
HyperFrames CLI runtime; Python 3.12 for the local Indonesian TTS (GPU installs only).

**Primary Dependencies**: `hyperframes`, pinned (Apache-2.0; needs Chrome via
`browser ensure`, plus FFmpeg); the existing `Llm` (OpenAI-compatible; optional vision model)
and `Jev` clients; existing `webSearch.ts` for fetching fact sources; new optional `image`
(OpenAI-compatible), `voice` (ElevenLabs, Fish Audio or OpenAI-compatible APIs on every
install; a local engine on GPU installs only) and `data` (read-only SQLite sources) connections;
a local TTS model chosen in spike S3 (MMS-TTS `facebook/mms-tts-ind` baseline), shipped only in
GPU builds; existing Whisper for caption timing; Next.js 14 static
export UI.

**Storage**: SQLite (new `gen_*` tables, `social_post.subject_kind`); project files under
`data/generate/{projectId}/` (per-version HyperFrames project folders, assets, drafts, exports).

**Testing**: `bun test --coverage` (backend, CLI), jest (frontend), pytest (`tts.py`). All
HyperFrames commands go through the injected `exec`, and the LLM, Jev, image and voice calls go
through the injected `fetch`. Golden `lint`/`check --json` fixtures come from spike S1.

**Target Platform**: Windows 11 (Docker on WSL2, plus native once S1 confirms it) and Linux
(Docker and native); CPU and NVIDIA GPU. Must also run hosted (Principle I).

**Project Type**: web app (Bun API serving a static UI) + CLI, in the existing monorepo.

**Performance Goals**: brief to approved plan in < 5 min for a 30 s video (SC-001); a 30 s 9:16
draft ready in ≤ 10 min after approval on the owner's machine (SC-002, confirmed in spike S2);
a final-quality 1080×1920 render runs near the reference rate (58 s ≈ 6 min at delivery, 2 workers);
director calls bounded (scene repair ≤ 3 rounds per shot, fix round ≤ 1 director call per
finding group).

**Constraints**: deterministic renders (no network or clock at render time; generated images
cached by prompt hash; bundled fonts); works offline except for the AI connections; video length
5 to 90 s; formats 9:16, 16:9, 1:1; Indonesian-first text; generation builds never block clipping
for long (own queue, waits during clip GPU stages).

**Scale/Scope**: one owner, a few projects a week; projects of ≤ 20 shots; ≤ 10 versions kept per
project by default (older drafts are pruned, exports kept).

## Constitution Check

*GATE: checked before Phase 0 and again after Phase 1 (below). Constitution v2.2.0.*

| Principle | Check | Status |
|---|---|---|
| I. Local-First, Host-Ready | Runs locally on HyperFrames, Node and Chrome; paths come from `DATA_DIR`, and data-source paths come from settings; long work is queued and cancellable; the UI stays same-origin; image and voice providers are optional; speech QC uses local Whisper only; no hosted tracing (LangSmith rejected) | PASS |
| I. Build order | The strict build order applies to the clipping pipeline (constitution v2.2.0); Generate follows its frozen recipe's order and keeps the two fixed rules (FR-035) | PASS |
| II. Language Boundaries | Director, state machine, verdicts, plan-lock and publishing are Bun. Media: HyperFrames is called as an external CLI through `exec`, like FFmpeg and yt-dlp, and holds no Sorot logic. Local TTS is Python (media/ML) with the JSON envelope. Caption timing reuses `transcribe.py`. Users' custom commands are their own scripts outside Sorot's code, run through `exec` with the same envelope, timeout and cancel; Sorot logic stays in Bun | PASS (Node runtime and commands noted in Complexity Tracking) |
| III. Test Gate | All effects injected through `createApp(config, deps)`; tables plus shared fakes (`fakeHyperframes`, `fakeLlm` replies in `backend/tests/helpers.ts`); 95% coverage on the new modules | PASS |
| IV. Optional AI / AI-only modes | Generate is an AI-only mode: it shows as unavailable without an LLM, keeps work and allows retry on failure, and clipping never depends on it. Images and voice degrade gracefully: a recipe that *requires* a missing provider (voice, vision, a data source) shows as unavailable with the reason, others keep working, and fail-closed narration never renders silent. Jev first for CREATIVE and for blocking judge rules, LLM fallback | PASS |
| V. Stable Contracts | New tables with camelCase API keys; `social_post.subject_kind` defaults to `'clip'`, so existing rows and the API stay valid; auto-migration in `db.ts`; frontend stays a static export | PASS |
| VI. Safe Publishing | Publishing goes through the same `publisher.ts` path: user-owned choices are never auto-filled, the row and body are saved first, and the idempotency key is kept. Unattended runs stop at a checked final video; there is no publish step in the step library | PASS |
| Platform constraints | `docker-compose.yml` stays CPU-only; the Dockerfile adds Node 22 and Chrome libraries; local-TTS packages are installed only with `--build-arg LOCAL_TTS=1` (the `:latest-cuda` image), so the CPU image ships none, and CPU installs voice through online APIs (FR-018a); PowerShell changes are ASCII and PS 5.1 safe; `install.sh` stays shellcheck-clean | PASS |

**Post-design re-check (after Phase 1)**: still PASS. The contracts keep every existing route
and key (new publish routes sit beside the clip ones, and `subjectKind` is additive). The data
model adds tables and one defaulted column. All director and judge calls are plain `Llm`/`Jev`
calls with injected `fetch`, and all HyperFrames calls use injected `exec`. Nothing in the design
makes clipping depend on Generate.

## Project Structure

### Documentation (this feature)

```text
specs/001-2d-video-generator/
├── spec.md
├── plan.md              # this file
├── research.md          # R1 to R13, spikes S1 to S4
├── data-model.md        # gen_* tables, plan JSON, state machine
├── quickstart.md        # end-to-end validation guide
├── contracts/
│   ├── recipe.md        # recipe shape, step library, dependency rules, examples, porting an agent pipeline
│   ├── api.md           # REST endpoints under /api/generate
│   ├── cli.md           # `sorot gen ...`
│   └── director.md      # director and judge call contracts (inputs, JSON outputs, task field)
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks (not created here)
```

### Source Code (repository root)

```text
backend/src/
├── generate/
│   ├── service.ts        # GenerateService: projects, versions, accept/export, routes' entry point
│   ├── runner.ts         # walks a frozen recipe's steps; gates; step cache by input hash; fix re-runs
│   ├── recipe.ts         # recipe validation (shape, ranges, dependencies, the two fixed rules), examples, availability, freezing
│   ├── steps/            # one module per step type: settings schema + run(); the library = this folder
│   ├── commands.ts       # user-registered local commands (exec, envelope, timeout, cancel; off when hosted)
│   ├── director.ts       # LLM director calls: script, storylines, pick, plan, revise, scene, repair, fix, copy
│   ├── facts.ts          # verify (fetch + judge) / research (runTools, read-only tools); number matching
│   ├── look.ts           # self-review: beat frames, stranger descriptions, defaults audit (vision)
│   ├── novelty.ts        # concept history per recipe; repeat check
│   ├── ideas.ts          # idea bank, cursor, unattended run, history import (documented JSON)
│   ├── mirror.ts         # writes BRIEF.md, facts.md, STORYLINES.md, SPEC.md, MOTION_PLAN.md, CONCEPT.txt, MOTION_REVIEW.md
│   ├── planSchema.ts     # plan/shot validation and normalisation (lengths, text limits, fonts, numeric spec)
│   ├── composer.ts       # writes root index.html from the plan; plan-lock checks on scenes
│   ├── hyperframes.ts    # exec wrapper: init, add, catalog, lint, check, snapshot, render, doctor
│   ├── technical.ts      # TECHNICAL verdict: opt-in measures (code) + blocking judge rules + command findings
│   ├── creative.ts       # CREATIVE verdict: the user's questions via Jev or a fresh LLM judge, optional vision; question lint
│   ├── assets.ts         # uploads, generated images (image connection), fonts, music
│   ├── narration.ts      # voice engines from Settings (elevenlabs, fish, openai; local tts.py only when WHISPER_DEVICE is a GPU), cache by script hash, alignment (engine timestamps or Whisper), captions, speech match
│   └── queue.ts          # build queue (concurrency 1, waits on clip GPU stages)
├── llm.ts                # + optional image content parts (vision)
├── settings.ts           # + `image`, `voice`, `data`, `commands`, `llm.vision`
├── db.ts / store.ts      # + gen_* tables, social_post.subject_kind
├── publisher.ts          # + subject abstraction (clip | generated export)
└── app.ts                # + /api/generate routes
backend/tests/generate/   # one file per module above, table-driven; fixtures/hyperframes/*.json

generator/                # new workspace package (no Sorot logic)
├── package.json          # pins hyperframes
├── recipes/              # example recipes (read-only; copied to edit): quick, narrated-explainer, story
├── prompts/authoring.md  # condensed HyperFrames authoring contract (attributed)
├── prompts/story.md      # storyline and plan guidance
└── fonts/                # bundled OFL fonts with Indonesian coverage

ai-pipeline/
├── tts.py                # local TTS (GPU installs only) → wav + JSON envelope
├── requirements-tts.txt  # local-TTS packages; installed only in GPU builds/installs
└── tests/test_tts.py

cli/src/
└── generate.ts           # `sorot gen` subcommands (registered in commands.ts)

frontend/src/
├── app/studio/page.tsx   # + "Generate" window in the dock
├── components/generate/
│   ├── BriefForm.tsx
│   ├── StorylineCards.tsx
│   ├── PlanEditor.tsx    # shot table + "Ask the director" box + approve
│   ├── VerdictPanel.tsx  # TECHNICAL | CREATIVE cards, findings, fix actions
│   ├── VersionHistory.tsx
│   ├── DirectorLog.tsx
│   ├── RecipeEditor.tsx  # step list (add / remove / drag to reorder), per-step settings form from the step schema, gates, prompts, rules, criteria, JSON tab; live validation
│   ├── FactsPanel.tsx    # claims, sources, status, evidence
│   └── IdeaBank.tsx      # ideas, status, run / resume
└── lib/api.ts            # + generate endpoints

docs/examples/recipes/    # agent-explainer.json: porting an existing agent pipeline (placeholders)

backend/Dockerfile        # + Node 22, Chrome libraries, `hyperframes browser ensure`; ARG LOCAL_TTS (0 default) → requirements-tts.txt
.github/workflows/release-image.yml   # LOCAL_TTS=1 for :latest-cuda only
scripts/install.ps1, install.sh   # + Node 22 check/install for native mode; local TTS packages only in GPU mode
```

**Structure Decision**: keep the existing monorepo layout. Generation logic is a new `generate/`
folder inside `backend/src` (it shares config, store, LLM, Jev, settings and publisher). The
pinned HyperFrames CLI, prompts and fonts live in a new `generator/` workspace package so the
version is locked in the root `bun.lock` and the assets ship in Docker. No Sorot logic goes in
`generator/`.

## Design Overview

```text
 UI / CLI / outside agents ──► /api/generate ──► GenerateService ──► Runner (frozen recipe, the user's step order, gates)
                                   │
              ┌────────────────────┼─────────────────────────────┐
              ▼                    ▼                             ▼
      Director (Llm)        Composer + Hyperframes (exec)   Verdicts
      storylines, plan,     init · add · write index.html   TECHNICAL: lint/check/ffprobe/plan-lock (code)
      revise, scene,        · lint/check · snapshot ·       CREATIVE: Jev Nouls ▸ fresh LLM judge
      repair, fix, copy     render (draft / delivery)                (+ review sheets if vision)
              │                    │                             │
              └──────── gen_event (local director log) ◄─────────┘
```

Key flows. The runner runs whichever steps the project's frozen recipe lists, **in the recipe's
order**. These are the common steps; their order is the user's choice:

0. **Project steps** (any of, in any valid order): `idea` → `facts` (verify, or research with
   read-only tools) → `script` (numbers mapped to facts) → `voice` (from Settings, fail-closed,
   cached) → `align` (Whisper word timings) → `storylines` → `plan` → `concept` → `images` /
   `music`. A gate stops for the user (`owner`) or logs the director's decision (`director`).
1. **Plan** (`POST /projects`, `/storylines/:i/pick`, `/plan/revise`, `/plan/approve`): director
   calls return JSON → `planSchema` validates and normalises it (durations sum to the target
   ± 10%, text limits, fonts, generated-image flags only when `image` is connected, narration
   only when `voice` is available; numeric spec, frames, motion plan and concept novelty when
   the recipe asks) → a stored plan version. The `plan` gate locks it (the user approves, or the
   director approves with a logged reason).
2. **Build** (`POST /versions`): queue → assets (images fetched and cached, voiceover + caption
   alignment) → HyperFrames `init` + `add` → composer writes `index.html` → director writes each
   scene → plan-lock + `lint`/`check` → repair, or hold with a reason (≤ recipe rounds per shot)
   → look self-review (vision, ≤ step rounds) → `render` (draft or delivery, per the step) →
   any `command` steps → `snapshot --review` + frames every N s → TECHNICAL (the recipe's
   measures, blocking rules, command findings) and CREATIVE (the user's questions) →
   MOTION_REVIEW.md → version BUILT, with optional `autoFixRounds` for unattended recipes.
   Cancel kills the process tree, and the version becomes CANCELLED.
3. **Fix** (`POST /versions/:id/fix`): the chosen findings go to the director → it returns plan
   edits (re-approval is needed only when they change approved text or durations) and/or scene
   edits → a new version reuses unchanged scenes and assets → fresh verdicts.
4. **Export** (`POST /versions/:id/export`): refused while TECHNICAL is FAIL → `render --quality
   delivery` (or a copy, when the verdicts were already on the final render) → `gen_export` → Library "Generated" → the existing Publish panel through
   `subjectKind: "generated"`.

## Phases (for /speckit-tasks)

0. **Spikes S1 to S4** ([research](research.md#spikes-before-the-main-build)): they may change
   the draft settings, Windows support or the local (GPU-only) TTS engine.
1. **Foundation**: `generator/` package, Docker and installer runtime, `hyperframes.ts` wrapper +
   fixtures, `gen_*` schema, **recipe model, validator and runner** (with the minimal step set:
   storylines, plan, author, check, render, technical, creative, export) and the `quick` example,
   settings (`image`, `voice`, `data`, `commands`, `llm.vision`), the Generate window showing
   availability per recipe.
2. **US1, plan**: director storylines, plan and revise; `planSchema`; Brief, Storyline and Plan UI;
   `sorot gen new|pick|plan|revise|approve`.
3. **US2, build + two verdicts**: composer, scene and repair loop, queue, draft render, TECHNICAL,
   CREATIVE, Verdict UI; `sorot gen build|verdicts`.
4. **US3, revise**: fix rounds, version history and restore, scene and asset reuse.
5. **US4, export + publish**: delivery render, Library group, publisher subject abstraction,
   post copy.
6. **US6, custom pipelines**: step library endpoint, recipe editor (reorder, per-step forms,
   gates, prompts, rules, criteria, question lint), CLI, copy/import/export/validate, frozen
   copies, availability reasons, custom `command` steps.
7. **US7, facts**: facts panel, verify/research, number matching, forbidden numbers, blocking
   judge rules.
8. **Voice steps**: `script`, `voice` (Fish/OpenAI/local), `align`, fail-closed, cache, speech
   match measure.
9. **Advanced steps**: numeric `plan` + motion plan, `concept` (novelty), `look` (vision),
   final-render measures, mirrored files; the `narrated-explainer` and `story` examples; the
   porting test (S6, SC-012): the shared agent pipeline rebuilt as a recipe without code.
10. **US8, idea bank and outside agents**: `idea` step, cursor, `sorot gen run --json`, history
    import.
11. **US5, presets** and **extras**: format presets, generated images.
12. **Docs**: `docs/generate.md` (design, recipes, measurements), `AGENTS.md` rules, journal entry,
    README, a "build your own pipeline" guide, and a "porting an agent pipeline" guide.

## Part 3: Any look, any director (2026-11-01)

**Spec**: User Story 9, FR-038 to FR-047, SC-015 to SC-020. **Research**:
[R22 to R31, spike S7](research.md#part-3-any-look-any-director-2026-11-01). **Contracts**:
[kit.md](contracts/kit.md) and the additions at the end of api.md, cli.md, recipe.md and
director.md. **Data**: [data-model.md](data-model.md#additions-for-any-look-any-director-2026-11-01).

### Summary

The director may draw anything; Sorot adds a floor. An open **kit** of drawing and motion parts
(browser modules with a manifest, built-in and user-added, proven deterministic before use) is
loaded by the root composition. **Director levels** decide how much the model writes per shot:
`kit` (the model fills part settings in a tool call and Sorot writes the scene), `compose` (the
model writes the scene using parts) and `free` (any drawing code within the contract). The level
comes from each model's **record** on this install or a calibration, and a shot that fails at its
level is rebuilt one level down. Every call gets a **capability description** generated from the
installed kit, the renderer, the machine and the connections, and answers are checked against it.
TECHNICAL gains an always-on `motion` measure; CREATIVE always asks whether things look finished
and move with weight. The authoring contract follows HyperFrames' own rules (R31).

### Technical context (changes only)

- **Dependencies**: Three.js, pinned, shipped as the built-in `three` kit part (offline). No other
  new dependency; the motion measure uses ffmpeg, which Sorot already runs.
- **Storage**: `gen_kit_part`, `gen_model_record`, two nullable `gen_version` columns; user parts
  under `data/kit/`.
- **Performance**: kit-level calls are small (one shot's layers), so a small local model stays fast;
  WebGL and motion blur costs are measured in spike S7 and set `maxLevel` for CPU installs.
- **Testing**: parts are tested by rendering their examples through the fake HyperFrames runner
  (unit) and the real CLI in spike S7; the model record and level choice are pure functions with
  table tests; the capability description is snapshot-tested from a fixture kit.

### Constitution check (Part 3)

| Principle | Check | Status |
|---|---|---|
| I. Local-first, host-ready | Parts ship in the install or are added by the owner; renders stay offline; `data/kit` sits under `DATA_DIR` | PASS |
| II. Language boundaries | Part scripts are browser media code run by HyperFrames (like GSAP), not Sorot logic; level choice, capability, validation, scene writing and measures are Bun | PASS |
| III. Test gate | Every new module is a pure function or goes through the injected `exec`/`fetch`; shared fakes extended (`fakeHyperframes` renders part examples, `fakeLlm` `Calls`) | PASS |
| IV. Optional AI | Generate stays AI-only; the kit level lets a small local model finish a film, and falling back keeps a build alive when a model can't write advanced code | PASS |
| V. Stable contracts | Additive tables, columns, JSON fields and routes; new step settings keep their defaults in code so existing projects don't re-run | PASS |
| VI. Safe publishing | Unchanged | PASS |

**Post-design re-check**: still PASS. User parts are the one new trust point; they follow the
custom-command model (only the owner adds them; recipes can only name them; each is rendered twice
and checked before use).

### Source changes

```text
generator/kit/<name>/{part.json, part.js, example.json}   built-in parts (shade, shadow, depth, camera, motion, text-reveal, particles, image-place, three)
backend/src/generate/kit.ts            registry: sync built-ins, add/validate/remove user parts, example render check
backend/src/generate/capabilities.ts   the capability description per call, and the checks against it
backend/src/generate/levels.ts         model record updates, auto level choice, calibration run
backend/src/generate/kitScene.ts       writes compositions/shot-NN.html from a kit-level answer
backend/src/generate/motion.ts         the `motion` measure (ffmpeg frame differences per shot)
backend/src/generate/{composer,director,planSchema,steps/author,steps/check,steps/technical,creative}.ts   wired in
cli/src/generate.ts                    kit, capabilities, models, calibrate
frontend/src/components/generate/      plan shows each shot's look and level; Settings: kit list, models and calibrate
generator/prompts/{authoring,story}.md HyperFrames contract fixes (R31); parts are never listed by hand
```

### Flow (build, with levels)

```text
plan (look + parts per shot, checked against capabilities) ─► approve
   └► author: for each shot, level = pin ?? auto(record, recipe maxLevel, machine)
        kit      ─► submit_shot_kit ─► kitScene writes HTML
        compose  ─► submit_scene (mounts parts) ─► kit-call + plan-lock checks
        free     ─► submit_scene (any drawing code) ─► same checks
        ▼ repair rounds; still failing or over the frame budget ─► one level down (level_drop)
   └► check ─► render (motion blur per plan) ─► TECHNICAL (+ motion) ─► CREATIVE (+ finished, motion)
   └► model record updated from every answer
```

### Phases (for /speckit-tasks)

13. **Contract and prompts first** (R31, R29): HyperFrames authoring rules, story guidance, error
    position in repairs, plans in parts. No new UI; measurable on the next build.
14. **Kit foundation** (R22, R23): part format, registry, built-in parts, root loading, user parts
    with validation, CLI and API; spike S7 for WebGL and motion blur cost.
15. **Capability description** (R27): generated per call, checks in plan and scene validation.
16. **Levels** (R24 to R26): kit-level tool call and scene writer, compose and free rules, model
    record, auto choice, calibration, fallback with `level_drop`.
17. **Smooth motion and finished look** (R28, R30): `motion` measure, motion blur setting, plan
    `look`, CREATIVE criteria.
18. **UI, docs and validation**: plan shows look and level; Settings kit and models; docs; quickstart
    scenario 11; SC-015 to SC-020 measured on the 20-brief set with a small local model and a
    strong one.
## Complexity Tracking

| Item | Why needed | Simpler alternative rejected because |
|---|---|---|
| Node.js 22 runtime next to Bun (Docker + native) | HyperFrames' CLI requires Node ≥ 22 and Chrome; it is the chosen renderer | Running it under Bun isn't supported by its docs; writing our own renderer duplicates HyperFrames |
| New `generator/` workspace package | Pins the CLI version in the one lockfile and ships prompts and fonts | `npx hyperframes@x` at runtime downloads at run time (non-deterministic, needs network) |
| Separate generation build queue | Renders are long and Chrome-heavy; they must not fill the clip queue or fight the GPU | Reusing `JobService` ties generation to the clip `STAGES` model |
| New optional connections (`image`, `voice`, `data`) | FR-017, FR-018 and FR-026 need providers; they follow the same `setting` pattern | Hard-coding one provider breaks local-first and the any-endpoint rule |
| Recipes as composed pipelines + runner | FR-022 to FR-025, FR-035 to FR-037: anyone must be able to run their own process, in their own order, without code | Fixed order + on/off knobs can't express different orders; a free graph/workflow engine is more than any known flow needs and much harder to validate and keep within the two rules |
| User-registered local commands | FR-036: people need checks Sorot doesn't have | Code inside recipes would make shared recipes unsafe to import |
| Kit of browser parts, built-in and user-added (FR-038, FR-039) | HyperFrames draws nothing by itself; parts give every director a tested floor and users their own looks | HyperFrames registry blocks are demo compositions, not composable parts; a Sorot DSL is a new language for no gain at the free level |
| Director levels with a per-install model record (FR-042 to FR-044) | Sorot runs models from small local ones to strong hosted ones; one way of writing scenes can't serve both | A single level either caps strong models or fails weak ones; a hand-kept model list goes stale and ignores the gateway |
