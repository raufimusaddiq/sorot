# The director loop (2026-11-02)

Status: **built** (phases 19 to 22: the session, `search_blocks`, `use_block`, `look`, `check`, the forced
submit, the stranger's read and compaction), **not yet measured on a real build** (spike S8, T156, T169).
Builds on the build session (`docs/generate.md`, "The build session"). Code: `directorTools.ts`
(tools), `compaction.ts` (pure), `Director.useTools` / `askScene` (the turn), `look.ts` (`strangerRead`).

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
| `look` | `html` (the draft), `times` (1–3 s inside the shot) | the frames as images, and a stranger's read of them as findings (see Vision) | 2 (`author.looks`) |
| `check` | `html` (the draft) | Sorot's scene rules (`checkScene`), HyperFrames `lint` for this shot, and the scene probe's findings for this shot (text on a drawing, a missing first-frame title, fighting moves, and the motion measure's jumps and stalls; see "The probe and the motion measure in the loop"): code, severity, message, hint | 3 |
| `submit_*` | as today | `{accepted}` or the problems (one more try, as today) | ends the turn |

- `look` and `check` write the draft to `compositions/shot-NN.html` before they run; `submit_*`
  overwrites it, and a turn that ends without an accepted submit puts the last accepted file back.
- `look` uses `hyperframes snapshot --at` on the whole root, at the shot's absolute times. On this CPU a
  batch of three frames has taken about a minute; that cost is why it is limited.
- The scene probe also stays in the check step after the build (a repair turn if it finds something).
- Three.js needs no tool: the parts and their settings are in the session's opening (`capabilities`),
  and at `free` the director may write its own WebGL.

## A look is asked for once

On the first real build with the tools on (GLM, 7 shots, 2026-11-03), the model used no tool in any
of the 11 turns: it submitted straight away. A tool that is only offered is skipped by a fast model.
So the first submit of a **scene** turn that has `look` available is turned back once, inside the turn, with
"look at your draft first…" (no retry is used); after a `look` (or on the forced last step) a submit
is accepted. `author.looks: 0` turns the look off, and with it this rule. The authoring guide's
"Your tools" section says when `search_blocks` and `use_block` are worth a step; those stay optional.

## The probe and the motion measure in the loop

The probe took the director's own drawing as its only judge before this: GLM's films had 14 to 16% of their
text moments under a drawing (a hull made of CSS boxes, which the probe did not count as a drawing), and
nothing said so. Now `check` and `look` both return the probe's findings for the shot being written. HyperFrames'
check refuses a project whose shots are missing, so the probe runs on a scratch copy: the root, the shots so
far, a placeholder for each shot not yet written, the assets linked; the version's own folder is never touched.
The probe takes about 5 s. The same scratch copy then renders just this shot at draft quality (`hyperframes render
--start/--end`, about 13 s for 3.5 s on this CPU) and runs the TECHNICAL motion measure on it (`shotMotionFindings`):
a frame that jumps, a shot that freezes and moves again. On films already built, the in-loop measure found the same
jumps at the same moments as the build's verdict (0.37 s, 0.6 s and 1.83 s) and kept clean shots clean. A measure
that can't run adds nothing. CSS-drawn boxes count as drawings, except a box a
fifth of the frame or more (`panelShare`), which is a card the words sit on; and a text lying wholly inside a
drawing at least 5 times its own area (`labelShare`, `labelSize`) is a label on it, not a collision (GLM's
labels on its own panels were flagged until then). A text only partly over a drawing is the collision.

## Looking at a shot, not at one frame

The look step used to take one frame 0.3 s into each shot and judge it against what the shot was meant to
show. A shot's picture, its hero move and its objects arrive later than that, so every build had three or four
"a stranger can't tell what this is" must-fixes and "the hero move can't be seen" warnings about things that
were still on their way in, whoever the director was (the same on a hand-drawn film as on GLM's, 2026-11-05).
Now the step takes three pictures of each shot, at 20%, 55% and 90% of its length, and the stranger answers once
per shot from all of them: `objects` and `unexplained` are what is on screen in the last picture (something
only arriving or leaving earlier doesn't count), `matches` is whether the shot reads as meant by then, and
`heroVisible` whether the move can be seen across the pictures. The director's own `look` tool does the same
with the times it picks (sorted early to late; it is told to spread them). `beatOffsetSec` is gone.

## Vision: who looks at what

One model sees: **the director's own model.** There is no separate vision model (`LLM_VISION` and
`LLM_VISION_MODEL` are removed, 2026-11-02): a Generate director must reason and see.

- **`look` = the look check, moved into the loop.** The look step's value is that it looks *as a
  stranger*: a call that doesn't know what the shot meant describes what it sees, lists the objects,
  and names the ones it can't tell the purpose of; code then compares that with the plan
  (`look_unexplained` must-fix, `look_mismatch`, `look_hero_hidden`). The director can't be that
  stranger for its own drawing, so `look` does both in one tool call:
  1. renders the frames (HyperFrames `snapshot --at`);
  2. asks a **fresh** call to the same model (no session history, no plan intent, only the frames) the look
     step's questions;
  3. returns to the director the frames as images **and** the stranger's answer turned into findings
     by the same code as today (`look.ts`).
  The director redraws in the same turn, before it submits. The separate look step is retired;
  the build records "looked in the loop" for each shot.
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

Sizes are estimated in code (`compaction.ts`): text at 3.5 characters a token, an image at 2,700 tokens
(measured from the provider's usage numbers for a 1080×1920 frame: 2,693 on GLM, 2,701 on Kimi). A turn that fails
(its answer never validates) is cut from the conversation altogether, so what came before stays an
exact prefix. `looked.json` in the version's project records, per shot, the hash of the file that was
looked at; the look step does nothing when every scene is still the one that was looked at.

## Settings

| Setting | Default | Where |
| --- | --- | --- |
| `author.toolSteps` | 8 | recipe (0 = today's one forced call) |
| `author.looks` | 2 | recipe |
| `GEN_TURN_TOKENS` | 60000 (5000 to 500000) | env / Settings → LLM |
| `GEN_CONTEXT_TOKENS` | 600000 (20000 to 2000000) | env / Settings → LLM |

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
