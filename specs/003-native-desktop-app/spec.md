# Feature Specification: Sorot Native Desktop App

**Feature Branch**: `003-native-desktop-app`

**Created**: 2026-11-15

**Status**: Draft

**Input**: User description: "i want this apps rewrite to be a native app (windows, mac, linux) using this https://github.com/anomalyco/rune framework. make sure the design is sophisticated and futuristic"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Install and launch a native app on any desktop OS (Priority: P1)

A Sorot user on Windows, macOS or Linux installs Sorot like any other desktop program and opens it from the Start menu, Launchpad or application launcher. A window appears, the app checks that everything it needs is in place, and the user lands on the home screen without opening a terminal, a browser tab, or running scripts by hand.

**Why this priority**: Today Sorot is a server plus a browser tab started from scripts. Being a real installed app is the whole point of the rewrite; without it nothing else in this feature matters.

**Independent Test**: On a clean machine of each OS, install the app, open it, and reach the home screen with no manual steps beyond the installer; close it and confirm nothing keeps running.

**Acceptance Scenarios**:

1. **Given** a clean Windows, macOS or Linux machine, **When** the user installs and opens Sorot, **Then** the app window opens on the home screen and shows a readiness check (video tools, speech model, optional AI connections) with plain-language status for each item.
2. **Given** a required component is missing or still downloading, **When** the app opens, **Then** it shows what is missing, its progress, and a single action to fix or retry, and never shows a blank or frozen window.
3. **Given** the app is open with a job running, **When** the user closes the window, **Then** the app says what is running and lets them keep it running in the background, wait, or cancel; after a full quit nothing is left running.
4. **Given** an existing Sorot user with data from the current web version, **When** they open the native app, **Then** their videos, clips, settings, connections and published-post history are all there.

---

### User Story 2 - Make clips end to end from the native app (Priority: P1)

The user drops a video file or pastes a YouTube link into the app, optionally adds a direction, and watches the clipping pipeline run with live stage progress. When it finishes they browse the ranked clips, preview each one, adjust options (captions, silence trim, reframe, music, hook), re-render, and export or reveal the files in their file manager.

**Why this priority**: Clipping is Sorot's core job; the native app must do it at least as well as the web UI before anything else is ported.

**Independent Test**: Import one local video and one YouTube link in the native app, run to completion, preview and export a clip, and compare results against the current web version for the same inputs.

**Acceptance Scenarios**:

1. **Given** the home screen, **When** the user drags a video file onto the window or pastes a link, **Then** an import starts and the stage-by-stage progress (with percentage and a cancel control) appears without further input.
2. **Given** a finished job, **When** the user opens it, **Then** ranked clips appear with score, verdict, title and a playable preview, in the same order the current web version would show.
3. **Given** a clip, **When** the user changes an editing option and re-renders, **Then** the new version replaces the preview and the previous export is unchanged until the user exports again.
4. **Given** an exported clip, **When** the user picks "show in folder", **Then** the OS file manager opens at that file.
5. **Given** a long job, **When** it finishes while the app is minimized or in the background, **Then** the user gets a desktop notification that opens the finished job when clicked.

---

### User Story 3 - A sophisticated, futuristic look and feel (Priority: P1)

The whole app has a deliberate, premium, forward-looking visual identity: a dark-first interface with luminous accents, fluid motion, depth and glow used with restraint, crisp typography and a clear visual hierarchy. Progress, scores and the pipeline are shown as living, animated visuals rather than flat tables. It feels fast and responsive on every action and still reads clearly: nothing is decoration at the cost of usability.

**Why this priority**: The owner named design as a first-class requirement. The look is part of the product, so it is a P1 outcome and not a final polish pass.

**Independent Test**: Review each main screen against the design acceptance list (consistent theme, motion, hierarchy, contrast); put it in front of five first-time viewers and ask each to describe the look in their own words.

**Acceptance Scenarios**:

1. **Given** any main screen (home, import, job progress, clip results, clip editor, publish, settings, Generate), **When** the user views it, **Then** it uses one shared design language: colour, type, spacing, depth, iconography and motion are consistent across screens.
2. **Given** a running job, **When** the user watches the progress view, **Then** pipeline stages animate smoothly as work advances and each stage shows its state (waiting, running, done, failed) at a glance.
3. **Given** a clip list, **When** the user hovers, selects or scrolls, **Then** motion responds within one frame budget with no visible stutter, and respects the OS "reduce motion" setting by switching to near-static transitions.
4. **Given** the OS is in light or dark mode, **When** the app opens, **Then** it follows the OS choice, with dark as the default and showcase theme, and every text and control meets readable contrast in both.
5. **Given** a high-density display or a window resized from compact to large, **When** the user resizes the window, **Then** layout reflows cleanly with no clipped text or overlapping controls.

---

### User Story 4 - Full keyboard, drag-and-drop and OS integration (Priority: P2)

The app behaves like a good desktop citizen: files and links can be dropped in, every action has a keyboard shortcut and a command palette, windows remember their size and position, the app has a proper menu, supports opening a video from the OS ("Open with Sorot"), shows progress in the taskbar/dock, and can be driven fully without a mouse.

**Why this priority**: These details turn a ported web page into a native app, but clipping works without them.

**Independent Test**: Complete an import, review and export using only the keyboard, then restart and confirm window layout and last view are restored.

**Acceptance Scenarios**:

1. **Given** the app is open, **When** the user presses the command-palette shortcut, **Then** a searchable list of every action appears and runs the chosen one.
2. **Given** a video file in the OS file manager, **When** the user chooses "Open with Sorot", **Then** the app opens (or comes to front) and starts the import dialog for that file.
3. **Given** the app was last closed at a given size, position and view, **When** it is reopened, **Then** it restores them (falling back to a visible position if the monitor setup changed).
4. **Given** a screen reader or keyboard-only user, **When** they move through the app, **Then** focus order is logical, focus is always visible, and every control has an accessible name and role.

---

### User Story 5 - Settings, AI connections, publishing and Generate in the native app (Priority: P2)

All remaining Sorot areas are available natively: Settings (including LLM, Jev and Tebar connections with masked keys), the learning/analytics panels, publishing with its draft → choices → upload flow, and the Generate mode (briefs to 2D videos) with its AI-only availability rules.

**Why this priority**: Built after clipping, but required for the first release: the native app ships only at full parity (FR-020).

**Independent Test**: Connect an AI provider, publish a drafted clip to a test account, and run a Generate brief, all from the native app; then with every AI connection removed, confirm clipping still works and Generate shows as unavailable with a link to Settings.

**Acceptance Scenarios**:

1. **Given** Settings, **When** the user enters or edits a key, **Then** it is stored securely, always shown masked, and takes effect on the next action without restarting the app.
2. **Given** a drafted post, **When** the user publishes, **Then** the same safeguards as today apply: user-owned choices are never auto-filled, the post is recorded before sending, and a retry can never double-post.
3. **Given** no AI connection, **When** the user opens Generate, **Then** it is shown as unavailable with a link to Settings, while every other area keeps working.

---

### User Story 6 - Stay current and recoverable (Priority: P3)

The app tells the user when a newer version is available, updates in a few clicks, and never loses data across updates. If something crashes, the app restarts to a safe state with the user's jobs and library intact and offers a one-click diagnostic report.

**Why this priority**: Important for long-term use, deferrable beyond first release.

**Independent Test**: Install an older build with data, update to a newer one, confirm all data survives; force-kill the app mid-job and confirm it reopens with the job marked interrupted and resumable or retryable.

**Acceptance Scenarios**:

1. **Given** a newer version exists, **When** the user opens the app, **Then** a non-blocking prompt offers to update, and declining never blocks use.
2. **Given** the app is killed mid-job, **When** it is reopened, **Then** the job shows as interrupted with a retry action and no corrupted library entries.

---

### Edge Cases

- No internet: clipping a local file works fully; YouTube import, update checks and AI features show a clear offline state instead of failing silently.
- The machine has no capable GPU or the graphics driver is old: the app still opens and works (reduced effects), and says so once, instead of crashing or showing a blank window.
- Very large videos or low disk space: the app warns before starting an import that cannot finish and never fills the disk silently.
- Opening a second copy of the app: the existing window comes to the front instead of starting a second engine on the same data.
- Multiple monitors, mixed display scaling, and a monitor unplugged while the app is open.
- Text input in Indonesian and other non-Latin scripts, including IME composition, in every text field.
- A user on Linux without a notification service, tray or file-manager integration: those features degrade quietly.
- User data from the web version is partially corrupt or from a much older version: the app opens what it can, reports what it could not, and never deletes the source data.
- Window closed while a publish is in flight: the post state stays consistent and resumes or reports on next start.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Sorot MUST ship as an installable native desktop application for Windows, macOS and Linux, launched like any other installed program, with no terminal, browser or manual script step required for normal use.
- **FR-002**: The app MUST be built on the Rune framework (github.com/anomalyco/rune), as specified by the owner.
- **FR-003**: The native app MUST provide every user-facing capability of the current web UI: import (file or link, options, direction), job progress and cancel, clip results and preview, clip editor, export, publishing, analytics and learning panels, Settings and connections, and Generate. Delivery order follows the user-story priorities.
- **FR-004**: Existing Sorot data (videos, jobs, clips, settings, connections, post history, learned weights) MUST open in the native app without loss or manual migration, and MUST NOT be changed in a way that breaks the current version while both are installed.
- **FR-005**: The clipping pipeline MUST produce the same results (ranking, scores, verdicts, renders) in the native app as in the current version for the same inputs and settings.
- **FR-006**: Clipping MUST continue to work fully with every AI connection (Jev, LLM, Tebar) absent or failing; Generate MUST be the only area that can show as unavailable without an AI connection, with a link to Settings.
- **FR-007**: The app MUST show a first-run and ongoing readiness check for everything it depends on, with plain-language status, progress and a fix/retry action for each missing item.
- **FR-008**: Long-running work MUST show live stage progress, be cancellable, and keep running or stop cleanly according to the user's choice when the window is closed; quitting the app MUST leave no stray processes.
- **FR-009**: The app MUST apply one cohesive visual language across all screens: dark-first with a light variant following the OS, luminous accent colours, consistent typography, depth, iconography and fluid, purposeful motion; pipeline stages, scores and progress MUST be shown as animated visuals.
- **FR-010**: All motion and effects MUST respect the OS reduce-motion setting and degrade gracefully on machines with weak or no graphics acceleration, without losing information or function.
- **FR-011**: The app MUST meet WCAG 2.1 AA contrast for text and controls in both themes, expose accessible names and roles for every control, support full keyboard operation with visible focus, and work with OS screen readers on each platform.
- **FR-012**: The app MUST support drag-and-drop of video files and links, "Open with Sorot" from the OS, desktop notifications for finished or failed jobs, taskbar/dock progress, a native menu, a command palette and customizable keyboard shortcuts.
- **FR-013**: The app MUST remember window size, position, last view and user preferences, and recover to a visible position if the display setup changed.
- **FR-014**: Secrets (API keys) MUST be kept only in the engine's own settings store on the user's machine (never in app files), always shown masked, and never written to logs, diagnostics or shared files.
- **FR-015**: The app MUST allow only one running instance per user data location, bringing the existing window forward when launched again.
- **FR-016**: The app MUST check for updates, let the user install them without losing data, and never block use when an update is declined or unavailable.
- **FR-017**: The app MUST survive a crash or forced quit: on the next launch jobs are shown as interrupted with a retry action, the library is intact, and the user can export a diagnostic report with secrets removed.
- **FR-018**: All user-facing text MUST be available in Indonesian and English, with Indonesian input (including IME) working in every field.
- **FR-019**: The browser UI MUST remain a supported surface after the native app ships. Sorot has three surfaces: the web UI (`frontend/`, a Next.js static export served by the engine), the native desktop app (`desktop/`), and the CLI (`cli/`). The web UI keeps working unchanged (fixes only) until the native app's first release, and stays after it: it is not removed, and its tests stay in the gate. New user-facing capability MUST reach both the web UI and the native app.
- **FR-020**: The first release MUST include full parity with the current web UI (every capability in FR-003, user stories 1-5). Story priorities order the build, not separate releases; no partial native release replaces the web UI, and the web UI is not retired by the release.
- **FR-021**: The engine MUST stay reachable by the native app over a defined connection rather than only in-process, so a later hosted mode can point the same native app at a remote engine without another UI rewrite.

### Key Entities *(include if feature involves data)*

- **Workspace**: the user's local Sorot data (library of videos, jobs, clips, exports, settings); one active per app instance; carries over from the web version.
- **Job**: one import-to-clips run with stages, progress, state (running, done, failed, interrupted) and cancel/retry.
- **Clip**: a candidate short with score, verdict, title, hook, edit options, preview and export state.
- **Connection**: an optional AI or publishing link (Jev, LLM, Tebar) with masked secret and health status.
- **Readiness item**: a dependency the app needs (video tools, speech model, optional hardware acceleration), with status and fix action.
- **Theme**: the visual language (colours, type, motion level) applied across the app, following OS light/dark and reduce-motion.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A new user installs and reaches the home screen in under 5 minutes on each of Windows, macOS and Linux, with no terminal use.
- **SC-002**: The app window appears within 3 seconds of launch on a typical laptop, and every in-app action responds visibly within 100 ms.
- **SC-003**: At least 90% of first-time users complete import → review → export of one clip in the native app without help on their first attempt.
- **SC-004**: Clips ranked and rendered for a fixed test set of videos match the current version's results on every test video.
- **SC-005**: 100% of users with existing Sorot data see all videos, clips and settings after first launch, with zero manual steps.
- **SC-006**: Animated screens hold a smooth frame rate (no visible stutter) on a typical integrated-graphics laptop during job progress and clip browsing.
- **SC-007**: At least 4 of 5 first-time viewers describe the look unprompted as modern, premium or futuristic, and none describe it as hard to read.
- **SC-008**: Every main screen passes an accessibility audit: AA contrast, full keyboard path, and screen-reader names, on all three OSes.
- **SC-009**: After a forced quit mid-job, 100% of relaunches open with the library intact and the interrupted job offering retry.
- **SC-010**: Quitting the app leaves zero leftover background processes on all three OSes.

SC-001, SC-002, SC-008 (the screen-reader part) and SC-010 need a real machine. They are
verified by the owner's manual release checks (quickstart.md sections 2, 3, 7 and 8), not by the
automated gate, which proves their logic with unit tests, Kani proofs and headless runs.
SC-003 and SC-007 are measured with real users after the build.

## Assumptions

- Rune is a pre-release, GPU-rendered Rust UI framework for macOS, Windows and Linux (and web) with its own renderer rather than OS widgets, consumed as a pinned source dependency. Its maturity and its lack of a documented installer or backend-connection story are risks for planning, not for this spec.
- The existing engine (import, transcription, segmentation, scoring, rendering, publishing, Generate) is reused; this feature replaces the browser-based interface and how the app is installed and started, not the clipping behaviour.
- The app ships as a self-contained installer per OS; large components (speech models, GPU runtimes) may download on first run through the readiness check.
- Target users stay owner-scale personal users; accounts, multi-user data isolation and billing remain out of scope.
- Mobile platforms and a browser build of the app are out of scope for this feature.
- Hosting the engine on a server stays a planned later step. A hosted engine will be used through the native app or the web UI connecting to it remotely, and authentication and HTTPS for that stay as Principle I already requires. Connecting to a remote engine (picking one, storing its token) is out of scope for this feature; FR-021 only requires that the app reaches the engine through its API, so that later step needs no UI rewrite.
- Constitution amendment (MAJOR, owner decision 2026-11-15, now v3.0.0): Principle V's static Next.js frontend rule is replaced by the native app; Principle I's "UI stays same-origin" becomes "the native app reaches the engine over a defined connection"; the stack constraints add the native app and its installers.
- The web UI and its tests stay in the gate permanently (FR-019); the native app is added beside it, not in place of it.
- Existing quality gates (full test pass, coverage, no type errors) continue to apply to the new work.
