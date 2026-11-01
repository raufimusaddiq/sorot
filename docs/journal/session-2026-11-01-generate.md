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
