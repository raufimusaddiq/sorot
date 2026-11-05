# Session 2026-11-05: Generate review before merge (PR #43)

Gate review of branch `claude/brave-hamilton-a69okw` against `specs/001-2d-video-generator/`.

## Reviewed
- Code and diff of phases 20 to 24: tool loop, stranger's look, compaction, scene probe in the
  director's tools, draft motion measure, three-picture look step, voice rewrite, version
  retry/resume, cancel during author.
- Spec kit: spec.md, plan.md, research.md, data-model.md, tasks.md, contracts (api, cli, recipe,
  director), docs/generate.md, docs/api-spec.md, docs/cli.md, AGENTS.md.

## Code defects found and fixed (two commits, each fix checked by disabling it)
- `ca38378`: retry after the plan changed now answers 409 instead of building the old plan; a
  refused build ends FAILED, not stuck; the voice step's rewrite rekeys the next step's input hash;
  accent hex check anchored; model records use the model that answered; the pin route decoded twice.
- `84e8e8f`: director loop: per-step abort checks, tool errors rethrown on cancel, look-first rule
  once per turn and never on the forced step, tools offered in a session opened before the loop,
  compaction keeps the answer tail when the last message is a tool result.

## Spec deviations (code is right; specs updated)
- api contract: retry 409 conditions, fix response shape, files/exports/import-history, kit delete
  `{deleted: true}`, calibrate 202, pin returns `{model}`, `forbiddenNumbers`, `turnTokens`.
- cli contract: `--no-numbers`, `--no-wait`, `facts add|rm`, `retry`, `resume`.
- recipe contract: script rewrite up to twice, author defaults, look skipped when looked in the loop.
- data-model: snake_case columns (`checked_at`, `first_pass`, `calibrated_at`, `shot_levels`),
  storylines count from the step, `llm.vision*` removed, look state `outputRef`, retry transition.
- spec.md: FR-054 voice rewrite, FR-055 two worked examples, FR-056 boxes in the probe; FR-009,
  FR-016, FR-031, FR-049 updated. tasks.md: phase 24 (T173 to T182 done, T183 open).
- plan.md and research.md: tool loop marked built; `beatOffsetSec` replaced by three pictures.

## Open
- T183: low contrast between a subject and its ground is not measured (the stranger's read is the
  only signal today).
- ESLint's parser fails to load during `next build` (the build still exports). This branch changes no
  ESLint package, so it likely predates it; not confirmed on master.

## Gate
OPEN: backend 1309 pass, 98.19% lines, `tsc` clean; cli 146 pass, binary builds; frontend 236
pass, static build; ai-pipeline 230 pass.

## Live runs and what they found (later the same day)

The open tasks run for real: a 20-brief bench (GLM, then Qwen 8B at kit, then Kimi; CPU, 4 cores, one
build at a time), the quickstart scenarios on a second server, and the story brief built five times.
Numbers: `specs/001-2d-video-generator/research.md` (S8 part 1 and 2, the quickstart run, the bench's
TECHNICAL failures, a subject too dark to see).

Fixed (T183 to T195), each with a test that fails without it:
- API projects lost `buildWithoutStopping`/`ideaId` (my own comment had swallowed them); narration default
  was off for every project made over the API, CLI or UI.
- An interrupted unattended build couldn't be resumed by naming its idea.
- Numeric plans: CSS tracking, GSAP eases with settings, outline repair noise; an unsourced or forbidden
  number now named with its shot and words, and a no-numbers brief holds the plan and script to it.
- Plan slips set right in code: a total within 25% scaled; kit parts and registry blocks swapped back.
- The voice keeps the script's order; a voice up to 10% too long is sped up instead of failing.
- The look step asks about three shots a call (HTTP 413 on a whole film); the look tool's read and checks
  run together.
- The session stays inside `GEN_CONTEXT_TOKENS`; the provider's input and cached tokens are kept per call.
- SC-021 raised above 90% by the owner: the director's look frames are 360×640 in its conversation and
  `look`/`check` reuse its last draft; the story brief went 82.1% → 90.8%, 34% faster.
- The jump measure flagged flashes, counters ticking and moves starting: 23 bench jumps were 2 real ones.
- CLI: current plan after a restore, `idea add` flags, `--no-narration`, step states and idea titles in
  `gen show`; `voice.json` listed instead of a file nothing wrote.

Settled without a measurement here: T095 (no original agent pipeline to compare), T100's publish half
(Tebar not connected; covered by `social.test.ts`). Left for the GPU: T067, T096, T120. Running: the
bench
(T150, T172, T192).

## Gate (after the fixes)
OPEN: backend 1326 pass, 98.19% / 99.45%, `tsc` clean; cli 146 pass, binary builds; frontend 236 pass,
static build (the ESLint parser error also shows on master's code); ai-pipeline 230 pass.
