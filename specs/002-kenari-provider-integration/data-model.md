# Phase 1 Data Model: Kenari as Default AI Provider (US1 + US2 + US3)

## No new persisted entities

The whole feature reuses the existing **AI Provider Connection** entity — the `llm.*` rows of
the SQLite `setting` table, defined by `CONNECTIONS.llm` in `backend/src/settings.ts:24-28`:

| Field (view name) | Setting key | Kind | Existing validation (`settings.ts:validate()`) |
|---|---|---|---|
| `enabled` | `llm.enabled` | bool | must be boolean |
| `baseUrl` | `llm.baseUrl` | url | must be `http(s)://…`, ≤ 300 chars — holds `https://kenari.id/v1` once a user connects Kenari, or any other OpenAI-compatible URL |
| `model` | `llm.model` | text | ≤ 300 chars — holds a Kenari model id (e.g. `kenari/auto`, `step-3-7-flash:free`, `claude-sonnet-5-5`) or any other provider's model name |
| `apiKey` | `llm.apiKey` | secret | no whitespace, ≤ 500 chars; masked in every read (`mask()`) — Kenari keys are `kn-…`, same length class as any other provider key, no special-casing needed |
| `director` | `llm.director` | bool | unchanged |
| `vision` / `visionModel` | `llm.vision` / `llm.visionModel` | bool / text | unchanged, not touched by this feature |
| `genMaxTokens` | `llm.genLlmMaxTokens` | tokens | unchanged — already shared by Generate's director (`research.md` §9), no Kenari-specific budget needed |

Nothing in this table changes shape. Connecting Kenari is **writing Kenari's values into fields
that already exist** via the existing `PUT /api/settings/llm` contract (`contracts/
llm-connection.md`) — the same call US2's "general provider" path already makes.

## Derived, non-persisted concept: connection mode (US2, unchanged)

```text
mode(llmView) =
  if llmView.baseUrl is unset              -> "unset"   (first run — show the choice, no default)
  elif llmView.baseUrl is Kenari's endpoint -> "kenari"
  else                                      -> "custom"
```

Computed on every read from `llm.baseUrl`, never stored. Used by the frontend and the CLI to
decide which branch to show by default (`research.md` §3). `KENARI_BASE_URL` (the string
`https://kenari.id/v1`) is the one new well-known constant this introduces, duplicated in
`frontend/src/components/ConnectionsPanel.tsx`, `cli/src/social.ts`, and `backend/src/
settings.ts` (the backend needs it too now, as the default `baseUrl` for `probe()` and as the
target of the model-catalog proxy — see below).

## New, non-persisted read model: Kenari Model Catalog (US1)

Fetched live from Kenari at onboarding time via `GET /api/settings/llm/kenari-models`
(`contracts/kenari-models.md`); never written to the database. Each entry:

| Field | Type | Meaning |
|---|---|---|
| `id` | string | The model id to put in `llm.model` if chosen (e.g. `kenari/auto`, `claude-sonnet-5-5`, `step-3-7-flash:free`) |
| `free` | boolean | Whether this model is in Kenari's no-cost tier (rate-limited) — shown in the picker so a cost-conscious user can tell at a glance |

The onboarding UI/CLI pre-selects `id === "kenari/auto"` (`research.md` §7) when present, and
otherwise leaves nothing pre-selected rather than guessing.

## New, non-persisted read model: Connection Probe Result (US1)

Returned by `POST /api/settings/llm/probe` (`contracts/llm-probe.md`); identical shape to the
existing `TestResult` interface already in `backend/src/settings.ts:49-55` (`{ ok, ms, model?,
detail?, error? }`), applied to a **candidate** connection (not-yet-saved `baseUrl`/`model`/
`apiKey`) instead of the already-saved one that `ConnectionSettings.test()` checks. Never
persisted; never echoes the submitted `apiKey` back.

## State transitions (US1 + US2 combined)

```text
unset  --(user picks "Kenari", enters key, probe() ok, saves)-->  kenari
unset  --(user picks "a different provider", saves)-->            custom
kenari --(user edits baseUrl/model away from Kenari's)-->         custom
custom --(user clears all of baseUrl/model/apiKey)-->             unset
custom --(user edits baseUrl/model/apiKey)-->                     custom   (stays custom)
kenari --(user changes model within Kenari's catalog)-->          kenari   (stays kenari — still Kenari's baseUrl)
```

Every transition is still just a `PUT /api/settings/llm` call with the existing fields (plus, for
the two new `kenari` entry transitions, a prior `GET /api/settings/llm/kenari-models` and/or
`POST /api/settings/llm/probe` call that writes nothing). `mode` is always recomputed from the
result, never sent as part of any request.

## US3: no data model

The acknowledgment (`README.md`, `CHANGELOG.md`) is static documentation text, not an entity.
