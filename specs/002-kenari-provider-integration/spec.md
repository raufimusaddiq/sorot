# Feature Specification: Kenari as Default AI Provider

**Feature Branch**: `002-kenari-provider-integration`

**Created**: 2026-11-02

**Status**: Draft

**Input**: User description: "need to build seamless connection to kenari as primary AI Provider for this projects, but still customizeable. mappthe api in here first https://kenari.id/docs then how we build the seamless integration (just use api key and the info is full in CLI and UI) and we shoutout the to the docs for supporting this project as in email screenshot i give"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Connect with just an API key (Priority: P1)

A Sorot user who wants AI-assisted director, review, and post-copy help pastes a single Kenari
API key into UI Settings, or runs `sorot connect llm` and enters the key at the prompt. They get
working AI assistance immediately, without needing to know or enter an endpoint URL, a model
name, or any other technical detail.

**Why this priority**: This is the core ask — a one-field setup is what makes Kenari "seamless"
instead of just "another provider you can configure." Without this, the feature is no different
from today's existing manual LLM setup.

**Independent Test**: Can be fully tested by entering only a valid Kenari API key (UI or CLI)
on a machine with no prior AI configuration, and confirming AI-assisted features turn on.

**Acceptance Scenarios**:

1. **Given** no AI provider is configured, **When** the user enters a Kenari API key in UI
   Settings, **Then** the system verifies the key, fetches Kenari's current model list, and
   shows it in the same onboarding form with a sensible default (Kenari's automatic routing
   model) already selected — the user can accept the default and finish, or pick a different
   model from the list, without entering an endpoint by hand.
2. **Given** no AI provider is configured, **When** the user runs `sorot connect llm`, chooses
   Kenari, and enters the API key, **Then** the CLI fetches and lists the same model choices,
   lets the user accept the default or pick one, and confirms the connection is active.
3. **Given** an invalid or revoked API key, **When** the user tries to connect, **Then** the
   system shows a clear, non-technical error and does not mark the provider as connected.

---

### User Story 2 - Stay customizable (Priority: P2)

A user who wants a different OpenAI-compatible endpoint (self-hosted model, another gateway) or
who wants to pin a specific Kenari model instead of the automatic default, can see and override
the endpoint and model that the one-field Kenari setup chose, without losing the simple path for
everyone else.

**Why this priority**: The request explicitly asks for "still customizeable" — Kenari must not
become a hard-coded, unchangeable dependency.

**Independent Test**: Can be fully tested by connecting Kenari, then changing the model and/or
endpoint in advanced settings, and confirming subsequent AI calls use the new values.

**Acceptance Scenarios**:

1. **Given** Kenari is connected with its default endpoint/model, **When** the user opens
   advanced provider settings, **Then** they can view and edit the endpoint and model without
   being blocked or required to re-enter the API key.
2. **Given** a different AI provider is already configured, **When** this feature ships,
   **Then** the user's existing configuration is left exactly as it was (see Assumptions).
3. **Given** the user clears the API key, **When** the change is saved, **Then** AI assistance
   turns off and clipping continues using the existing rule-based fallback.

---

### User Story 3 - Credit Kenari's support (Priority: P3)

A maintainer wants the project's public documentation to acknowledge that Kenari granted Sorot
free access (the "Kenari Grant"), matching the thank-you the project received by email.

**Why this priority**: Lowest technical risk, but part of what was asked for, and keeping the
acknowledgment in the same change as the integration avoids it being forgotten later.

**Independent Test**: Can be fully tested by reading the project's public documentation and
finding a short, linked acknowledgment of Kenari's support.

**Acceptance Scenarios**:

1. **Given** this feature has shipped, **When** someone reads the project's top-level
   documentation, **Then** they find a short acknowledgment crediting Kenari, linking to
   kenari.id.

---

### Edge Cases

- What happens when the Kenari API key is revoked or rotated while a clip job is mid-run using it?
- How does the system handle Kenari reporting insufficient balance or an exhausted plan quota
  (an account-level limit, not a code problem) during a job?
- How does the system handle Kenari being unreachable or returning a server-side failure?
- What happens if a user has both a Kenari key and an unrelated custom provider's key entered at
  different times — which one is actually in effect, and is that shown clearly?
- Is the API key ever visible unmasked in the UI, CLI output, or logs after it is saved?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST let a user turn on AI-assisted features (director, review, post copy)
  by entering only a Kenari API key, in both the UI Settings panel and the `sorot connect llm`
  CLI command — no other field required for the common case.
- **FR-002**: System MUST validate a submitted Kenari API key before marking the provider as
  connected, and MUST show a clear, non-technical error when the key is invalid, expired, or
  revoked.
- **FR-003**: System MUST automatically fill in the provider's endpoint with Kenari's value once
  a valid Kenari key is entered, so the user never has to know or type it.
- **FR-004**: Users MUST be able to see and override the automatically-chosen endpoint and
  model, so the project keeps working with any compatible provider — Kenari is the default,
  not the only option.
- **FR-005**: System MUST mask the Kenari API key everywhere it is displayed or logged,
  consistent with how other provider keys are already handled.
- **FR-006**: System MUST keep working with rule-based behavior (no AI) whenever the Kenari
  connection is unset, invalid, or a call fails — clipping MUST NOT depend on Kenari being
  reachable.
- **FR-007**: As part of the same connection form (UI and CLI), once the Kenari API key is
  validated, the system MUST fetch Kenari's current model list and let the user pick a model
  from it, with a sensible default (Kenari's automatic routing model) pre-selected so accepting
  the default requires no extra step.
- **FR-008**: System MUST NOT alter or replace an already-configured, different AI provider's
  settings when a Kenari key is entered. Kenari only becomes the active provider when no
  provider is already configured, or when the user explicitly switches to it afterward (User
  Story 2).
- **FR-009**: The same Kenari connection (one API key and configuration) MUST be the default
  provider for both the optional clipping-path AI assists (director, review, post copy) and
  Generate's AI-only director — one connection step covers both.
- **FR-010**: The project's public-facing documentation MUST include a short acknowledgment
  crediting Kenari for supporting Sorot's development, with a link to kenari.id.
- **FR-011**: This integration MUST be additive — it MUST NOT require or replace the project's
  separate Jev or Tebar connections, which keep using their own API keys.

### Key Entities

- **AI Provider Connection**: the stored configuration deciding which AI service answers
  director/review/copy and Generate's director calls — holds which provider is active (Kenari
  or a custom one), an endpoint, a model choice, and a masked key. One active connection at a
  time, shared by both call sites.
- **Kenari Model Catalog (fetched)**: the live list of models Kenari currently offers, read at
  connection time to populate the onboarding model picker; not stored beyond the chosen model.
- **Acknowledgment entry**: a short credit and link to Kenari placed in the project's public
  documentation.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user with only a Kenari API key goes from "no AI configured" to "AI-assisted
  clipping active" in under 2 minutes, through either the UI or the CLI, without reading
  external setup docs.
- **SC-002**: 100% of existing clipping functionality keeps working unchanged for a user who
  never enters a Kenari key — AI stays fully optional.
- **SC-003**: A user who wants a non-Kenari provider can fully override the connection
  (endpoint, model) in under 5 UI steps or one CLI command, with no code changes.
- **SC-004**: An invalid or revoked Kenari key produces a clear, actionable error — never a
  silent failure or a raw technical error — in 100% of connection attempts.
- **SC-005**: The project's documentation publicly credits Kenari's support in the same change
  that ships this integration.

## Assumptions

- "Primary AI Provider" means the project's existing optional LLM integration points (director,
  review, post copy) plus Generate's AI-only director, sharing one connection (FR-009). It does
  not mean the separate Jev judging system or the Tebar publishing integration, which use their
  own protocols and stay independent (FR-011).
- Kenari exposes an OpenAI-compatible chat endpoint and a model-listing endpoint, matching the
  project's existing "any OpenAI-compatible endpoint" design, so no new provider protocol needs
  to be built — only a default configuration and a simplified, model-picking setup path.
- The Kenari API key is stored and masked the same way existing provider keys are, per the
  project's existing secret-handling rules.
- "Seamless" means no endpoint or technical field to fill in by hand, and a working default
  model pre-selected — not that model choice disappears; the user picks from a live list during
  the same setup step, and can still change endpoint/model later (User Story 2).
- If fetching Kenari's model list fails during setup (e.g. Kenari temporarily unreachable), the
  connection form falls back to the automatic-routing default model and lets the user finish
  connecting, rather than blocking setup entirely.
- The Kenari acknowledgment is a documentation change (e.g. a README or changelog credit), not
  an in-product UI element — the request's "shoutout" was about crediting the grant the project
  received, not a requirement found in Kenari's own API documentation.
- Jev and Tebar continue to use their own separate API keys and are unaffected by this change.
