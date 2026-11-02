# Phase 0 Research: US2 — Skip Kenari or customize it

No `[NEEDS CLARIFICATION]` markers remain in the Technical Context for US2 — the project's
existing connection-settings code (`backend/src/settings.ts`, `frontend/src/components/
ConnectionsPanel.tsx`, `cli/src/social.ts`, `cli/src/commands.ts`) already gave concrete answers
to every open question. This file records the decisions made while reading that code, in the
Decision/Rationale/Alternatives format.

## 1. Does reaching the general-provider form need a new API contract?

- **Decision**: No. `GET /api/settings`, `PUT /api/settings/llm`, and `POST /api/settings/llm/
  test` (documented in `docs/api-spec.md` §"GET /api/settings" / §"PUT /api/settings/{llm|jev|
  tebar}") already accept `baseUrl`, `model`, `apiKey`, `enabled`, `director` with no required
  field implying Kenari. A client can call `PUT /api/settings/llm` with those four fields today
  and get a fully working, non-Kenari provider — this is exactly what `ConnectionCard` already
  does in `frontend/src/components/ConnectionsPanel.tsx` and what `sorot connect llm --base-url
  … --model … --key -` already does in `cli/src/commands.ts`.
- **Rationale**: FR-012 only requires that the *flow* never gates this existing form behind a
  Kenari step. Since the backend contract was never Kenari-specific, no endpoint change, no new
  field, and no migration is needed — the work is entirely in the UI/CLI entry point.
- **Alternatives considered**: A dedicated `/api/settings/llm/provider` "mode" endpoint was
  considered, to let the client declare "kenari" vs "custom" server-side. Rejected: it would add
  a persisted field purely for a UI choice that is fully recoverable from the already-saved
  `baseUrl` (see §3), and it would be a new contract surface to keep stable for no behavioral
  gain (Constitution V favors the smaller surface).

## 2. Where does the "skip" choice belong in the UI?

- **Decision**: Inside the existing `llm` `ConnectionCard` in `ConnectionsPanel.tsx`, as a small
  two-option choice rendered above the fields (`'Connect Kenari' | 'Use a different provider'`).
  Selecting "Use a different provider" reveals exactly the `baseUrl`/`model`/`apiKey` fields the
  card already renders today — no new fields, no new card, no new route.
- **Rationale**: `ConnectionsPanel.tsx` already has one card per connection kind (`llm`, `jev`,
  `tebar`); US1's Kenari-specific fields (key input + fetched model picker) are additive to this
  same card, not a separate onboarding page, per the spec's "same onboarding form" wording in
  spec.md US1 acceptance scenario 1. Keeping the choice inside the existing card means there is
  exactly one place a user looks for "how do I set up AI," and the skip path costs one click.
- **Alternatives considered**: A separate full-screen "Connect AI provider" wizard was
  considered (new route/page). Rejected as unnecessary complexity for a project whose UI is a
  static-exported single page (Constitution V: frontend stays a Next.js static export, no new
  routes) and whose existing Settings panel already works well as a set of cards.

## 3. How does the UI decide which choice to show by default?

- **Decision**: Derive it from the already-saved `llm.baseUrl`, no new stored field. If
  `llm.baseUrl` is unset, show both options with neither pre-selected as "in progress" (first
  run). If `llm.baseUrl` is set and matches Kenari's known endpoint, default to the Kenari
  branch (so re-opening Settings shows what's active). If `llm.baseUrl` is set and does not
  match Kenari's endpoint, default to "Use a different provider" and show the saved values —
  this is what already happens today, unchanged, for every existing user who already has a
  non-Kenari `llm.baseUrl` saved (FR-008: untouched).
- **Rationale**: Keeps the "connection" entity exactly as it already exists (`llm.*` setting
  rows); the Kenari/custom distinction is a view-layer classification of existing data, not new
  data. Matches the spec's Assumptions ("Skipping Kenari and leaving the general provider form
  blank is a valid end state").
- **Alternatives considered**: Persist an explicit `llm.provider: "kenari" | "custom"` field.
  Rejected for the same reason as §1 — recoverable from existing data, so storing it would be a
  second source of truth that could drift from the actual `baseUrl` (e.g. after a manual edit).

## 4. How does the CLI expose the same choice?

- **Decision**: Two already-distinct CLI paths stay distinct and both satisfy FR-012 without
  new flags:
  - **Non-interactive / scriptable**: `sorot connect llm --base-url <url> --model <m> --key -`
    (`cli/src/commands.ts:connectCmd`) already sets a general provider directly, with no Kenari
    step in between. No change needed here beyond leaving it alone.
  - **Interactive / guided**: `sorot connect setup` (`cli/src/social.ts:setupCmd`, the `llm`
    step in the `SETUP` array) gets one new prompt, asked only in that step, before the existing
    `baseUrl`/`model` field loop: a short choice between "Kenari" and "a different provider,"
    defaulting on an empty answer (Enter) to "a different provider" — i.e. today's existing
    field loop — so a user who just presses Enter through the wizard never sees or is asked for
    a Kenari key.
- **Rationale**: Matches the wizard's existing idiom ("Enter skips") and keeps the fast,
  scriptable path (used in CI/automation) completely unaffected, satisfying SC-003's "one CLI
  command" bar via the already-existing flag-driven command.
- **Alternatives considered**: Making `sorot connect llm` interactive by default when run with no
  flags. Rejected — it already has defined flag-only behavior (errors with "Nothing to change"
  if no flags are given) that other tooling may depend on; changing that is out of scope for US2
  and would be a larger, separate contract change.

## 5. Does this interact with FR-008 (don't overwrite an existing different provider)?

- **Decision**: Yes, directly — the same `baseUrl`-derived default (§3) naturally satisfies
  FR-008: a user who already has a non-Kenari `baseUrl` saved sees their own values by default
  on next visit, not a Kenari prompt, and nothing is written unless they explicitly submit a
  change (`ConnectionCard`'s existing dirty-check / `save(patchOf())` pattern already only PUTs
  changed fields).
- **Rationale**: No new "first run vs returning user" state is needed; `apply()` in
  `ConnectionSettings` (`backend/src/settings.ts:72-89`) already treats a saved field as
  authoritative over env/defaults, which is exactly the "don't silently replace" guarantee
  FR-008 asks for.
