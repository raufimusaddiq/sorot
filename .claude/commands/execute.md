---
description: Execute a plan — write code, verify each step, run integration tests
argument-hint: <plan reference or feature>
---

# Execute Plan

Implement a previously planned set of changes, verifying each step and writing integration tests.

## Steps:

1. **Read the plan**: Understand the full scope before starting
2. **Implement step by step**: Make one logical change at a time
3. **Write integration tests FIRST or alongside**: Every new feature gets a test before moving on
4. **Verify after each step**: Run relevant commands to confirm correctness
5. **Update progress**: Mark completed steps in the plan
6. **Handle mismatches**: If reality differs from plan, stop and document the deviation
7. **Final gate**: Run `/test` to delegate to the test-runner sub-agent for a full gate report
8. **Write journal**: Log what was implemented, test results, any deviations. Do NOT expand memory blocks.

## Rules:
- Follow `docs/python-pipeline.md` interface contract for all Python scripts
- Follow `docs/api-spec.md` for all REST endpoints
- Follow `docs/data-model.md` for all DB schema changes
- Keep it personal-use simple; don't over-engineer
- Python scripts: exit 0 on success, non-zero on failure, JSON stdout envelope
- **Every code change must include an integration test**
- **KEEP MEMORY LEAN**: Write details to journal, not memory. Memory = compressed pointers only.

## Verification:
- After backend changes: `cd backend && bun test --coverage && bun run typecheck`
- After Python changes: `cd ai-pipeline && pytest --cov=. --cov-fail-under=95`
- After frontend changes: `cd frontend && bun run test`
- After full pipeline: test with a sample video

## Gate Criteria (must ALL pass before finishing):
- Run `/test` for the full gate report via test-runner sub-agent
- Test pass rate: **100%**
- Code coverage: **≥95%** on changed modules
- Zero compiler/type errors

$ARGUMENTS
