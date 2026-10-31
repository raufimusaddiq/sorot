# Feature Specification: 2D Video Generator (Studio)

**Feature Branch**: `feat/2d-video-generator`

**Created**: 2026-10-31

**Status**: Draft

**Input**: User description: "i want to add new feature rather than clipping, i want Sorot gonna be
video-multimedia generator. so it could be created the motion graphic, 2d story teller and whatever
user need for 2d, uising this https://github.com/heygen-com/hyperframes with llm director and
"Plan before building", "Two verdicts" (TECHNICAL vs CREATIVE) this paradigm"

## Overview

Today Sorot only cuts existing videos into short clips. This feature adds a second way to make
video: **generate** a new 2D video from a written idea. A user describes what they want (a motion
graphic, a short animated story, an explainer, a promo, a data highlight, a title card) and an AI
director turns it into a finished video.

Two working rules shape the whole flow:

- **Plan before building**: the director first writes a plan the user can read and change
  (storyline options, then a shot-by-shot plan). Nothing is built until the user approves a plan.
- **Two verdicts**: every built draft gets two separate verdicts, **TECHNICAL** (does the video
  work: it renders, text is readable, timing holds, nothing is broken) and **CREATIVE** (does it
  say what the brief asked, in the agreed style, and hold a first-time viewer). Each verdict is
  PASS, REVIEW, or FAIL on its own, with reasons. A draft is only offered for final export when
  TECHNICAL passes; the CREATIVE verdict guides revision and the user has the final say.

Finished videos join the same library as clips, so they can be previewed, exported, and published
through Sorot's existing publishing flow.

How a project runs is set by a **recipe**: a pipeline the user builds from a library of steps
(facts, script, voice, storylines, plan, concept, images, author, check, look, render, own
commands, the two verdicts, export). The user sets the steps' order, their settings and numbers,
where the pipeline stops for approval, the rules and creative questions for the two verdicts,
and their own instructions for each director step. Sorot doesn't impose anyone's pipeline. It
ships a few neutral example recipes, and anyone running Sorot can build, tune, share and import
their own without changing code. Only the two working rules above are fixed for every recipe.

## Clarifications

### Session 2026-10-31

- Q: What works without the AI director? → A: Nothing in Generate; it needs a configured director
  (FR-016). Clipping is unaffected.
- Q: Where may visuals come from? → A: Text, shapes, icons, charts, uploads, plus AI-generated
  images when an image provider is onboarded (FR-017).
- Q: Voiceover in v1? → A: Optional synthetic voiceover from the plan's script, with matching
  captions (FR-018).
- Q: Where does the voice come from on different machines? → A: Online voice services (such as
  ElevenLabs or Fish Audio) work on every install. A local voice engine is allowed only on
  installs with a GPU; CPU-only installs must use an online service (FR-018a).
- Q: How does an existing agent pipeline (pick the film → verify facts → narration →
  storylines + numeric spec → author → check and look → render, verify, two verdicts → publish)
  fit? → A: It is an *example* of what users must be able to build, not a rule. Sorot provides
  a step library and custom pipelines (recipes) that anyone can compose, and that pipeline is one
  of them (FR-022 to FR-035). Nothing user-specific (voices, data sources, accounts) ships with
  Sorot.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Idea to approved plan (Priority: P1)

A user opens the new "Generate" area, types a brief such as "30-second motion graphic explaining
how compound interest works, Indonesian text, upbeat", picks a format (9:16, 16:9, or 1:1) and a
target length. The director answers with three different storyline options, each with a one-line
pitch, its opening seconds, its beats, its look, and its sound, plus a recommendation and why.
The user picks one (or asks for changes), and the director expands it into a shot-by-shot plan
with on-screen text, timing, visual style, and audio choices. The user can edit the plan in plain
words and approve it.

**Why this priority**: the plan is the core of "plan before building"; without it the director
has nothing to build from, and it already gives value on its own as a reviewable creative brief.

**Independent Test**: submit a brief, receive three storylines, pick one, edit one shot, approve
the plan — all without any video being rendered.

**Acceptance Scenarios**:

1. **Given** a brief and format, **When** the user submits it, **Then** the number of distinct
   storyline options the recipe sets (three in the examples) and one recommendation are shown.
2. **Given** storyline options, **When** the user picks one, **Then** a shot-by-shot plan is shown
   whose total length matches the target length within 10%.
3. **Given** a shown plan, **When** the user asks for a change in plain words ("make shot 3
   shorter, use blue"), **Then** a revised plan is shown with the change applied and the rest kept.
4. **Given** a plan that has not been approved, **When** the user tries to build, **Then** building
   is not allowed and the user is asked to approve the plan first.

---

### User Story 2 - Build a draft and get two verdicts (Priority: P1)

After approving a plan, the user starts the build. Sorot builds a draft video from the plan and
shows a playable preview. It then shows two verdict cards side by side: TECHNICAL and CREATIVE,
each with PASS / REVIEW / FAIL and a short list of findings ranked by severity (must-fix,
should-fix, polish), each finding pointing to a shot and time.

**Why this priority**: a draft plus honest, separated verdicts is the minimum that turns a plan
into a usable video.

**Independent Test**: approve a plan, build, and confirm a preview plays and both verdicts appear
with at least one finding or an explicit "no issues".

**Acceptance Scenarios**:

1. **Given** an approved plan, **When** the user builds, **Then** a preview of the full draft is
   playable and the build shows progress while it runs.
2. **Given** a built draft, **When** verdicts finish, **Then** TECHNICAL and CREATIVE verdicts are
   shown separately, each with its own status and findings.
3. **Given** a draft with a TECHNICAL must-fix finding (for example text off-screen or too small
   to read on a phone), **When** the verdict is shown, **Then** TECHNICAL is FAIL and final export
   is blocked until it is fixed.
4. **Given** a draft whose TECHNICAL verdict passes and CREATIVE is REVIEW, **When** the user
   chooses to accept it, **Then** final export is allowed.

---

### User Story 3 - Revise until satisfied (Priority: P2)

From the verdicts or their own viewing, the user asks for fixes: "apply the director's must-fix
items", or a plain-words note on a shot. Sorot updates the plan, rebuilds only what changed where
possible, and re-runs both verdicts. Each round is kept as a version the user can compare and
roll back to.

**Why this priority**: first drafts are rarely final; revision is what makes results good enough
to publish.

**Independent Test**: build a draft, request one fix, and confirm a new version appears with fresh
verdicts while the previous version stays viewable.

**Acceptance Scenarios**:

1. **Given** a draft with findings, **When** the user chooses "fix must-fix items", **Then** a new
   version is built and both verdicts re-run on it.
2. **Given** two versions, **When** the user opens history, **Then** they can view either version
   and its verdicts and restore an earlier one.

---

### User Story 4 - Export and publish (Priority: P2)

When satisfied, the user exports the final video at full quality. It appears in Sorot's library
next to clips, with a title and description drafted from the plan, and can be published through
the existing publishing flow with the same user choices and safeguards as clips.

**Why this priority**: reuses Sorot's existing value (library, export, publishing) for the new
content type.

**Independent Test**: export an accepted draft and confirm the file plays, appears in the library,
and can open the publish panel.

**Acceptance Scenarios**:

1. **Given** an accepted draft, **When** the user exports, **Then** a full-quality video file is
   produced in the chosen format and listed in the library.
2. **Given** an exported video, **When** the user opens publish, **Then** the same publishing steps,
   required choices, and double-post protection apply as for clips.

---

### User Story 5 - Ready-made formats (Priority: P3)

The user can start from a format preset instead of a blank brief: motion graphic, 2D story,
explainer, title/quote card, data highlight, product promo. Each preset pre-fills sensible length,
pacing, and style hints the director uses, and the user can still change anything.

**Why this priority**: speeds up common jobs, but the free-form brief already covers them.

**Independent Test**: start from the "2D story" preset and confirm the plan reflects its defaults.

**Acceptance Scenarios**:

1. **Given** the preset list, **When** the user picks "data highlight" and enters numbers,
   **Then** the plan includes a chart shot using those exact numbers.

---

### User Story 6 - Build your own pipeline (Priority: P2)

A user opens the Recipes window and builds the pipeline they want. They start from an example or
from scratch, add steps from the library, put them in their own order, and set each step (for
example: verify facts first, voice before the storyline, three storylines picked by the director,
a numeric plan timed to the voice, no templates, a self-review, one final-quality render). They
choose where the pipeline stops for their approval, write the rules and creative questions the
two verdicts use, add their own instructions per director step, and plug in their own local
check scripts. They save it and share it as a file; another person imports it and uses it with
their own voices and connections.

**Why this priority**: people already make videos in very different ways; Sorot is useful to
them only if it can run *their* process, not one fixed process.

**Independent Test**: build a recipe that moves the voice step before storylines and adds one
custom creative question; run it and confirm the steps ran in that order and the verdict asked
that question; export it, import it on a clean Sorot, and confirm it runs there with that
install's own voice settings.

**Acceptance Scenarios**:

1. **Given** the step library, **When** the user adds, removes or reorders steps and saves,
   **Then** new projects run exactly those steps in that order, and existing projects keep their
   frozen recipe.
2. **Given** a recipe whose order breaks a dependency (for example `voice` before `script`, or no
   approved plan before building), **When** the user saves, **Then** it is refused with a clear
   reason naming the steps.
3. **Given** a recipe that needs something this install lacks (a voice engine, an image-capable
   model, a data source or a custom command), **When** the user views it, **Then** it shows as
   unavailable with the reason, and other recipes still work.
4. **Given** an imported recipe that names a custom command, **When** that command isn't
   registered in the user's own Settings, **Then** nothing runs, and the recipe says which command
   is missing.

---

### User Story 7 - Facts with sources (Priority: P2)

For factual films (finance, news, education), the project holds a list of facts, each claim with
a source link. The director checks each claim against its source and corrects it, but never adds
new facts in "verify only" mode. In "research" mode it may look up real data in sources the user
registered (such as a local database file) and add it with the source. When the recipe includes
the sourced-numbers check, every number that appears on screen or in the narration must match a
sourced fact.

**Why this priority**: a wrong number in a factual video harms trust; many factual pipelines
treat this as a hard gate.

**Independent Test**: start a project with three sourced facts, one deliberately wrong; confirm
the wrong one is corrected (or flagged) and that a plan showing an unsourced number fails the
TECHNICAL verdict.

**Acceptance Scenarios**:

1. **Given** facts with source links, **When** facts are verified, **Then** each fact shows
   verified, corrected (with the old and new value), or unverifiable, with the source.
2. **Given** a built video showing a number not in the facts, **When** TECHNICAL runs, **Then** it
   is FAIL with a must-fix finding naming the number and shot.
3. **Given** a brief that says no market data is needed, **When** the plan or video contains an
   index or foreign-market number, **Then** TECHNICAL is FAIL.

---

### User Story 8 - Unattended runs and outside agents (Priority: P3)

A user (or an outside agent or scheduler they already use) keeps a bank of ideas, each with a
brief and facts. A run takes the next unused idea, or a named one to resume an unposted project,
and goes through the recipe without stopping when its gates are set to the director, recording
each choice and why. It then waits for the user to publish. Outside agents drive this through the
command line or API and read the per-project files.

**Why this priority**: it lets people automate their own daily flow, but needs US1 to US7 first.

**Independent Test**: add two ideas, start an unattended run, and confirm the first idea is used
and marked, a second run uses the second, and resuming the first by name does not move the
cursor.

**Acceptance Scenarios**:

1. **Given** an idea bank, **When** an unattended run starts, **Then** it uses the next unused
   idea and marks it used.
2. **Given** a used but unposted idea, **When** the user resumes it by name, **Then** its
   existing project continues and the next-idea cursor does not move.

### Edge Cases

- The brief is too vague or too long for the target length: the director says so in the plan and
  proposes a shorter story or a longer length instead of silently cutting content.
- The brief asks for something outside 2D (photoreal footage, 3D characters, a real person's
  likeness): the director explains it is not supported and offers the nearest 2D treatment.
- Facts, names, or numbers in the brief: the plan uses them exactly; the director never invents
  statistics or quotes and marks anything it added as an assumption.
- The AI director is not configured: the Generate area says so and links to Settings; nothing
  else in Sorot changes (FR-016).
- The AI director fails mid-plan: the user keeps any plan already produced, sees a clear message,
  and can retry later (FR-016).
- The image provider fails or refuses a prompt: the shot falls back to a non-generated treatment
  and the plan says so; the user can upload an image instead (FR-017).
- The narration is longer than its shot: the TECHNICAL verdict flags it; the director shortens
  the script or lengthens the shot on the next fix round (FR-018).
- A build fails or is cancelled: no partial file is offered for export; the plan and earlier
  versions are kept; the user can retry.
- The TECHNICAL verdict cannot run (checker error): treated as not passed; export stays blocked
  with an explanation.
- Verdicts disagree (TECHNICAL PASS, CREATIVE FAIL, or the reverse): both are shown as they are;
  neither overrides the other.
- Indonesian text with long words or mixed Indonesian/English: text still fits the frame and stays
  readable on a phone-size screen.
- Machine too slow for the requested length or format: the user is told the expected build time
  before starting and can pick a draft (faster, lower quality) preview first.
- Hard voice failure under a recipe that requires narration: the run stops and reports the error;
  a silent video is never rendered.
- A CPU-only install with no online voice service connected: narration is unavailable, with the
  reason "connect a voice service (for example ElevenLabs or Fish Audio)". A recipe that needs a
  voice shows as unavailable; one that pins the local engine says the local voice needs a GPU
  install.
- A GPU install loses its GPU (driver missing, container started without it): the local voice
  engine stops being offered, and narration uses the connected online service if there is one;
  otherwise it is unavailable, as above.
- A visual-only revision: the existing narration is reused; the voice is never generated again
  unless the script changed.
- A fact's source page can't be reached or doesn't confirm the claim: the fact is marked
  unverifiable and may not appear on screen until the user fixes or removes it.
- The chosen visual concept repeats one used by an earlier project with the same recipe: the
  director must pick a different one before the plan is shown.
- The rendered speech doesn't match the script (a skipped or garbled line): TECHNICAL flags it
  with the line and time.

## Requirements *(mandatory)*

### Functional Requirements

**Brief and plan (Plan before building)**

- **FR-001**: Users MUST be able to start a generation project from a written brief (up to 2,000
  characters), a format (9:16 default, 16:9, 1:1), a target length (5 to 90 seconds), a language
  (Indonesian default, English), and optional style notes.
- **FR-002**: Users MUST be able to attach their own assets to a project (logo, images, brand
  colours, fonts, background music) for the director to use.
- **FR-003**: When the recipe has a `storylines` step, the director MUST first propose as many
  distinct storyline options as that step sets (1 to 5), with a recommendation and its reason.
  When the brief's length is at or under the step's `skipUnderSec`, or the recipe has no such
  step, it MUST go straight to a single plan.
- **FR-004**: The director MUST produce a shot-by-shot plan stating, per shot: purpose, duration,
  on-screen text, visual description, motion, transition, and audio; plus the overall look (palette,
  type, pacing) and sound.
- **FR-005**: Users MUST be able to edit the plan directly or by plain-words requests, and the
  director MUST apply only the requested changes.
- **FR-006**: The system MUST NOT build a draft from a plan the user has not approved, except when
  the user explicitly chooses "build the recommendation without stopping".
- **FR-007**: The plan MUST keep every fact, number, name, and quote from the brief unchanged and
  MUST label anything the director added on its own as an assumption.

**Build**

- **FR-008**: The system MUST build a complete, playable draft video from an approved plan, matching
  the plan's shots, order, text, and durations.
- **FR-009**: Builds MUST show progress, MUST be cancellable, and MUST produce the same video when
  rebuilt from the same plan and assets.
- **FR-010**: When the recipe renders a draft, users MUST be able to watch it before any
  full-quality export. When it renders only at final quality, users MUST be able to watch that
  render before accepting it.

**Two verdicts**

- **FR-011**: Every built draft MUST receive two separate verdicts, TECHNICAL and CREATIVE, each
  PASS, REVIEW, or FAIL, each with findings ranked must-fix / should-fix / polish and linked to a
  shot and time. No single combined score replaces the two verdicts.
- **FR-012**: The TECHNICAL verdict MUST check at least: the video builds and plays end to end; the
  length matches the plan; all planned text appears, stays inside the frame, and is readable on a
  phone-size screen for long enough to read; no blank or frozen stretches beyond what the plan
  intends; the first frame is not empty; audio is present when planned and not clipping. These
  checks run in every recipe: a recipe sets their limits within the allowed ranges and may add
  checks, but can't turn these off.
- **FR-013**: Every CREATIVE verdict MUST ask whether the video communicates the brief's one main
  message, and a failed answer fails CREATIVE. Recipes add their own questions; the examples also
  ask whether it follows the approved storyline and look, the opening holds attention, pacing
  suits the format, and the ending lands (call to action or payoff).
- **FR-014**: Final export MUST be blocked while TECHNICAL is FAIL. When TECHNICAL is PASS or
  REVIEW, the user decides whether to accept regardless of the CREATIVE verdict.
- **FR-015**: Users MUST be able to ask the director to fix findings; each fix round MUST produce a
  new version with fresh verdicts, and earlier versions MUST stay viewable and restorable.

**Director availability, library, publishing**

- **FR-016**: Generation MUST require a configured AI director. When none is configured, the
  Generate area MUST show that it is unavailable and how to connect one, and clipping MUST keep
  working unchanged. When the director fails mid-project, work already done (brief, plans,
  versions) MUST be kept and the user MUST be able to retry once it is back.
- **FR-017**: Visuals MUST be built from text, shapes, icons, charts, and the user's own uploads.
  When an image-generation provider is connected in Settings, the director MAY also generate 2D
  images for shots; the plan MUST mark which shots use generated images, and the user MUST be able
  to swap any generated image for an upload. Without a connected provider, plans MUST use only the
  other sources.
- **FR-018**: Each plan MAY include a narration script. When the user turns narration on, the video
  MUST get a synthetic voiceover in the project's language from that script, with on-screen
  captions matching the spoken words; the user MUST be able to pick a voice and to turn narration
  off. Narration and captions MUST be covered by the TECHNICAL verdict (audible, in sync, not
  clipping).
- **FR-018a**: Narration MUST work with online voice services on every install. At least two must
  be supported (ElevenLabs and Fish Audio), plus any service with the common OpenAI-style speech
  interface. A local voice engine MUST be offered only on installs with a GPU (the same GPU
  setting clipping uses). On CPU-only installs it MUST NOT be offered, installed or selectable,
  even by an imported recipe. Each user picks the service and the voice per language in their own
  Settings.
- **FR-019**: Exported videos MUST appear in Sorot's library alongside clips and MUST be publishable
  through the existing publishing flow with the same required user choices and double-post
  protection.
- **FR-020**: The system MUST draft a title and post description for each exported video from its
  plan, which the user can edit.
- **FR-021**: Users MUST be able to use the feature from both the web UI and the command line.

**Custom pipelines (recipes)**

- **FR-022**: Every project MUST run under a recipe: an ordered list of steps from Sorot's step
  library, each with its own settings. Users MUST be able to create recipes from scratch or from
  an example, and to add, remove, reorder, configure, rename, delete, export and import them
  without code changes.
- **FR-023**: For each step a recipe MUST be able to set its settings and numbers, whether and
  how the pipeline stops there (the user approves, the director decides and records why, or no
  stop), whether it is skipped when a connection is missing, and the user's own instructions for
  that step's director call (added to or replacing Sorot's). A recipe MUST also hold shared rules
  (output size, frame rate, length window, layout, reading rules, defaults to audit, content
  rules) and the creative questions.
- **FR-024**: A project MUST keep a frozen copy of its recipe; editing or deleting a recipe MUST
  NOT change existing projects.
- **FR-025**: A recipe that needs something the install lacks (a voice engine, an image-capable
  model, an image provider, a data source, a custom command) MUST show as unavailable with the
  reason, unless the step is set to be skipped in that case. Other recipes MUST stay usable.
- **FR-035**: Every recipe MUST keep the two working rules: an approved plan before building, and
  both a TECHNICAL and a CREATIVE verdict after rendering. Saving or importing a recipe that breaks
  them, or breaks a step dependency (for example a voice step with no script before it), MUST be
  refused with a reason. Users' instructions MUST NOT be able to change the format the director
  must answer in.
- **FR-036**: Users MUST be able to register their own local check commands in their Settings and
  use them as recipe steps whose findings join a verdict. A recipe MUST only be able to name a
  registered command, never carry one, so importing a recipe can't run anything the user didn't
  register.
- **FR-037**: Sorot MUST ship a few neutral example recipes (at least a quick user-approved flow,
  a narrated factual explainer, and a narrated 2D story) with no personal values: voices, keys,
  accounts and data sources always come from each user's own Settings.

**Facts, narration and the numeric plan**

- **FR-026**: Projects MUST be able to hold facts, each a claim with a source link. In "verify
  only" mode the director MUST check each claim against its source and may correct it but MUST
  NOT add facts. In "research" mode it MAY query data sources the user registered and add facts
  with their source.
- **FR-027**: When the recipe includes the sourced-numbers check, every number shown on screen or
  spoken in the narration MUST match a verified fact (numbers given in the brief count as
  verified), checked by the TECHNICAL verdict. When a brief forbids whole kinds of numbers (for
  example "no market data"), any such number MUST fail TECHNICAL in every recipe.
- **FR-028**: When a recipe uses narration-first timing, the narration script (numbers spelled
  out in words) MUST be written and voiced before the visual plan is timed, and shot timing MUST
  follow the spoken lines. Narration MUST be generated again only when the script changes.
- **FR-029**: When a recipe asks for a numeric plan, every look choice in the plan MUST be a
  number or exact value (colours as hex; font, weight, size and tracking; shadows; easing per role;
  durations and staggers in frames). Each shot MUST state its frame range, its single main move,
  what the viewer reads, and the handoff to the next shot. A per-shot motion plan MUST follow it.
- **FR-030**: When a recipe enables novelty, each project MUST record its visual concept, and the
  director MUST NOT reuse a concept recorded by earlier projects of the same recipe.

**Self-review and final checks**

- **FR-031**: When a recipe enables self-review, before the final render the director MUST look
  at sample frames of every beat. It describes each one as a stranger would and compares it with
  the plan. It audits the recipe's list of defaults and fixes what it finds, up to the recipe's
  round limit. A warning kept on purpose MUST be marked with its reason, and the reason MUST show
  in the verdict.
- **FR-032**: When a recipe sets final-render verdicts, both verdicts MUST be given on the real
  final render (not a draft). TECHNICAL MUST also check the output size, frame rate, length
  window, that the audio is present and loud enough, and that the speech heard in the render
  matches the script, using local speech recognition only.
- **FR-033**: Content rules marked blocking (for example "education, never a buy
  recommendation") MUST count toward the TECHNICAL verdict; other rules count toward CREATIVE.
- **FR-034**: Users MUST be able to keep an idea bank (brief + facts per idea), start an
  unattended run on the next unused idea or resume a named one, and see which ideas are used,
  built and posted (US8). Outside agents MUST be able to do the same through the command line and
  API, with machine-readable output.

### Key Entities

- **Generation project**: one user idea; holds brief, format, length, language, style notes,
  attached assets, and status (planning, planned, building, built, accepted, exported).
- **Storyline option**: one of three proposed directions; pitch, opening, beats, look, sound,
  whether it is the recommended one.
- **Plan**: the approved shot list for a project, with version number and approval state.
- **Shot**: one segment of a plan; purpose, duration, text, visual, motion, transition, audio.
- **Draft version**: one build of a plan version; preview, build status, link to its verdicts.
- **Verdict**: TECHNICAL or CREATIVE; status (PASS/REVIEW/FAIL), findings, who/what produced it.
- **Finding**: severity, shot, time range, description, suggested fix, fixed or kept on purpose.
- **Asset**: a file used by a project (logo, image, font, music, generated image, voiceover);
  records whether the user uploaded it or Sorot generated it.
- **Narration**: optional script per plan, chosen voice, and the matching captions.
- **Recipe**: a named, versioned custom pipeline: ordered steps with settings, gates and
  instructions, plus shared rules and creative questions; an example (read-only) or user-made; a
  frozen copy is stored on each project.
- **Step**: one entry of a recipe, of a type from the step library; it runs once per project or
  per build, depending on its type.
- **Custom command**: a local check script the user registered in their Settings, named by
  recipe steps.
- **Fact**: a claim with a source link, a status (unverified, verified, corrected, unverifiable),
  and the original value when corrected.
- **Data source**: a read-only source the user registered for research mode (for example a
  local database file), named in recipes.
- **Idea**: an entry in the idea bank (brief, facts, status: new, used, built, posted) linked to
  the project made from it.
- **Concept**: the one visual mechanism a project uses, recorded per recipe for the novelty
  check.
- **Exported video**: final file in the library, linked to its project and usable by publishing.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user goes from typing a brief to an approved plan in under 5 minutes for a
  30-second video.
- **SC-002**: A 30-second 9:16 draft is ready to preview within 10 minutes of approving the plan on
  the owner's current machine.
- **SC-003**: 100% of exported videos have a TECHNICAL verdict of PASS or REVIEW; none are exported
  while TECHNICAL is FAIL.
- **SC-004**: In a test set of 20 briefs, at least 80% produce a draft whose TECHNICAL verdict is
  PASS within two fix rounds.
- **SC-005**: In the same test set, at least 70% of drafts are accepted by the owner within three
  versions.
- **SC-006**: All planned on-screen text in exported videos is fully visible and readable on a
  phone-size screen (no text cut off or shown too briefly to read), checked on every export.
- **SC-007**: Rebuilding the same approved plan with the same assets gives an identical video
  every time.
- **SC-008**: The owner publishes at least one generated video per week through Sorot within the
  first month of use.
- **SC-009**: 100% of numbers shown or spoken in exported videos trace to a verified, sourced fact.
- **SC-010**: For every recipe, 100% of exports meet that recipe's own output rules (size, frame
  rate, length window, loudness, speech match where the recipe checks them).
- **SC-011**: A user can change any step, its order, a number or a rule and see it take effect on
  the next project without a code change or restart.
- **SC-012**: A user can rebuild an existing multi-step video pipeline of theirs (at least 10
  steps, with facts, voice, numeric plan, self-review and final checks) as a recipe in under
  30 minutes, without code.
- **SC-013**: An unattended run of a narrated 60-second recipe goes from idea to a checked final
  video with no user input, with render time within the measured reference (about 6 minutes for
  a 58-second 1080×1920 film at final quality), plus planning time.
- **SC-014**: A recipe exported from one install and imported into another runs there with no
  edits other than that install's own connections.

## Assumptions

- The rendering engine is the open-source HyperFrames framework named by the owner, which turns
  web-style compositions into video and supports 9:16, 16:9, and 1:1; Sorot depends on it and on
  its machine requirements being installable locally and in the Docker image.
- "2D" means motion graphics, kinetic text, flat illustration, icons, shapes, charts, simple
  character-free or flat-character animation, and the user's own images; photoreal footage and 3D
  scenes are out of scope.
- The AI director uses Sorot's existing AI connections (LLM, and Jev for judgment where it fits)
  configured in Settings. Generated images need an extra image-generation provider, which is
  optional and onboarded in Settings like the other connections.
- Synthetic voiceover comes from an online voice service the user connects (ElevenLabs, Fish
  Audio, or any compatible service), or, on GPU installs only, from a local voice engine. All
  must support Indonesian, and the local engine's Indonesian quality is checked during planning.
  CPU-only installs (including the CPU Docker image) don't ship a local voice engine at all, so
  they stay small and fast.
- **AI-only mode**: Generate is an AI-only mode under constitution Principle IV (v2.1.0): it
  requires a configured AI director (FR-016), while clipping keeps its rules fallback and never
  depends on Generate. Generated images and synthetic voice are optional extras that degrade
  gracefully (FR-017, FR-018).
- "Plan before building" and "Two verdicts" are the owner's working rules for this feature, as
  defined in the Overview; they are not features of the rendering engine.
- One user, local machine first; hosted use follows the constitution's host-ready rule.
- Length limit of 90 seconds and the 9:16 default fit the short-video platforms Sorot already
  publishes to.
- Existing clipping features stay unchanged; this is a new, separate mode.
- Generated projects and versions are kept until the user deletes them, like videos and clips today.
- The step library and the "narrated explainer" example were shaped by a real unattended agent
  pipeline the owner runs today (idea → facts → narration → storylines + numeric spec → author →
  check and look → render, verify → two verdicts → publish), including its measured render time.
  That pipeline is an example of what recipes must express, not a default or a rule.
- "Anyone" means anyone who runs their own Sorot (it is open source). Each install has its own
  recipes, connections and data. Shared, multi-user hosting stays out of scope (constitution
  Principle I).
- Outside agents and schedulers can drive Sorot through its command line and API, and read the
  per-project files Sorot writes (storylines, spec, motion plan, concept, review).
- Publishing is never automatic: unattended runs stop at a checked final video, and posting uses
  the existing publish flow with its required choices.
