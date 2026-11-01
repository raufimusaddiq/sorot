# Generate: briefs to finished 2D videos

Generate makes a short video from a brief, with no source footage: **brief → storylines → an
approved plan → a HyperFrames build → two verdicts → fix rounds → export and publish**. It is a
separate mode from clipping. It needs an LLM (Settings → LLM) and says so when it has none; clipping
never needs one.

Design and decisions: `specs/001-2d-video-generator/` (`spec.md`, `plan.md`, `research.md`).
Contracts: `contracts/api.md`, `contracts/cli.md`, `contracts/recipe.md`, `contracts/director.md`.
Guides: [Build your own pipeline](generate-recipes.md) · [Porting an agent pipeline](generate-porting.md).

## The two rules

1. **Plan before building.** Every recipe has a `plan` step with a gate (`owner` or `director`)
   before `author`. Nothing is built from a plan nobody (or no director call, with its reason
   logged) approved.
2. **Two verdicts.** Every build ends with a TECHNICAL verdict (decided in code) and a CREATIVE
   verdict (a fresh judge). Neither can be turned off; a recipe only tunes their numbers and
   questions.

Everything else (which steps, in what order, with what numbers and prompts) is the recipe's. Sorot
ships a few neutral recipes (`generator/recipes/`, read-only) and you copy them to edit.

## Where the code lives

| Part | Where |
|---|---|
| API, steps, director, verdicts, storage | `backend/src/generate/` |
| Window, recipe editor, library | `frontend/src/components/generate/` |
| CLI | `cli/src/generate.ts` (`sorot gen …`) |
| HyperFrames (pinned `0.8.223`), prompts, fonts, recipes, presets | `generator/` |
| Voice engines and Whisper alignment | `backend/src/generate/narration.ts`, `ai-pipeline/tts.py`, `transcribe.py` |

`generator/` holds **no Sorot logic**: it is the tool bundle (HyperFrames and its pinned version),
the prompt text, fonts, and data (`recipes/*.json`, `presets.json`). Rules, gates and verdicts are
code in `backend/`.

## How a video is made

A project is created from a brief (plus optional facts, assets, a preset and flags). It stores a
**frozen copy** of its recipe, so editing the recipe later never changes it. The recipe's steps run
in order; the plan is stored as numbered revisions; each build is a **version** with its own
folder, draft/delivery render and two verdicts. Files are mirrored into the project folder
(`BRIEF.md`, `facts.md`, `CONCEPT.txt`, `MOTION_PLAN.md`, the plan, `voice.json`) so an outside agent
can read them: `GET /api/generate/projects/:id/files`.

### The director

Every model decision is a **forced single tool call** (`submit_storylines`, `submit_plan`,
`submit_scene`, `submit_judgement`, …) validated in code, with one repair call when the answer is
invalid. A prompt in a recipe step changes what the director is told, never what it must return. If
the answer is still invalid after the repair, the step fails with the reason; it never carries on
with a guess. Research steps (`facts`) use read-only tools (`fetch_url`, `search_web`, `query_data`
with `SELECT` only, at most 50 rows).

### Step library

| Step | Does |
|---|---|
| `idea` | takes the recipe's next idea from the idea bank (or a named one) |
| `facts` | builds or checks the fact list against its sources |
| `script`, `voice`, `align` | narration lines, voice, word timings (engine timestamps or Whisper) |
| `storylines` | N different films in words (gate: owner / director) |
| `concept` | names the visual mechanism and checks it against past work |
| `plan` | the shot-by-shot plan, numeric (hex palette, type, easing, frames) (**required gate**) |
| `images`, `music` | generated images for marked shots; a music bed with ducking under the voice |
| `author`, `check` | one scene per shot, then HyperFrames `lint` + `check` with repair rounds |
| `look` | the model looks at beat frames (vision) and audits for defaults |
| `render` | `draft`, `standard` or `delivery` |
| `command` | a local command registered in Settings; its findings join a verdict |
| `technical`, `creative` | the two verdicts |
| `export` | the final file into the library (`copy` the delivery render or `rerender`) |

`GET /api/generate/steps` (or `sorot gen steps`) prints the live library with every setting and its
range. Dependencies (voice needs script, align needs voice, `export.mode: copy` needs a delivery
render, …) are checked when a recipe is saved or imported.

## Verdicts

**TECHNICAL** is code. Always on: output size, fps and length window, every planned line present,
layout safe areas, readability (text size, hold time), first frame, audio levels when there is
sound, and forbidden numbers. Optional: `speechMatch` (the voice says the script, by word error
rate), `voiceRoute` (engine and voice are the ones configured), `sourcedNumbers`, dead stretches,
blocking content rules (judged by Jev, then the LLM, else a should-fix "unjudged"), and `command`
findings. A finding is `must-fix` or `should-fix`; any must-fix is a FAIL.

**CREATIVE** is a fresh judge (Jev first, then the LLM) answering the recipe's criteria on the
rendered frames. Sorot always adds a main-message question; a recipe's `fail: "main"` marks which
failure fails the verdict. `command-creative:*` findings count here.

**Fix rounds**: fix the must-fix items (or ones you pick, with a note and a shot), up to the
recipe's `autoFixRounds`; each fix is a new version, and `restore` returns to an earlier one.
A version can be accepted only when its build is finished and TECHNICAL is not FAIL.

## The voice compute rule

Online voices (`elevenlabs`, `fish`, `openai`) work on every install. The **local** voice
(`engine: local`, KittenTTS 2) works **only on GPU installs** (`WHISPER_DEVICE` anything but `cpu`, the same switch clipping uses): the CPU image
does not even contain its packages (`LOCAL_TTS=1` is a build argument only the `:latest-cuda` image
sets), and a recipe that pins `local` on a CPU install is *unavailable* with that reason. It is never
swapped for another engine silently, and `failClosed` voice steps stop rather than fall back.
KittenTTS has no Indonesian voice: for Indonesian the Settings voice must be a reference recording
it clones (see research R9), so the online engines remain the dependable Indonesian route.

## Facts and numbers

Facts are claims with a source page. `verify` checks that the evidence is **on the page**, that a
correction is quoted from it, and that a headline alone is "unverifiable". `sourcedNumbers` makes
TECHNICAL fail any number on screen or in the voice that no verified fact states (digits and
spelled-out Indonesian or English numbers alike); "No other numbers" on a brief is the same rule
applied by the brief. Plan and script refuse an unsourced number for a factual recipe.

## Presets and defaults

`generator/presets.json` holds ready-made formats (motion-graphic, story, explainer, card, data,
promo). A preset feeds the director a fixed brief fragment and a default length; the brief, flags and
the recipe's `output` still win.

## Export and publish

`export` puts the file in the Generated library. Publishing reuses the clip publisher with a
`generated` subject (`sorot publish --generated <id>`): draft copy per platform, user choices (TikTok
privacy, YouTube title and made-for-kids are never filled in for you), one Tebar workspace per post,
and an idempotent upload so a retry cannot double-post. **Publishing is never automatic**, not even in
unattended runs.

## Measurements

Recorded in `specs/001-2d-video-generator/research.md`; they are one machine, one time.

| Spike | What | Result |
|---|---|---|
| S2 | Render speed, 1080×1920, 30 s light scene, RTX 4060 + Ryzen 5 7500F | 25 s draft, 25 s delivery, 24 s with `--gpu` (about 0.8 s per second of video); CPU Docker 19 s / 17 s. A real 60 s narrated film is still to be measured; plan on 6 to 10 s per second until then. |
| S3 | Local Indonesian voice; ElevenLabs and Fish fixtures | Not done: needs a listening test and keys. Engine is KittenTTS 2; online engines are the Indonesian route. |
| S4 | Does the model write one valid scene? | 10 of 10 scenes passed plan-lock, `lint` and `check` (8 first call, 2 after a repair). Writing them took 1,170 s (about 2 min per shot): authoring is the slow step of a build. |

---

# Driving Generate from outside

Ideas, unattended runs and past work: the part an outside agent or a scheduler drives.


## The idea bank

An idea is a brief you line up for later. Add one in the Generate window, with
`sorot gen idea add BRIEF.md`, or with `POST /api/generate/ideas`:

```json
{
  "id": "IDEA-042",
  "slug": "bunga-majemuk",
  "brief": "Jelaskan bunga majemuk untuk anak muda yang baru menabung.",
  "flags": { "language": "id", "targetSec": 40, "preset": "explainer", "narration": true, "market_data": false },
  "facts": [{ "claim": "Suku bunga acuan BI adalah 5,75 persen", "value": "5,75%", "sourceUrl": "https://www.bi.go.id/..." }]
}
```

- `id` is yours (letters, digits, `.`, `-`, `_`) or generated. `slug` is lowercase and unique.
- `flags` are all optional: `language` (`id` or `en`), `format`, `targetSec`, `preset`, `narration`
  and `market_data: false` (the video then shows no number that is not in the brief).
- `facts` come with the idea and go to the video made from it, each with the page that states it.

An idea's **status** follows its video: `new`, then `used` once a run took it, `built` once a version
was built, `posted` once its export was posted.

## Unattended runs

`sorot gen run --recipe <id>` (or `POST /api/generate/run {recipeId}`) takes the recipe's **next new
idea** and carries it to an exported video without stopping, then moves the recipe's cursor to that
idea. The next run takes the one after it.

`--idea <ID>` names an idea instead. A new one is started; one already started is **resumed** (a
failed run is retried, a failed build is built again). Naming an idea never moves the cursor.

A run only gets to the end when every gate in the recipe is the director's (`gate: director`) or
none: a gate that waits for the owner leaves the video waiting at that step, and you pass it in the
window or with `sorot gen approve-step`. A run ends at an exported video whose TECHNICAL verdict is
not FAIL. **Publishing is never automatic**: use the Publish panel or `sorot publish --generated <id>`.

## Past work: `import-history`

`sorot gen import-history file.json` (or `POST /api/generate/import-history`) brings in what you made
before, so new videos do not repeat it and the bank does not offer it again:

```json
{
  "concepts": [
    { "recipeId": "narrated-explainer", "mechanism": "A seed that grows into a tree", "concept": "The money tree grows by itself.", "date": "2026-03-01T00:00:00Z" }
  ],
  "ideas": [
    { "id": "IDEA-001", "slug": "bunga-dasar", "brief": "Dulu: bunga dasar", "flags": { "language": "id" }, "status": "posted" }
  ]
}
```

- `concepts`: each needs `mechanism` and `concept`; `recipeId` defaults to `quick`, `date` to now.
  They join the novelty history of that recipe (the check that a new concept differs from the last
  ones).
- `ideas`: as above; `status` defaults to `used` (they were made already), so a run never takes them.
- Anything that is already there (the same concept, the same id or slug) is skipped, not replaced.
  The answer is `{"concepts": n, "ideas": n, "skipped": n}`.
