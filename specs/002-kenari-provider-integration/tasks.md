---

description: "Task list for Kenari as Default AI Provider (US1 + US2 + US3)"
---

# Tasks: Kenari as Default AI Provider

**Input**: Design documents from `/specs/002-kenari-provider-integration/`
(`plan.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`)

**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Scope**: Supersedes the earlier US2-only task list. Covers all three user stories in priority
order: **US1** (P1 — connect with just an API key), **US2** (P2 — skip Kenari or customize it),
**US3** (P3 — credit Kenari's support).

**Tests**: Included as table-row additions to the project's existing test suites, per
`AGENTS.md`'s gate ("one test per behaviour... a new case is a table row... before it is a new
test") — not a separate TDD red/green phase. No new test files are created.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: User story this task belongs to — `[US1]`, `[US2]`, `[US3]`
- File paths are exact, from `plan.md`'s Project Structure

## Phase 1: Setup

*No setup tasks.* No new dependency, package, route-level scaffolding, or project is introduced.
Every task below modifies a file already wired into the existing Bun workspace (`backend/`,
`frontend/`, `cli/`) or a root documentation file. `bun install` at the repo root already covers
everything needed.

## Phase 2: Foundational

*No foundational/blocking tasks.* US1, US2, and US3 touch the same `llm` connection surface but
are independently addable branches/content on it, not a shared prerequisite layer — the existing
`llm.*` settings fields and `PUT /api/settings/llm` contract they all build on already exist
unchanged (`contracts/llm-connection.md`). Each story's own first task sets up what only that
story needs.

---

## Phase 3: User Story 1 - Connect with just an API key (Priority: P1) 🎯 MVP

**Goal**: A user turns on AI-assisted director/review/post-copy (and, by construction, Generate's
director — `research.md` §9) by pasting one Kenari API key, in the UI or the CLI, picking a model
from Kenari's live catalog (or accepting the pre-selected `kenari/auto` default) — no endpoint to
type, no guesswork about whether the key works before saving.

**Independent Test**: Enter only a valid Kenari API key (UI or CLI) on a machine with no prior AI
configuration; confirm the model list loads, the key validates before saving, and
`GET /api/settings` afterward shows `llm.active: true` with Kenari's base URL. Repeat with an
invalid key and confirm a clear error, nothing saved.

### Implementation for User Story 1 — Backend (`settings.ts`, `app.ts`)

- [X] T001 [US1] Add `KENARI_BASE_URL = "https://kenari.id/v1"` and `KENARI_DEFAULT_MODEL = "kenari/auto"` constants in `backend/src/settings.ts`, per `data-model.md`'s "connection mode" and "Kenari Model Catalog" sections.
- [X] T002 [US1] Add an injected `fetchFn: typeof fetch = fetch` (and reuse the existing `retryWaitMs` convention) to `ConnectionSettings`'s constructor in `backend/src/settings.ts`, and pass the same `httpFetch`/`deps.retryWaitMs` already used for `new Llm(config, httpFetch, deps.retryWaitMs)` (`backend/src/app.ts:60`) into `new ConnectionSettings(...)` at its construction site in `backend/src/app.ts` — required so `probe()` (T003) never makes a real network call under test, per Constitution III and `research.md` §8's "New testability requirement". Depends on T001.
- [X] T003 [US1] Implement `ConnectionSettings.probe(candidate: { baseUrl?: string; model: string; apiKey: string }): Promise<TestResult>` in `backend/src/settings.ts`: validate `model` (`text`, ≤ 300 chars) and `apiKey` (`secret`, no whitespace, ≤ 500 chars) with the existing `validate()` helper (400 on failure); build a throwaway `Llm` instance from `{ llmBaseUrl: candidate.baseUrl ?? KENARI_BASE_URL, llmModel: candidate.model, llmApiKey: candidate.apiKey, llmTimeoutSec: this.config.llmTimeoutSec }` using the injected `fetchFn`/`retryWaitMs` from T002; call `.chat([{ role: 'user', content: 'Reply with the single word OK.' }], { temperature: 0 })` exactly as `test()`'s existing `llm` branch does; return `{ ok: true, ms, model: candidate.model, detail }` or `{ ok: false, ms, error }` from a caught `LlmError`, per `contracts/llm-probe.md`. Never persists, never echoes `apiKey` back. Depends on T002.
- [X] T004 [US1] Implement `ConnectionSettings.kenariModels(): Promise<{ models: { id: string; free: boolean }[]; warning?: string }>` in `backend/src/settings.ts`: `fetch(`${KENARI_BASE_URL}/models`)` via the injected `fetchFn` (no key needed — Kenari's `GET /v1/models` is public), map each catalog entry to `{ id, free: !!entry.pricing?.free }`; on any fetch/parse failure, return `{ models: [], warning: <short message> }` rather than throwing, per `contracts/kenari-models.md`'s "Error handling". Depends on T001, T002.
- [X] T005 [US1] Wire `GET /api/settings/llm/kenari-models` → `ok(await settings.kenariModels())` and `POST /api/settings/llm/probe` → `ok(await settings.probe(await c.body()))` in `backend/src/app.ts`, next to the existing `/api/settings*` routes (`app.ts:157-160`). Depends on T003, T004.
- [X] T006 [US1] Add rows to `backend/tests/social.test.ts` (fake `fetchFn` injected per Constitution III, consistent with existing `Llm`/`Jev`/`Tebar` fakes in `backend/tests/helpers.ts`): (a) `probe()` with a candidate that gets an OK chat reply returns `{ ok: true, model, detail }`; (b) `probe()` with a candidate that gets a 401 returns `{ ok: false, error }` and nothing is written to the `setting` table; (c) `probe()` with a missing `model`/`apiKey` returns 400; (d) `kenariModels()` maps a fake `/v1/models` response to `{ models: [{id, free}, …] }`; (e) `kenariModels()` on a fetch failure returns `{ models: [], warning }` instead of throwing. Depends on T003, T004, T005.

### Implementation for User Story 1 — Frontend (`ConnectionsPanel.tsx`, `lib/api.ts`)

- [X] T007 [P] [US1] Add `getKenariModels()` (`GET /api/settings/llm/kenari-models`) and `probeLlm(candidate: { model: string; apiKey: string })` (`POST /api/settings/llm/probe`) methods to `ApiClient` in `frontend/src/lib/api.ts`, mirroring the existing `getSettings()`/`updateSettings()`/`testConnection()` methods (`api.ts:183-194`).
- [X] T008 [US1] In the `llm` `ConnectionCard`'s Kenari branch (`frontend/src/components/ConnectionsPanel.tsx` — the sibling of US2's "Use a different provider" branch), call `api.getKenariModels()` on selecting Kenari, render a model `<select>` populated from the result with `kenari/auto` pre-selected (falling back to a typed `kenari/auto` option if the fetch returned a `warning`/empty list), and an API key input. Depends on T007.
- [X] T009 [US1] Wire a "Test key" action in the Kenari branch that calls `api.probeLlm({ model: selectedModel, apiKey })`, shows the same success/error rendering the card already uses for `test`/`error` (`ConnectionCard`'s existing `test`/`error` state), and only enables "Save" once the probe succeeds; "Save" then calls the existing `save(patchOf())` → `PUT /api/settings/llm` with `{ baseUrl: KENARI_BASE_URL, model: selectedModel, apiKey }` — no new save path. Depends on T008.
- [X] T010 [US1] Add rows to `frontend/src/components/__tests__/social.test.tsx`: (a) selecting the Kenari branch fetches and shows the model list with `kenari/auto` pre-selected; (b) entering a key and testing it calls `probeLlm` and renders success; (c) a failed probe shows the error and leaves "Save" disabled; (d) saving after a successful probe calls `updateSettings('llm', { baseUrl: KENARI_BASE_URL, model, apiKey })`. Depends on T007, T008, T009.

### Implementation for User Story 1 — CLI (`api.ts`, `social.ts`, `commands.ts`)

- [X] T011 [P] [US1] ~~Add `getKenariModels()` and `probeLlm(candidate)` methods to the `Api` class~~ — adapted: `cli/src/api.ts`'s `Api` class is intentionally generic (`get`/`post`/`put`, no domain methods anywhere in the CLI, unlike the frontend's `ApiClient`); `social.ts`/`commands.ts` call `d.api.get("/api/settings/llm/kenari-models")` / `d.api.post("/api/settings/llm/probe", …)` directly, matching every other settings call in this file (e.g. `d.api.post(\`/api/settings/${kind}/test\`)`). No change to `cli/src/api.ts` was needed.
- [X] T012 [US1] In `setupCmd`'s `llm` step (`cli/src/social.ts`), implement the "kenari" branch of the choice prompt added for US2 (T0xx below): fetch `getKenariModels()`, ask for the API key via `ask(..., true)` (`cli/src/prompt.ts`), call `probeLlm({ model: KENARI_DEFAULT_MODEL or a user-picked id, apiKey })`, report the result the same way the step already reports `test()` results, then `PUT /api/settings/llm` with `{ baseUrl: KENARI_BASE_URL, model, apiKey }` on success. Depends on T011.
- [X] T013 [US1] Add a `--kenari` flag to `connectCmd`'s `llm` handling in `cli/src/commands.ts` (`sorot connect llm --kenari --key -`): defaults `baseUrl` to `KENARI_BASE_URL` and `model` to `KENARI_DEFAULT_MODEL` unless `--model` is also given, calls `probeLlm` then `PUT /api/settings/llm`, entirely non-interactively — mirrors the existing `--base-url`/`--model`/`--key` flag path. Depends on T011.
- [X] T014 [US1] Add rows to `cli/tests/social.test.ts` (the `setupCmd` `llm` step's kenari branch: key → fetched models → probe → save) and `cli/tests/commands.test.ts` (`sorot connect llm --kenari --key -` completes non-interactively and PUTs the expected body). Depends on T012, T013.

**Checkpoint**: User Story 1 is fully functional and independently testable — a fresh install can go from nothing to Kenari-backed AI assistance with one key, in the UI or the CLI, with a clear pre-save validation step.

---

## Phase 4: User Story 2 - Skip Kenari or customize it (Priority: P2)

**Goal**: A user can reach and fully use the existing general/custom AI provider form (base URL,
model, API key) directly, in one click or one CLI step, without ever entering, trying, or
rejecting a Kenari key — and an already-configured different provider is never silently
overwritten.

**Independent Test**: (a) Open the connection flow (UI or CLI) with no `llm.baseUrl` saved,
choose "a different provider," and confirm AI assistance turns on using only that provider's
values with no Kenari key involved. (b) With a non-Kenari `llm.baseUrl` already saved, reopen the
flow and confirm the saved values are shown unchanged, not a Kenari prompt.

### Implementation for User Story 2 — Frontend (`ConnectionsPanel.tsx`)

- [X] T015 [P] [US2] Add a `connectionMode(baseUrl: string): 'unset' | 'kenari' | 'custom'` helper in `frontend/src/components/ConnectionsPanel.tsx`, using the `KENARI_BASE_URL` constant (T007's package can reuse T001's value via a shared literal, since frontend and backend share no runtime module): empty `baseUrl` → `"unset"`; equal to `KENARI_BASE_URL` → `"kenari"`; else → `"custom"`, per `data-model.md`'s mode table.
- [X] T016 [US2] In the `llm` `ConnectionCard`, add a two-option choice ("Connect Kenari" / "Use a different provider") rendered above the existing `baseUrl`/`model`/`apiKey` fields, initialized from `connectionMode(view.baseUrl)` (T015) so a returning user with a saved non-Kenari `baseUrl` lands on "Use a different provider" by default (FR-008), while a first-run user (`"unset"`) sees both options with neither pre-selected. Depends on T015.
- [X] T017 [US2] Wire "Use a different provider" to reveal exactly the card's existing `baseUrl`/`model`/`apiKey` fields unchanged, confirming `save(patchOf())` still PUTs only the fields the user actually edited to `PUT /api/settings/llm` — no Kenari-specific field is ever added (FR-012; `contracts/llm-connection.md` "Non-goals"). Depends on T016.
- [X] T018 [US2] Add rows to `frontend/src/components/__tests__/social.test.tsx` for the `llm` card: (a) with `view.baseUrl` empty, "Use a different provider" is reachable with no API key input required before the existing fields appear; (b) with `view.baseUrl` set to a non-Kenari URL, the card renders directly with those saved values, not the choice screen; (c) saving the general-provider fields sends only `baseUrl`/`model`/`apiKey` keys. Depends on T015, T016, T017.

### Implementation for User Story 2 — CLI (`social.ts`, `commands.ts`, `prompt.ts`)

- [X] T019 [P] [US2] Add a `connectionMode(baseUrl: string)` helper in `cli/src/social.ts`, mirroring T015.
- [X] T020 [US2] In `setupCmd`'s loop over `SETUP` (`cli/src/social.ts`), for the `llm` step only, insert one new choice question via `ask()` (`cli/src/prompt.ts`) before the existing field loop: pressing Enter (empty answer) proceeds straight into that existing `baseUrl`/`model` field loop unchanged; typing "kenari" invokes US1's branch (T012). Depends on T019.
- [X] T021 [US2] Add rows to `cli/tests/social.test.ts` for `setupCmd`'s `llm` step: (a) answering Enter at the new choice prompt proceeds directly to the existing `Base URL`/`Model`/API-key questions with no Kenari key requested; (b) the resulting `PUT /api/settings/llm` call carries only the fields the existing `llm` step already sends. Depends on T019, T020.
- [X] T022 [US2] Add a row to `cli/tests/commands.test.ts` confirming `sorot connect llm --base-url <url> --model <m> --key -` still completes non-interactively in one call, unaffected by the new `setupCmd` prompt (T020) or the new `--kenari` flag (T013) — the SC-003 "one CLI command" regression check. Depends on T020.

**Checkpoint**: User Stories 1 AND 2 both work independently — Kenari onboarding and the general-provider skip path co-exist on the same `llm` card/step without either blocking the other.

---

## Phase 5: User Story 3 - Credit Kenari's support (Priority: P3)

**Goal**: The project's public documentation acknowledges Kenari's support grant, with a link to
kenari.id, landing in the same change that ships the integration.

**Independent Test**: Read `README.md` and `CHANGELOG.md` and find a short, linked acknowledgment
of Kenari's support.

### Implementation for User Story 3 — Docs

- [X] T023 [P] [US3] Add a short line crediting Kenari's support, linking to kenari.id, in `README.md` near the existing "🤖 Optional LLM" feature-table row or the intro paragraph's "Jev, an LLM and Tebar are optional online extras" sentence, per `research.md` §11.
- [X] T024 [P] [US3] Add an entry under the existing `## [Unreleased]` section of `CHANGELOG.md`, matching the style of the current feature entries (e.g. `### Generate: briefs to finished 2D videos`), describing the Kenari integration (US1 one-key onboarding, US2 general-provider path) and the acknowledgment together.

**Checkpoint**: All three user stories are independently functional — Kenari onboarding, the general-provider skip path, and the public acknowledgment.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T025 [P] Walk through `specs/002-kenari-provider-integration/quickstart.md`'s UI and CLI validation steps for all three stories, plus the "Generate also defaults to Kenari" check (no separate setup needed, per `research.md` §9), end-to-end against a running local backend; note any deviation. Depends on T006, T010, T014, T018, T021, T022, T023, T024.
- [X] T026 Run the full gate and confirm 100% pass, ≥95% line/function coverage, zero type errors: `cd backend && bun test --coverage && bun run typecheck`; `cd frontend && bun run test`; `cd cli && bun test --coverage` (Constitution III — non-negotiable). Depends on T025.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: None — empty, nothing to start.
- **Foundational (Phase 2)**: None — empty, nothing blocks any user story.
- **User Story 1 (Phase 3)**: Can start immediately. Highest priority (P1) — MVP.
- **User Story 2 (Phase 4)**: Can start immediately, independent of US1's completion, but its CLI choice prompt (T020) is the entry point into US1's CLI branch (T012) once both exist — see "Within/Across Stories" below.
- **User Story 3 (Phase 5)**: Can start immediately, fully independent (docs-only).
- **Polish (Phase 6)**: Depends on all three stories being complete.

### Within User Story 1

- Backend: T001 → T002 → {T003, T004} → T005 → T006.
- Frontend: T007 → T008 → T009 → T010 (T007 can start in parallel with the backend track; T008 needs T005's routes live to call against in a real run, though tests (T010) use fakes).
- CLI: T011 → T012 / T013 → T014 (T011 can start in parallel with backend/frontend tracks).

### Within User Story 2

- Frontend: T015 → T016 → T017 → T018.
- CLI: T019 → T020 → {T021, T022}.

### Across Stories

- T020 (US2's CLI choice prompt, "type kenari to branch") and T012 (US1's kenari branch
  implementation) touch the same function in `cli/src/social.ts` — implement T012 before or
  alongside T020 to avoid rework, even though they're in different story phases. The frontend
  equivalent has no such ordering constraint: T008/T009 (US1's Kenari branch) and T016/T017
  (US2's "different provider" branch) are separate conditional branches inside the same card and
  can be built in either order.
- T022 (US2's regression check) also guards against T013 (US1's new `--kenari` flag) leaking
  into the existing flag-only command — written after both T013 and T020 exist.

### Parallel Opportunities

- T001/T007/T011 (the three per-package starting points — backend constants, frontend API
  methods, CLI API methods) can all run in parallel.
- T015 and T019 (US2's frontend/CLI mode helpers) can run in parallel with each other and with
  US1's tasks, since they touch different files.
- T023 and T024 (US3, docs-only) can run in parallel with everything — no code dependency at all.

---

## Parallel Example: Starting All Three Stories Together

```bash
# Kick off each story's independent starting point at once:
Task: "Add KENARI_BASE_URL/KENARI_DEFAULT_MODEL constants in backend/src/settings.ts"              # T001 [US1]
Task: "Add connectionMode() helper in frontend/src/components/ConnectionsPanel.tsx"                 # T015 [US2]
Task: "Add a Kenari acknowledgment line in README.md"                                               # T023 [US3]

# Once T001/T002 land, the three US1 tracks fan out:
Task: "Implement ConnectionSettings.probe() in backend/src/settings.ts"                             # T003
Task: "Add getKenariModels()/probeLlm() to ApiClient in frontend/src/lib/api.ts"                     # T007
Task: "Add getKenariModels()/probeLlm() to Api in cli/src/api.ts"                                    # T011
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Confirm Phase 1/2 are empty (nothing to build first).
2. Complete Phase 3 (US1): backend probe/model-catalog endpoints, frontend Kenari branch, CLI
   Kenari branch.
3. **STOP and VALIDATE**: run the US1 portion of `quickstart.md` and the full test gate.
4. Ship — a user can already connect Kenari with one key. US2 (skip/customize) and US3
   (acknowledgment) are valuable but not required for this to be useful.

### Incremental Delivery

1. Phase 3 (US1) → validate → ship (MVP: Kenari onboarding works).
2. Phase 4 (US2) → validate → ship (the general-provider path stays fully reachable alongside it).
3. Phase 5 (US3) → ship (docs credit lands, typically bundled with whichever of the above merges
   first, since it has no code dependency).
4. Phase 6 (Polish): full quickstart + gate run once all three are in.

### Parallel Team Strategy

With three people/agents: one takes US1 (the largest story — backend + frontend + CLI), one takes
US2, one takes US3. Coordinate only on the two points noted under "Across Stories" above
(`cli/src/social.ts`'s `llm` step, and the US2 regression check T022).

---

## Notes

- [P] tasks touch different files with no unmet dependency.
- No new persisted fields; two new, purely additive backend routes
  (`GET /api/settings/llm/kenari-models`, `POST /api/settings/llm/probe`) — see
  `contracts/kenari-models.md` and `contracts/llm-probe.md`.
- Commit after each task or logical group, per repository convention.
- Stop at each phase checkpoint to validate that story independently before moving to the next.
