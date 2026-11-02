# Phase 1 Data Model: US2 — Skip Kenari or customize it

## No new entities

US2 introduces no new database table, column, or persisted field. It reuses the **AI Provider
Connection** entity named in `spec.md`'s Key Entities, which already exists as the `llm.*` rows
of the SQLite `setting` table, defined by `CONNECTIONS.llm` in `backend/src/settings.ts:24-28`:

| Field (view name) | Setting key | Kind | Existing validation (`settings.ts:validate()`) |
|---|---|---|---|
| `enabled` | `llm.enabled` | bool | must be boolean |
| `baseUrl` | `llm.baseUrl` | url | must be `http(s)://…`, ≤ 300 chars |
| `model` | `llm.model` | text | ≤ 300 chars |
| `apiKey` | `llm.apiKey` | secret | no whitespace, ≤ 500 chars; masked in every read (`mask()`) |
| `director` | `llm.director` | bool | must be boolean |
| `vision` / `visionModel` | `llm.vision` / `llm.visionModel` | bool / text | unchanged, not touched by US2 |
| `genMaxTokens` | `llm.genLlmMaxTokens` | tokens | unchanged, not touched by US2 |

A saved field wins over the server's env default (`ConnectionSettings.apply()`); clearing a field
(`null`) reverts to the env value. This existing "saved overrides env, clear reverts" behavior is
exactly what makes FR-008 (don't overwrite an existing provider) hold without new code: nothing
is written to any of these fields unless the user explicitly submits a change.

## Derived, non-persisted concept: connection mode

US2 adds one **view-layer-only** concept, computed on read and never written to the database:

```text
mode(llmView) =
  if llmView.baseUrl is unset              -> "unset"   (first run — show the choice, no default)
  elif llmView.baseUrl is Kenari's endpoint -> "kenari"
  else                                      -> "custom"
```

- Used by the frontend (`ConnectionsPanel.tsx`) to decide which fields to show by default when
  the `llm` card renders.
- Used by the CLI (`cli/src/social.ts`'s `llm` setup step) the same way, read from
  `GET /api/settings`'s existing `llm.baseUrl` field — no new API response field needed.
- Not stored: recomputing it from `baseUrl` on every read means it can never drift from the
  actual saved configuration (see `research.md` §3).

## State transitions

```text
unset --(user picks "Kenari", enters key)-->        kenari   [US1, out of scope here]
unset --(user picks "a different provider")-->      custom
kenari --(user edits baseUrl/model away from Kenari's)--> custom
custom --(user clears all of baseUrl/model/apiKey)-->     unset
custom --(user edits baseUrl/model/apiKey)-->              custom   (stays custom)
```

Every transition is just a `PUT /api/settings/llm` call with the existing fields; `mode` is
recomputed from the result, never sent as part of the request.
