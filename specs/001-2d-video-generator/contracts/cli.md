# CLI Contract: `sorot gen`

A thin client over [api.md](api.md), like the other `sorot` commands. It is non-interactive when
flags are given, and asks questions otherwise (the same as `sorot publish`). `--json` prints the
raw API data.

| Command | Does | Key flags |
|---|---|---|
| `sorot gen status` | availability and reasons | |
| `sorot gen new "<brief>"` | create a project → prints storylines (or the plan) | `--recipe <id>` `--facts facts.md` `--format 9:16\|16:9\|1:1` `--length <sec>` `--lang id\|en` `--style "<notes>"` `--preset <name>` `--narration` `--no-stop` |
| `sorot gen run --recipe <id>` | unattended run on the next new idea | `--idea <ID>` resume without moving the cursor · `--json` (for outside agents and schedulers) |
| `sorot gen steps` | list the step library with settings and dependencies | `--json` |
| `sorot gen recipes` / `recipe show <id>` | list recipes with availability / print one | |
| `sorot gen recipe new <id>` / `recipe validate <file>` | start an empty recipe (plan + two verdicts) / check a file | |
| `sorot gen recipe copy <from> <id>` / `recipe edit <id>` / `recipe export <id>` / `recipe import <file>` | customise recipes | `edit` opens `$EDITOR` on the JSON, validated on save |
| `sorot gen idea add <BRIEF.md>` / `ideas` / `idea show <id>` | idea bank | `--facts facts.md` `--id IDEA-042` `--slug <s>` |
| `sorot gen facts <project>` / `facts verify <project>` | list or re-verify facts | |
| `sorot gen files <project> [<name>]` | list or print the mirrored files | |
| `sorot gen import-history <file.json>` | import past concepts (for novelty) and ideas from the documented JSON shape | |
| `sorot gen approve-step <project> <stepId>` | pass an `owner` gate | `--note` |
| `sorot gen list` / `sorot gen show <project>` | projects / a project's state, plan and versions | |
| `sorot gen storylines <project>` | ask for 3 new storylines | `--note "<text>"` |
| `sorot gen pick <project> <1-3>` | pick a storyline → plan | `--note` |
| `sorot gen plan <project>` | print the current plan as a shot table | `--edit` opens `$EDITOR` on the JSON |
| `sorot gen revise <project> "<request>"` | plain-words change → new revision | |
| `sorot gen approve <project>` | approve the current revision | |
| `sorot gen asset <project> <file>` | upload an asset | `--kind logo\|image\|font\|music` `--shot <id>` |
| `sorot gen build <project>` | build a version and follow its progress | `--no-watch` |
| `sorot gen verdicts <version>` | show TECHNICAL and CREATIVE with findings | |
| `sorot gen fix <version>` | fix must-fix items (or chosen ones) | `--finding <id>`... `--note "<text>"` `--shot <id>` |
| `sorot gen cancel <version>` / `restore <version>` / `accept <version>` | | |
| `sorot gen export <version>` | delivery render → library | `--title` `--description` `--out <path>` (also downloads) |

Publishing a generated export goes through the existing command:
`sorot publish --generated <exportId>`, with the same required choices (flags or questions).

Exit codes: 0 ok, 1 API error, 2 bad usage (the same as other `sorot` commands).
