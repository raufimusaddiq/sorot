---

description: "Task list for User Story 2 — Skip Kenari or customize it"
---

# Tasks: Kenari as Default AI Provider — User Story 2 (Skip Kenari or customize it)

**Input**: Design documents from `/specs/002-kenari-provider-integration/`
(`plan.md`, `research.md`, `data-model.md`, `contracts/llm-connection.md`, `quickstart.md`)

**Prerequisites**: plan.md (required, scoped to US2), spec.md (required for user story), research.md, data-model.md, contracts/

**Scope**: This plan and its tasks cover **User Story 2 only** (FR-004, FR-008, FR-012; SC-003).
User Story 1 (Kenari one-key onboarding) and User Story 3 (docs acknowledgment) are **not**
included — they need their own `/speckit-plan` pass before tasks can be generated for them, since
this plan's design documents (`research.md`, `data-model.md`, `contracts/`) were scoped only to
US2 by the preceding `/speckit-plan US2` run.

**Tests**: Included as table-row additions to the project's existing test suites, per
`AGENTS.md`'s gate ("one test per behaviour... a new case is a table row... before it is a new
test") — not a separate TDD red/green phase. No new test files are created.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: User story this task belongs to — all tasks below are `[US2]`
- File paths are exact, from `plan.md`'s Project Structure

## Phase 1: Setup

*No setup tasks.* This feature adds no new dependency, package, route, or scaffolding — it
modifies three files already wired into the existing Bun workspace (`frontend/src/components/
ConnectionsPanel.tsx`, `cli/src/social.ts`, `cli/src/commands.ts`) plus their existing test
files. `bun install` at the repo root already covers everything needed.

## Phase 2: Foundational

*No foundational/blocking tasks.* The `llm` connection contract (`GET /api/settings`,
`PUT /api/settings/llm`, `POST /api/settings/llm/test`) and its SQLite-backed `llm.*` fields
already exist and are unchanged by this plan (`contracts/llm-connection.md`, `data-model.md`).
User Story 2's tasks can start immediately — there is no shared infrastructure to build first.

---

## Phase 3: User Story 2 - Skip Kenari or customize it (Priority: P2)

**Goal**: A user can reach and fully use the existing general/custom AI provider form (base URL,
model, API key) directly, in one click or one CLI step, without ever entering, trying, or
rejecting a Kenari key — and an already-configured different provider is never silently
overwritten.

**Independent Test**: (a) Open the connection flow (UI or CLI) with no `llm.baseUrl` saved,
choose "a different provider," and confirm AI assistance turns on using only that provider's
values with no Kenari key involved. (b) With a non-Kenari `llm.baseUrl` already saved, reopen the
flow and confirm the saved values are shown unchanged, not a Kenari prompt.

### Implementation for User Story 2 — Frontend (`ConnectionsPanel.tsx`)

- [ ] T001 [P] [US2] Add a `KENARI_BASE_URL` constant and a `connectionMode(baseUrl: string): 'unset' | 'kenari' | 'custom'` helper in `frontend/src/components/ConnectionsPanel.tsx`, implementing the mode table in `data-model.md` ("Derived, non-persisted concept: connection mode"): empty `baseUrl` → `"unset"`; `baseUrl` equal to `KENARI_BASE_URL` → `"kenari"`; anything else → `"custom"`.
- [ ] T002 [US2] In the `llm` `ConnectionCard` (`frontend/src/components/ConnectionsPanel.tsx`), add a two-option choice ("Connect Kenari" / "Use a different provider") rendered above the existing `baseUrl`/`model`/`apiKey` fields, initialized from `connectionMode(view.baseUrl)` via T001 so a returning user with a saved non-Kenari `baseUrl` lands on "Use a different provider" by default (FR-008), while a first-run user (`"unset"`) sees both options with neither pre-selected. Depends on T001.
- [ ] T003 [US2] Wire "Use a different provider" to reveal exactly the card's existing `baseUrl`/`model`/`apiKey` fields unchanged, and confirm `save(patchOf())` still PUTs only the fields the user actually edited to `PUT /api/settings/llm` — no Kenari-specific field is ever added to the request body (FR-012; `contracts/llm-connection.md` "Non-goals for US2"). Depends on T002.
- [ ] T004 [US2] Add rows to `frontend/src/components/__tests__/social.test.tsx` for the `llm` card: (a) with `view.baseUrl` empty, "Use a different provider" is reachable and selecting it requires no API key input of any kind before the existing fields appear; (b) with `view.baseUrl` set to a non-Kenari URL, the card renders directly with those saved values on mount, not the choice screen; (c) saving the general-provider fields calls `api.updateSettings('llm', patch)` with only `baseUrl`/`model`/`apiKey` keys present in `patch`. Depends on T001, T002, T003.

### Implementation for User Story 2 — CLI (`social.ts`, `commands.ts`, `prompt.ts`)

- [ ] T005 [P] [US2] Add the same `KENARI_BASE_URL` constant and a `connectionMode(baseUrl: string)` helper in `cli/src/social.ts`, mirroring T001 (duplicated per `plan.md`'s Structure Decision — `frontend` and `cli` share no runtime module).
- [ ] T006 [US2] In `setupCmd`'s loop over `SETUP` (`cli/src/social.ts`), for the `llm` step only, insert one new choice question via `ask()` (`cli/src/prompt.ts`) before the existing `for (const [field, question, fallback] of step.fields)` loop: pressing Enter (empty answer) proceeds straight into that existing field loop unchanged, asking nothing Kenari-related. Depends on T005.
- [ ] T007 [US2] Add rows to `cli/tests/social.test.ts` for `setupCmd`'s `llm` step: (a) answering Enter at the new choice prompt proceeds directly to the existing `Base URL`/`Model`/API-key questions with no Kenari key requested; (b) the resulting `PUT /api/settings/llm` call carries only the fields the existing `llm` step already sends (`baseUrl`, `model`, `apiKey`), confirming no Kenari-specific field was added. Depends on T005, T006.
- [ ] T008 [US2] Add a row to `cli/tests/commands.test.ts` confirming `sorot connect llm --base-url <url> --model <m> --key -` (`cli/src/commands.ts`'s `connectCmd`) still completes non-interactively in one call, unaffected by the new `setupCmd` prompt from T006 — this is the SC-003 "one CLI command" regression check. Depends on T006.

**Checkpoint**: User Story 2 is fully functional and independently testable — both the UI card and the CLI wizard let a user skip straight to the general provider form, and the flag-driven CLI command is untouched.

---

## Phase 4: Polish & Cross-Cutting Concerns

- [ ] T009 [P] Walk through `specs/002-kenari-provider-integration/quickstart.md`'s UI and CLI validation steps (Scenarios 1, 3, 4) end-to-end against a running local backend, and note any deviation. Depends on T004, T007, T008.
- [ ] T010 Run the full gate and confirm 100% pass, ≥95% line/function coverage, zero type errors: `cd backend && bun test --coverage && bun run typecheck`; `cd frontend && bun run test`; `cd cli && bun test --coverage` (Constitution III — non-negotiable). Depends on T009.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: None — empty, nothing to start.
- **Foundational (Phase 2)**: None — empty, nothing blocks User Story 2.
- **User Story 2 (Phase 3)**: Can start immediately.
- **Polish (Phase 4)**: Depends on Phase 3 being complete.

### Within User Story 2

- Frontend track: T001 → T002 → T003 → T004.
- CLI track: T005 → T006 → {T007, T008} (T007 and T008 both depend on T006 but not on each other).
- The frontend track and the CLI track touch entirely different files/packages and can proceed in parallel with each other.

### Parallel Opportunities

- T001 (frontend helper) and T005 (CLI helper) can run in parallel — different packages, no shared state.
- T007 and T008 can run in parallel once T006 is done — different test files.
- The whole frontend track (T001–T004) can run in parallel with the whole CLI track (T005–T008) if staffed by two people/agents.

---

## Parallel Example: User Story 2

```bash
# Start both tracks' foundation helpers together:
Task: "Add KENARI_BASE_URL + connectionMode() in frontend/src/components/ConnectionsPanel.tsx"   # T001
Task: "Add KENARI_BASE_URL + connectionMode() in cli/src/social.ts"                               # T005

# Once each track's prompt/choice work (T002-T003 / T006) lands, run its tests in parallel with the other track's tests:
Task: "Add social.test.tsx rows for the llm card's skip/default behavior"        # T004
Task: "Add social.test.ts + commands.test.ts rows for setupCmd's llm step"       # T007, T008
```

---

## Implementation Strategy

### Single increment (US2 is the whole scope of this plan)

1. Confirm Phase 1/2 are empty (nothing to build first).
2. Implement the frontend track (T001–T004) and CLI track (T005–T008), in parallel if staffed.
3. **STOP and VALIDATE**: run `quickstart.md`'s steps (T009) and the full test gate (T010).
4. Done — User Story 2 ships independently of User Story 1 and User Story 3, which are separately planned and tasked later.

---

## Notes

- [P] tasks touch different files with no unmet dependency.
- No new files, endpoints, or persisted fields are introduced anywhere in this task list — every
  task modifies an existing file named in `plan.md`'s Project Structure.
- Commit after each task or logical group, per repository convention.
- Stop at the Phase 3 checkpoint to validate User Story 2 independently before touching anything
  else.
