@AGENTS.md

## Claude Code specifics
- Subagents live in `.claude/agents/` (see `test-runner`).
- Slash commands live in `.claude/commands/`: `/research`, `/plan`, `/execute`, `/review`, `/test`, `/verify`.
- Test gate: `/test` delegates to the `test-runner` subagent (Haiku). Binary verdict: OPEN or BLOCKED.
- Persistent user/project memory lives under `~/.claude/projects/D--VibeCoding-ViralVideo/memory/` — not in this file.

<!-- antislop:start -->
## antislop
For UI, copy, people, mobile layout, or code comments work, read these installed skill files directly (use these paths even if a same-named global skill exists):
- Core filter, always on: `antislop`: `.claude/skills/antislop`
- UI / visual: `antislop-ui`: `.claude/skills/antislop-ui`
- Copy & text: `antislop-copywriting`: `.claude/skills/antislop-copywriting`
- People: `antislop-human`: `.claude/skills/antislop-human`
- Mobile / responsive: `antislop-layoutmobile`: `.claude/skills/antislop-layoutmobile`
- Code comments: `antislop-code`: `.claude/skills/antislop-code`
Before starting, follow the core's "Two Usage Modes" section in strict order: explicit session instruction first, then global preference, then ask. A session instruction always wins. For a resolved mode, say `antislop active: <mode> (session override).` or `antislop active: <mode> (global preference).` once before presenting findings or making edits, using the actual mode and source. Acknowledging the user's request without naming the source does not replace this notice.
Only an explicit choice of antislop during or after selects a session mode. A request to review, audit, or avoid file edits does not select a mode; read the global preference in that case. Another skill's mode does not select antislop's mode.
If the mode is unresolved, ask during/after and end the response; wait for the answer before any UI review, planning, or concept. For read-only tasks, put the active-mode notice only at the start of the final answer, never in progress messages. For editing tasks, announce before the first edit and omit it from the final answer.
To update antislop later: `npx antislop-ai --update`, or run `npx antislop-ai` and pick Overwrite them.
<!-- antislop:end -->
