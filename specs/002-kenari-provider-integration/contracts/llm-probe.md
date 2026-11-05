# Contract: `POST /api/settings/llm/probe` (new, US1)

Validates a **candidate** `baseUrl`/`model`/`apiKey` combination with one small real chat call,
before anything is saved — so onboarding can tell the user "this key works" (or exactly why not)
ahead of the actual `PUT /api/settings/llm` that commits it. Mirrors the shape and behavior of
the existing `POST /api/settings/{kind}/test` (`backend/src/settings.ts:135-172`), applied to a
not-yet-saved connection instead of the currently-saved one (`research.md` §8).

## Request

```jsonc
{
  "baseUrl": "https://kenari.id/v1",  // optional — defaults to Kenari's base URL if omitted
  "model": "kenari/auto",             // required
  "apiKey": "kn-…"                    // required
}
```

400 if `model` or `apiKey` is missing or fails the same `validate()` rules already applied to
`PUT /api/settings/llm`'s `model`/`apiKey` fields (`settings.ts:validate()` — `url`, text ≤ 300
chars, secret with no whitespace ≤ 500 chars).

## Response `200`

Identical shape to the existing `TestResult` (`settings.ts:49-55`):

```jsonc
// success
{ "ok": true, "ms": 412, "model": "kenari/auto", "detail": "OK" }
// failure
{ "ok": false, "ms": 318, "error": "LLM HTTP 401: invalid key" }
```

`error` is the same `LlmError`-derived message the existing `test()` flow already produces and
the frontend already knows how to render (`ConnectionCard`'s `test.error` text) — no new error
vocabulary for the client to learn (FR-002).

## Guarantees

- **Never persists anything.** No `setting` row is written by this call, regardless of outcome.
- **Never echoes the submitted key back**, in the response or in logs (FR-005) — only `ok`/`ms`/
  `model`/`detail`/`error`, same discipline as every other masked-key path in this project.
- **Does not require a prior `PUT /api/settings/llm`.** The whole point is to validate before
  committing.

## Non-goals

- Does not replace `POST /api/settings/llm/test`, which still checks the *saved* connection
  after it's committed — `probe()` only covers the window before saving.
- Not provider-specific: the body accepts any `baseUrl`, so the same endpoint could validate a
  non-Kenari candidate too, but US1 is the only caller that needs this today.
