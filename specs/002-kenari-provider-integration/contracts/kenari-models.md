# Contract: `GET /api/settings/llm/kenari-models` (new, US1)

Proxies Kenari's public, keyless model catalog (`GET https://kenari.id/v1/models`) so the
onboarding UI/CLI can populate a model picker before — or without — any API key being entered,
per `research.md` §6/§8. Read-only; writes nothing.

## Request

No parameters, no body, no auth required (mirrors Kenari's own endpoint, which needs no key).

## Response `200`

```jsonc
{
  "models": [
    { "id": "kenari/auto", "free": false },
    { "id": "step-3-7-flash", "free": false },
    { "id": "step-3-7-flash:free", "free": true },
    { "id": "claude-sonnet-5-5", "free": false }
    // … the rest of Kenari's current catalog, filtered to chat-capable models
  ]
}
```

- `id`: pass straight through as `llm.model` if the user picks it.
- `free`: Kenari's own `pricing.free` flag, surfaced so the UI can show a "free" badge — never
  used server-side to change behavior.

## Error handling

If the upstream fetch fails (Kenari unreachable, non-2xx, malformed JSON), respond `200` with
`{ "models": [] }` plus a `warning` string field, rather than a `5xx` — per `spec.md`'s
Assumptions ("falls back to the automatic-routing default model and lets the user finish
connecting, rather than blocking setup entirely"). The client always still offers `kenari/auto`
as a typed-in fallback even when the list is empty.

## Non-goals

- Never requires or forwards a user's API key — Kenari's `/v1/models` doesn't need one.
- Never caches across requests server-side beyond what a normal short-lived HTTP fetch implies;
  this is an onboarding-time call, not a hot path, so no caching layer is introduced.
