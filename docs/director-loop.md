# The director loop (draft spec, 2026-11-02)

Status: **proposed**, not built. Builds on the build session (`docs/generate.md`, "The build session").

## Why

Real GLM and Kimi films (2026-11-02) drew people and objects as flat shapes a viewer couldn't name
("a stranger can't tell what the dome is for"). Sorot already ships the tools that fix this:
HyperFrames (renderer, checks and a registry of 448 blocks and components: 38 in 3D, a jointed
walking character, 12 maps, 9 charts) and Three.js (the `three` and `iso` parts, or the director's own
WebGL at `free`). Today the director sees the registry only as names while planning, writes each shot
blind, and learns what it drew from a separate vision step afterwards. This spec makes each shot a
short tool loop: the director finds and uses what exists, looks at its own frames, checks its own
draft, then submits. The look and the creativity stay the model's; the gates stay in code.

## The turn

Each shot (scene, repair or kit shot) is one turn of the build session:

```
user: {request, shot fields, task}
  assistant → tool call ─┐
  tool result            │ up to author.toolSteps (default 8)
  ...                    ┘
  assistant → submit_scene | submit_repair | submit_shot_kit   (ends the turn)
```

- Tools are offered every step (`tool_choice: "auto"`) with the submit tool among them; on the last
  allowed step the call is forced to the submit tool.
- A tool error goes back as the tool's result (`{ "error": "…" }`); it never fails the build.
- Every tool runs on the version's own project folder; nothing touches another shot's file except
  through `submit_*` (and the draft slot below).

## Tools

| Tool | Arguments | Returns | Limit per turn |
| --- | --- | --- | --- |
| `search_blocks` | `query` (≤ 120 chars), `type?` `block`\|`component`, `limit?` ≤ 8 | name, type, title, description, tags, size, duration of the best matches in the cached catalog (word and tag match, no embeddings) | 4 |
| `use_block` | `name` | installs it (`hyperframes add`), returns its files and its source (≤ 24 KB, the rest cut with a note) | 2; refused when the recipe's plan step has `blocks: false` |
| `look` | `html` (the draft), `times` (1–3 s inside the shot) | the frames as images, and a stranger's read of them as findings (see Vision) | 2 (`author.looks`); offered when a model can see (the director's, or `LLM_VISION_MODEL`) |
| `check` | `html` (the draft) | Sorot's scene rules (`checkScene`) and HyperFrames `lint` for this shot: code, severity, message, hint | 3 |
| `submit_*` | as today | `{accepted}` or the problems (one more try, as today) | ends the turn |

- `look` and `check` write the draft to `compositions/shot-NN.html` before they run; `submit_*`
  overwrites it, and a turn that ends without an accepted submit puts the last accepted file back.
- `look` uses `hyperframes snapshot --at` on the whole root, at the shot's absolute times. On this CPU a
  batch of three frames has taken about a minute; that cost is why it is limited.
- Not a tool: the scene probe (`sceneProbe.ts`) needs a full `hyperframes check` of the project
  (minutes), so it stays in the check step and comes back as a repair turn.
- Three.js needs no tool: the parts and their settings are in the session's opening (`capabilities`),
  and at `free` the director may write its own WebGL.

## Vision: who looks at what

One model sees, by default: **the director's own (scene) model.** `LLM_VISION_MODEL` stops being a
second model to run; it stays only as an optional override (a text-only director, or a different eye).

- **`look` = the look check, moved into the loop.** The look step's value is that it looks *as a
  stranger*: a call that doesn't know what the shot meant describes what it sees, lists the objects,
  and names the ones it can't tell the purpose of; code then compares that with the plan
  (`look_unexplained` must-fix, `look_mismatch`, `look_hero_hidden`). The director can't be that
  stranger for its own drawing, so `look` does both in one tool call:
  1. renders the frames (HyperFrames `snapshot --at`);
  2. asks a **fresh** vision call (no session history, no plan intent, only the frames) the look
     step's questions;
  3. returns to the director the frames as images **and** the stranger's answer turned into findings
     by the same code as today (`look.ts`).
  The director redraws in the same turn, before it submits. The separate look step is retired: a
  build whose director can see records "looked in the loop" for each shot instead.
- **A director that can't see** gets the stranger's answer as text only (frames go to
  `LLM_VISION_MODEL` when one is set); with no seeing model at all, `look` is not offered.
- **The CREATIVE verdict keeps a fresh judge** (constitution: two verdicts, neither can be turned
  off): a new conversation without the director's history, so the author never grades its own work.
  Same model by default (`GEN_JUDGE_MODEL` overrides). One call per build.

## Context: compaction

Tool results are the bulky part of a turn (images, block sources, check output). Three levels keep
the session small without breaking the cache for earlier shots: each one only rewrites the tail of
the conversation (the current turn), so everything before it stays an exact prefix.

1. **End of turn (always).** When a submit is accepted, the turn's tool exchanges are replaced by one
   short note, and the accepted answer is kept:
   `user: {task}` → `user: "tools used: search_blocks ×1 (lottie-character-walk), look ×2 (1.2, 2.8 s), check ×1 (passed)"`
   → `assistant: submit_* (final html)` → `tool: {accepted: true}`. Images, block sources and check
   output are dropped; the installed block's files stay in the project.
2. **Mid-turn (when the turn passes `GEN_TURN_TOKENS`, default 60000).** Inside the current turn,
   older tool results become stubs and only the latest of each kind is kept whole: the latest `look`
   images ("frames from look 1 removed: see look 2"), the latest `check`, and a used block's source
   once (later copies point back to it). The model's own tool calls stay, so the turn still reads in
   order.
3. **Session (when the session passes `GEN_CONTEXT_TOKENS`, default 600000).** As today: restart from
   the opening plus the latest version of every shot.

Sizes are estimated in code: text at 3.5 characters a token, an image at a fixed 1,500 tokens (to be
measured against the provider's usage numbers and corrected).

## Settings

| Setting | Default | Where |
| --- | --- | --- |
| `author.toolSteps` | 8 | recipe (0 = today's one forced call) |
| `author.looks` | 2 | recipe |
| `GEN_TURN_TOKENS` | 60000 | env / Settings → LLM |
| `GEN_CONTEXT_TOKENS` | 600000 | env / Settings → LLM (exists) |

## Measuring it

The same story brief on GLM, against the 2026-11-02 builds: the look findings "a stranger can't
tell what it is" (3 must-fix on the first build), the CREATIVE `finished` answer, the frames side by
side, build time (`look` costs about a minute each on CPU), tokens and cache reuse (87% on the
session build), and how often the director used each tool.

## Open questions

- How well a flash model runs a multi-step tool loop: measured, not assumed.
- Whether `lottie-character-walk` and the 3D blocks can be adapted to 9:16 and to a film's look, or
  only serve as references.
- Image token cost on the provider: measured from its usage numbers.
