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

**Update (phase 12, 2026-11-01)**: a real narrated build looked flat (every seam a cut, little
light or blur), so the owner asked for the director to be given the effects as tools. The plan step
now ends with a bounded **effects pass** through `Llm.runTools` (`Director.effects`): `search_catalog`,
`set_transition`, `add_block`, `set_look`, each checked in code, at most `effects.maxSteps` (12) calls
and `effects.tokenBudget` (60000) tokens. Its choices and reasons are kept in `plan.effectNotes` and
approved with the plan; a failed pass leaves the plan as written. Scene writing stays one fixed call
per shot. HyperFrames' shader transition blocks (`light-leak`, `flash-through-white`, ...) turned
out to be self-contained demo compositions that capture their own two scenes, so they cannot be
wired between Sorot's shot hosts: Sorot writes eight seam kinds itself (`transitions.ts`: cut, fade,
blur, flash, light-leak, wipe, zoom, iris) as GSAP tweens on the root timeline, half in each shot,
checked with `hyperframes lint`/`check`/`snapshot` 0.8.223 on a scratch project (all eight render).

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

- Use the `hyperframes` CLI (npm `hyperframes`, Apache-2.0), pinned to an exact version in
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

**S1 result (2026-10-31, Windows 11, native, `hyperframes` 0.8.223, Node 24)**:

- The CLI runs natively on Windows: `init`, `lint`, `check`, `snapshot`, `render` and `doctor`
  all work with system Chrome (or the one `browser ensure` fetches). It also runs on Linux
  (Ubuntu 24.04 container, Node 22 binary copied from `node:22-slim`, the apt libraries listed in
  `backend/Dockerfile`, Chrome from `browser ensure`): `check` exits 0 and `render` works.
- The npm name is `hyperframes`, not `@hyperframes/cli` (that name 404s).
- `init <name> --non-interactive --skip-skills --resolution portrait --example blank` writes
  `index.html`, `hyperframes.json`, `meta.json`, `package.json`, `AGENTS.md` and `CLAUDE.md`
  (the last two are skill pointers; Sorot ignores them). Resolutions: `portrait` 1080x1920,
  `landscape` 1920x1080, `square` 1080x1080.
- `lint --json` exits 1 on errors. Shape: `{ok, errorCount, warningCount, infoCount, findings[],
  filesScanned}`; a finding has `code`, `severity`, `message`, `fixHint`, `file`, and optional
  `line`, `column`, `snippet`. Codes seen: `missing_timeline_registry`, `non_deterministic_code`.
- `check --json` is `{ok, strict, browserSkipped, lint, runtime, layout, ...}`; each section is
  `{ok, errorCount, warningCount, infoCount, findings[]}`. Layout findings carry `code`,
  `severity`, `time`, `selector`, `sourceFile`, `bbox`, `message`, `fixHint`, `occurrences` and
  `times[]`; the layout section also has `duration` and `samples[]`. A still scene gives the
  warning `sweep_static`. Checking a 10 s project took about 6 s.
- `snapshot --review --json` and `--at 1,3 --json` return `{ok, outputDir, frames[{path, time,
  role, label}], ...}`; PNGs land under `.hyperframes/artifacts/snapshots/<id>/`.
- `doctor --json` is `{ok, platform, arch, checks[{name, ok, detail, hint?}]}`. **Top-level `ok`
  is false whenever an optional tool is missing** (whisper-cpp, Kokoro TTS, MusicGen), so T019
  must judge availability from the required checks (`Node.js`, `FFmpeg`, `Chrome`), not `ok`.
- **Render is not offline by default.** The compiler fetches Google Fonts and inlines the GSAP
  CDN script (`cdn.jsdelivr.net`) on first use, then caches them, and the `init` template loads
  GSAP from the CDN. The composer must write local `@font-face` rules for the bundled fonts and
  a local GSAP file under `assets/`, so builds are deterministic and work offline.
- `render --quality` accepts `draft | looks | delivery` (plus `standard`/`high` aliases); the
  default is `looks`. The recipe's `standard` therefore maps to `looks`. Other flags used:
  `-f/--fps`, `-w/--workers`, `--gpu`, `-o`, `--quiet`.
- Fixtures: `backend/tests/fixtures/hyperframes/` (`doctor`, `lint-ok`, `lint-fail`, `check-ok`,
  `snapshot-review`, `snapshot-at`), with local paths replaced by `<project>` and `<home>`.

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

**Decision (owner, 2026-11-01)**: the local engine is **KittenTTS 2** (`kittenml`, Apache-2.0,
https://github.com/KittenML/KittenTTS), not MMS-TTS. Its docs list 20 languages and Indonesian is
not one of them: English uses a built-in voice (Bruno by default), the nine languages with their own
voice use it, and any other language (Indonesian included) needs the Settings voice for that language
to be a reference recording, which the model clones. Without one, `tts.py` fails with that
explanation rather than speaking Indonesian with an English voice. Whether a cloned Indonesian
reference sounds good enough is still for the listening test (S3) to say; the online engines remain
the dependable Indonesian route.

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

**S2 result, first pass (2026-10-31, native Windows, RTX 4060, Ryzen 5 7500F)**: a 30 s
1080×1920 composition (one animated title, 30 fps) rendered in **25 s at `draft`, 25 s at
`delivery` and 24 s at `delivery --gpu`**, about **0.8 s of render per second of video**, so a
30 s draft sits far inside SC-002. `--gpu` gave no gain on this light scene (the cost is Chrome
frame capture, not encoding), so it stays optional. Heavier scenes (video, many elements) will
be slower; the 6 to 10 s per second reference above stays the planning figure until S2 (final)
measures a real 60 s narrated film. **CPU-only Docker** (Ubuntu 24.04, 12 threads, no GPU): the
same sample took **19 s at `draft` and 17 s at `delivery`**, so the CPU image is not slower on a
light scene. Both runs had network access (GSAP CDN inlined on first use).

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

**S4 result (2026-10-31, `deepseek-v4-1-flash` through kenari.id, real HyperFrames 0.8.223)**: the
real `author` and `check` steps wrote 10 varied 3 s shots (a coin and sprout, a counting number, a
progress ring, a coin stack, looping arrows, a line chart, two bars, a bracket, a clock, an ending).

- **10 of 10 scenes passed** plan-lock, `lint` and `check` (target: at least 8 of 10 within 3
  rounds). 8 were right on the first call; 2 repair calls fixed the rest; no call failed.
- The rendered 30 s draft is exactly 30.000 s. The review sheet shows the planned text in each shot
  and an animation that matches each shot's description (checked by eye on `review-beats-1.jpg`).
- The only finding left was HyperFrames' `film_silent` warning (no sound bed). The check step now
  treats it as the plan's own doing when the plan has no sound, so no repair call is spent on it.
- `snapshot --review` writes `review-beats-N.jpg`, `review-phone-N.jpg` and `review-seam-NN.jpg`
  (not a `contact-sheet.jpg`, which is what `--at` makes); the creative step uses page 1 of the
  first two and keeps them as `sheets/review-beats.jpg` and `review-phone.jpg`.
- **Speed is the weak point.** Writing the 10 scenes took 1,170 s (about 2 min of reasoning-model
  time per shot, more with a repair); `check` 36 s; the draft render 36 s. A 10-shot 30 s video
  therefore takes about 20 min, over SC-002's 10 min. Scenes don't depend on each other, so
  `author.concurrency` (1 to 4; the `quick` example asks for 3) writes several at once; the unit
  test shows three in flight. Fewer, longer shots, or a faster non-reasoning scene model, are the
  other levers. To re-measure with concurrency 3 once a build is run in the UI.

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
- `look` (needs the director's model to see, or `when: "connection:vision"`): three pictures of
  each shot (early, middle, settled; `beatOffsetSec` was removed). A **separate** call describes the frames as
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

### Spike status at the end of the build (2026-11-01)

Done: S1, S4 (10 of 10), S2 first pass (light 30 s scene). **Still open, because each needs a person,
keys or the user's own pipeline** (the code paths are tested with fakes only):

- **S3** (T067): listen-test KittenTTS 2 with a cloned Indonesian reference on the RTX 4060; record
  ElevenLabs and Fish request and response fixtures. Until then the online engines are the Indonesian route.
- **S6 / SC-012** (T095): rebuild one real agent-pipeline video from
  `docs/examples/recipes/agent-explainer.json` (the template validates and has 15 steps); time the
  setup against the 30-minute target and compare `sorot gen verdicts` numbers with that pipeline's checks.
- **S2 final / S5 / SC-013** (T096): one unattended 60 s narrated delivery render (expect 6 to 10 s per
  second of video), and the vision look review with the configured `llm.visionModel`.
- **Quickstart run** (T100): scenarios 1 to 10 need a running server with an LLM, a voice key and
  HyperFrames; the same flows are covered by the backend, CLI and frontend tests against fakes.

### Real run, 2026-11-01 (phase 12)

The first real narrated build ("Gunung Koin", 20 s, recipe with `plan` before `script`/`voice`/`align`)
on the RTX 4060 Docker app: Fish Audio with the model header `s2.1-pro-free` and no voice id (Fish's
default voice; the redacted request is `backend/tests/fixtures/voice/fish-tts.json`), Whisper
alignment on the GPU, 7 scenes, **467 s** from build start to verdicts. What it found, and the fixes:

- A build could start after a failed voice step: now refused until the project is retried.
- Every retry re-ran the plan (revisions 2 to 4, each asking for approval): the plan's input key
  read `narrationScript`, which a script step **after** the plan changes. It now reads only what
  earlier steps made.
- One `console_warning` was listed 45 times: `check` findings are grouped by code, shot and message
  with a count.
- Reasoning calls were dropped by the gateway and a scene ran out of `LLM_MAX_TOKENS` (4000 in
  Docker): transient failures are tried 3 times and Generate has its own budget (`GEN_LLM_MAX_TOKENS`, 32000).
- The same forbidden number in a shot's title and text was two findings: now one.
- The film looked flat: transitions, the effects pass, the `effects_few` TECHNICAL measure and the
  CREATIVE "flat film" risk (above, R3).

This closes the Fish half of S3 (T067) and is the first data point for S2 final (T096); the 60 s
delivery render is still to do.

**T114, the same brief rebuilt with the effects pass** (same recipe, same storyline idea, Phase 12
image on the RTX 4060 Docker, LLM `deepseek-v4-flash`, Jev judging):

| | Flat build | With effects |
|---|---|---|
| Effects (blocks / non-cut seams / shots with light, blur, depth or glow) | 0 / 0 / 0 | 6 / 4 (wipe, wipe, flash, light-leak) / 7 |
| TECHNICAL | REVIEW: 3 open `clip_ends_past_root_duration`, 1 `dead_stretch`, 45 copies of one kept console warning | PASS (one kept `film_silent`) |
| CREATIVE (Jev) | REVIEW: `misleading_claim` | REVIEW: `misleading_claim`; `flat_film` not flagged |
| Effects pass | none | 67 s, 18 notes approved with the plan |
| Build | 467 s | 570 s |

Frames: the seams are visible (wipes, light leak, glow on the final sphere, blurred depth), but the
director chose an almost white palette, so the flash and the pale wipe band hardly read against it:
the effects pass does not yet weigh a transition's colour against the palette. Both films invent
Rp amounts the brief does not state (the CREATIVE `misleading_claim`). Found on the way: the director
answered `sound.narration: false` although the owner turned narration on, so the recorded voice was
left out of this build (hence `film_silent`); narration now follows the project (`validatePlan`).
Contact sheet: `data/generate/t114-compare.png` (not in the repo).

Known limit: an export runs inside its HTTP request (server idle timeout 255 s); a long delivery
re-render may need the request moved to a background job.

# Part 3: Any look, any director (2026-11-01)

Covers spec User Story 9 and FR-038 to FR-047. The first real builds were correct but flat, and
the director models on one install ranged from 1.9 repair rounds per scene (deepseek-v4-flash) to
0.3 but 4× slower with dropped calls and malformed 12,000-character plans (deepseek-v4-1-flash).
HyperFrames plays whatever the scenes draw (DOM + GSAP, canvas, WebGL, Three.js, Lottie, all
driven from timeline time), so the looks and the floor of quality are Sorot's to provide.

## R22. The kit: parts as browser modules, loaded by the root

**Decision**: a **kit part** is a folder with a `part.json` manifest and one browser script (no
build step). Built-in parts ship in `generator/kit/<name>/` (pinned with the generator package);
user parts live in `data/kit/<name>/`. The manifest says what the part does, its settings (the
same field schema recipes use, `steps/schema.ts`), a short example, its runtime (`dom`, `canvas`,
`webgl`) and what it needs (`gpu: preferred`). The script registers
`window.SorotKit["<name>"] = { mount(host, settings, ctx) }`, where `ctx` gives the scene's GSAP
timeline, the shot's start and length, the fps, a seeded random source, and the film's look
(palette, key light) so every part is lit and coloured the same way. A part draws into `host` and
adds its motion to the timeline, or registers a `render(t)` for canvas/WebGL; it never reads the
clock, the network or `Math.random` (the same determinism rules as scenes).

The composer copies the parts a version uses into `assets/kit/` and loads them from the root
`index.html`, like GSAP. Scenes never load scripts themselves, so the plan-lock rule against
`<script src>` in a scene stays as it is.

The first built-in parts are general building blocks, not a catalogue of looks: shading and light
for any shape (gradient lighting from the key light, highlight, rim), shadows (soft, contact),
depth layers and parallax, a camera (pan, zoom, dolly, any projection, isometric being a setting),
motion tokens (eases by role, precomputed springs, paths, stagger), text reveal, seeded particles,
image placement (a generated or uploaded image as a lit card or cut-out with a shadow), and a
`three` runtime part (pinned Three.js, offline) for real 3D. More parts are added by users or later
releases.

**Rationale**: browser modules are what HyperFrames runs; a manifest with settings makes a part
usable at the kit level (the model fills settings) and describable to the director (FR-047).
Copying into the project keeps renders offline and the same every time.

**Alternatives considered**: registry blocks from HyperFrames (demo compositions, not composable
parts; the shader transitions proved this in phase 12); a Sorot DSL compiled to HTML (a new
language to learn and maintain, and a strong model gains nothing from it); npm packages per part
(network at install time, versions per project harder to pin).

## R23. User parts: added locally, named by recipes, checked before use

**Decision**: users add parts with `sorot gen kit add <folder|.zip>` or the UI; they can be
exported and imported like recipes (FR-039). A recipe may only **name** parts (in the `author`
step's `require` list or a shot's look); it never carries part code, so importing a recipe can't
bring in scripts. On add, Sorot validates the manifest and renders the part's example twice in a
throwaway project: it must pass `lint`/`check` and give the same frames both times, or it is
refused with the findings. A recipe naming a missing part shows as unavailable (FR-025).

**Rationale**: the same trust model as custom commands (R14): code reaches an install only by the
owner's own action, and every part is proven deterministic before a director can use it.

## R24. Director levels and how scenes are made at each

**Decision**: three levels, per shot (FR-042):

| Level | The model writes | Sorot does |
|---|---|---|
| `kit` | a forced tool call `submit_shot_kit`: the parts, their settings, layers and timing for the shot | validates against the capability description and writes `compositions/shot-NN.html` in code |
| `compose` | the scene HTML, using kit parts through `SorotKit[...].mount` plus its own GSAP | plan-lock, kit-call check, lint/check, repairs |
| `free` | any scene within the contract, including its own canvas, WebGL or Three.js code | the same checks, plus a frame-time budget |

The `author` step gets `level: auto | kit | compose | free` (default `auto`) and `maxLevel`
(default `free`, a recipe or a CPU install may lower it). The plan shows each shot's level
(FR-042, US9 scenario 5).

**Rationale**: the kit level needs no code from the model, so a small local model can make a
finished film; the higher levels only raise the ceiling.

## R25. Choosing the level: the model record

**Decision**: a new table `gen_model_record` keeps, per model and level, the counts that matter:
scenes asked, passed first time, passed after repair, dropped a level, malformed answers, and time
spent. Updated by the author and plan steps after each call. `auto` picks the highest level the
recipe allows where the model has passed first time in at least 60% of at least 8 shots and sent
malformed answers in at most 10%; a model with no record starts at `kit` unless calibrated. The
owner can run **Calibrate** (Settings → LLM, or `sorot gen calibrate`): three sample shots at each
level, about 5 minutes, which fills the record at once. A pin per recipe or per model overrides
`auto` (FR-043). The thresholds are first guesses, checked in spike S7.

**Rationale**: the director log already shows the differences (today's two models); a record per
install measures the model the user actually runs, through the gateway they actually use.

**Alternatives considered**: a list of model names and levels (stale at once, and the same model
behaves differently behind different gateways); always starting high and falling back (costs a
full repair cycle per shot on a weak model).

## R26. Falling back one level

**Decision**: in the `author` and `check` steps, a shot that still fails after its repair rounds
at its level, or whose frames take longer than the budget to draw, is rebuilt one level down with
the same shot spec (FR-044). A `level_drop` finding (should-fix) names the shot, the levels and the
reason, and the model record counts it. Only a failure at `kit` fails the build. The frame-time
budget comes from the render estimate (R11) per machine; a heavy shot is measured with one
`snapshot` of its busiest moment.

## R27. The capability description

**Decision**: `capabilities.ts` builds one description per call from what is installed and
connected (FR-047): the kit parts (name, what it does, settings, example) from their manifests;
the level of the call and what it may do; the renderer (HyperFrames version, which runtimes this
machine can draw and on what, the frame-time budget); the connections that are on. Calls get the
parts in summary (name and one line) at plan time, and the full settings of the parts a shot uses
at scene time, so a small model's context stays small. Plans and scenes are checked against it:
an unknown part, an unknown setting, or a runtime the level doesn't allow is a validation error
that goes back to the director (FR-045). Nothing in `generator/prompts/` lists parts by hand.

## R28. Measuring smooth motion

**Decision**: a new always-on TECHNICAL measure `motion` (FR-040), from the rendered video in
code: ffmpeg's per-frame difference inside each shot (seams excluded) flags **jumps** (a frame
whose change is far above its neighbours') and **stalls** (a moving shot that freezes for a few
frames, then moves again), with the shot and time. HyperFrames' own motion-blur findings are added
as they are. Kit motion parts use eased tweens and precomputed springs, and the root turns on
HyperFrames motion blur (`data-motion-blur`) for shots the plan marks as fast unless the recipe's
`render.motionBlur` says `off`. Thresholds are measured in spike S7.

**Alternatives considered**: optical flow (heavier, and a dependency for one number); judging
smoothness only by the CREATIVE judge (not repeatable).

## R29. Structured answers: where the error is, and smaller pieces

**Decision**: a malformed answer's repair call carries the parser's message and about 80
characters around the position (FR-045); Sorot finds the position itself, since Bun's JSON.parse
reports none. Every numeric plan is asked in two parts (and, once the model record exists, any plan
from a model whose record shows malformed answers): first the film (title, message, look, the shot
list with durations and text; Sorot counts the frames from the lengths), then the shots' motion
detail in batches of four, each validated in place and repaired with only its own problems.

**Rationale**: the two malformed numeric plans of 2026-11-01 each lost one closing brace about
9,000 characters in; the message "not valid JSON" gave the model nothing to fix.

## R30. Looks in the plan, and the CREATIVE question

**Decision**: each shot gets a `look` object stated in whatever terms the shot needs (FR-041),
with exact values where it has them (colours, angles, sizes, timings) and, optionally, the kit
parts and settings it will use. Only the part references are checked against the kit; the rest is
the director's to say. The CREATIVE judge always asks one more criterion, `finished`: "Do the
things in `shots` read as what they are, and look finished and intended?" plus the motion question
"Does the motion in `shots` move smoothly and with weight?" (FR-046).

## R31. The authoring contract follows HyperFrames' own rules

**Decision**: `generator/prompts/authoring.md` is corrected to HyperFrames 0.8.223's contract
(skill review of 2026-11-01): never tween `visibility` on a clip, animate transforms rather than
`width`/`height`, `fromTo` rather than `from`, no CSS transform on a tweened element, `data-hold`
for deliberate stillness, contrast 4.5:1 for text, eases by role, no idle loops. Story guidance
gains the vertical safe band, title scale, openings and the transition rules ("at most a third of
seams are cuts", reversing the phase 12 text).

## Spike S7 (before phase 13 builds)

| Question | Done when |
|---|---|
| Cost of motion blur and of WebGL/Three.js scenes on the RTX 4060 and on CPU | Render seconds per video second recorded; `maxLevel` default for CPU installs chosen |
| Thresholds for `motion` (jump, stall) on today's builds | No finding on the smooth builds, a finding on a planted jump |
| Level thresholds (R25) | Calibration of both deepseek models and one small local model recorded; their levels look right |

### S7 cost, CPU half (2026-11-02)

One run each, native Linux (not the Docker image), 4-core Intel Xeon 2.1 GHz, no GPU, 16 GB;
HyperFrames 0.8.223, `render -q draft -f 30 -w 2`, 10 s at 1080×1920 (300 frames). Chrome drew
WebGL with SwiftShader (software). Treat these as single measurements.

| Scene | Render | Seconds per video second |
|---|---|---|
| Six 2D cards darting across every 0.5 s (fast `expo.out` moves) | 10.3 s | 1.0 |
| The same with `data-motion-blur="on"` (default samples) | 34.8 s | 3.5 |
| `three` kit part: six lit metal coins, orbiting camera | 22.5 s | 2.3 |
| The same with `data-motion-blur="on"` and `data-motion-blur-events="on"` | 36.2 s | 3.6 |

- Motion blur costs about 3.4× on 2D movers: worth it only on shots the plan marks fast
  (`render.motionBlur: auto`). On a WebGL canvas HyperFrames falls back to its filter blur (its log:
  "html-in-canvas captures [WebGL] frozen (Chrome 152)").
- Software WebGL is affordable for a simple 3D shot (2.3 s per second, far inside the 15 s planning
  figure), so **CPU installs keep `maxLevel: free`** (`CPU_MAX_LEVEL`); a heavier shot is caught by the
  frame budget (T139) and dropped a level.
- Chrome logs "GPU stall due to ReadPixels" console warnings for a WebGL canvas; they come from the
  frame capture, so the check step drops them.
- The nine built-in parts each rendered their example twice with identical frames (framemd5) on this
  machine, which is the check a user part must pass.
- Still open: the same four scenes on the RTX 4060 Docker app.

### S7 motion thresholds, first pass (2026-11-02)

- ffmpeg's scene score (`select=gte(scene,0)`) and `freezedetect` were tried first. Both round a
  small element's motion to zero: a 240 px box moving 4 px a frame scored 0.000, and `freezedetect`
  reported 42 "freezes" in that smooth 6 s clip. Not usable for stalls or for small elements.
- The measure uses the mean luma difference of each frame pair instead
  (`tblend=all_mode=difference,signalstats`, YAVG). Ratio of a frame's change to the median of its
  four neighbours on each side:

  | Clip (spike S7 renders, plus two made with ffmpeg) | Highest ratio |
  |---|---|
  | Planted: a 240 px box jumping 400 px for one frame and back | 45× (one finding) |
  | The same box moving smoothly | 1.3× |
  | Six cards darting with `expo.out` every 0.5 s (fast, eased) | 2.0× |
  | `three` coins orbiting | 1.2× |

  So `jumpRatio` defaults to 6 (must-fix from 12) with a floor of 1 luma level; `stallFrames` to 8
  (must-fix from 16), a frame under 0.03 counting as still. Fixtures: `backend/tests/fixtures/motion/`.
- Still open (T147): the same on the real builds of 2026-11-01, and calibrating deepseek-v4-flash,
  deepseek-v4-1-flash and a small local model to check their `auto` levels.
- The `finished` question is worded "Do the things in `shots` read as what they are, looking finished
  and intended?": the spec's "..., and look finished and intended?" asks two things by Sorot's own
  question lint.

### S7 level thresholds: calibration (2026-11-02, T147)

Calibrate (`POST /api/generate/models/calibrate`, three sample shots per level from the fixed
calibration plan) on the CPU test install, through the Kenari gateway. No local model was reachable
here; `gemma-4-31b-it` (an open-weights model of the size people run on their own machines) stands
in for "a small local model", served by the gateway, not locally.

| Model | Time | First pass kit / compose / free | Proven level | `auto` |
|---|---|---|---|---|
| deepseek-v4-1-flash | 6.0 min | 3/3, 3/3, 3/3 | kit (older answers) | free |
| deepseek-v4-flash | 5.7 min | 3/3, 3/3, 3/3 | free | free |
| gemma-4-31b-it | 41 s | 3/3, 3/3, 3/3 | free | free |

- Every model wrote valid scenes at every level. Calibration measures validity (the scene passes
  `checkScene` or the kit answer validates), not looks; the CREATIVE and look findings of real
  builds (GLM, Kimi) are the measure of looks.
- `auto` is `free` for all three, as the owner's rule says (the director is never held back); the
  record only reports.
- deepseek-v4-1-flash stays "proven kit" because its record holds this morning's kit-answer
  failures: 41 malformed for 28 kit asks. That exposed a counting bug: each malformed *attempt*
  was counted, so the share could pass 100%. Fixed: a malformed answer counts once per ask
  (`director.ts`, `converse`). The old rows keep their counts.
- gemma's 41 s for nine shots is far faster than the others; its scenes were short. Looks were not
  judged in calibration.

### S2 and S5 on the CPU test install (2026-11-02, T096)

- **S5, the vision look review**: done. The model that writes is the model that sees (no separate
  vision model, R36). On the GLM story builds (`glm-5-3-flash`, 7 shots) four look calls took
  23 to 69 s each and described the frames accurately ("an old woman seen from behind … carrying a
  rattan basket of jars"); they caught the weak shot ("a dark dome shape with a dim sphere and a
  stylized hand knocking on nothing … the lamp appears unlit") and gave `look_unexplained` /
  `look_mismatch` findings for it. The CREATIVE judge with the frames (14 to 22 s a call) answered
  `finished: partly` on the same shot with the same reason. Jev, reading text, can't see these.
- **S2, delivery render on CPU**: the 30 s story film (7 shots, narration, 1080×1920, 30 fps)
  renders at delivery quality in **118 s** (3.9 s of render per second of video) and at draft in
  97 s (3.2 s/s) on a 4-core, 15 GB container. A 60 s narrated film would take about 4 minutes on
  this machine (estimate, not run). The RTX 4060 numbers and a full unattended 60 s narrated run
  (SC-013) are still open.
- **Determinism (quickstart 5, SC-007)**: the same version rendered twice at draft: 900 frames each,
  all 900 frame hashes equal.

## Part 4: The director loop (2026-11-02)

Evidence: three real builds on 2026-11-02 (Kimi isometric, GLM isometric, GLM story) and the
`gen_event` log of every call. Design note: [docs/director-loop.md](../../docs/director-loop.md).

## R32. One build session instead of a call per shot

- **Decision**: a version's scenes, repairs and kit shots are one conversation (opening: system
  message, whole plan, capabilities; one turn per shot, in order; each request extends the last).
  `GEN_CONTEXT_TOKENS` (default 600000, for models with a 1M window) restarts it from the opening
  and the latest shots. Built in `3c1ae8a`.
- **Rationale**: with separate calls the best possible prefix reuse, replayed from the log, was 44%
  (isometric) and 51% (story); the provider reported 34% and 40%. Calls ran in parallel (none could
  reuse another), scene and repair started with different instructions, and the shot's own fields
  came before the shared 8.7 KB capabilities. On the session build the estimate was 84% for scenes
  (94 to 97% after the first) and 89% for repairs, 87% overall. Shots also see each other: the
  story's figures stayed one style across shots.
- **Cost**: scene writing is serial (4.4 min vs about 2.5 for seven GLM scenes); whole build time
  was unchanged (about 15 min).
- **Alternatives**: reordering fields only (tried first, `4c91448`: the ceiling stays near 50%);
  staggering parallel calls (timing-dependent, cache writes aren't guaranteed in time); a bigger
  output budget (`GEN_LLM_MAX_TOKENS` caps the answer, not the cache).

## R33. Tools in the turn: use what ships, don't bundle art

- **Decision**: `search_blocks` (word and tag match over the cached catalog), `use_block`
  (`hyperframes add`, source returned up to 24 KB), `look` (R34), `check` (`checkScene` +
  `hyperframes lint` for one shot), then `submit_*`. `tool_choice: auto` with the submit tool
  offered every step; the last allowed step is forced to it. Limits per turn: 8 steps, 4 searches,
  2 blocks, 2 looks, 3 checks (recipe `author.toolSteps`, `author.looks`).
- **Rationale**: the registry already holds 448 items (238 components, 210 blocks): 38 in 3D, a
  jointed walking character (`lottie-character-walk`), 12 maps, 9 charts; Three.js is already the
  `three` part. The owner's requirement: no bundled assets (bloat, licences, sameness), no paid
  generated images, the director's creativity not capped.
- **Alternatives**: drawing lessons in the prompt (no feedback to the model; tried in spirit with
  the worked example, which changed layout but not drawing); a bundled character/icon library
  (rejected by the owner: size and sameness); embeddings for search (a new dependency for 448
  short descriptions; word and tag match first, measured in S8).
- **Not a tool**: the scene probe needs a full `hyperframes check` (minutes); it stays in the check
  step and comes back as a repair turn.

## R34. Looking: the director's eyes and a stranger's read, one model

- **Decision**: `look` renders 1 to 3 frames of the draft (`snapshot --at`), sends only the frames
  to a fresh call of the same model with the look step's questions, turns the answer into the look
  findings with `look.ts`, and returns frames and findings to the director in the same turn. The
  look step records "looked in the loop" when every shot was looked at. No separate vision model
  (`LLM_VISION`, `LLM_VISION_MODEL` removed in `8ba50db`); a call with pictures goes to its role's
  model.
- **Rationale**: the look step's value is the stranger: a viewer that doesn't know what the shot
  meant. The author can't be that for its own drawing, but the same model in a fresh call can.
  Moving it into the turn means the director redraws before submitting instead of after the
  build. GLM read a frame sheet correctly in a direct test (2026-11-02). One model to configure
  keeps the settings small (owner's requirement).
- **Alternatives**: the director judging its own frames only (biased: it knows its intent); keeping
  the look step after the build (feedback arrives after the scene is written, text only); a second
  vision model (more configuration; the director must see anyway).

## R35. Compaction that keeps the cache

- **Decision**: three levels, each rewriting only the tail (the current turn): end of turn
  (always): the turn's tool exchanges become one note (`tools used: …`), the accepted answer stays;
  mid-turn (past `GEN_TURN_TOKENS`, default 60000): older tool results become stubs, the latest of
  each kind (frames, check, block source) stays whole; session (past `GEN_CONTEXT_TOKENS`): restart
  from the opening and the latest shots (built).
- **Rationale**: a provider caches the request's prefix, so editing anything before the current
  turn would make every later request miss. Tool results are the bulky part (images, block sources,
  check output) and are only useful while the shot is being made.
- **Alternatives**: summarising the turn with an extra LLM call (cost and latency for a note code
  can write); a sliding window over the whole conversation (moves the prefix on every turn, so
  nothing is cached); never compacting (frames from earlier shots would fill the window).
- **Sizes**: estimated in code at 3.5 characters a token and a placeholder 1,500 tokens an image,
  corrected from the provider's usage numbers in S8.

## R36. Removing the vision settings is a contract break

- **Decision**: `llm.vision` and `llm.visionModel` answer 400 (unknown field); saved values are
  ignored; called out in the CHANGELOG (constitution V). Recipes keep `creative.vision`
  (`on`/`auto`/`off`): whether to show the frames, not which model sees them.

## Spike S8 (before phases 20 to 22)

| Question | How | Decides |
|---|---|---|
| Does a fast model (GLM) run a multi-step tool loop, or call the same tool repeatedly? | the story brief with tools on, the `gen_event` tool rows | per-tool limits, the forced-submit step |
| What does an image cost in tokens on the provider? | the provider's usage numbers for calls with 1, 2, 3 frames | the compaction estimate, `author.looks` |
| Can `lottie-character-walk` and the 3D blocks be adapted to 9:16 and a film's look? | install into a 9:16 project, adapt, render | whether `use_block` returns full sources or references |
| Word and tag search: do the right blocks come up for "a person walking", "a bar chart", "a map"? | ten queries against the catalog | whether search needs more than words and tags |

### S8, first real runs (2026-11-03, T169 in part)

The GLM story brief (`glm-5-3-flash`, 7 shots, same plan, images and voice) rebuilt twice on the CPU
test install with the tool loop on (`author.toolSteps` default 8, `looks` default 2).

| Run | Tools used | Scene+repair model calls | Prefix reuse (log estimate) | Author step | Final `look_unexplained` must-fix |
|---|---|---|---|---|---|
| A. tools offered, nothing asking for a look (`545fa70`) | none: 0 of 11 turns | 11 | not measured | 3.4 min | 2 (s02, s03) |
| B. first submit asks for a look once (`7974c56`) | `look` 10×, `search_blocks` 0, `use_block` 0, `check` 0 | 32 | 93% | about 11 min | 4 (s02 ×2, s03 ×2) |

- **A fast model skips optional tools.** With the tools only offered, GLM submitted every turn at
  once. Run B's rule ("look at your draft first", turned back inside the turn, no retry used) got a
  look for each of the 7 shots; three shots looked more than once. It never searched the registry
  or ran `check`, even with the "Your tools" section in the authoring guide.
- **Looking didn't make the drawing better by the stranger's measure.** The director read the
  findings and sometimes redrew (one turn says "the look renders showed two problems: the brown
  rectangle…"), but the final look step still found unnameable objects in shots 2 and 3, as many
  as before. By eye, shot 1 now fills the frame with the generated illustration and the street scene
  is busier and more readable; the hands and the door are still crude.
- **Cost**: about 3× the author time (each look is a render of up to 3 frames plus a stranger call,
  about 20 s plus 15 s here), 10 looks in all.
- **Cache**: 93% of the scene and repair requests' text was a prefix of an earlier finished request
  (session with tool results), against 87% without tools. The provider's own number is still to be
  read from its dashboard.
- **The look step still ran**: repairs after the check step changed scenes, so the hashes no longer
  matched ("looked in the loop" applies only when no scene changed since its look).
- **Run B failed at the creative verdict**: the gateway reset the connection (`ECONNRESET`); a retry
  of the version would produce the verdicts. Not caused by the loop.
- **Open**: image cost in tokens (needs the provider's usage numbers), registry blocks adapted to
  9:16 (nothing tried them), a stronger model's use of `search_blocks` and `use_block`, the 20-brief set.

### S8, a subject too dark to see (2026-11-05, T183, not built)

GLM build `a54d3888` (the Wi-Fi brief) drew the router, a wall and two houses in navy (about `rgb(25,37,74)`)
on a near-black ground (`rgb(9,13,35)`). Lint, check, the probe, the motion measure and the look step all
passed it. HyperFrames' own `contrast` check reports text only (empty for this build). The second GLM build of
the same brief (`d8c3a94a`) reads well: a white router and cyan waves on navy. Measured offline on both, no LLM
calls:

| Measure | `a54d` (subject hard to see) | `d8c3` (reads well) | Verdict |
|---|---|---|---|
| Share of a drawing's pixels under 1.5:1 against the ring around its probe box | 45 to 98% | 21 to 100% | doesn't separate: glows and gradients count as faint |
| 90th percentile contrast inside the probe box | 1.3 to 1.8 in shots 1, 5, 6; 5.2 in shot 4 | 1.2 to 1.5 for the dim walls; 2.6 to 15 elsewhere | misses shot 4: one svg holds the navy router and wall and the bright orange rings |
| Flat regions grown across neighbour differences of ≤ 4, 540×960 | router and wall 1.33 to 1.36, houses 1.29 | walls and glow halos 1.16 to 1.26 | the dim shapes measure the same in both films |
| Brightest region in the frame, text left out | 1.36 at 15 s, 1.29 at 20 s (the shots that look wrong) | 4.5 to 15.7 in every frame | separates these two films |

- **Contrast alone can't tell a subject from scenery.** Both films draw navy shapes at about 1.2 to 1.35:1; in
  `d8c3` they are walls behind a white router, in `a54d` they are the subject itself.
- **The stranger's read, live** (GLM, one draft frame a shot, both builds): it called something faint in
  3 of 5 `a54d` shots (the phone outline, the dashed Wi-Fi arcs on the phone panel, the houses) but not the
  router and wall of shot 4, and in 6 of 6 `d8c3` shots (the dim walls, and the weak waves of "jauh =
  lemah", which are weak on purpose). Noisy both ways.
- **Decision (built, FR-057)**: the stranger's `faint` list goes to the director in its own turn as
  `look_faint` should-fix, where it knows what is meant to be weak; the look step keeps it out of the
  verdict, since as a TECHNICAL should-fix it would have marked most films REVIEW. The pixel rule below
  stays unbuilt until more films are labelled.
- **Candidate**: a frame where nothing drawn stands out (every sizeable non-text region under about 1.5:1
  against what it sits on) is a should-fix. Tested on two films only, so the threshold is uncalibrated; it
  needs the probe's text boxes to leave text out, misses thin bright strokes under the size floor, and must be
  run on the hand-written film (`claude-v`) and both worked examples before it ships.
- **Other option**: the stranger's read in the look step names what is hard to see against the ground (it
  knows the plan's subject); costs nothing new to run but depends on the model's eyes.
- The `a54d` version's snapshots don't match its `draft.mp4` (shot 1 at 6, 10 and 15 s); not investigated.

### S8, registry blocks and the planner (2026-11-03, T156 in part)

- **What the planner sees**: the plan call gets every block's name and tags (448 items), not their descriptions
  (the effects pass's search does see them). GLM's plan named one block, `godrays`, for shot 4, and the
  scene for that shot doesn't use it. Nothing for people.
- **Two install layouts**: `hyperframes add` writes a block flat (`compositions/godrays.html` plus
  `compositions/lib/…`) or in its own folder (`compositions/lottie-character-walk/lottie-character-walk.html`
  plus `assets/mascot.json`). Sorot looked only at the flat paths, so `use_block` would have returned an
  empty source for a folder block, and a planned folder block never reached its scene call either. Fixed:
  the source comes from the files `add` reports as written (`blockFiles`).
- **`lottie-character-walk` in a vertical film is not a drop-in**: it is a 1920×1080 composition with a card
  on the right, loads GSAP, lottie-web and Google Fonts from the web (the authoring contract forbids remote
  scripts and links, and Sorot ships no Lottie player; Three.js is the only vendored library), and the
  character is a 92 KB Lottie file. Using it needs a vendored player and a re-layout to 9:16; a strong
  model might adapt it, a flash model is unlikely to. `use_block` now flags what a block loads from the web.
- **So option 2 (the planner picks blocks) would not fix GLM's drawing of people by itself.** Open: whether
  a vendored `lottie-web` kit part (about 150 KB, my estimate) plus a few Lottie characters is worth the size,
  against drawing people in Three.js (`iso`/`three`) or SVG.
- **A failed last step loses the build.** The gateway's `ECONNRESET` is already treated as transient (3
  attempts, 2 s then 4 s apart) but a reset longer than 6 s ended the creative step, and a version has no
  "retry from the failed step": a new build re-authors everything (about 15 min). Candidate fix: retry a
  failed version from its failed step (finished steps are already reused by input hash) and a longer wait.
