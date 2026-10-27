---
description: Run full integration test suite via test-runner sub-agent
---

# Run Integration Tests

Delegate to the **test-runner** sub-agent (defined in `.claude/agents/test-runner.md`) to execute the full test suite and produce a gate report.

Use the Agent tool with `subagent_type: "test-runner"` and pass `$ARGUMENTS` as additional context. Do not run the tests yourself.

## What happens:
1. The test-runner agent executes all 3 test suites:
   - AI Pipeline: `cd ai-pipeline && pytest --cov=. --cov-fail-under=95 -v`
   - Backend: `cd backend && bun test --coverage && bun run typecheck`
   - Frontend: `cd frontend && bun run test`
2. Produces a structured gate report with pass/fail/coverage
3. Gives a binary verdict: 🟢 GATE OPEN or 🔴 GATE BLOCKED

## Gate criteria:
- 100% test pass rate (0 failures, 0 skips)
- ≥95% coverage on all suites
- Zero compiler/type errors

## When to use:
- After `/execute` to validate your implementation
- After `/review` to confirm gate criteria pass
- Any time you need confidence the codebase is healthy
- Before committing final changes

## If gate is BLOCKED:
- Read the failure details in the report
- Fix the reported issues
- Run `/test` again to re-verify

$ARGUMENTS
