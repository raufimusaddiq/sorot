# API Contract: /api/generate

Same envelope as the rest of the API: `{"status":"ok","data":...}` or
`{"status":"error","error":"..."}`. Keys are camelCase of the [data model](../data-model.md)
columns. Errors: 400 bad input, 404 unknown id, 409 wrong state, 503 Generate unavailable.

| Method | Path | Body / query | Returns | Notes |
|---|---|---|---|---|
| GET | `/api/generate/status` | | `{available, reasons[], hyperframes:{ok,version}, llm, jev, image, voice:{engines[], localAvailable, localReason?}, compute:"cpu"\|"gpu", presets[]}` | `available` is false without an LLM or with a failing `doctor` (FR-016); `localAvailable` is false on CPU-only installs (FR-018a) |
| GET | `/api/generate/projects` | | `{projects[]}` | newest first |
| POST | `/api/generate/projects` | `{brief, recipeId?, ideaId?, facts?[], format?, targetSec?, language?, styleNotes?, preset?, narration?, buildWithoutStopping?}` | `{project}` | runs the recipe's first steps (facts / narration / storylines); 503 if unavailable, 409 if the recipe is unavailable |
| GET | `/api/generate/projects/:id` | | `{project, plans[], versions[], assets[], exports[]}` | the plan list is newest first |
| PATCH | `/api/generate/projects/:id` | `{title?, narration?, styleNotes?}` | `{project}` | |
| DELETE | `/api/generate/projects/:id` | | `{deleted:true}` | removes files; 409 while building |
| POST | `/api/generate/projects/:id/storylines` | `{note?}` | `{project}` | asks for 3 new storylines |
| POST | `/api/generate/projects/:id/storylines/:index/pick` | `{note?}` | `{plan}` | index 0 to 2 |
| PUT | `/api/generate/projects/:id/plan` | `{plan}` | `{plan}` | direct edit → new revision, validated |
| POST | `/api/generate/projects/:id/plan/revise` | `{request}` | `{plan, changeSummary}` | plain-words change (FR-005) |
| POST | `/api/generate/projects/:id/plan/approve` | `{planId}` | `{project}` | `planId` must be the current revision |
| POST | `/api/generate/projects/:id/assets` | multipart `file`, `kind`, `shotId?` | `{asset}` | uploads; images also replace generated ones (FR-017) |
| DELETE | `/api/generate/assets/:id` | | `{deleted:true}` | |
| GET | `/api/generate/projects/:id/estimate` | | `{draftSec, exportSec}` | from previous `build_ms` (edge case) |
| POST | `/api/generate/projects/:id/versions` | | `{version}` | build; 409 without an approved plan (FR-006) |
| GET | `/api/generate/versions/:id` | | `{version, verdicts[]}` | poll while building |
| POST | `/api/generate/versions/:id/cancel` | | `{version}` | kills the process tree |
| POST | `/api/generate/versions/:id/fix` | `{findingIds?[], note?, shotId?}` | `{version}` | new version; no ids = all must-fix |
| POST | `/api/generate/versions/:id/restore` | | `{project}` | makes this version's plan the current one |
| POST | `/api/generate/versions/:id/accept` | | `{project}` | 409 if TECHNICAL = FAIL (FR-014) |
| POST | `/api/generate/versions/:id/export` | `{title?, description?}` | `{export}` | delivery render; 409 if TECHNICAL = FAIL |
| GET | `/api/generate/versions/:id/draft` | | `video/mp4` | range requests like clip files |
| GET | `/api/generate/versions/:id/sheets/:name` | | `image/jpeg` | `review-beats`, `review-phone` |
| GET | `/api/generate/exports/:id/file` | `?download=1` | `video/mp4` | |
| GET | `/api/generate/projects/:id/events` | `?limit=` | `{events[]}` | director log; no secrets |
| GET | `/api/generate/projects/:id/files/:name` | | text | the mirrored files (BRIEF.md, SPEC.md, MOTION_REVIEW.md, ...) |

### Recipes (FR-022 to FR-025, FR-035 to FR-037)

| Method | Path | Body | Returns | Notes |
|---|---|---|---|---|
| GET | `/api/generate/steps` | | `{steps[]}` | the step library: each type's settings schema, defaults, gate options, dependencies (drives the recipe editor) |
| GET | `/api/generate/recipes` | | `{recipes[]}` | each with `available`, `reasons[]` (missing voice, vision, image, data source, command) |
| POST | `/api/generate/recipes/validate` | `{recipe}` | `{ok, errors[], warnings[]}` | dependency rules, the two fixed rules, and question lint; nothing is saved |
| GET | `/api/generate/recipes/:id` | | `{recipe}` | |
| POST | `/api/generate/recipes` | `{fromId, id, name}` | `{recipe}` | copy; built-ins are copied, never edited |
| PUT | `/api/generate/recipes/:id` | `{recipe}` | `{recipe}` | validated; version +1; 409 on an example |
| DELETE | `/api/generate/recipes/:id` | | `{deleted:true}` | projects keep their frozen copy |
| POST | `/api/generate/recipes/import` | `{recipe}` | `{recipe}` | same validation; never imports commands or connections |
| GET | `/api/generate/recipes/:id/export` | | JSON file | |

### Gates

| Method | Path | Body | Returns | Notes |
|---|---|---|---|---|
| POST | `/api/generate/projects/:id/steps/:stepId/approve` | `{note?}` | `{project}` | passes an `owner` gate (storyline pick and plan approval also have the dedicated routes above) |

### Facts (FR-026, FR-027)

| Method | Path | Body | Returns | Notes |
|---|---|---|---|---|
| GET | `/api/generate/projects/:id/facts` | | `{facts[]}` | |
| POST | `/api/generate/projects/:id/facts` | `{claim, value?, sourceUrl}` | `{fact}` | owner-added |
| PATCH / DELETE | `/api/generate/facts/:id` | `{claim?, value?, sourceUrl?}` | `{fact}` | an edit resets status to `unverified` |
| POST | `/api/generate/projects/:id/facts/verify` | | `{facts[]}` | runs the facts step again |

### Ideas and unattended runs (FR-034)

| Method | Path | Body | Returns | Notes |
|---|---|---|---|---|
| GET | `/api/generate/ideas` | `?status=` | `{ideas[]}` | |
| POST | `/api/generate/ideas` | `{id?, slug, brief, flags?, facts?[]}` | `{idea}` | how the user or an outside agent fills the bank |
| PATCH / DELETE | `/api/generate/ideas/:id` | | `{idea}` | |
| POST | `/api/generate/run` | `{recipeId, ideaId?}` | `{project}` | next new idea (moves the cursor) or the named one (resume, cursor unchanged); runs to a checked final version without stopping when every gate is `director` |

## Publishing (changed)

Generated exports get the same three routes as clips, served by the same `publisher.ts` code
through a subject resolver:

| Clip route (unchanged) | Generated export route (new) |
|---|---|
| `POST /api/clips/:id/publish/draft` | `POST /api/generate/exports/:id/publish/draft` |
| `POST /api/clips/:id/publish` | `POST /api/generate/exports/:id/publish` |
| `GET /api/clips/:id/posts` | `GET /api/generate/exports/:id/posts` |

`/api/social/posts/:id/refresh|retry|cancel` and `/api/social/sync` work for both kinds.
`SocialPost` JSON gains `subjectKind`. Everything else (user choices, idempotency, retry,
cancel) is unchanged (Principle VI).

## Connections (changed)

`/api/settings` (and `/api/settings/:kind`, `/api/settings/:kind/test`) gains:

- `image`: `{enabled, baseUrl, model, apiKey (masked), size, style}`
- `voice`: `{enabled, engine: "elevenlabs" | "fish" | "openai" | "local", baseUrl, model, voices: {<language>: <voice id>}, apiKey (masked)}`;
  `local` is accepted only on GPU installs (409 on CPU, "the local voice needs a GPU install"); ElevenLabs uses `xi-api-key` and `model_id`; Fish sends the model as a header
  (Fish: `model` goes in an HTTP header)
- `data`: `{sources: [{name, kind: "sqlite", path}]}`, read-only data sources for facts research
- `commands`: `{commands: [{name, cmd, args[], timeoutSec}]}`, local check commands that recipes may name (off in hosted installs unless the admin enables them)
- `llm.vision`: bool, `llm.visionModel`: text (empty = the main model)

`image` and `voice` get `/api/settings/:kind/test`, like `llm`, `jev` and `tebar`.
