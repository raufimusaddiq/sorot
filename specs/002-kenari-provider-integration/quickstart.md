# Quickstart: Validate Kenari as Default AI Provider (US1 + US2 + US3)

Validates `spec.md`'s acceptance scenarios across all three user stories.

## Prerequisites

- Backend running locally (`docker compose --env-file .env.docker --profile dev up -d` or
  `bun run start` after `bun install` at repo root), reachable at its API base URL.
- A real or test Kenari API key, for the US1 steps that exercise `probe()` against the live
  Kenari API. If none is available, the "invalid key" step alone is still runnable.
- No `llm.*` settings saved yet (fresh install) for the first pass; reset with
  `sorot connect llm --reset` between runs.

## US1: connect with just an API key (Scenarios 1–3)

### UI

1. Open the Settings / Connections panel. In the `llm` card, confirm the Kenari branch is
   offered (alongside the "a different provider" branch from US2).
2. Select Kenari. Confirm the model list loads (`GET /api/settings/llm/kenari-models`) with
   `kenari/auto` pre-selected, before any key is typed.
3. Paste a valid Kenari API key. Confirm a validation call runs (`POST /api/settings/llm/probe`)
   and reports success, without requiring a base URL or model to be typed by hand.
4. Save. **Expected**: `GET /api/settings` afterward shows `llm.active: true`,
   `llm.baseUrl: "https://kenari.id/v1"`, and `llm.model: "kenari/auto"` (or whichever model was
   picked).
5. Repeat with an invalid/garbage key. **Expected**: the probe step reports a clear error (not a
   raw stack trace) and nothing is saved — `GET /api/settings` still shows the prior state.

### CLI

```bash
sorot connect setup
# at the "the LLM" step, type "kenari" at the new choice prompt, paste the API key when asked
```

or non-interactively:

```bash
sorot connect llm --kenari --key -
```

**Expected**: both complete in well under 2 minutes (SC-001), end with the connection active, and
print the resolved model (`kenari/auto` unless `--model` was also given).

## US2: skip Kenari, use a general provider (Scenarios 1, 3, 4)

*(Unchanged from the prior US2-only quickstart — re-verify alongside US1 now that both branches
share the same `llm` card/step.)*

1. In the same connection flow, choose "Use a different provider" instead of Kenari. Confirm no
   Kenari key field is shown or required, and the existing `baseUrl`/`model`/`apiKey` fields
   appear directly.
2. Fill in a non-Kenari endpoint (e.g. `http://localhost:11434/v1`) and model, save.
   **Expected**: `PUT /api/settings/llm` succeeds with no Kenari-related field in the body.
3. Reopen the panel. **Expected**: the saved custom values show directly, not a Kenari prompt
   (FR-008).
4. Clear the API key. **Expected**: `llm.active: false`; a clip job afterward completes on
   rule-based fallback, no AI error surfaced.
5. CLI equivalent: `sorot connect llm --base-url … --model … --key -` completes in one command
   with no Kenari step; `sorot connect setup`'s `llm` step, answered with Enter at the new choice
   prompt, goes straight to the existing field questions.

## US3: Kenari's support is credited (Scenario 1)

1. Open `README.md`. **Expected**: a short line credits Kenari's support, linking to kenari.id,
   near the existing "optional online extras" / LLM feature mention.
2. Open `CHANGELOG.md`'s `## [Unreleased]` section. **Expected**: an entry describing the Kenari
   integration is present.

## Shared: Generate also defaults to Kenari (FR-009, no separate steps needed)

After completing the US1 UI or CLI steps above, open Generate and confirm its connection status
reads from the same `llm` connection (no separate Generate-specific Kenari setup exists to do) —
this should already be true with zero extra action, per `research.md` §9.

## Test suite

```bash
cd backend; bun test --coverage; bun run typecheck
cd frontend; bun run test
cd cli; bun test --coverage
```

All new branches (US1's `probe()`/model-catalog routes and onboarding UI/CLI; US2's choice
affordance) should appear as additional rows in `backend/tests/social.test.ts`,
`frontend/src/components/__tests__/social.test.tsx`, and `cli/tests/social.test.ts` /
`commands.test.ts` — see `/speckit-tasks` for the per-file task breakdown (the existing
`tasks.md` only covers US2 and needs regenerating for the now-expanded scope).
