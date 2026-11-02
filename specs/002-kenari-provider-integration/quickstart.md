# Quickstart: Validate US2 — Skip Kenari or customize it

Validates spec.md US2 acceptance scenarios 1, 3, 4 (scenario 2 — overriding Kenari's own
defaults — depends on US1 shipping first, so it is re-checked once that lands).

## Prerequisites

- Backend running locally (`docker compose --env-file .env.docker --profile dev up -d` or
  `bun run start` after `bun install` at repo root), reachable at its API base URL.
- No `llm.*` settings saved yet (fresh install), to exercise the "unset" mode first. If settings
  already exist from prior testing, reset them first: `sorot connect llm --reset`.

## UI: skip Kenari, go straight to a general provider (Scenario 1)

1. Open the Settings / Connections panel in the browser UI.
2. In the `llm` card, confirm a "Use a different provider" (or equivalent) choice is visible and
   reachable with one click, with no Kenari key field required or shown first.
3. Click it. Confirm the existing `baseUrl`, `model`, and API key fields appear (same fields the
   card already renders today).
4. Fill in a non-Kenari endpoint (e.g. `http://localhost:11434/v1`), a model (e.g. `qwen2.5:7b`),
   and save.
5. **Expected**: `PUT /api/settings/llm` succeeds with no Kenari-related field in the request
   body; `GET /api/settings` afterward shows `llm.active: true` (once baseUrl+model+apiKey
   resolve) and `llm.baseUrl` equal to what was entered.

## UI: existing custom provider is left untouched (Scenario 3)

1. With a non-Kenari `llm.baseUrl` already saved (from the step above), reopen the Settings
   panel.
2. **Expected**: the card shows the saved custom values by default — not a Kenari-first prompt —
   confirming the `mode` derivation in `data-model.md` picks "custom" correctly.

## UI: clearing the key turns AI off, not an error (Scenario 4)

1. Clear the saved API key (click "Use .env" or blank the field and save, per the existing
   `ConnectionCard` affordance).
2. **Expected**: `GET /api/settings` shows `llm.active: false`; a clip job run afterward completes
   using rule-based scoring/hooks/copy (Constitution IV), with no error surfaced for "no AI."

## CLI: non-interactive general provider, no Kenari step (Scenario 1, SC-003)

```bash
sorot connect llm --base-url http://localhost:11434/v1 --model qwen2.5:7b --key -
```

(Pipe or type the key at the prompt; `-` reads from stdin so it stays out of shell history.)

**Expected**: completes in one command, prints the connection as active, and at no point asks
for or mentions a Kenari key. Verify with `sorot connect show` (or `--json` for a scriptable
check).

## CLI: guided wizard defaults to the general path on Enter (Scenario 1)

```bash
sorot connect setup
```

At the "the LLM" step, press Enter at the new choice prompt (added in this plan) without typing
"kenari".

**Expected**: the wizard proceeds directly into the existing `Base URL` / `Model` / `API key`
questions — the same ones it asks today — with no Kenari key requested.

## Test suite

Run the full gate to confirm no regression:

```bash
cd backend; bun test --coverage; bun run typecheck
cd frontend; bun run test
cd cli; bun test --coverage
```

All new branches from this plan should appear as additional rows in `backend/tests/social.test.ts`,
`frontend/src/components/__tests__/social.test.tsx`, and `cli/tests/social.test.ts` /
`commands.test.ts` — see `/speckit-tasks` for the per-file task breakdown.
