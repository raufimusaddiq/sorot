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
