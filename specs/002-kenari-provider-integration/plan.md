# Implementation Plan: Kenari as Default AI Provider — US2 (Skip Kenari or customize it)

**Branch**: `002-kenari-provider-integration` | **Date**: 2026-11-02 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-kenari-provider-integration/spec.md`, scoped to
**User Story 2** only (FR-004, FR-008, FR-012; SC-003). US1 (Kenari one-key onboarding, FR-001–
FR-003, FR-007) and US3 (docs acknowledgment, FR-010) are out of scope for this plan and are
planned separately.

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Make sure the project's AI provider connection flow (UI Settings and the CLI) never forces a
Kenari API key before a user can reach the existing general/custom OpenAI-compatible provider
form (base URL, model, key) — and never silently overwrites that general configuration once set.
Concretely: add a lightweight, un-gated choice ("Connect Kenari" vs "Use a different provider")
at the one entry point both paths share — the existing `llm` connection card in the frontend and
the `llm` step of the CLI's guided setup — defaulting to the general form when nothing is
answered, with zero new persisted fields or API contract changes.

## Technical Context

**Language/Version**: Bun/TypeScript (backend, cli — per `AGENTS.md` language boundary: no
Python, this is connection/settings logic, not media/ML); TypeScript/React, Next.js 14 static
export (frontend).

**Primary Dependencies**: `backend/src/settings.ts` (`ConnectionSettings`, the `CONNECTIONS.llm`
field map and `validate()`); `backend/src/llm.ts` (`Llm` client, unchanged);
`frontend/src/components/ConnectionsPanel.tsx` (`ConnectionCard` for `kind: 'llm'`);
`cli/src/social.ts` (`SETUP` array and `setupCmd`, the guided `sorot connect setup` wizard's
`llm` step); `cli/src/commands.ts` (`connectCmd`, the flag-driven `sorot connect llm` command);
`cli/src/prompt.ts` (`ask`, for the new choice prompt).

**Storage**: Existing SQLite `setting` table rows under the `llm.*` key namespace (`llm.enabled`,
`llm.baseUrl`, `llm.model`, `llm.apiKey`, `llm.director`, …), already defined in
`CONNECTIONS.llm` (`backend/src/settings.ts:24-28`). No schema change, no new table, no
migration — US2 adds a presentation-layer choice in front of fields that already exist and
already accept a general provider with no Kenari involvement.

**Testing**: `backend/tests/social.test.ts` (Bun test — existing LLM/Jev/Tebar connection
coverage); `frontend/src/components/__tests__/social.test.tsx` (Jest + Testing Library, covers
`ConnectionsPanel`); `cli/tests/social.test.ts` and `cli/tests/commands.test.ts` (Bun test, cover
`setupCmd` and `connectCmd`). New behavior is added as table rows in these existing suites, per
the project's "one test per behaviour, shared fakes" rule — no new test files.

**Target Platform**: Unchanged — same-origin web UI served by the backend in production; CLI
binary (`cli/dist/sorot`); local-first, host-ready (Constitution I).

**Project Type**: Existing Bun workspace web-service + CLI (`backend/`, `frontend/`, `cli/`) — no
new project, no new top-level directory.

**Performance Goals**: N/A — a presentation/flow change only; no new network calls beyond the
existing `GET /api/settings` / `PUT /api/settings/llm` / `POST /api/settings/llm/test` already
used by this card and command.

**Constraints**: Must not change the `PUT /api/settings/llm` request/response contract
(Constitution V — stable contracts; see `docs/api-spec.md` §`PUT /api/settings/{llm|jev|tebar}`).
Must never require, try, or reject a Kenari key before the general form is reachable (FR-012).
Must never overwrite an already-configured different provider's `baseUrl`/`model`/`apiKey`
without an explicit user action (FR-008).

**Scale/Scope**: One active LLM connection per install (existing design, unchanged). US2 touches
only the entry-point/presentation layer in front of the already-existing general-provider fields;
it does not touch the Kenari-specific onboarding fields or the Generate wiring (US1).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Check | Result |
|---|---|---|
| I. Local-First, Host-Ready | Skipping Kenari keeps clipping fully offline-capable; no host assumption added; UI stays same-origin. | **Pass** |
| II. Language Boundaries | All changed code is Bun/TypeScript (`backend/`, `cli/`) or TS/React (`frontend/`). No Python touched — this is connection/settings logic, not media/ML. | **Pass** |
| III. Test Gate | New branches (skip/choice affordance) must land as new rows in the existing `backend/tests/social.test.ts`, `frontend/.../social.test.tsx`, `cli/tests/social.test.ts`/`commands.test.ts` suites, keeping 95% coverage and 100% pass. | **Pass (must keep)** |
| IV. Optional AI, Rules Fallback | Directly reinforced: `llm.enabled` stays derived from whether `baseUrl`+`model` are actually set (`ConnectionSettings.view().active`), so "skip everything" still falls back to rules (FR-006). | **Pass** |
| V. Stable Contracts | No new endpoint, no breaking change to `PUT /api/settings/llm` or its JSON shape in `docs/api-spec.md`. The choice is UI/CLI-only, not a wire contract change. | **Pass** |
| VI. Safe Publishing | Not applicable — no publishing path touched. | **N/A** |

No violations. Complexity Tracking table is not needed.

## Project Structure

### Documentation (this feature)

```text
specs/002-kenari-provider-integration/
├── spec.md
├── plan.md               # This file (US2 scope)
├── research.md           # Phase 0 output
├── data-model.md         # Phase 1 output
├── quickstart.md         # Phase 1 output
├── contracts/            # Phase 1 output
└── checklists/requirements.md
```

### Source Code (repository root)

No new projects or directories. US2 is a narrow change inside the project's existing web-service
+ CLI workspace:

```text
backend/
├── src/
│   └── settings.ts               # CONNECTIONS.llm field map, ConnectionSettings.update/view —
│                                  # unchanged contract; may gain a small helper to tell whether
│                                  # a saved llm.baseUrl is Kenari's, for UI default-selection only
└── tests/
    └── social.test.ts            # existing LLM/Jev/Tebar connection coverage — add rows here

frontend/
└── src/
    └── components/
        ├── ConnectionsPanel.tsx  # the `llm` ConnectionCard — add the Kenari/"different
        │                         # provider" choice above the existing baseUrl/model/apiKey
        │                         # fields, which stay exactly as they are
        └── __tests__/
            └── social.test.tsx   # existing ConnectionsPanel coverage — add rows here

cli/
└── src/
    ├── social.ts                 # SETUP array's `llm` step + setupCmd — insert the choice
    │                              # prompt before the existing field loop, default = skip to
    │                              # the general form
    ├── commands.ts                # connectCmd / `sorot connect llm --base-url … --model … --key …`
    │                              # already bypasses any wizard — confirm it stays untouched
    └── prompt.ts                  # ask() reused for the new choice prompt
└── tests/
    ├── social.test.ts
    └── commands.test.ts
```

**Structure Decision**: Reuse the existing single `llm` connection surface in both the frontend
(`ConnectionsPanel`'s `llm` card) and the CLI (`social.ts`'s `SETUP` wizard step plus
`commands.ts`'s flag-driven command). US2 adds one small branch point to each, not a new surface,
new page, or new command — keeping the general-provider path exactly as it already behaves today
(it already requires no Kenari involvement) and only making sure a future Kenari-first entry
point (US1) cannot grow in front of it as a gate.

## Complexity Tracking

*Not applicable — no Constitution Check violations.*

## Post-Design Constitution Re-Check

Phase 0/1 design (`research.md`, `data-model.md`, `contracts/llm-connection.md`) introduced no
new entity, no new endpoint, and no schema change — it only adds a derived, non-persisted `mode`
view and a client-side choice prompt in front of the existing `llm` connection. All six gates in
the table above still hold exactly as evaluated pre-design; none newly apply or newly fail.
