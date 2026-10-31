# Research: 2D Video Generator (Studio)

**Feature**: [spec.md](spec.md) · **Plan**: [plan.md](plan.md) · **Date**: 2026-10-31

The owner's questions for this plan were: how does the user talk to the LLM, is the director an
agent, how does the LLM use HyperFrames once the plan is approved, and should Sorot adopt
LangChain, LangGraph and LangSmith. R1 to R4 answer those; R5 to R13 settle the rest of the
Technical Context. R14 to R21 make the pipeline itself customizable: users compose their own
recipes from a step library, informed by a real agent pipeline the owner shared as an example.
Where they conflict with an earlier section, they win.

Sources: HyperFrames README, AGENTS.md, `skills/hyperframes/SKILL.md`, `references/story.md`,
`references/review.md`, docs site (`/packages/cli`, `/packages/producer`, `/packages/core`,
`/guides/performance`); Sorot `backend/src/llm.ts`, `jev.ts`, `jevDirector.ts`, `clipGate.ts`,
`discoveryAgent.ts`, `jobs.ts`, `publisher.ts`, `settings.ts`, `db.ts`, `backend/Dockerfile`.

---

## R1. How the user interacts with the LLM

**Decision**: The user never chats freely with the model. Every exchange is a structured step of
a project, and every LLM answer is a JSON document that Sorot validates and shows as a form:

| Surface | What the user does | What the director returns |
|---|---|---|
| Brief form | Brief, format, length, language, style notes, assets, preset | 3 storylines + recommendation (or one plan for ≤ 15 s) |
| Storyline cards | Pick one, or "change: ..." | Shot-by-shot plan (draft) |
| Plan editor | Edit shot fields directly, or type a change request in the "Ask the director" box | A revised plan with only the requested changes (diffed and shown) |
| Approve button | Approve (locks the plan version) | Nothing: the build starts |
| Verdict panel | "Fix must-fix items", or a note on one finding / shot | A fix list applied to the plan and/or the scenes; a new version |

The "Ask the director" box looks like a chat thread (each request and the director's one-line
summary of what changed are kept in the project's director log), but each message turns into a
new plan revision. The same steps exist in the CLI (`sorot gen ...`), with flags or questions,
like `sorot publish`.

**Rationale**: matches "Plan before building": the plan is a document the user owns, not a
conversation. Structured output is what Sorot already does with the LLM (`director.ts`,
`clipReview.ts`: JSON with a closing `task` field), it is testable with fake `fetch`, and a small
or reasoning model can't drift off the format or quietly change the approved plan.

**Alternatives considered**: free chat with the model choosing when to build (rejected: breaks
"plan before building", hard to test, and the model could change approved content); form-only
with no plain-words changes (rejected: FR-005 needs plain-words edits).

## R2. Is it an agent director?

**Decision**: Yes, a **director role**, but a **bounded** one inside a Sorot-coded state machine,
not an autonomous agent. Sorot code owns the flow:

```text
BRIEF -> STORYLINES -> PLAN (draft <-> revise) -> APPROVED -> BUILD -> VERDICTS -> ACCEPTED -> EXPORTED
                                                                ^           |
                                                                +-- FIX ----+
```

The LLM is called at fixed points with a fixed job each: write storylines, write the plan, apply
a change request, write one scene, repair one scene from checker output, propose fixes from
findings, draft post copy. It never decides to move the project to another state, never
approves its own plan, and never grades its own creative work (R7). The places where the
director loops (scene repair, look review, fix rounds) have hard step limits, which the recipe
sets. The one step that uses tool calls is facts research (R15). It uses `Llm.runTools` with
read-only tools only, such as fetching a source URL or querying a registered data source. Even
under `approval: "director"`, the director's storyline pick and plan approval are written down
with their reason, and code checks them against the recipe before going on.

**Rationale**: the project rules (approval gate, export blocked on TECHNICAL FAIL, versions,
cancel, restart-safety) must hold no matter what the model says; putting them in code makes them
true by construction and covered by the 95% gate. Sorot already works this way (`jevDirector.ts`,
`director.ts`).

**Alternatives considered**: a fully agentic loop (one model with every tool, deciding the order;
rejected for the reasons above); a multi-agent crew such as planner, builder, critic and editor
as separate autonomous agents (rejected: the roles exist here as separate *calls* with separate
context, which gives the same separation without an agent framework).

## R3. How the LLM uses HyperFrames after the plan is approved

**Decision**: **Sorot is the hands; the LLM writes the scene code.** The LLM never runs a
command. After approval, Sorot code:

1. Creates the project folder `data/generate/{projectId}/v{n}/` with the HyperFrames CLI's
   `init` (blank, chosen resolution), and copies assets into `assets/` (uploads, generated images,
   voiceover, music, fonts).
2. Writes the root `index.html` itself from the plan: one sub-composition per shot, with
   `data-start` and `data-duration` taken from the plan (or from the spoken lines under
   narration-first timing, R16), `data-beat` marks per beat, the caption track, and the audio
   tracks. Timing therefore always matches the approved plan.
3. Installs the registry blocks named in the plan (`hyperframes add <block> --no-clipboard`),
   but only when the recipe allows blocks (`plan.blocks`). With blocks off, every scene is written
   from scratch.
4. For each shot, asks the director for `compositions/shot-NN.html` given the shot spec, the
   look, the installed block snippets and the HyperFrames authoring rules (R13). Scenes are
   written one shot at a time, so a small model only ever holds one shot.
5. Runs `hyperframes lint --json` and `check --json` and maps findings to shots. A shot with
   errors goes back to the director with its own findings ("repair"), at most 3 rounds per shot.
   After that the error stays as a TECHNICAL finding.
6. Renders a draft preview (`render --quality draft`), runs the TECHNICAL checks (R6) and the
   CREATIVE judge (R7), and saves the version.

Plan-lock checks run in code before anything is rendered: each scene must contain the shot's
planned on-screen text, must not set its own `data-start`/`data-duration`, must use only
`assets/` paths that exist, and must keep HyperFrames' determinism rules (no `Date.now`,
unseeded `Math.random`, network fetches, timers or `repeat: -1`). A scene that breaks these is
sent back to the director like a lint error.

**Rationale**: the CLI is built for this ("Flags, not prompts", `--json` output, exit codes 0, 1
and 2, never prompts when unattended). Keeping commands in code makes them fakeable through
`createApp(config, deps).exec`, cancellable through the process-tree kill, and identical between
UI and CLI. Writing timing in code keeps FR-008/FR-009 (matches the plan, reproducible) out of
the model's hands.

**Alternatives considered**: tool-calling with `Llm.runTools` so the model calls `add_block`,
`write_scene` and `check` itself (rejected for v1: it needs a gateway with dependable function
calling, it is harder to bound, and it isn't needed when each step's next action is fixed;
`runTools` stays available for a later "free edit" mode); one LLM call writing the whole
composition (rejected: too much context for local models, and one bad shot fails everything).

## R4. LangChain, LangGraph, LangSmith

**Decision**: **Not adopted.** The director uses Sorot's existing `Llm` client (`llm.ts`), `Jev`
client (`jev.ts`), SQLite state and job queue. Tracing is local: every director and judge call
(prompt, answer, model, tokens, ms, outcome) is saved in a `gen_event` row and shown in the
project's "Director log".

**Rationale**:

- Sorot already has what these libraries would add: an OpenAI-compatible client with retries,
  gateway-error handling (`{"error"}` inside HTTP 200, reasoning budget exhausted) and a
  tool-calling loop (`Llm.runTools`, used by `discoveryAgent.ts`). LangChain would wrap the same
  HTTP call and hide those fixes.
- The flow is a fixed state machine with a handful of states, a human approval gate and restart
  safety. LangGraph's main value (graph state, checkpoints, human-in-the-loop interrupts) is
  covered by a status column in SQLite and the existing queue. Its checkpointer would be a second
  source of truth next to SQLite.
- LangSmith is a hosted tracing service: sending every brief, plan and asset prompt to a third
  party goes against Principle I (local-first) and needs another account and key. The local
  `gen_event` log gives the same debugging view.
- The 95% gate and the injected-fakes rule (Principle III) are simple with plain `fetch`, but
  awkward through a framework's runtime. The packages also add a large dependency tree to a
  Bun/TS workspace with one lockfile.

**Revisit if**: Sorot moves to open-ended multi-agent work, such as an agent that browses, edits
any file and chooses its own steps for minutes at a time, or the hosted mode needs a team-wide
tracing dashboard. Even then, an OpenTelemetry exporter for `gen_event` would come before
LangSmith.

**Alternatives considered**: LangGraph.js for the state machine only (rejected: duplicates
SQLite state); LangSmith tracing only (rejected: hosted, see above); the Vercel AI SDK (rejected
for the same reason as LangChain: `llm.ts` already handles this gateway).

## R5. HyperFrames integration and runtime

**Decision**:

- Use the `hyperframes` CLI (npm `@hyperframes/cli`, Apache-2.0), pinned to an exact version in
  config (`HYPERFRAMES_VERSION`, like Jev's pinned model), installed as a dependency of a small
  new workspace package `generator/`. That gives the root lockfile a fixed version and lets Sorot
  call `node node_modules/.bin/hyperframes`.
- Sorot calls it through `exec` (`runner.ts` `spawnCapture`), with per-command timeouts
  (`render` scales with length × fps), `HYPERFRAMES_AGENT=1` so it never prompts, and the same
  process-tree cancel as the Python scripts.
- Runtime needs **Node.js ≥ 22**, **FFmpeg/FFprobe** (already present) and **Chrome**. Sorot
  runs `hyperframes browser ensure` at install time, and `HYPERFRAMES_BROWSER_PATH` can point at
  a system Chrome. `hyperframes doctor --json` (`ok` field) feeds `sorot doctor` and the Generate
  window's "unavailable" message.
- Docker: the runtime stage of `backend/Dockerfile` adds Node 22 and Chrome's system libraries;
  Chrome is fetched at build time with `browser ensure`. Expect the image to grow by about
  400 MB (measure in the spike).
- The render APIs (`@hyperframes/producer` `createRenderJob` and `executeRenderJob`, with an
  abort signal and progress callback) are documented, but `check`, `lint`, `snapshot` and
  `audio` are CLI-only. To keep one integration style, use the CLI for everything.

**Open (spike S1, first task)**: does the CLI run natively on Windows, not just in WSL? The docs
show a Windows Studio app but don't say so for the CLI. If it doesn't, native Windows mode shows
Generate as unavailable and points to Docker mode. Also capture the real `check --json` and
`lint --json` finding fields; the docs confirm the top-level keys
(`ok, lint, runtime, layout, motion, contrast, craft, audio, snapshots`) and that each finding
has a selector, source file, bbox and sample time.

**Alternatives considered**: Remotion (React build step, licence limits for companies; the
owner picked HyperFrames); writing a Bun-side HTML-to-video renderer (rejected: that is exactly
what HyperFrames is); a Python wrapper (rejected: Principle II, and it adds nothing).

## R6. TECHNICAL verdict

**Decision**: computed **in code only**, no LLM. Its inputs are HyperFrames `lint --json` and
`check --json` (lint, runtime, layout, motion, contrast, craft, audio), ffprobe on the draft, and
Sorot's own plan-lock and readability checks. Mapping to FR-012:

| FR-012 item | Source | Severity |
|---|---|---|
| Builds and plays end to end | render exit 0; ffprobe has video and audio streams as planned | must-fix |
| Length matches plan (± 0.1 s) | ffprobe duration vs plan total | must-fix |
| All planned text appears | plan-lock: shot text present in the scene DOM; `check` `line_unread` | must-fix |
| Text inside frame | `check` layout (bbox outside the safe area) | must-fix |
| Readable on a phone | `check` `text_below_floor`, contrast; Sorot rule: text shown ≥ 0.25 s per word + 0.5 s | must-fix |
| No unplanned blank/frozen stretch | `check` `dead_stretch` (> 3 s) unless the shot is marked hold | should-fix |
| First frame not empty | `check` `first_frame_empty` | must-fix |
| Audio present when planned, no clipping | `check` audio codes (`audio_src_not_found`, `audio_clip_silent`); `audio --json` true peak > −1 dBTP | must-fix / should-fix |
| Narration in sync (FR-018) | caption word times vs voiceover word times (R9), drift > 0.3 s | should-fix |

Every row is a `technical` measure the recipe turns on, with its numbers taken from the recipe
(`rules.readability`, `rules.layout`, `output`, the measure's own settings). The values shown
are the Quick example's. A recipe can be stricter, for example ≥ 28 px text, a hold of 0.5 s +
0.3 s per word, or a 9:16 safe band of y 168 to 1330. R19 adds the final-render measures (size,
fps, length window, loudness, speech match, voice route), sourced numbers, blocking content
rules and `command` findings.

Verdict: **FAIL** with any must-fix, **REVIEW** with should-fix only, **PASS** otherwise. HyperFrames
craft warnings, which its own docs call "a question, not a rule", count as polish. A warning kept
with `data-hold` and a reason (R18) stays visible as "kept" and doesn't count. A checker crash
means FAIL, with the reason "could not verify" (spec edge case).

**Rationale**: technical facts are measurable, and a code verdict can't flip between runs. This
is the same pattern as `verdictFrom` in `clipGate.ts`.

## R7. CREATIVE verdict

**Decision**: a **separate judge with fresh context**. It never sees the build history or the
director's reasoning, only: the brief, the approved plan (storyline, look, shots), what was
actually built (each shot's rendered text and the measured read times and motion from `check`
and `snapshot --json`), and, when the LLM accepts images, the `snapshot --review` sheets
(`review-beats.jpg`, `review-phone.jpg`).

- **Jev first** (Sorot's rule): when Jev is on, the `creative` step's criteria (the user's own
  questions) are asked as one-judgment Noul questions over a `jevState()`-style state. The Quick
  example asks `main_message_lands`, `follows_storyline`, `follows_look`, `opening_holds`,
  `pacing_fits_format` and `ending_lands`; a user might instead ask "would a muted stranger
  understand the mechanism?". Sorot always adds risk Nouls such as `misleading_claim` and
  `unreadable_rush`, plus a check for leftover items from the recipe's `rules.defaultsAudit`.
  Because user questions aren't pre-checked like Sorot's own, the recipe editor runs the same
  question lint as `clipGate.test.ts` (one judgment, names a state field, no counting or timing)
  and warns before saving. The verdict comes from the answers in code, using
  the 0.7 and 0.3 thresholds as in `verdictFrom`. Jev's answers are final, with no re-asks.
- **LLM judge** when Jev is off or fails: a separate call (new messages, no director history) that
  returns the same criteria as `yes/partly/no` + reason + finding list; the verdict is computed
  in code from those.
- **Vision**: if the connection setting `llm.vision` is on, the LLM judge also gets the review
  sheets as image parts. `ChatMessage.content` gains an optional parts array; string content
  keeps working for every current caller. Without vision the judge relies on the measured facts.
- Findings get must-fix / should-fix / polish, a shot and a time range, as in HyperFrames'
  P0/P1/P2 triage. **No numeric score is shown**, which matches review.md and FR-011.

**Rationale**: "Two verdicts" works only if the creative judgment doesn't come from the author
grading itself. A fresh-context judge is also what HyperFrames' review.md suggests ("a fresh
agent gets only the storyboard and the sheets").

**Alternatives considered**: the director judging itself in the same thread (rejected: no
independence); a numeric 0 to 100 score (rejected by FR-011); requiring a vision model
(rejected: the current LLM is text-only, so vision is an optional extra).

## R8. Generated images (FR-017)

**Decision**: a new optional connection, **`image`**: an OpenAI-compatible
`POST {baseUrl}/images/generations` with `model`, `apiKey`, `enabled`, `size` and `style`
fields, saved in the `setting` table like `llm`, `jev` and `tebar` and masked the same way. The
plan marks shots with `visual.generatedImage: { prompt, style }`. At build time Sorot fetches
each image once, saves it to `assets/gen-<shot>-<hash>.png`, records a `gen_asset` row
(`origin: generated`, prompt, model), and reuses it for later versions unless the shot's prompt
changes. Renders never fetch from the network. On failure or refusal the shot uses the plan's
`fallbackVisual` (shapes and text) and gets a polish finding. The user can swap any generated
image for an upload.

**Rationale**: the same connection pattern as the rest of Sorot; caching by prompt hash keeps
rebuilds identical (SC-007) and saves money.

## R9. Indonesian voiceover and captions (FR-018, FR-018a)

**Decision**: a new optional connection, **`voice`**. Each user picks the engine and the voice
per language in **their own Settings**; recipes use those settings, and only override them when
the user chooses to. Which engines are offered depends on the install's compute:

| Engine | Kind | CPU-only install | GPU install |
|---|---|---|---|
| `elevenlabs` | online API | ✔ | ✔ |
| `fish` | online API | ✔ | ✔ |
| `openai` | online API (any OpenAI-style `/audio/speech`) | ✔ | ✔ |
| `local` | on this machine (`tts.py`) | **✘ never offered** | ✔ |

- `elevenlabs`: `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}` with the
  `xi-api-key` header, a `model_id` (for example `eleven_multilingual_v2`, which covers Indonesian)
  and `output_format` (`mp3_44100_128`). The `/with-timestamps` variant returns
  character-level timing, which `align` can use directly (R16).
- `fish`: Fish Audio TTS. The model (for example `s2.1-pro-free`) is sent **as an HTTP header**,
  and the voice is a reference id that the user enters per language. A zero credit balance is
  normal on the free model and isn't treated as an error. Fish returns no timing, so `align`
  uses Whisper.
- `openai`: an OpenAI-compatible `POST {baseUrl}/audio/speech` with `model`, `voice` and
  `apiKey`, which covers OpenAI and self-hosted compatible servers (a user with a separate GPU
  box can serve a local model there and use it from a CPU install as an "API").
- `local` (**GPU installs only**): `ai-pipeline/tts.py`, which prints the JSON envelope; it's
  media/ML, so Python is allowed (Principle II). The model is picked in spike S3 from candidates
  with usable Indonesian on a GPU; MMS-TTS `facebook/mms-tts-ind` (VITS, **CC-BY-NC 4.0**) is the
  baseline, and the licence goes in the docs.

**The compute rule** (FR-018a), enforced in code and in packaging:

- `local` is offered only when `WHISPER_DEVICE` is a GPU (`cuda`). That is the same switch that
  already picks CPU or GPU behaviour for clipping, so one setting describes the machine, and
  `GET /api/generate/status` reports `voice.localAvailable` with a reason.
- On CPU, `local` is never listed in Settings, a saved `engine: local` is ignored, and a recipe
  step that pins `engine: local` makes the recipe unavailable ("the local voice needs a GPU
  install") instead of silently switching to an online service (FR-025).
- **Packaging**: local-TTS Python packages and weights live in a separate
  `ai-pipeline/requirements-tts.txt`. The Docker build installs it only when built with
  `--build-arg LOCAL_TTS=1`, which `release-image.yml` sets for `:latest-cuda` only, so the CPU
  `:latest` image never ships it. Native installers install it only when they set up GPU mode.
  Model weights download on first use into the existing `hf-cache` volume, like Whisper.
- If the GPU disappears at runtime (no driver, container started without it), `local` stops
  being offered at the next status check, and narration falls back to the user's online engine
  for that language if one is set.

HyperFrames' own `tts` (Kokoro-82M) **doesn't support Indonesian** (its languages are en, es, fr,
hi, it, pt-br, ja and zh), so it isn't used as a Sorot engine.

Caption timing comes from the `align` step: the engine's own timestamps when it returns them
(ElevenLabs with-timestamps), otherwise the existing Whisper pass (`transcribe.py`, per-word
timestamps, which handles Indonesian and also runs on CPU) on the voiceover, aligned word by word
to the known script. If narration is on but no engine is available, the narration toggle is
disabled with a link to Settings.

**Rationale**: online voices keep CPU installs (and a future CPU-hosted Sorot) light, with no
multi-GB model and no slow CPU synthesis. A machine with a GPU can run a local voice for free and
offline. Keying it to the existing GPU switch avoids a second "is this machine strong?" setting.

**Open (spike S3)**: on the RTX 4060, listen-test local candidates for Indonesian (MMS-TTS first)
for quality and speed. Record ElevenLabs and Fish request/response fixtures.

## R10. Fonts, look and determinism

**Decision**: bundle a small set of open fonts with Indonesian glyph coverage (for example
Plus Jakarta Sans, Inter, Bebas Neue and a serif, all OFL) under `generator/fonts/`, copied into
each project's `assets/`. The plan's `look.fonts` may only name bundled or uploaded fonts. There
are no web-font fetches at render time, so renders are deterministic and work offline.

## R11. Render performance and queue

**Decision**: draft previews use `--quality draft` (`--fps 24` for a 9:16 draft) and
`--workers auto`, and final export uses `--quality delivery` at 30 fps. With `WHISPER_DEVICE=cuda`,
`--gpu` turns on NVENC encoding. Generation builds run in their own FIFO queue with concurrency 1
(`GEN_CONCURRENCY`), separate from the clip `JobService`. A build waits while a clip job is in a
GPU-heavy stage (TRANSCRIBE or RENDER) so the two don't fight over the GPU. The estimated build
time (seconds of video × measured factor, saved after each build) is shown before the build
starts (spec edge case).

**Reference measurement** (the example pipeline): delivery quality, 30 fps, 2 workers,
1080×1920. A 58 s film took about 6 min, and a longer Indonesian film took 558 s and 603 s. That
is roughly 6 to 10 s of render per second of video. A recipe that renders once at delivery
(`render.quality: delivery`) should estimate about 6 to 10 min per minute-long film, plus
planning.

**Open (spike S2)**: repeat on the RTX 4060 with `--gpu` and on CPU-only Docker, and measure
draft quality. SC-002 (a 30 s draft in 10 min) looks safe from the numbers above; if it misses,
the Quick draft preview drops to 540×960.

## R12. Library and publishing

**Decision**: export writes `data/generate/{projectId}/exports/{versionId}.mp4` and a `gen_export`
row. The Library window gets a "Generated" group. Publishing reuses `publisher.ts` through a
small **subject** abstraction (new routes under `/api/generate/exports/:id/publish*` mirror the
clip ones): `social_post` gets `subject_kind TEXT NOT NULL DEFAULT 'clip'`,
and `clip_id` keeps holding the subject id (the clip id or the export id). Existing rows and the
API stay valid, and the API adds `subjectKind`. Draft copy comes from the plan's title and
message. User choices, Jev copy check, idempotency key and saved body are unchanged
(Principle VI). Metrics sync works for both kinds, but only clip metrics feed `clip_feedback`
training.

**Alternatives considered**: creating a fake `video` + `clip` row per export (rejected: pollutes
scoring, rank and training data); a separate generated-post table (rejected: duplicates the
publish and retry logic that Principle VI depends on).

## R13. Director prompt context

**Decision**: the director's scene-writing prompts carry a condensed, versioned **authoring
contract** (`generator/prompts/authoring.md`). It's derived from HyperFrames' `SKILL.md` render
contract (Apache-2.0, with attribution): root and sub-composition structure, `class="clip"` and
`data-*` timing, `assets/` paths, one paused GSAP timeline per composition registered on
`window.__timelines`, and the determinism rules. Story prompts reuse ideas from `story.md`:
three different storylines, a hook frame that is never black or logo-only, at most 6 words per
title line, and beat shares. Each request ends with a `task` field restating the job and the
output format (Sorot's rule for reasoning models). The registry catalog is fetched once per
pinned version (`catalog --json`), cached, and passed as a short list of block names and tags.

---

# Part 2: Custom pipelines

The owner shared a real unattended agent pipeline as an **example** of how one person makes
these videos: pick an idea → verify facts → narration → storylines + numeric spec → author →
check and look → render, verify, QC → two verdicts → publish. The requirement isn't to ship that
pipeline. It's that **anyone running Sorot can build their own**, that one included. R14 is the
core decision, and R15 to R21 are the step types and the integration points that pipeline showed
are needed. Each is described generically, and the example's values appear only as examples.

## R14. Recipes as composed pipelines

**Decision**: a recipe is an **ordered list of steps** from a fixed **step library**, each with
validated settings, an optional **gate** (`owner` / `director` / `none`), an optional `when`
(skip if a connection is missing), and optional **prompt** text (append to or replace Sorot's
instructions for that step). Shared `rules` (layout, readability, defaults audit, content rules)
and the creative questions sit beside the steps. The whole shape is in
[contracts/recipe.md](contracts/recipe.md).

- **The runner** (`generate/runner.ts`) walks the steps in order. Steps before `author` work on
  the project (facts, script, voice, storylines, plan, concept). Steps from `author` on run
  inside a **build version**. A gate pauses the run (`owner`), or lets the director decide and
  logs its reason (`director`). A fix round, or `autoFixRounds` in a verdict step, re-runs the
  build segment and skips steps whose inputs haven't changed (each step's output is cached by an
  input hash, so a visual-only fix never re-runs `voice`).
- **Fixed for every recipe** (the product's paradigm, FR-035): a gated `plan` before `author`,
  and `technical` + `creative` after `render`.
- **Dependency rules** in code (for example `voice` needs `script` earlier; `plan.timingFrom:
  voice` needs `align`; `sourcedNumbers` needs `facts`). Saving or importing a recipe that breaks
  one is refused with the step names.
- **Prompts**: users can change *what the director is told* for any step, but never *what it
  returns*. The output contract and the closing `task` field stay in code, so custom prompts
  can't break parsing, gates or verdicts.
- **Custom commands** (`command` step) are how anyone adds checks Sorot doesn't have. The
  command lives in the user's Settings, and a recipe only names it. So a shared recipe can't
  carry or run code, and a recipe that names an unknown command is unavailable. Commands use the
  same JSON envelope and timeout and cancel handling as Sorot's Python scripts, and are off in
  hosted installs unless the admin enables them.
- **Examples, not defaults**: `quick`, `narrated-explainer` and `story` ship read-only with no
  personal values. Voices, keys, data sources and commands always come from the user's own
  Settings, so a recipe moves between installs unchanged (SC-014).
- **Frozen copies**: a project stores the recipe it started with, so it can always be rebuilt
  the same way (SC-007).

**Rationale**: people make videos in very different orders. The example pipeline voices the
script *before* picking a storyline, and other people do the reverse, so a fixed order with
on/off switches isn't really customizable. A **linear** list of typed steps with gates covers
every flow seen so far, and stays simple enough to validate, test at 95% coverage, and edit in a
form.

**Alternatives considered**:

- A fixed order with on/off knobs (the previous draft). Rejected: it can't express a different
  order, so it isn't "custom".
- A free graph with branches and loops (a workflow engine, LangGraph-style). Rejected: no flow
  so far needs branches. The loops that exist (repair, look, fix) are already bounded inside step
  types, and a graph would be much harder to validate and edit, and to keep inside the two rules.
- Scriptable steps with code in the recipe. Rejected: it would make shared recipes unsafe to
  import. Custom commands registered in Settings give the same power without that risk.

## R15. Step `facts`

**Decision**: a `gen_fact` list per project (claim, value, source URL, status, original value,
evidence).

- `verify`: for each fact Sorot fetches the source page (`webSearch.ts` already fetches with
  `Accept-Language: id,en` and turns the HTML into text), then asks the director one structured
  question: confirmed, corrected (with the new value), or unverifiable, quoting the passage it
  relied on. Code refuses new facts.
- `research`: `Llm.runTools` with **read-only** tools only: `fetch_url`, `search_web` (Bing, as
  Sorot already does) and `query_data` for data sources the user registered in Settings (a
  SQLite file opened read-only, `SELECT` only, with a row cap). Every added fact must carry its
  source.
- `headlinesAsEvidence: false` marks facts sourced only from headline or list pages as
  unverifiable.
- The TECHNICAL `sourcedNumbers` measure pulls every number from the rendered text and the
  narration script (digits and spelled-out Indonesian or English numbers) and matches it against
  the verified and corrected facts, allowing for formatting (`1,5%` = `1.5 %` = "satu koma lima
  persen"). `forbiddenNumbers` applies brief flags (for example "no market data").
- A content rule with `kind: judge, blocking: true` (for example "education, never advice") is
  answered by Jev (or the LLM) and counts toward TECHNICAL, because it is a hard rule, not taste
  (FR-033).

## R16. Steps `script`, `voice`, `align`

**Decision**:

- `script`: the director writes narration lines (`[{id, text}]`, numbers spelled out when set),
  and code checks that every number maps to a fact when the recipe has `facts`.
- `voice`: engine and voice come from the user's **Settings** per language. A step may override
  them, but example recipes never do. Online engines are `elevenlabs`, `fish` and `openai`;
  `local` (`tts.py`) exists **only on GPU installs** (R9). `failClosed: true` stops the run
  on a hard failure, so nothing is ever rendered silent. The output is cached by
  `hash(script, engine, voice, model)`.
- `align`: the engine's own timestamps when it returns them (ElevenLabs with-timestamps),
  otherwise local Whisper (`transcribe.py`, CPU or GPU) on the voiceover, aligned to the known
  script. Captions are exact before the build. `plan.timingFrom: voice` snaps shot boundaries to line ends.
- **Order is the user's**: putting `script` → `voice` → `align` before `storylines` (as the
  example pipeline does) fixes the words first. Putting them after `storylines` fits a flow
  where the user picks the story first. Both are valid recipes.

## R17. Step `plan` (numeric), `concept`

**Decision**: `plan.numeric: true` turns the plan's `look` into exact tokens: hex colours; font,
weight, px and tracking per text role; medium; shadow; an easing curve per role; durations and
staggers in frames. Shots get `frames`, `heroMove`, `reads` and `handoff`, and
`motionPlan: true` adds a per-shot entry/hero/exit plan that may only use spec tokens. The
recipe's `rules.layout` and `rules.readability` are both stated to the director and checked in
TECHNICAL. In the example: a 9:16 safe band y 168 to 1330, only texture below it, captions at
its base, text ≥ 28 px, held 0.5 s + 0.3 s per word, and frame 0 as the hook.

`concept` runs after `storylines` and before `plan` (the plan builds on it). It records the one
visual mechanism and runs the "bolt-on" mechanism test. When
`novelty.lastN` is set, it compares the mechanism with the last N concepts of the same recipe
(normalised text, plus an LLM "same idea?" check) and asks again once on a repeat. Mirrored files
are `STORYLINES.md`, `SPEC.md`, `MOTION_PLAN.md` and `CONCEPT.txt`.

## R18. Steps `check`, `look`

**Decision**:

- `check`: `hyperframes check --json`. Errors go to the scene's repair (≤ `rounds`). A
  warning is handled by `warnings`: `fix`; `fix-or-hold` (keep it with `data-hold` and a reason
  the director must give, which is saved as a kept finding and shown in MOTION_REVIEW.md); or
  `report`.
- `look` (needs a vision model, or `when: "connection:vision"`): `snapshot --review` plus
  `snapshot --at` each beat + `beatOffsetSec`. A **separate** call describes every beat frame as
  a stranger would, names its objects (an object that needs explaining is a must-fix), compares
  the frame with the shot's `reads`/`heroMove`, and names any `rules.defaultsAudit` item it sees.
  The director then fixes the scenes, for up to `rounds` rounds. This is the author's
  self-review; it doesn't replace the CREATIVE verdict, which stays a fresh judge (R7).

Scenes are written per shot, which keeps every model call short. That avoids the stream drops
long answers can cause.

## R19. Steps `render`, `technical`, `creative`, `export`

**Decision**:

- `render.quality` picks the flow. With `draft`, the verdicts are on a draft and `export` re-renders
  at final quality (the Quick example). With `delivery`, the verdicts are on the real final render
  and `export: copy` adds no second render (the narrated example).
- `technical.measures` are opt-in, each with its own numbers: `output` (ffprobe size, fps, length
  window), `audio` (stream present, mean volume floor such as −35 dB, true peak), `speechMatch`
  (local `transcribe.py` on the render, ffmpeg-decoded to mono 16 kHz, word error rate against the
  script, naming each missed line with its time; never a paid service), `voiceRoute`,
  `sourcedNumbers`, `forbiddenNumbers`, `layout`, `readability`, `firstFrame`, `deadStretchSec`,
  `planText`, plus blocking content rules and `command` findings counted as technical.
- `creative.criteria` are the user's own questions. For example: "would a muted stranger
  understand the mechanism?" (`fail: main`), "does the camera reveal relationships?", "is every
  beat needed?", "is there one memorable moment?". It samples frames every `framesEverySec` of
  the render, plus the review sheets.
- Sorot writes `MOTION_REVIEW.md` with both verdicts, findings, kept warnings and reasons.

**Reference render time** (from the example pipeline): delivery, 30 fps, 2 workers, 1080×1920; a
58 s film ≈ 6 min, and longer films 558 to 603 s. That is about 6 to 10 s of render per second of
video.

## R20. Step `idea`, unattended runs

**Decision**: a `gen_idea` bank (slug, brief, facts, flags, status new/used/built/posted) with a
cursor per recipe. A recipe starting with `idea` takes the next new idea and moves the cursor;
`sorot gen run --recipe <id> --idea <ID>` resumes one without moving it. With every gate set to
`director`, the run goes to a checked final video and waits there. Publishing stays manual
(Principle VI).

## R21. Outside agents and schedulers

**Decision**: Sorot is the engine, and any outside agent or scheduler (a personal agent, cron, a
CI job) can drive it through the documented CLI (`--json`) and API, and read the mirrored
per-project files. There's no special integration for any one agent. Two generic helpers make
moving an existing pipeline in easier:

- `sorot gen import-history <file.json>`: load past concepts into the novelty check, and past
  ideas into the bank, from a documented JSON shape. A user converts their own history files to it.
- A golden-check recipe practice (spike S6): rebuild one video an existing pipeline already made
  and compare its `technical` numbers before switching over.

---

## Spikes before the main build

| Id | Question | Done when |
|---|---|---|
| S1 | HyperFrames CLI on native Windows; exact `lint`/`check --json` finding fields | Both answered with a sample JSON saved under `backend/tests/fixtures/hyperframes/` |
| S2 | Render speed of 1080×1920 draft and delivery on GPU and CPU (delivery baseline already known: ~6 min for 58 s) | Factors recorded in this file; draft settings adjusted for SC-002 |
| S3 | Local (GPU-only) Indonesian voice: quality and speed of the candidates (MMS-TTS first) on the RTX 4060; recorded ElevenLabs and Fish requests/responses | Local model chosen, or `local` deferred; ElevenLabs and Fish fixtures recorded; the CPU image size is confirmed unchanged by TTS |
| S4 | Does the configured LLM reliably write one valid scene from the authoring contract? | On 10 sample shots, ≥ 8 pass lint within 3 repair rounds |
| S5 | Can the configured LLM do the look review (vision) on HyperFrames review sheets? | Document the `llm.visionModel` choice; `look` stays `when: connection:vision` in the examples |
| S6 | Golden check: rebuild one video made by the example agent pipeline as a recipe | Its `technical` numbers match that pipeline's own verify output; the recipe is saved as `docs/examples/recipes/agent-explainer.json` with placeholders, and SC-012 is timed |
