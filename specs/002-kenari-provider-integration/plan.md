# Implementation Plan: Kenari as Default AI Provider

**Branch**: `002-kenari-provider-integration` | **Date**: 2026-11-02 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-kenari-provider-integration/spec.md`, covering
all three user stories: **US1** (connect with just an API key: FR-001–FR-003, FR-007, FR-009;
SC-001), **US2** (skip Kenari or customize it: FR-004, FR-008, FR-012; SC-003), and **US3** (credit
Kenari's support: FR-010; SC-005). This supersedes the earlier US2-only plan from the previous
`/speckit-plan US2` run — that design is preserved below, now alongside US1 and US3.

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Make Kenari (`kenari.id`) the project's default AI provider with a one-field setup — paste an
API key, pick a model from Kenari's live catalog (or accept the pre-selected default), done —
while keeping the existing general/custom OpenAI-compatible provider path exactly as reachable
and un-gated as it is today (US2, already planned), and crediting Kenari's support grant in the
project's public docs (US3). Kenari is a genuine drop-in: it speaks the same OpenAI Chat
Completions shape (`POST /v1/chat/completions`, `Authorization: Bearer <key>`) the project's
single shared `Llm` client (`backend/src/llm.ts`) already calls, so the only new work is (a) a
small backend "probe" that validates a candidate key and (b) a proxy for Kenari's keyless model
catalog (`GET /v1/models`) — both reused for the one-key onboarding in the UI and CLI. Because
the project has exactly one `Llm` instance shared by clipping's director/review/copy and by
Generate's director (`backend/src/app.ts:60`, `backend/src/orchestrator.ts:54`,
`backend/src/generate/director.ts`), FR-009 ("Kenari becomes the shared default for both") is
satisfied by construction, with no extra wiring.

## Technical Context

**Language/Version**: Bun/TypeScript (backend, cli — per `AGENTS.md` language boundary: no
Python, this is connection/settings logic, not media/ML); TypeScript/React, Next.js 14 static
export (frontend). Documentation changes (US3) are Markdown (`README.md`, `CHANGELOG.md`).

**Primary Dependencies**:
- `backend/src/settings.ts` (`ConnectionSettings` — `CONNECTIONS.llm` field map, `validate()`,
  `update()`/`view()`/`test()`; gains a candidate-connection `probe()` and the Kenari
  model-catalog proxy).
- `backend/src/llm.ts` (`Llm` client — unchanged `chat()`/auth logic; its constructor already
  accepts any `{ llmBaseUrl, llmModel, llmApiKey, llmTimeoutSec }`-shaped config, which is what
  makes a throwaway "candidate" instance possible without touching this file).
- `backend/src/app.ts:60` (`new Llm(config, httpFetch, deps.retryWaitMs)` — the single shared
  instance; `backend/src/app.ts:157-160` — the `/api/settings*` routes, gain two more).
- `frontend/src/components/ConnectionsPanel.tsx` (`ConnectionCard` for `kind: 'llm'` — gains the
  Kenari branch: key input, fetched model picker; US2's "Use a different provider" branch stays
  as already planned).
- `cli/src/social.ts` (`SETUP` array's `llm` step, `setupCmd`) and `cli/src/commands.ts`
  (`connectCmd`, `sorot connect llm`) — gain the Kenari branch mirroring the frontend's.
- `cli/src/prompt.ts` (`ask`, reused for both the US2 choice prompt and US1's key/model prompts).
- `README.md` (feature table / "optional online extras" line) and `CHANGELOG.md`'s
  `## [Unreleased]` section — US3's acknowledgment.

**Storage**: Existing SQLite `setting` table rows under the `llm.*` key namespace
(`backend/src/settings.ts:24-28`) — `llm.enabled`, `llm.baseUrl`, `llm.model`, `llm.apiKey`,
`llm.director`, `llm.vision`, `llm.visionModel`, `llm.genLlmMaxTokens`. No schema change, no new
table, no migration: Kenari is just a value these fields can hold (`baseUrl =
https://kenari.id/v1`), exactly like any other OpenAI-compatible endpoint already supported.

**Testing**: `backend/tests/social.test.ts` (Bun test — LLM/Jev/Tebar connection coverage, gains
rows for `probe()` and the model-catalog route, with HTTP calls faked per Constitution III);
`frontend/src/components/__tests__/social.test.tsx` (Jest + Testing Library); `cli/tests/
social.test.ts` and `cli/tests/commands.test.ts` (Bun test). New behavior lands as table rows in
these existing suites — no new test files, per the project's compact-test rule.

**Target Platform**: Unchanged — same-origin web UI served by the backend in production; CLI
binary (`cli/dist/sorot`); local-first, host-ready (Constitution I). The one new outbound call
(fetching Kenari's model catalog, and the candidate-probe chat call) is itself an "optional online
extra" exactly like the existing LLM/Jev/Tebar calls — never required for clipping.

**Project Type**: Existing Bun workspace web-service + CLI (`backend/`, `frontend/`, `cli/`) — no
new project, no new top-level directory.

**Performance Goals**: N/A — onboarding-time calls only (model-list fetch, one validation chat
call), not on the clipping hot path. Kenari docs note responses over ~2 minutes should stream;
the existing `Llm` client already supports streaming (`llmStream`) for its real chat calls, which
covers director/review/copy/Generate once Kenari is configured — the onboarding probe call is a
short, non-streamed "reply OK" check (mirrors `ConnectionSettings.test()`'s existing LLM check).

**Constraints**: Must not change the existing `PUT /api/settings/llm` or `POST /api/settings/
llm/test` request/response shapes (Constitution V). New endpoints are additive only. Must never
require, try, or reject a Kenari key before the general form is reachable (FR-012, US2). Must
never overwrite an already-configured different provider without an explicit user action
(FR-008, US2). The API key must stay masked everywhere, including in any new probe/model-list
response (FR-005) — the new endpoints never echo the raw key back.

**Scale/Scope**: One active LLM connection per install (existing design, unchanged) — Kenari
replaces the *default* values a user starts from, not the mechanism. US3 is documentation-only,
no runtime behavior.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Check | Result |
|---|---|---|
| I. Local-First, Host-Ready | Kenari is optional like every existing LLM endpoint; clipping stays fully offline-capable with it unset (FR-006, inherited from the existing `Llm.enabled` guard). UI stays same-origin — new backend routes, no new frontend routes. | **Pass** |
| II. Language Boundaries | All changed code is Bun/TypeScript (`backend/`, `cli/`) or TS/React (`frontend/`), plus Markdown docs (US3). No Python touched — this is connection/settings logic, not media/ML. | **Pass** |
| III. Test Gate | New branches (probe, model-catalog proxy, onboarding UI/CLI flows, US2's choice) land as rows in the existing `social.test.ts` suites (backend/frontend/cli), with the new outbound HTTP calls injected/faked exactly like the existing `Llm`/`Jev`/`Tebar` test fakes (`backend/tests/helpers.ts`). | **Pass (must keep)** |
| IV. Optional AI, Rules Fallback | Reinforced: an unset or invalid Kenari connection leaves `Llm.enabled` false, so clipping and Generate both fall back to rules/unavailable exactly as they do today for any other unset LLM connection. | **Pass** |
| V. Stable Contracts | `PUT /api/settings/llm` and `POST /api/settings/llm/test` are untouched. Two new routes are purely additive (`GET /api/settings/llm/kenari-models`, `POST /api/settings/llm/probe`) and documented in `contracts/`. | **Pass** |
| VI. Safe Publishing | Not applicable — no publishing path touched. | **N/A** |

No violations. Complexity Tracking table is not needed.

## Project Structure

### Documentation (this feature)

```text
specs/002-kenari-provider-integration/
├── spec.md
├── plan.md               # This file (full feature: US1 + US2 + US3)
├── research.md           # Phase 0 output
├── data-model.md         # Phase 1 output
├── quickstart.md         # Phase 1 output
├── contracts/            # Phase 1 output
└── checklists/requirements.md
```

### Source Code (repository root)

No new projects or directories. The whole feature is a narrow addition inside the project's
existing web-service + CLI workspace:

```text
backend/
├── src/
│   ├── settings.ts          # CONNECTIONS.llm field map (unchanged shape); ConnectionSettings
│   │                         # gains probe(candidate) [US1] and the Kenari model-catalog fetch
│   │                         # [US1]; view()/update() stay exactly as they are [US2 unchanged]
│   ├── llm.ts                # Llm client — unchanged; its constructor shape is what makes a
│   │                         # throwaway "candidate" instance possible for probe() [US1]
│   └── app.ts                 # adds GET /api/settings/llm/kenari-models and
│                              # POST /api/settings/llm/probe next to the existing
│                              # /api/settings* routes (app.ts:157-160) [US1]
└── tests/
    └── social.test.ts        # add rows: probe() success/failure, model-catalog fetch,
                               # Kenari baseUrl defaulting [US1]; US2's rows as already planned

frontend/
└── src/
    └── components/
        ├── ConnectionsPanel.tsx  # the `llm` ConnectionCard gains the Kenari branch (key input
        │                         # + fetched model picker, default pre-selected) [US1], and the
        │                         # "Use a different provider" branch [US2, already planned]
        └── __tests__/
            └── social.test.tsx   # add rows for both branches

cli/
└── src/
    ├── social.ts              # SETUP array's `llm` step gains the "kenari" branch (key prompt,
    │                           # fetched model list, default) [US1]; the choice prompt and
    │                           # "skip to general form" default stay as already planned [US2]
    ├── commands.ts             # `sorot connect llm --kenari --key -` (or equivalent flag path)
    │                           # for non-interactive Kenari setup [US1]; existing
    │                           # `--base-url/--model/--key` path stays untouched [US2]
    └── prompt.ts               # ask(), reused by both branches
└── tests/
    ├── social.test.ts
    └── commands.test.ts

README.md                       # short Kenari support acknowledgment + link [US3]
CHANGELOG.md                    # entry under ## [Unreleased] for this feature, incl. the
                                 # acknowledgment [US3]
```

**Structure Decision**: One shared connection surface (the `llm` card/step/command) grows two
branches — Kenari (US1) and general/custom (US2, already planned) — plus two small, additive
backend routes that exist only to power Kenari onboarding (candidate validation, model listing).
No new page, no new top-level directory, no change to the existing `PUT /api/settings/llm`
contract. US3 is a pure documentation diff, reviewed and merged alongside the code change.

## Complexity Tracking

*Not applicable — no Constitution Check violations.*

## Post-Design Constitution Re-Check

Phase 0/1 design (`research.md`, `data-model.md`, `contracts/`) adds two new, purely additive
backend routes and no new persisted field, matching what the Technical Context already
anticipated. All six gates in the table above still hold exactly as evaluated pre-design; none
newly apply or newly fail. In particular: Constitution V (Stable Contracts) still passes because
the two new routes are additive, not a change to any existing route's shape, and Constitution IV
still passes because `probe()` reuses the same `LlmError` → clear-message path the existing
`test()` already relies on, with no new failure mode that could leak past the UI's existing
`error`/`test.error` rendering.
