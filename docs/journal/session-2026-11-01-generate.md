# Session 2026-11-01 — Generate (2D video generator)

Feature `specs/001-2d-video-generator/`, built in 11 stacked phases (PRs on `feat/gen-phase-N`).
Design and measurements: [generate.md](../generate.md); decisions: `research.md` R1 to R21.

## Built
- Brief → storylines → approved plan → HyperFrames build → TECHNICAL and CREATIVE verdicts → fix
  rounds → export and publish (phases 3 to 6). Every model decision is a forced single tool call
  validated in code with one repair call.
- Recipes as ordered steps from a library with gates, `when: connection:x`, frozen copies per project,
  RecipeBook, a settings-driven editor (phase 7). Voice (online engines and local KittenTTS on GPU),
  Whisper alignment, numeric plans, concept novelty, vision `look`, images, music, custom commands.
- Facts with evidence checks, presets, idea bank and fully unattended runs (phases 8 to 10).

## Found
- Reasoning models ignore a system prompt: every call ends with a restating `task` field (as for the
  clip LLM paths). Forced tool calls + code validation made repairs rare: S4, 10 of 10 scenes valid.
- Authoring is the slow part of a build (about 2 min per shot); rendering is not (S2: 25 s for 30 s).
- KittenTTS has no Indonesian; the local voice needs a cloned reference there. MMS-TTS was dropped.
- Windows: Bash heredocs mangle backslashes, so scripts were written with the file tools; sqlite temp
  files need `maxRetries` on `rmSync`; tests must keep `genDir` inside their temp dir.
- Two pre-existing timing tests (build queue order, `maxParallelRenders`) are flaky under the full run.

## Not done (needs hardware, keys or a person)
- S3 (listening test, recorded ElevenLabs/Fish fixtures), S6 (rebuild a real agent pipeline from
  `docs/examples/recipes/agent-explainer.json`, timed), S2 final and S5 (60 s narrated delivery render,
  vision look model). Real HyperFrames, vision, image and data-source paths were exercised with fakes.

## Phase 12, phase 13 and the first real runs (2026-11-01 to 11-02)

Real builds on the RTX 4060 Docker app (kenari.id, deepseek-v4-flash then deepseek-v4-1-flash; Fish;
Jev). Measurements and decisions: `research.md` (T114, Part 3 R22 to R31, spike S7).

- **Phase 12**: per-shot transitions written by Sorot on the root timeline, the director's effects
  pass (tools), the `effects_few` measure and the `flat_film` risk, grouped check findings, a plan
  that a retry keeps, Generate's own token budget.
- **Phase 13**: the authoring contract follows HyperFrames' rules (`fromTo`, transforms only,
  `data-hold`, contrast, vertical safe band, motion craft); openings and look rules in the story
  guidance; malformed JSON sent back with where it broke; numeric plans asked in parts; seams that
  wouldn't show on the ground refused.
- **Found by real runs and fixed**: the gateway cut every non-streamed request at 180 s (answers are
  now streamed); the plan's input key read a later step's script (re-plans on retry); voice overran
  the film (script words capped by length at 1.8 words/s); narration switched off by the director;
  no image prompts (no guidance); motion frames counted from the shot; `=` counted as a word;
  unsourced numbers with no repair call; fix rounds failed on `init`; approving a plan step didn't
  approve the plan; old effect notes contradicted the pass; spoken numbers in digits failed the
  speech check; a scene that thought past its budget wasn't retried.
- **Not yet solved**: deepseek-v4-1-flash sometimes thinks through all 32,000 tokens on one scene
  and answers nothing, twice in a row (Gunung Koin rebuild of 11-02). Next: a larger budget or a
  different model, then the kit and director levels (phases 14 to 16) so a scene needs less code.
- **Spec**: User Story 9 and FR-038 to FR-047 (any look, an open kit, director levels from small to
  strong models, a capability description per call); plan Part 3 and tasks T115 to T151.

**Verify (before commit)**: backend 1124 pass, 0 fail, 98.0% functions / 99.4% lines, typecheck
clean; CLI 134 pass, 97.0% / 99.7%; frontend 227 pass, 98.3% functions / 99.1% lines. No skips.

## 2026-11-02: any look, any director (phases 14 to 18)

- **Kit** (`kit.ts`, `generator/kit/`): nine built-in parts and a small runtime (`ctx`, seeded random,
  `render(t)` driven by a timeline tween). Each built-in example rendered twice with identical frames
  (`framemd5`) with HyperFrames 0.8.223 on a 4-core CPU; a contact sheet confirmed they draw (the
  contact shadow and the Three.js coin were fixed after that look). Three.js r159 vendored (last plain
  browser build; tarball checked against npm's sha512). User parts: `.zip` or folder, a small zip
  reader/writer of our own (no new dependency), refused for a clock/random/network in `part.js` or
  frames that differ between two renders.
- **Capabilities** (`capabilities.ts`): one description per call; plans' shot looks and scenes checked
  against it (unknown part or setting, a WebGL part or WebGL code below `free`).
- **Levels** (`levels.ts`, `kitScene.ts`): the kit level writes the scene in code from
  `submit_shot_kit`; a shot that fails drops a level (`level_drop`), heavy shots are timed with
  snapshots against the frame budget (`frame_budget`). The test env pins its model to `compose`,
  since a new model now starts at `kit` (R25). `require` names parts as `kit:<name>` so free-form
  entries in older recipes stay hints.
- **Motion** (`motion.ts`): ffmpeg's scene score and freezedetect read a slowly moving small element as
  still, so the measure uses the luma difference per frame pair; a planted 400 px one-frame jump
  measured 45× its neighbours, the smooth spike renders at most 2×.
- **Spike S7, CPU half**: 2D movers 1.0 s per second of video, with motion blur 3.5 s; software WebGL
  (six Three.js coins) 2.3 s, with blur 3.6 s. CPU installs keep `maxLevel: free`. Chrome's "GPU stall
  due to ReadPixels" console warnings come from the capture and are dropped by the check step.
- **Still open**: T067 (local voice listen-test), T095 (rebuild an agent-pipeline video), T096 (60 s
  narrated delivery render + vision look review), T100 and T150 (quickstart runs), the RTX 4060 half of
  T120, and T147 (motion thresholds on real builds; calibrating deepseek models and a small local
  model). Each needs the owner's GPU, keys, models or own pipeline.

**Verify (before commit)**: backend 1218 pass, 0 fail, 98.3% functions / 99.3% lines, typecheck
clean; CLI 140 pass, 98.2% / 99.7%, build ok; frontend 231 pass, 97.9% functions / 99.0% lines,
static build ok. No skips.
