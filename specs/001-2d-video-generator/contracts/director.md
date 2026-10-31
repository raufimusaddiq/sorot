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
| `script` | brief, verified facts, language, target window, recipe guidance | `{lines: [{id, text}]}` with numbers spelled out | every number must map to a fact (checked in code) |
| `storylines` | brief, format, targetSec, language, styleNotes, preset hints, asset list, `note?`, story guidance, the step's settings and the user's prompt text, the script if `script` ran earlier | `{storylines: [N × Storyline]}`; exactly one has `recommended: true`, one has `bold: true` | N different films (world, device, form), each with the first 2 s, beats and look |
| `gate` (a step with `gate: director`) | the step's output (storylines or plan), the step's `pickRule` / the user's prompt text | `{decision, index?, reason}` (one clause) | logged in `step_state` |
| `concept` | picked storyline, topic, last `lastN` concepts of the recipe | `{mechanism, whyThisTopic, sameAsPrevious: false}` | code also checks text similarity; a repeat → ask again once, then fail |
| `plan` | brief, picked storyline, format, targetSec, language, look hints, assets, block catalog (names + tags), connections (`image`, `narration`) | `Plan` | validated by `planSchema`; one repair call with the validation errors, then fail |
| `revise` | current plan, request | `{plan, changeSummary}` | code diffs the plans; changed fields outside the request's shots are rejected and asked again once |
| `scene` | one shot, look, format size, block snippets used by the shot, asset paths, authoring contract | `{html}`: one `compositions/shot-NN.html` | plan-lock and lint/check in code |
| `repair` | the shot, its current html, its findings (lint/check/plan-lock) | `{html}` or `{html, holds: [{code, reason}]}` (warnings kept with `data-hold`) | ≤ recipe rounds per shot per version (default 3) |
| `look` (vision) | per beat: frame image(s) at beat +0.3 s, the shot's `reads`/`heroMove`, review sheets, the recipe's `rules.defaultsAudit` | `{beats: [{shotId, frame, strangerDescription, objects[], unexplained[], matchesShot: bool, defaultsSeen[]}]}` | separate call from the director; ≤ the step's `rounds`; unexplained objects → must-fix |
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
