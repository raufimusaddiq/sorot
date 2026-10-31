# Recipe Contract: custom pipelines

A **recipe** is a pipeline anyone can build: an ordered list of **steps** chosen from Sorot's
step library. Each step has its own settings, an optional approval gate and optional prompt
text (FR-022 to FR-025). Sorot doesn't hard-code anyone's pipeline. It ships a few neutral
example recipes, and users copy, reorder, add, remove and tune steps in the Recipes window or as
JSON. A recipe can be exported and imported, so people can share pipelines.

Two things are fixed for every recipe because they are the product's paradigm:

1. **Plan before building**: a `plan` step with a gate (`owner` or `director`) must come before
   `author`.
2. **Two verdicts**: every recipe ends its build with a `technical` and a `creative` step.

Everything else (which steps, their order, numbers, rules, criteria, prompts) is the user's.

Recipes are stored as JSON in `gen_recipe` and validated in code (`backend/src/generate/recipe.ts`):
unknown step types or keys are rejected, every number has a range, and step dependencies are
checked (see [Dependency rules](#dependency-rules)). Each project stores a **frozen copy** of its
recipe, so editing or deleting a recipe never changes existing projects.

## Shape

```jsonc
{
  "id": "my-explainer",                 // slug, unique per Sorot install
  "name": "My explainer",
  "description": "...",
  "version": 4,                          // +1 on every save
  "builtIn": false,
  "output":   { "width": 1080, "height": 1920, "fps": 30, "minSec": 45, "maxSec": 60 },
  "language": "id",                      // default; a brief or idea can override it
  "steps": [
    { "use": "facts", "with": { "mode": "verify" } },
    { "use": "script", "with": { "spellNumbers": true } },
    { "use": "voice",  "with": { "failClosed": true } },
    { "use": "align" },
    { "use": "storylines", "with": { "count": 3, "requireBold": true }, "gate": "director",
      "prompt": { "mode": "append", "text": "Pick the one a stranger would follow and remember." } },
    { "use": "concept", "with": { "novelty": { "lastN": 30 }, "mechanismTest": true } },
    { "use": "plan", "with": { "numeric": true, "motionPlan": true, "timingFrom": "voice", "blocks": false }, "gate": "director" },
    { "use": "author", "with": { "require": ["mechanism-or-dataviz", "camera", "typography", "captions"] } },
    { "use": "check", "with": { "warnings": "fix-or-hold" } },
    { "use": "look", "with": { "rounds": 3 } },
    { "use": "render", "with": { "quality": "delivery", "workers": 2 } },
    { "use": "technical", "with": { "measures": { "...": "see below" } } },
    { "use": "creative", "with": { "criteria": [ "...see below" ] } },
    { "use": "export", "with": { "mode": "copy" } }
  ],
  "rules": {                              // shared by several steps
    "layout": { "safeTopPx": 168, "safeBottomPx": 1330, "belowSafe": "texture-only", "captions": "base-of-safe-band", "firstFrame": "hook" },
    "readability": { "minTextPx": 28, "holdBaseSec": 0.5, "holdPerWordSec": 0.3 },
    "defaultsAudit": ["everything centred", "everything fading in together", "three cards in a row"],
    "content": [
      { "id": "education_not_advice", "kind": "judge", "blocking": true,
        "question": "Does the film tell the viewer to buy, sell or hold a specific asset?" }
    ]
  }
}
```

Each step: `use` (step type), `id` (optional; needed when a type appears twice), `with` (settings,
validated per type), `gate` (`owner` = stop until the user approves, `director` = the director
decides and its reason is logged, `none`), `prompt` (`{mode: "append" | "replace", text}`:
the user's instructions for that step's director call), and `when` (optional:
`"connection:image"`, `"connection:vision"` and so on, to skip a step when a connection is
missing instead of making the recipe unavailable).

`prompt` changes **what the director is told**, never **what it must return**. The output format
and the closing `task` field stay Sorot's, so a custom prompt can't break parsing or the gates.

## Step library

| Step | Does | Settings (`with`) | Gate |
|---|---|---|---|
| `idea` | takes the next idea from the idea bank, or a named one | `cursor: true` | |
| `facts` | builds or checks the fact list | `mode: verify \| research \| brief-only`, `sources: [<data source names>]`, `headlinesAsEvidence: false`, `maxSteps` | optional |
| `script` | writes the narration lines | `spellNumbers`, `maxWords`, `tone` | optional |
| `voice` | voices the script (engine and voice from Settings, per language) | `engine?: elevenlabs \| fish \| openai \| local` and `voice?` (overrides; examples never set them), `failClosed: true`, `speed` | |
| `align` | word timings: the engine's timestamps if it returns them, else local Whisper on the voiceover | `source: auto \| engine \| whisper`, `model?` | |
| `storylines` | N different films in words | `count: 1..5`, `skipUnderSec` (go straight to a plan at or under this length), `requireBold`, `pickRule` | **owner / director** |
| `plan` | shot-by-shot plan | `numeric`, `motionPlan`, `timingFrom: plan \| voice`, `blocks: true \| false`, `templates`, `maxShots` | **required: owner / director** |
| `concept` | names the visual mechanism, checks novelty | `novelty: {lastN}`, `mechanismTest` | |
| `images` | generated images for marked shots | `style`, `size` | |
| `music` | picks or uses a music bed | `track?`, `duckUnderVoiceDb` | |
| `author` | writes one scene per shot | `require: [...]`, `repairRounds: 0..5` | |
| `check` | HyperFrames `lint` + `check` loop | `warnings: fix \| fix-or-hold \| report`, `rounds` | |
| `look` | vision self-review of beat frames + defaults audit | `rounds: 0..5`, `beatOffsetSec`, `audit: true` | |
| `render` | renders the video | `quality: draft \| standard \| delivery`, `fps?`, `workers` | |
| `command` | runs a **local command registered in Settings**; its findings join a verdict | `name`, `counts: technical \| creative` | |
| `technical` | TECHNICAL verdict (code) | `measures` (below), `autoFixRounds: 0..3` | |
| `creative` | CREATIVE verdict (fresh judge) | `criteria` (below), `framesEverySec`, `vision: auto \| on \| off`, `autoFixRounds: 0..3` | |
| `export` | final file into the library | `mode: copy \| rerender`, `quality` | optional owner gate |

**TECHNICAL measures**, each with its own numbers.

- **Always on** (FR-012: a recipe sets their limits within the ranges but can't turn them off):
  `output` (size, fps, length window), `planText` (every planned line appears), `layout` (from
  `rules.layout`), `readability` (from `rules.readability`), `firstFrame`, `audio` when the plan
  has sound (present, `minMeanVolumeDb`, `maxTruePeakDb`), and `forbiddenNumbers` whenever the
  brief has such a flag (FR-027).
- **Optional**: `speechMatch` (`maxWordErrorRate`, local Whisper only), `voiceRoute` (engine and
  voice metadata match), `sourcedNumbers`, `deadStretchSec`, `rules.content` items with
  `blocking: true`, and `command` findings counted as technical.

**CREATIVE criteria**: a list of `{id, question, fail?: "main"}` written by the user; `fail:
"main"` makes a failed answer FAIL CREATIVE. Sorot always adds a main-message question ("does the
video communicate the brief's one main message?", `fail: "main"`) unless the user's list already
marks one question `fail: "main"` (FR-013). Non-blocking content rules and `rules.defaultsAudit`
leftovers are added as risks.

**Custom commands** (`command` step): a recipe names a command, and the command itself lives in
the user's Settings (`commands: [{name, cmd, args, timeoutSec}]`). Importing a recipe therefore
can never run something the user didn't register; a recipe that names an unknown command shows
as unavailable with the reason. The command gets `--project-dir` and `--version-dir` and prints
Sorot's JSON envelope `{"success": true, "data": {"findings": [Finding...]}}`. Hosted installs
turn commands off unless the admin enables them.

## Dependency rules

Checked when a recipe is saved or imported:

- `plan` exists, has `gate: owner | director`, and comes before `author`.
- `concept` comes after `storylines` (if any) and before `plan`; the plan builds on the recorded
  concept.
- The always-on TECHNICAL measures can't be turned off, only tuned within their ranges.
- `author` → `check`/`look`/`render` (in that relative order); `render` → `technical` and
  `creative` (both required, after `render`); `export` is last.
- `voice` needs `script` earlier; `align` needs `voice`; `plan.timingFrom: voice` needs `align`
  earlier; `measures.speechMatch` and `voiceRoute` need `voice`.
- `voice` needs a voice engine for the project's language in Settings. Online engines
  (`elevenlabs`, `fish`, `openai`) work on every install. `engine: local` works **only on GPU
  installs**: on a CPU-only install a recipe that pins it is unavailable ("the local voice needs a
  GPU install"), and it is never swapped for another engine silently.
- `measures.sourcedNumbers` needs `facts`; `facts.mode: research` with `sources` needs those data
  sources to exist in Settings (else the recipe is unavailable, with the reason).
- `look`, and `creative.vision: on`, need a vision-capable model (or `when: "connection:vision"`).
- `images` needs the `image` connection (or `when`).
- `export.mode: copy` needs `render.quality: delivery`.
- Limits: ≤ 30 steps; `output` within 360..4096 px, 12..60 fps, 5..90 s; ≤ 20 audit items,
  20 content rules and 8 criteria; each prompt ≤ 4,000 chars.

## Built-in example recipes

Neutral starting points, shipped read-only in `generator/recipes/` and copied to edit. They
contain no personal values: voices, keys and data sources always come from the user's own
Settings.

| Recipe | Steps | For |
|---|---|---|
| `quick` | storylines (owner, count 3, skipUnderSec 15) → plan (owner, blocks allowed) → author → check → render (draft) → technical → creative → export (rerender) | the simplest flow; any format, 5 to 90 s |
| `narrated-explainer` | facts (verify) → script → voice → align → storylines (director) → concept (novelty) → plan (director, numeric, motion plan, timed from voice, no blocks) → author → check (fix-or-hold) → look → render (delivery) → technical (output, audio, speech match, sourced numbers, layout, readability) → creative → export (copy) | factual, narrated vertical explainers that can run unattended |
| `story` | storylines (owner) → plan (owner) → images (when connected) → script → voice → align → author → check → look (when vision) → render (draft) → technical → creative → export | 2D storytelling with a narrator |

## Example: porting an existing agent pipeline

Anyone who already runs a video agent can express it as a recipe. The table below is one
unattended pipeline (pick an idea → verify facts → narration → storylines + numeric spec →
author → check and look → render, verify, QC → publish) written as steps. Personal values are
placeholders that the user sets in their own Settings. The example ships as
`docs/examples/recipes/agent-explainer.json`.

| Agent pipeline step | Recipe steps |
|---|---|
| Pick the next idea, or resume one | `idea` (`cursor: true`); `sorot gen run --idea <ID>` resumes without moving the cursor |
| Verify the facts against their sources; never add facts; headlines aren't evidence | `facts` (`mode: verify`, `headlinesAsEvidence: false`); `research` with `sources: ["<your data source>"]` for topics that need data |
| Narration first, numbers spelled out, fail-closed, never re-voiced for a visual-only change | `script` (`spellNumbers`) → `voice` (`failClosed`, engine and voice from Settings, cached by script hash) → `align` |
| Three storylines, one bold, picked with a reason; nothing built before the pick | `storylines` (`count: 3`, `requireBold`, `gate: director`) |
| Every adjective a number; shots with frame ranges; motion plan; safe zone and reading rules | `plan` (`numeric`, `motionPlan`, `timingFrom: voice`, `gate: director`) + `rules.layout` + `rules.readability` |
| Bespoke film, no templates, one mechanism born from the topic, concept differs from history | `author` (`require`) + `plan.blocks: false` + `concept` (`novelty`, `mechanismTest`) |
| Fix every error; fix warnings or keep them with a reason; describe beat frames as a stranger; audit defaults | `check` (`fix-or-hold`) + `look` + `rules.defaultsAudit` |
| Delivery render; check size, fps, length, audio, loudness, voice route, speech (local STT) | `render` (`delivery`) + `technical` measures (`output`, `audio`, `voiceRoute`, `speechMatch`) |
| Two verdicts written to a review file | `technical` + `creative` (the user's criteria) → `MOTION_REVIEW.md` |
| The agent's own extra checks | `command` steps, registered in Settings |
| Publish | outside the recipe: the Publish panel or `sorot publish --generated <id>` (never automatic) |

## Files written per project

From the database, for people and outside agents to read (read-only mirrors), into
`data/generate/{projectId}/`: `BRIEF.md`, `facts.md`, `audio_request.json`, `audio_meta.json`,
`STORYLINES.md`, `SPEC.md`, `MOTION_PLAN.md`, `CONCEPT.txt`, `v{n}/` (the HyperFrames project) and
`MOTION_REVIEW.md` (both verdicts, findings, kept warnings and their reasons). A file is written
only when the step that produces it is in the recipe.
