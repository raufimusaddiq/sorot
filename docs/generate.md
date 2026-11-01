# Generate: ideas, unattended runs and past work

This is the part of Generate that an outside agent or a scheduler drives. The design is in
`specs/001-2d-video-generator/`; the API is in `specs/001-2d-video-generator/contracts/api.md` and
the CLI in `contracts/cli.md`.

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
