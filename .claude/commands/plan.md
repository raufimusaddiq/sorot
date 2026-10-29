---
description: Plan implementation for a pipeline step
argument-hint: <pipeline step or feature>
---

# Plan Implementation

Create a focused implementation plan for a specific feature or pipeline step.

## Steps:

1. **Read research output** (if any prior research was done)
2. **Read relevant docs**: `docs/architecture.md`, `docs/api-spec.md`, `docs/data-model.md`, `docs/python-pipeline.md`, `docs/scoring-spec.md` as needed
3. **Identify exact files to create/modify** with specific changes
4. **Define verification steps**: How to confirm the implementation works
5. **Check for regressions**: Ensure changes don't break existing pipeline steps

## Rules:
- Follow the build order in AGENTS.md strictly — no skipping ahead
- All Python scripts must follow the contract in `docs/python-pipeline.md`
- All new REST endpoints must be documented in `docs/api-spec.md`
- Database changes must be reflected in `docs/data-model.md` and `backend/src/db.ts`
- **KEEP MEMORY LEAN**: Write plan details to journal, not memory. Memory = compressed pointers only.

## Output:
- Ordered list of file changes with descriptions
- Verification commands to run after each change
- Expected test results

$ARGUMENTS
