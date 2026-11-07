# Director and Judge Call Contracts

Every LLM call is one request and one **tool call**: the model must call one function
(`tool_choice` names it), and the function's arguments are the answer. That keeps a reasoning
model from wrapping the answer in prose. The arguments are validated in code; if the model writes
the JSON as text instead, that is read too. A validation failure goes back to the model as the
function's result (`{accepted: false, problems}`) and it gets one more try. Every request ends
with a `task` field that restates the job (Sorot's rule, because reasoning models ignore the
system prompt). A failure raises `LlmError` -> the project keeps its state and `error_message` is
set (FR-016). Each call is logged in `gen_event` (the arguments are the logged response). The
output budget is the configured `LLM_MAX_TOKENS` or a per-job floor, whichever is larger, because
a reasoning model's thinking counts against it.

Functions: `submit_storylines`, `submit_plan`, `submit_revision` (`plan` + `changeSummary`) and
`submit_decision` (`gate`). The other calls below follow the same pattern when their steps land.

| Call | Input (user-message JSON) | Output JSON | Limits |
|---|---|---|---|
| `facts.verify` | one fact (claim, value), source page text (fetched by Sorot) | `{status: "verified"\|"corrected"\|"unverifiable", value?, evidence}` | no new facts; a headline-only source → unverifiable |
| `facts.research` (tools) | brief, existing facts, recipe rules; tools `fetch_url`, `search_web`, `query_data` (read-only, SELECT only, row cap) | `{facts: [{claim, value, sourceUrl, evidence}]}` | `Llm.runTools`, ≤ 8 steps, `finalPrompt` asks for the JSON |
| `script` | brief, verified facts, language, target window, `targetWords` (the film's length at about 1.8 words a second, a target only), recipe guidance; on a rewrite also `overrun: {spokenSec, filmSec, lines: [{id, text, sec}]}` (the voice step's measured speech) | `{lines: [{id, text}]}` with numbers spelled out | every number must map to a fact (checked in code); only the recipe's `maxWords` is a hard limit |
| `storylines` | brief, format, targetSec, language, styleNotes, preset hints, asset list, `note?`, story guidance, the step's settings and the user's prompt text, the script if `script` ran earlier | `{storylines: [N × Storyline]}`; exactly one has `recommended: true`, one has `bold: true` | N different films (world, device, form), each with the first 2 s, beats and look |
| `gate` (a step with `gate: director`) | the step's output (storylines or plan), the step's `pickRule` / the user's prompt text | `{decision, index?, reason}` (one clause) | logged in `step_state` |
| `concept` | picked storyline, topic, last `lastN` concepts of the recipe | `{mechanism, whyThisTopic, sameAsPrevious: false}` | code also checks text similarity; a repeat → ask again once, then fail |
| `plan` | brief, picked storyline, format, targetSec, language, look hints, assets, block catalog (names + tags), connections (`image`, `narration`) | `Plan` | validated by `planSchema`; slips set right in code first (shot lengths within 25% of the target scaled to it, a kit part listed as a block or the reverse moved, effect values clamped, CSS tracking and eases with settings read as such); one repair call with the validation errors, then fail |
| `revise` | current plan, request | `{plan, changeSummary}` | code diffs the plans; changed fields outside the request's shots are rejected and asked again once |
| `scene` | one shot, look, format size, block snippets used by the shot, asset paths, authoring contract | `{html}`: one `compositions/shot-NN.html` | plan-lock and lint/check in code |
| `repair` | the shot, its current html, its findings (lint/check/plan-lock) | `{html}` or `{html, holds: [{code, reason}]}` (warnings kept with `data-hold`) | ≤ recipe rounds per shot per version (default 3) |
| `look` (vision) | three pictures of each shot, early to late (at 20%, 55% and 90% of it), `meant: [{shotId, reads, heroMove, pictures}]`, the recipe's `rules.defaultsAudit` | `{frames: [{shotId, description, objects[], unexplained[], faint[], matches: bool, heroVisible: bool}], defaultsSeen[]}`, one entry per shot: `objects`, `unexplained` and `faint` (too close to their ground to make out, not text) are what is on screen in its last picture, `matches` whether it reads as meant by then, `heroVisible` whether the move shows across the pictures | separate call from the director, up to 3 shots a call (a whole film's frames in one request was refused with HTTP 413) and merged; a shot answered once per picture counts once (its last answer; the move is seen if any answer saw it); ≤ the step's `rounds`; unexplained objects → must-fix; `faint` never reaches the look step's findings |
| `fix` | approved plan, findings chosen by the user, user note | `{planEdits?: Plan, sceneEdits: [{shotId, instruction}], summary}` | a `planEdits` that changes approved text or durations needs re-approval |
| `judge` (LLM CREATIVE) | brief, approved plan, built facts per shot (rendered text, read time, motion, timings), optional review sheets (vision) | `{criteria: {mainMessage, followsStoryline, followsLook, openingHolds, pacingFits, endingLands}: {answer: "yes"\|"partly"\|"no", reason, shotId?, fromSec?, toSec?, suggestedFix?}}` | fresh messages, no director history (R7) |
| `copy` | plan title, message, platform limits | `{title, description, hashtags[]}` | reuses publisher copy rules; Jev copy check |

The `plan` call with a numeric recipe returns the numeric `look`, frame-range shots, `motionPlan`
and `concept` described in [data-model.md](../data-model.md#plan-json). Every call appends the
step's `prompt` text after Sorot's built-in instructions (`mode: append`), or in their place
(`mode: replace`), but always before the output format and the `task` field, which code owns.

## CREATIVE verdict from answers (code)

The criteria come from the `creative` step's `criteria` (the user's own questions), and the names
below are the Quick example's. A criterion with `fail: "main"` plays the role of `mainMessage`
(for example a user's "would a muted stranger understand the mechanism?"). Non-blocking `judge` content rules are added as risk questions.

- Jev (first): a Noul per criterion plus risk Nouls (`misleading_claim`, `unreadable_rush`). A
  criterion is failed when < 0.3 and borderline when 0.3 to 0.7. A risk is flagged when ≥ 0.7,
  which gives REVIEW and never an automatic FAIL (the same as the clip gate).
- LLM judge: `no` → failed, `partly` → borderline.
- Status: **FAIL** if `mainMessage` or `followsStoryline` failed, or ≥ 3 criteria failed;
  **REVIEW** if any criterion is failed or borderline, or a risk is flagged; **PASS** otherwise.
- Findings: failed → should-fix, borderline → polish, both with the reason and the suggested fix.
  CREATIVE never blocks export (FR-014); it guides the fix round.

## TECHNICAL verdict (code)

See [research R6](../research.md#r6-technical-verdict) and
[R19](../research.md#r19-final-render-verify-and-the-two-verdicts): FAIL with any must-fix,
REVIEW with should-fix only, PASS otherwise. Every check is code (HyperFrames JSON, ffprobe,
local Whisper speech match, fact matching), except the recipe's **blocking** `judge` content
rules (for example `education_not_advice`), which Jev answers (or the LLM when Jev is off). A
flagged blocking rule is a must-fix.

## Additions for any look, any director (2026-11-01)

- **Capability description**: every call's user JSON carries `capabilities`
  ([kit.md](kit.md#the-capability-description-every-director-call)), generated per call. Prompts
  never list parts by hand.
- **`submit_shot_kit`** (kit level): input is the shot spec, its look, the film's look, size,
  assets, and `capabilities` with `kitDetail`; output `{shotId, layers: [{part, settings, fromSec,
  toSec, layer?}], text}`; checked against the kit, then Sorot writes the scene.
- **`scene` / `repair` at `compose` and `free`**: as above, plus `capabilities` and the level's
  rules; kit calls in the HTML are checked like plan-lock.
- **Malformed answers**: the repair message names the parser error and quotes about 80 characters
  around its position (FR-045).
- **Plans in parts**: every numeric plan (and, once the model record exists, any plan from a model
  whose record shows malformed answers) is asked as `submit_plan_outline` (title, message, look, shots with
  durations and text; Sorot counts the frames from the lengths) then `submit_shot_specs` for four
  shots at a time, each batch validated in place and repaired with only its own problems.
- **Judge**: Sorot always adds the criteria `finished` ("Do the things in `shots` read as what they
  are, and look finished and intended?") and `motion` ("Does the motion in `shots` move smoothly and
  with weight?").

## Additions for the director loop (2026-11-02)

**Session** (FR-048): `scene`, `repair` and `kitshot` are turns of one conversation per version.
Opening: system (the three jobs, the authoring contract, the two worked examples, the step prompt) and
one user message `{capabilities, film: {title, message, look, language, shots}, size, assets,
fonts, task}`. Each turn's user message: `{request, level, levelMeans, …the shot's own fields,
currentHtml?, findings?, task}`. All three submit tools are offered on every turn; the request
names which one ends it. The tool list is set by the session's first turn that has tools (a kit shot or a
look-step repair has none) and stays the same for every later request.

**Tools in a turn** (FR-049). Offered with `tool_choice: "auto"`; the last allowed step forces the
submit tool, and that step ends the loop even if a provider ignores the forced choice. Every result
is JSON; an error is `{ "error": "…" }`. A cancelled build starts no further turn or tool step.
**Look first** (FR-049): the first submit of a `scene` turn that has `look` and hasn't looked is
turned back once with `{accepted: false, problems: ["look at your draft first…"]}` (no retry is used);
repairs and kit shots are not made to look. A turn's tool counts and this rule hold across its second
attempt.

| Tool | Arguments | Result |
|---|---|---|
| `search_blocks` | `{query: string ≤ 120, type?: "block" \| "component", limit?: 1..8}` | `{matches: [{name, type, title, description, tags, width, height, duration}]}` |
| `use_block` | `{name: string}` | `{name, files: string[], source: string (≤ 24 KB), cut: boolean, external?: string[], note?}` (`external`: URLs the block loads from the web, which a render can't); not offered when the recipe's plan step has `blocks: false` |
| `look` | `{html?: string, times: number[1..3]}` (`html` left out = the director's latest draft; seconds inside the shot, sorted early to late) | content parts: the frames as images, then `{frames, findings: [{code, severity, message, hint, atShotSec?}], seen: {description, objects, unexplained, faint}}`: the stranger's read (its `faint` things also come as `look_faint` should-fix findings) (a fresh call that sees only the frames, one answer for the shot) plus the same probe and motion findings as `check` |
| `check` | `{html?: string}` (left out = the director's latest draft) | `{findings: [{code, severity, message, hint, atShotSec?}]}` from `checkScene`, `hyperframes lint`, the scene probe (`text_over_object`, `first_frame_*`, `fighting_tweens`, `hard_swap`) and the motion measure on a draft render of just this shot (`motion_jump`, `motion_stall`); the last two run on a scratch copy of the project with a placeholder for each shot not yet written. `atShotSec` is shot time (the probe's own messages count film time) |
| `submit_scene` / `submit_repair` / `submit_shot_kit` | as before | `{accepted: true}` or `{accepted: false, problems}` (one more try) |

Limits per turn (recipe): `toolSteps` 8, `search_blocks` 4, `use_block` 2, `look` (`looks`) 2,
`check` 3. Past a tool's limit its call returns `{ "error": "limit reached: submit now" }`.
Inside the session the frames `look` returns are shrunk to 360×640 (the look step keeps full-size frames). `look` and `check` put the draft in the shot's file only while they read it, then put back what was
there: only an accepted submit changes the version's file.

**Compaction** (FR-051): after `{accepted: true}`, the turn becomes `user (task)` → `user ("tools
used: …")` → `assistant (submit_*)` → `tool ({accepted: true})`. An answer the model gave as plain text
(possible with `tool_choice: "auto"`) stays as its one assistant message after the note, so no tool
result is left without its call. Mid-turn past `GEN_TURN_TOKENS`:
earlier tool results in the turn become `{ "stub": "<kind> #n removed: see #m" }`.

**Pictures** (FR-052): a call with images goes to its role's model (`judge` for the CREATIVE
verdict, `scene` for `look`); there is no vision model setting.
