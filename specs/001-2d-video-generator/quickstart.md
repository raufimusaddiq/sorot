# Quickstart: validating the 2D Video Generator

End-to-end checks that prove the feature works. Contracts: [api.md](contracts/api.md),
[cli.md](contracts/cli.md), [director.md](contracts/director.md). Entities:
[data-model.md](data-model.md).

## Prerequisites

- Sorot running (`.\scripts\start.ps1` or `sorot up`), with the LLM connected in Settings.
  Jev is optional; when it's on, it judges CREATIVE.
- `sorot doctor` reports HyperFrames ok (Node ≥ 22, Chrome, FFmpeg). In Docker mode this is
  built into the image.
- Optional: `image` and `voice` connections set in Settings → Connections.

## 1. Availability (FR-016)

1. Turn the LLM off in Settings → `sorot gen status` shows `available: false` and the reason. The
   Generate window shows "connect an LLM" with a link to Settings, and importing and clipping a
   video still work.
2. Turn the LLM back on → `available: true`.

## 2. Plan before building (US1)

```bash
sorot gen new "30 detik motion graphic: kenapa bunga majemuk bikin tabungan tumbuh, nada ceria" --format 9:16 --length 30
```

Expected: 3 storylines, one marked recommended and one bold.

```bash
sorot gen pick <project> 1
```

Expected: a shot table whose durations sum to 27 to 33 s, and whose numbers match the brief.

```bash
sorot gen revise <project> "shot 3 lebih pendek, pakai warna biru"
```

Expected: only shot 3's duration and the palette change, and a change summary is printed.

```bash
sorot gen build <project>
```

Expected: exit 1, "approve the plan first" (409).

```bash
sorot gen approve <project>
```

## 3. Build and two verdicts (US2)

```bash
sorot gen build <project>
```

Expected: progress through ASSETS, SCENES, CHECK, RENDER and VERDICTS; the draft plays in the
UI; the time taken is within the estimate shown before the build.

```bash
sorot gen verdicts <version>
```

Expected: separate TECHNICAL and CREATIVE statuses, each with findings that name a shot and a
time, and no combined score.

**Forced failure**: edit the plan so that a shot has a 20-word title in a 1 s shot, approve and
build. Expected: TECHNICAL is FAIL (`text_below_floor` or the read-time rule), and
`sorot gen export <version>` is refused with 409.

## 4. Revise (US3)

```bash
sorot gen fix <version>
```

Expected: a new version with fresh verdicts. The UI history shows both versions, and
`sorot gen restore <old>` brings back the old plan.

## 5. Determinism (SC-007)

Build the same approved plan twice with no asset changes. The two drafts' frame hashes should
be identical:

```bash
ffmpeg -i a.mp4 -f framemd5 -
```

Generated images are not fetched again (one `image` event only).

## 6. Export and publish (US4)

```bash
sorot gen export <version> --title "Bunga majemuk"
```

Expected: the file appears in Library → Generated. Opening Publish requires the same choices as a
clip (TikTok privacy, YouTube title and made-for-kids), and a retry doesn't double-post.

## 7. Extras

- **Image connection on**: the plan marks shots with generated images, and the assets show
  `origin: generated`. Replace one with an upload and rebuild: the upload is used.
- **Image connection broken**: the shot uses its fallback visual and gets a polish finding.
- **Narration on, with a voice engine**: the draft has an Indonesian voiceover and matching
  captions; TECHNICAL flags drift over 0.3 s.
- **No voice engine**: the narration toggle is disabled with a hint.
- **CPU-only install** (`WHISPER_DEVICE=cpu`, or the CPU `:latest` image): Settings → Voice lists
  only ElevenLabs, Fish and OpenAI-compatible. `sorot gen status` shows
  `localAvailable: false`. Importing a recipe whose `voice` step pins `engine: local` shows it as
  unavailable ("the local voice needs a GPU install"). With ElevenLabs or Fish connected, a
  narrated project voices normally.
- **GPU install** (`WHISPER_DEVICE=cuda`, the `:latest-cuda` image): Settings → Voice also lists
  Local, and a narrated project with the local engine voices with no online call (no `voice` API
  request in the director log).
- **Image size**: the CPU image is no larger than before because of TTS (`docker image ls`; no
  local-TTS packages: `pip show` for the S3-chosen package fails in the CPU image).

## 8. Build your own pipeline (US6)

```bash
sorot gen steps
sorot gen recipes
```

Expected: the step library with settings and dependencies; the examples `quick`,
`narrated-explainer` and `story`, each with availability and reasons (for example "needs a voice
engine", "needs a vision model").

1. **Compose**: `sorot gen recipe new mine`. This starts with the fixed minimum (plan with an
   owner gate, author, render, technical, creative, export). Then `sorot gen recipe edit mine`:
   add `script`, `voice` and `align` **before** `storylines`, set `plan.timingFrom: voice`, add
   one creative question, and set `output` to 30 to 40 s.
2. **Run**: `sorot gen new "<brief>" --recipe mine`. The director log shows the steps in exactly
   that order; the plan is 30 to 40 s and timed to the voice; CREATIVE asks the new question.
3. **Reorder wrongly**: move `voice` above `script` and save. Expected: refused, "voice needs
   script earlier". Remove `technical` and save. Expected: refused (two verdicts are required).
4. **Frozen**: edit `mine` again; the project from step 2 still shows its old recipe
   (`sorot gen show <project>`).
5. **Custom command**: register `my-check` in Settings → Commands (a script that prints
   `{"success":true,"data":{"findings":[...]}}`), and add `{use: "command", with: {name:
   "my-check", counts: "technical"}}` after `render`. Its findings appear in TECHNICAL.
6. **Share**: `sorot gen recipe export mine > mine.json`, then on a clean install
   `sorot gen recipe import mine.json`. Expected: it runs with that install's voices; if
   `my-check` isn't registered there, the recipe shows unavailable with "command my-check is
   not registered", and nothing runs.

## 9. Unattended factual run (US7, US8, R15 to R20)

Using the `narrated-explainer` example, or a copy:

1. Add an idea with three sourced facts, one of them deliberately wrong:

   ```bash
   sorot gen idea add BRIEF.md --facts facts.md --id IDEA-001
   ```

2. Start an unattended run:

   ```bash
   sorot gen run --recipe narrated-explainer --json
   ```

   Expected: it uses IDEA-001 and moves the cursor. The wrong fact is `corrected`, with the
   evidence. The voice comes from this install's Settings (`audio_meta.json` names the engine and
   voice). Director gate decisions are logged with their reasons. STORYLINES.md, SPEC.md (hex,
   px and frame values), MOTION_PLAN.md and CONCEPT.txt are written. It renders once at delivery.

3. `sorot gen verdicts <version>`. Expected: TECHNICAL lists the recipe's measures (size, fps,
   length window, audio and loudness, speech match, sourced numbers). CREATIVE lists the recipe's
   questions. MOTION_REVIEW.md lists kept warnings with their reasons.

4. **Fail-closed**: break the voice key and run again. Expected: the run stops at `voice` with
   the error, and nothing is rendered.

5. **Visual-only fix**: `sorot gen fix <version> --note "shot 2 lebih dinamis"`. Expected: no
   new `voice` event (the step is reused from cache).

6. **Resume**: `sorot gen run --recipe narrated-explainer --idea IDEA-001` continues that
   project, and the cursor doesn't move.

7. **Porting test (S6, SC-012)**: rebuild a video made by an existing agent pipeline as a recipe
   (`docs/examples/recipes/agent-explainer.json` with your own Settings). Expected: it took under
   30 minutes to set up, needed no code, and its TECHNICAL numbers match that pipeline's own
   checks.

## 10. Gates

```bash
cd backend; bun test --coverage; bun run typecheck
```

```bash
cd frontend; bun run test; bun run build
```

```bash
cd cli; bun test --coverage
```

```bash
cd ai-pipeline; .venv\Scripts\python.exe -m pytest tests --cov=.
```

All four must pass with ≥ 95% line and function coverage (`/test` → OPEN).
