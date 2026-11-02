# Build your own pipeline

A **recipe** is your pipeline: an ordered list of steps from Sorot's step library, each with its own
settings, an optional gate and optional prompt text. This guide builds one from the window, then from
JSON. The full contract is `specs/001-2d-video-generator/contracts/recipe.md`; the design is in
[generate.md](generate.md).

## In the window (no code)

1. Open **Generate → Recipes**. The shipped examples are read-only: **Copy** one (`quick` is the
   shortest, `narrated-explainer` has facts, voice and timing).
2. Add, remove and reorder steps. Each step's form is built from its settings (numbers have ranges,
   choices are menus), so a wrong value cannot be typed.
3. Per step you can set a **gate**: `owner` stops the run until you approve, `director` lets the model
   decide and logs its reason, `none` runs on. `plan` must have a gate (rule 1).
4. Per step you can add **prompt text** that is appended to (or replaces) what the director is told for
   that step. It changes what the model is asked, never what it must return.
5. Save. The editor shows what is wrong in plain words ("`voice` needs a `script` before it") and
   which Settings are missing (a voice engine, a data source, the LLM); a recipe that needs
   something you have not set is **unavailable** with that reason, not broken.

## Two things are fixed

- `plan` has a gate and comes before `author` (plan before building).
- The build ends with `technical` and `creative` (two verdicts). Their always-on checks (size,
  length, every planned line present, safe areas, readability, first frame, audio) cannot be turned off;
  you only tune their numbers.

## From JSON

```bash
sorot gen steps                       # every step, its settings and ranges
sorot gen recipe copy quick mine      # start from an example
sorot gen recipe edit mine            # opens $EDITOR; validated on save
sorot gen recipe validate mine.json   # check a file without saving it
sorot gen recipe export mine > mine.json
sorot gen recipe import mine.json     # share pipelines as files
```

A step is `{ "use": "<type>", "id"?, "with": {settings}, "gate"?, "prompt"?: {"mode", "text"}, "when"? }`.
Give an `id` when a type appears twice. `when: "connection:vision"` (or `image`) skips a step when that
connection is missing instead of making the recipe unavailable.

The `rules` block is shared by steps: `layout` (safe top and bottom px), `readability` (min text size,
hold times), `defaultsAudit` (looks you want the model to avoid), and `content` (questions judged on the
finished video; `blocking: true` makes a "yes" fail TECHNICAL). Questions name the field they read in
backticks (`shots`, `opening`, `message`) so the judge looks at the right thing.

## Your own checks: custom commands

A `command` step runs a program **you registered in Settings → Commands** (name, command, arguments,
timeout). A recipe only names it, so importing a recipe can never run something you did not allow; an
unknown name makes the recipe unavailable. The program gets `--project-dir` and `--version-dir` and
prints one JSON envelope:

```json
{ "success": true, "data": { "findings": [ { "id": "palette", "severity": "must-fix", "message": "Orange is not in the brand palette", "shot": "s3" } ] } }
```

`counts: technical` adds its findings to TECHNICAL, `counts: creative` to CREATIVE.

## Facts from your own data

`facts` with `mode: research` and `sources: ["name"]` lets the model query a data source you named in
Settings → Data (read-only `SELECT`, 50 rows at most per query). Every number in the film then has to
come from a verified fact when you turn on `sourcedNumbers`.

## Run it

```bash
sorot gen new "Jelaskan bunga majemuk" --recipe mine        # stops at your gates
sorot gen idea add BRIEF.md && sorot gen run --recipe mine  # no stops (director gates only)
```

Editing a recipe never changes a video that already started: each project keeps a frozen copy.
