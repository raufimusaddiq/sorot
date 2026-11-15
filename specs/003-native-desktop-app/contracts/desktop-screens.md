# Contract: Desktop Screens and Parity

**Feature**: `003-native-desktop-app` | **Date**: 2026-11-15

FR-020 requires full parity before the first release. This is the parity checklist: every
web UI file (`frontend/src`) maps to a desktop screen (`desktop/src/screens/`). The engine
routes it calls are unchanged. A row is done when the desktop screen passes the headless tests
for its behaviour, plus its empty, loading and error states (R-27).

| Web UI (today) | Desktop screen | Engine routes (prefix `/api`) | Story |
|---|---|---|---|
| `app/page.tsx` (desktop, windows, dock) | `shell` (rail, menu bar, command palette, toasts) | `health`, `settings` | US1, US4 |
| `app/studio/page.tsx` (import, jobs, clips) | `home`, `job`, `clips` | `import`, `process`, `jobs`, `jobs/:id`, `jobs/:id/cancel`, `jobs/:id/retry`, `clips/*`, `options`, `music` | US2, US6 |
| `components/ImportOptions.tsx` | `home` import options sheet | `options`, `music` | US2 |
| `components/progress.tsx` | `job` stage track (beam) | `jobs/:id` | US2, US3 |
| `components/ClipEditor.tsx` | `editor` | `clips/:id`, `clips/:id/rerender`, `clips/:id/preview` | US2 |
| `components/ResultsForm.tsx` | `clips` feedback sheet | `clips/:id/feedback`, `feedback` | US5 |
| `components/LearningPanel.tsx` | `learning` | `feedback`, `feedback/train`, `feedback/weights` | US5 |
| `components/PublishPanel.tsx` | `publish` | `clips/:id/publish/draft`, `clips/:id/publish`, `clips/:id/posts`, `generate/exports/:id/publish`, `generate/exports/:id/posts` | US5 |
| `components/ConnectionsPanel.tsx` | `settings/connections` | `settings`, `settings/commands` | US5 |
| `components/GenerateConnections.tsx` | `settings/generate` | `generate/status`, `generate/models`, `generate/models/calibrate`, `generate/models/:id/level` | US5 |
| `components/generate/GenerateWindow.tsx` | `generate` (project list, steps) | `generate/projects`, `generate/run`, `generate/steps`, `generate/status` | US5 |
| `components/generate/BriefForm.tsx` | `generate/brief` | `generate/projects`, `generate/projects/:id/assets` | US5 |
| `components/generate/IdeaBank.tsx` | `generate/ideas` | `generate/ideas` | US5 |
| `components/generate/FactsPanel.tsx` | `generate/facts` | `generate/projects/:id/facts`, `.../facts/verify`, `generate/facts/:id` | US5 |
| `components/generate/StorylineCards.tsx` | `generate/storylines` | `.../storylines`, `.../storylines/:n/pick` | US5 |
| `components/generate/PlanEditor.tsx` | `generate/plan` | `.../plan`, `.../plan/approve` | US5 |
| `components/generate/BuildPanel.tsx`, `DirectorLog.tsx` | `generate/build` | `generate/projects/:id/versions`, `generate/versions/:id/cancel`, `.../retry` | US5 |
| `components/generate/VerdictPanel.tsx` | `generate/verdict` | `generate/versions/:id/accept`, `.../draft`, `.../export` | US5 |
| `components/generate/VersionHistory.tsx` | `generate/versions` | `generate/versions/:id/restore` | US5 |
| `components/generate/RecipeEditor.tsx` | `generate/recipes` | `generate/recipes`, `.../import`, `.../mine`, `.../mine/export`, `.../shared`, `.../validate` | US5 |
| `components/generate/KitPanel.tsx` | `generate/kit` | `generate/kit`, `generate/kit/:name/export` | US5 |
| (discovery in studio) | `discover` | `discover/*` | US5 |
| (none) | `readiness` (first run + Settings) | `readiness`, `readiness/:id/fix` | US1 |
| (none) | `welcome/library` (adopt or copy existing data) | engine startup commands `--find-libraries`, `--copy-library`, `--import-keys` (engine-connection §7) | US1 |
| (none) | `settings/general` (language, theme, close behaviour, notifications, shortcuts) | none (app preferences) | US4 |

## Behaviours every screen must keep

- **Generate is AI-only** (constitution IV): with no AI connection, the `generate` rail item
  stays visible, but the screen shows "Generate needs an AI connection" plus a link to
  `settings/connections`. Clipping never checks for AI.
- **Publish choices** (constitution VI): TikTok privacy or draft mode, the YouTube title and
  made-for-kids start empty and are required, and the Post button stays disabled until they are
  set. Posting is never automatic.
- **Masked keys**: key fields show the engine's masked value. Typing replaces it, and the app
  never displays a value it did not just receive from the user.
- **Retry paths**: interrupted or failed jobs show Retry, and a failed Generate version shows
  "Continue from the failed step" (`POST /api/generate/versions/:id/retry`; 409 = "The plan
  changed since this run. Start a new version.").

## Keyboard map (defaults, editable in Settings)

| Action | Windows / Linux | macOS |
|---|---|---|
| Command palette | Ctrl+K | Cmd+K |
| Import file | Ctrl+O | Cmd+O |
| Paste link and import | Ctrl+Shift+V | Cmd+Shift+V |
| Play / pause preview | Space | Space |
| Next / previous clip | J / K | J / K |
| Export selected clip | Ctrl+E | Cmd+E |
| Show in folder | Ctrl+Shift+R | Cmd+Shift+R |
| Settings | Ctrl+, | Cmd+, |
| Cancel running job | Ctrl+. | Cmd+. |
