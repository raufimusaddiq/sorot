# Phase 0 Research: Kenari as Default AI Provider (US1 + US2 + US3)

No `[NEEDS CLARIFICATION]` markers remain. Sections 1–5 (US2) are carried over from the earlier
US2-only plan, unchanged — they still hold once US1 exists. Sections 6–11 are new research for
US1 and US3.

## US2 — Skip Kenari or customize it (unchanged from the prior plan)

### 1. Does reaching the general-provider form need a new API contract?

- **Decision**: No. `GET /api/settings`, `PUT /api/settings/llm`, and `POST /api/settings/llm/
  test` already accept `baseUrl`, `model`, `apiKey`, `enabled`, `director` with nothing
  Kenari-specific required.
- **Rationale**: FR-012 only requires the *flow* never gate this form behind a Kenari step; the
  backend contract was never Kenari-specific to begin with.
- **Alternatives considered**: A dedicated provider-mode endpoint — rejected, adds a persisted
  field purely for a UI choice recoverable from existing data (see §3).

### 2. Where does the "skip" choice belong in the UI?

- **Decision**: Inside the existing `llm` `ConnectionCard`, as a small two-option choice above
  the fields. "Use a different provider" reveals the fields the card already renders.
- **Rationale**: One card, one place to look; Constitution V keeps the frontend a static export
  with no new routes.
- **Alternatives considered**: A separate wizard page — rejected as unnecessary complexity.

### 3. How does the UI decide which choice to show by default?

- **Decision**: Derive it from the saved `llm.baseUrl` — unset → show both options; set to
  Kenari's known endpoint → default to the Kenari branch; set to anything else → default to
  "Use a different provider" with the saved values shown.
- **Rationale**: Keeps the connection as one entity; no second source of truth to drift.
- **Alternatives considered**: A persisted `llm.provider` field — rejected for the same reason.

### 4. How does the CLI expose the same choice?

- **Decision**: The flag-driven `sorot connect llm --base-url … --model … --key -` stays
  untouched (already bypasses any wizard). The interactive `sorot connect setup` wizard's `llm`
  step gets one new choice prompt before its existing field loop, defaulting on Enter to that
  existing loop.
- **Rationale**: Matches the wizard's "Enter skips" idiom; keeps the scriptable path unaffected.
- **Alternatives considered**: Making `sorot connect llm` interactive by default — rejected,
  would change defined flag-only behavior other tooling may depend on.

### 5. Does this interact with FR-008 (don't overwrite an existing different provider)?

- **Decision**: Yes — the same `baseUrl`-derived default (§3) satisfies FR-008 directly; nothing
  is written unless the user explicitly submits a change.
- **Rationale**: `ConnectionSettings.apply()` already treats a saved field as authoritative over
  env/defaults — exactly the "don't silently replace" guarantee FR-008 asks for.

---

## US1 — Connect with just an API key

### 6. Mapping Kenari's API (from `https://kenari.id/docs`, fetched 2026-11-02)

Kenari is an AI model gateway: one API key and base URL reach every chat model it lists, through
an OpenAI Chat Completions-compatible surface.

| Concern | Kenari's answer | Fit with Sorot's existing `Llm` client (`backend/src/llm.ts`) |
|---|---|---|
| Chat endpoint | `POST https://kenari.id/v1/chat/completions`, OpenAI-compatible request/response | Exact match — `Llm.chatOnce` already builds this shape (`model`, `messages`, `temperature`, `max_tokens`) against `config.llmBaseUrl` |
| Auth | `Authorization: Bearer kn-...` (also accepts `x-api-key`, but Bearer is primary) | Exact match — `chatOnce` already sends `Authorization: Bearer ${config.llmApiKey}` (`llm.ts:231`); no new auth code needed |
| Base URL | `https://kenari.id/v1` for OpenAI-style clients | Becomes the default value written to `llm.baseUrl` when a user picks Kenari |
| Model catalog | `GET /v1/models` — **public, no API key required** — returns `{ "data": [{ "id": …, "pricing": { "free": bool, … }, … }] }`; docs explicitly recommend reading this live rather than hardcoding model ids | New: a small backend proxy (§8) — this call needs no key, so it can run before/without a saved connection |
| Streaming | `"stream": true`, SSE | Already supported (`config.llmStream`) — applies automatically once Kenari is the configured endpoint |
| Errors | OpenAI-style `{"error": {"message", "type", "code"}}` for chat/completions | Already parsed by `chatOnce`'s existing error handling (`llm.ts:255-271`) — `LlmError` messages surface Kenari's `message`/`code` as-is |
| Model id formats | catalog id (`claude-sonnet-5-5`), `:free` variant, named route, `kenari/auto` (automatic routing, no fixed model) | Any of these is just a string in `llm.model` — no parsing needed on Sorot's side |
| Rate/plan limits | 429 with `code` like `free_quota_rpm`/`plan_limit_reached`; `Retry-After` sometimes present | Falls into `chatOnce`'s existing `TRANSIENT_STATUSES` retry (429 is already retried up to 3 times) |

**Decision**: Kenari needs no new provider protocol in `llm.ts` — it is a configuration (default
`baseUrl`/`model`) on top of the project's existing generic OpenAI-compatible client, exactly as
`AGENTS.md` already describes LLM support ("any OpenAI-compatible endpoint"). The only genuinely
new capability is reading Kenari's live, keyless model list, and validating a candidate key
before it's saved.

### 7. What default model should be pre-selected?

- **Decision**: `kenari/auto` (Kenari's automatic routing — it picks the best available model
  per call). The onboarding model picker shows this selected, with the full live catalog
  available to override.
- **Rationale**: Per the user's own answer during spec clarification: "user still could choose
  from /v1/models, we give the onboard form with api key input" — i.e. a live, pickable list with
  a working default, not a single hardcoded model. `kenari/auto` needs no per-model cost/quality
  tuning and matches the "seamless" framing of US1.
- **Alternatives considered**: a fixed free model (`step-3-7-flash:free`) — rejected as the
  default because free-tier rate limits (`free_quota_rpm`/`free_quota_daily`) could silently
  throttle a real clipping batch; still available in the picker for a cost-conscious user to
  choose explicitly.

### 8. How is a candidate key validated, and the model list fetched, before saving?

- **Decision**: Two small, additive backend endpoints, both read-only / non-persisting:
  - `GET /api/settings/llm/kenari-models` — proxies Kenari's keyless `GET /v1/models`, no
    request body, returns a compact `{ id, free }[]` list. Needs no saved or candidate key at
    all (per §6, the endpoint is public), so the UI/CLI can fetch it the instant Kenari is
    chosen, before any key is typed.
  - `POST /api/settings/llm/probe` — body `{ baseUrl?, model, apiKey }` (`baseUrl` defaults to
    Kenari's if omitted); builds a throwaway `Llm` instance from exactly those three values
    (`Llm`'s constructor already accepts any object shaped like `{ llmBaseUrl, llmModel,
    llmApiKey, llmTimeoutSec }` — see `llm.ts:162-167`) and makes one small real call ("reply
    with the single word OK"), mirroring `ConnectionSettings.test()`'s existing LLM branch
    exactly, but against a *candidate* connection instead of the saved one. Returns the same
    shape as `test()`'s `TestResult` (`{ ok, ms, model?, detail?, error? }`). Never echoes the
    key back, never persists anything — saving is still the existing `PUT /api/settings/llm`.
- **Rationale**: Reuses the `Llm` class exactly as designed (it already takes a plain config
  object, not a live reference to app config) and the existing `TestResult` shape the frontend
  already knows how to render (`ConnectionCard`'s `test`/`error` UI), so FR-002's "clear,
  non-technical error" requirement is satisfied by code that already exists and is already
  tested, applied to one new input source.
- **Alternatives considered**: Validating the key via Kenari's `GET /v1/account/balance`.
  Rejected — that endpoint 403s for restricted or shared keys (`restricted_key_not_allowed`,
  `shared_key_not_allowed` per Kenari's docs) even when the key is perfectly valid for chat
  calls, which would wrongly reject legitimate keys. A real chat call is the actual thing being
  validated for, so it is also the right validation.
- **New testability requirement**: `ConnectionSettings` must receive the same injected
  `fetchFn`/`retryWaitMs` that `app.ts` already passes to the shared `Llm` instance (`new
  Llm(config, httpFetch, deps.retryWaitMs)`, `app.ts:60`), so `probe()`'s throwaway `Llm` never
  makes a real network call in tests — satisfying Constitution III ("External effects … MUST be
  injected through `createApp(config, deps)`").

### 9. Does Kenari automatically become Generate's default too (FR-009)?

- **Decision**: Yes, with no extra wiring. There is exactly one `Llm` instance in the whole
  backend (`app.ts:60`), shared by `orchestrator.ts` (clipping director/review/copy) and
  `generate/director.ts` (Generate's director, via `this.llm.genMaxTokens` for its larger token
  budget — `generate/director.ts:399,681,836`). Once a user sets `llm.baseUrl`/`model`/`apiKey`
  to Kenari's values, every caller of that shared instance uses Kenari — Generate included.
- **Rationale**: Confirms FR-009 is already true by construction; this story needs zero backend
  wiring for it beyond making Kenari an easy default to set.
- **Alternatives considered**: A second, Generate-specific connection — rejected; would
  contradict the existing one-connection design and add complexity FR-009 doesn't ask for.

### 10. How does the CLI expose the Kenari branch non-interactively?

- **Decision**: `sorot connect llm --kenari --key -` (reading the key from stdin, consistent
  with the existing `--key -` convention) defaults `baseUrl` to Kenari's and `model` to
  `kenari/auto` unless `--model` is also given, then calls the same `probe()` → `PUT
  /api/settings/llm` sequence the interactive wizard uses.
- **Rationale**: Mirrors the existing flag-driven fast path (`--base-url`/`--model`/`--key`) so
  scripting/CI setup is possible without a TTY, consistent with SC-001's "under 2 minutes,
  through either the UI or the CLI."
- **Alternatives considered**: Requiring the interactive wizard for Kenari — rejected, breaks
  non-interactive installs (Docker, CI) that the existing `--key -` flags already support for
  every other connection.

---

## US3 — Credit Kenari's support

### 11. Where does the acknowledgment go?

- **Decision**: Two small additions, no runtime code:
  - `README.md` — one short line near the existing "🤖 Optional LLM" feature-table row or the
    intro paragraph (which already lists "Jev, an LLM and Tebar are optional online extras"),
    crediting Kenari's support grant with a link to kenari.id.
  - `CHANGELOG.md` — a new entry under the existing `## [Unreleased]` section (matching the
    style of the current `### Generate: briefs to finished 2D videos` entries), describing the
    Kenari integration and the acknowledgment together.
- **Rationale**: `AGENTS.md`'s release rule already states "user-facing changes go under `##
  [Unreleased]` in `CHANGELOG.md` as they merge" — this is the natural, already-existing place.
  `README.md` already has a line about optional online extras, so the credit reads naturally
  next to it rather than as a bolted-on section.
- **Alternatives considered**: A dedicated `CREDITS.md` or `SPONSORS.md` file — rejected as
  more than this one acknowledgment needs; nothing else in the repo currently warrants a
  separate credits file.
