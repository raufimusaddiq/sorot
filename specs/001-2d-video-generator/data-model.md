# Data Model: 2D Video Generator

SQLite, auto-created and auto-migrated in `backend/src/db.ts`. UUIDs are stored as TEXT and
times as ISO TEXT. API JSON keys are the camelCase of the columns (Principle V). JSON columns are
TEXT and are validated in code (`planSchema.ts`).

## Tables

### gen_project

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | |
| title | TEXT | from the plan, editable |
| brief | TEXT NOT NULL | ≤ 2,000 chars (FR-001) |
| format | TEXT NOT NULL | `9:16` (default) · `16:9` · `1:1` |
| target_sec | INTEGER NOT NULL | 5 to 90 |
| language | TEXT NOT NULL | `id` (default) · `en` |
| style_notes | TEXT | |
| preset | TEXT | `motion-graphic` · `story` · `explainer` · `card` · `data` · `promo` · null |
| recipe_id | TEXT NOT NULL | → gen_recipe (`quick` by default) |
| recipe | TEXT NOT NULL | **frozen** JSON copy of the recipe at creation (FR-024) |
| idea_id | TEXT | → gen_idea, when made from the idea bank |
| brief_flags | TEXT | JSON, e.g. `{"market_data": "none"}` → `forbidden_numbers` |
| narration_script | TEXT | JSON `audio_request` lines `[{id, text}]` (numbers spelled out) |
| concept | TEXT | the one visual mechanism (CONCEPT.txt), for novelty (FR-030) |
| step_index | INTEGER NOT NULL DEFAULT 0 | position in the frozen recipe's `steps` (project-level steps) |
| step_state | TEXT | JSON per step id: `{status: done\|waiting\|failed\|skipped, inputHash, outputRef, reason?}`; `reason` holds a director gate decision |
| narration | INTEGER NOT NULL DEFAULT 0 | user toggle (FR-018) |
| storylines | TEXT | JSON array of 3 [Storyline](#storyline-json), or null for ≤ 15 s |
| picked_storyline | INTEGER | index 0 to 2 |
| status | TEXT NOT NULL | see [state machine](#project-state-machine) |
| current_plan_id | TEXT | → gen_plan |
| accepted_version_id | TEXT | → gen_version |
| error_message | TEXT | last director/build failure (work kept, FR-016) |
| created_at, updated_at | TEXT | |

### gen_plan (one row per plan revision)

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | |
| project_id | TEXT NOT NULL | → gen_project |
| revision | INTEGER NOT NULL | 1, 2, ... per project |
| plan | TEXT NOT NULL | JSON [Plan](#plan-json) |
| change_request | TEXT | the plain-words request that produced it (null for the first) |
| change_summary | TEXT | the director's one-line summary of what changed |
| approved_at | TEXT | set once; an approved revision is never edited (a change makes a new revision) |
| created_at | TEXT | |

### gen_version (one build)

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | |
| project_id | TEXT NOT NULL | |
| plan_id | TEXT NOT NULL | must be approved (FR-006) |
| number | INTEGER NOT NULL | v1, v2, ... per project |
| parent_version_id | TEXT | the version a fix round started from |
| status | TEXT NOT NULL | `QUEUED` · `BUILDING` · `BUILT` · `FAILED` · `CANCELLED` |
| step | TEXT | id of the build-segment step running now (`author` … `export`) |
| progress | INTEGER | 0 to 100 |
| project_dir | TEXT | `data/generate/{projectId}/v{n}` |
| render_kind | TEXT NOT NULL | `draft` · `final` (from the recipe's `render.quality`) |
| draft_path | TEXT | the rendered MP4 the verdicts judged (draft or final) |
| step_state | TEXT | JSON per build step id (as on gen_project), incl. rounds used by `check`/`look`/auto-fix |
| hyperframes_version | TEXT | pinned CLI version used |
| build_ms | INTEGER | feeds the build-time estimate |
| error_message | TEXT | |
| created_at, updated_at | TEXT | |

### gen_verdict (two per BUILT version)

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | |
| version_id | TEXT NOT NULL | UNIQUE(version_id, kind) |
| kind | TEXT NOT NULL | `TECHNICAL` · `CREATIVE` |
| status | TEXT NOT NULL | `PASS` · `REVIEW` · `FAIL` |
| findings | TEXT NOT NULL | JSON array of [Finding](#finding-json) |
| judged_by | TEXT NOT NULL | `code` · `jev:<model>` · `llm:<model>` · `llm-vision:<model>` |
| inputs | TEXT | JSON: which checks and sheets were used (FR-011 traceability) |
| created_at | TEXT | |

### gen_asset

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | |
| project_id | TEXT NOT NULL | |
| kind | TEXT NOT NULL | `logo` · `image` · `font` · `music` · `voiceover` · `captions` |
| origin | TEXT NOT NULL | `upload` · `generated` · `bundled` |
| path | TEXT NOT NULL | file under the project's `assets/` |
| shot_id | TEXT | for generated images and per-shot uploads |
| prompt_hash | TEXT | generated images/voice: reused while unchanged (SC-007) |
| meta | TEXT | JSON: prompt, model, voice, word timings, dimensions |
| created_at | TEXT | |

### gen_recipe

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | slug (examples `quick`, `narrated-explainer`, `story`; user recipes) |
| name | TEXT NOT NULL | |
| version | INTEGER NOT NULL | +1 on every save |
| built_in | INTEGER NOT NULL | examples are read-only and seeded from `generator/recipes/*.json` |
| description | TEXT | |
| recipe | TEXT NOT NULL | JSON per [contracts/recipe.md](contracts/recipe.md), validated |
| idea_cursor | TEXT | last idea id used by unattended runs of this recipe |
| created_at, updated_at | TEXT | |

### gen_fact

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | |
| project_id | TEXT | null while the fact belongs to an idea only |
| idea_id | TEXT | |
| claim | TEXT NOT NULL | sentence form |
| value | TEXT | the number/value as written (normalised copy in `meta`) |
| source_url | TEXT | required unless status is `unverifiable` |
| status | TEXT NOT NULL | `unverified` · `verified` · `corrected` · `unverifiable` |
| original_value | TEXT | set when `corrected` |
| evidence | TEXT | quoted passage from the source used to verify |
| added_by | TEXT NOT NULL | `owner` · `idea` · `director` (research mode only) |
| created_at, updated_at | TEXT | |

### gen_idea

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | the user's own idea id (e.g. `IDEA-042`) or a UUID |
| slug | TEXT NOT NULL UNIQUE | folder name |
| brief | TEXT NOT NULL | BRIEF.md content |
| flags | TEXT | JSON brief flags (`market_data`, language, ...) |
| status | TEXT NOT NULL | `new` · `used` · `built` · `posted` |
| project_id | TEXT | project made from it |
| created_at, updated_at | TEXT | |

### gen_export

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | also the publishing subject id |
| project_id, version_id | TEXT NOT NULL | version's TECHNICAL ≠ FAIL at export time (FR-014) |
| path | TEXT NOT NULL | `data/generate/{projectId}/exports/{versionId}.mp4` |
| format, duration_sec | TEXT, REAL | |
| title, description | TEXT | drafted from the plan, editable (FR-020) |
| created_at | TEXT | |

### gen_event (local director log, replaces hosted tracing)

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | |
| project_id | TEXT NOT NULL | |
| version_id | TEXT | |
| kind | TEXT NOT NULL | `facts` · `tool` · `script` · `storylines` · `pick` · `plan` · `revise` · `scene` · `repair` · `look` · `concept` · `fix` · `judge` · `copy` · `image` · `voice` · `command` |
| model | TEXT | |
| request | TEXT | prompt or command line (secrets never stored) |
| response | TEXT | truncated to 20,000 chars |
| ok | INTEGER NOT NULL | |
| ms, tokens | INTEGER | |
| created_at | TEXT | |

### Change to an existing table

`social_post` gets `subject_kind TEXT NOT NULL DEFAULT 'clip'` (`'clip'` · `'generated'`).
`clip_id` keeps holding the subject id. Migration: `ALTER TABLE ... ADD COLUMN`. Existing rows
become `'clip'`.

### Settings (existing `setting` table)

New connection groups `image`, `voice` (`engine: elevenlabs | fish | openai | local`, voice id
per language; `local` only on GPU installs; for Fish the `model` goes in a header) and `data`
(registered read-only data sources:
`{name, kind: "sqlite", path}`), and `llm.vision` / `llm.visionModel`. Keys are masked like the
others, and secrets also go in `.env.llm` (`ELEVENLABS_API_KEY`, `FISH_API_KEY`, `VOICE_API_KEY`,
`IMAGE_API_KEY`).

## JSON documents

### Storyline JSON

```json
{ "title": "...", "pitch": "one line", "opening": "first 2 s", "beats": ["hook", "...", "end card"],
  "look": "one line", "sound": "one line", "bold": false, "recommended": true, "reason": "..." }
```

### Plan JSON

```json
{
  "title": "...", "message": "the one thing the viewer remembers",
  "format": "9:16", "totalSec": 30, "language": "id",
  "look": { "palette": ["#0B1020", "#FFD23F"], "fonts": ["Plus Jakarta Sans"], "pacing": "brisk", "notes": "..." },
  "sound": { "music": "asset id | none", "narration": true },
  "narrationScript": "full script or null",
  "blocks": ["data-chart"],
  "assumptions": ["anything the director added that wasn't in the brief (FR-007)"],
  "shots": [
    {
      "id": "s01", "purpose": "hook", "durationSec": 3.0,
      "text": [{ "role": "title", "value": "Bunga berbunga?" }],
      "visual": { "description": "...", "block": "data-chart | null",
                  "generatedImage": { "prompt": "...", "style": "flat" } , "fallbackVisual": "..." },
      "motion": "...", "transition": "cut | wipe | ...", "audio": "...",
      "narration": "words spoken in this shot or null", "hold": false
    }
  ]
}
```

With a numeric plan (`plan` step `numeric: true`), `look` and each shot carry exact values instead of
adjectives:

```json
{
  "look": {
    "ground": "#0E1116", "ink": "#F4F1EA", "accent": "#FF5A36", "medium": "flat vector + paper grain",
    "type": { "title": { "font": "Plus Jakarta Sans", "weight": 800, "px": 96, "trackingEm": -0.02 },
              "body":  { "font": "Inter", "weight": 500, "px": 40, "trackingEm": 0 },
              "caption": { "font": "Inter", "weight": 600, "px": 44, "trackingEm": 0 } },
    "shadow": { "x": 0, "y": 12, "blur": 32, "opacity": 0.25 },
    "easing": { "enter": "cubic-bezier(0.16,1,0.3,1)", "hero": "cubic-bezier(0.65,0,0.35,1)", "exit": "cubic-bezier(0.7,0,0.84,0)" },
    "staggerFrames": 4
  },
  "shots": [{ "id": "s01", "frames": [0, 90], "heroMove": "...", "reads": "...", "handoff": "...",
              "beats": [{ "frame": 9, "label": "hook lands" }], "...": "as above" }],
  "motionPlan": [{ "shotId": "s01", "enter": {"frames": [0, 12], "easing": "enter"},
                   "hero": {"frames": [12, 70], "easing": "hero", "what": "..."},
                   "exit": {"frames": [80, 90], "easing": "exit"} }],
  "concept": { "mechanism": "...", "whyThisTopic": "fails the bolt-on test because ..." }
}
```

Validation (`planSchema.ts`): 1 to 20 shots; each `durationSec` between 1 and 15; the sum within
± 10% of `target_sec` (SC/US1-2); each title line ≤ 6 words and each text value ≤ 120 chars;
fonts must be bundled or uploaded; `generatedImage` only when the `image` connection is enabled
(otherwise stripped, keeping `fallbackVisual`); `narration*` only when narration is on and a
voice engine is available; facts check: each number in the brief that the plan mentions must
appear unchanged, and anything else is listed in `assumptions`. All length, size and readability
limits come from the project's frozen recipe (the numbers above are the Quick example's). With
`numeric: true`, the plan also needs: every colour as hex, every text role with font, weight, px and
tracking, easing as a curve per role, shot `frames` covering `[0, totalFrames)` with no gaps,
and motion-plan entries that only use spec tokens; every number in shot text or narration must
be a verified fact.

### Finding JSON

```json
{ "id": "f3", "severity": "must-fix | should-fix | polish", "shotId": "s02",
  "fromSec": 4.2, "toSec": 5.0, "code": "text_below_floor | creative.opening_holds | ...",
  "description": "...", "suggestedFix": "...", "state": "open | fixed | kept",
  "keptReason": "required when kept (data-hold), shown in MOTION_REVIEW.md", "rule": "recipe rule/criterion id" }
```

## Project state machine (recipe runner)

There is no fixed list of states per step: the **runner** walks the frozen recipe's `steps` in
order. The project's coarse `status` is:

```text
RUNNING ──(owner gate)──► WAITING ──approve / pick / revise──► RUNNING
RUNNING ──(reaches author)──► BUILDING (a gen_version runs the build segment: author … creative)
BUILDING ──► BUILT ──fix (owner) or autoFixRounds──► BUILDING (new version; unchanged steps reused)
BUILT ──accept──► ACCEPTED ──export──► EXPORTED
any ──director/step failure──► FAILED (work kept; retry resumes at the failed step)
BUILDING ──cancel──► CANCELLED version; project back to BUILT/WAITING as before
```

- **Project segment**: the steps before `author` (`idea`, `facts`, `script`, `voice`, `align`,
  `storylines`, `plan`, `concept`, `images`, `music`, in the recipe's order). A step with
  `gate: owner` sets `WAITING` until the user acts. `gate: director` asks the director, stores
  its decision and reason in `step_state`, and continues.
- **Build segment**: `author` through `export`, run inside a `gen_version`. Each step's output is
  cached by `inputHash`. A fix round re-runs from the first step whose input changed, so a
  visual-only fix never re-runs `voice`.
- **Revise**: a change request goes back to the `plan` step (new revision). The `plan` gate must
  pass again before building.

Rules enforced by the runner (all from FR-006, FR-014, FR-016, FR-035):

- No build segment without an approved current plan revision (owner, or director with a logged
  reason).
- `accept` and `export` need a version whose TECHNICAL verdict is `PASS` or `REVIEW`.
- A step failure keeps all previous work and sets `error_message`. Retry resumes at that step.
- A `voice` step with `failClosed` that fails stops the run; nothing is rendered silent.
- The `plan` step can't complete while a number in the plan or script lacks a verified fact
  (when the recipe has `sourcedNumbers`).
- `concept` runs before `plan`; on a repeat it asks once more, then fails the step, so `plan`
  never starts on a repeated concept.
- On restart, a `BUILDING` version becomes `FAILED` ("interrupted"), the same as the clip job
  sweep.
- A version rendered at `delivery` is exported by copying the file (no second render).
