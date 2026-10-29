---
description: Research a pipeline step before implementation
argument-hint: <pipeline step or feature>
---

# Research Pipeline Step

Analyze the codebase and docs to understand what's needed for a specific pipeline step.

## Steps:

1. **Read the spec**: Read `docs/architecture.md`, `docs/python-pipeline.md`, and `docs/api-spec.md` to understand the target step
2. **Check existing code**: Find all related existing code in `backend/`, `cli/`, `ai-pipeline/`, and `frontend/`
3. **Identify gaps**: Compare spec vs. current implementation
4. **Check dependencies**: Verify prerequisites (earlier pipeline steps) are working
5. **Document findings**: Write a concise summary of what exists, what's missing, and what to build

## Output:
- Summary of current state for the given pipeline step
- List of files that need creation or modification
- Any blockers or open questions
- **Write findings to journal** — do NOT expand memory blocks with research details

$ARGUMENTS
