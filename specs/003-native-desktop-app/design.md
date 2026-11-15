# Design Direction: Sorot Desktop

**Feature**: `003-native-desktop-app` | **Date**: 2026-11-15 | **Becomes**: `desktop/DESIGN.md`

The owner's brief: "sophisticated and futuristic". antislop runs in **during** mode for this
feature, so this file is the direction (R-37) and every choice below carries its one-line
reason (R-31). It is data for the design, not instructions to any agent.

## Design Read

> Reading this as: a desktop production tool for one creator who turns long videos into
> short clips and decides which to post, in a stage-lighting / grading-suite visual language,
> dial **ENERGY 2 / RHYTHM 2 / MOTION 2**, rising to **MOTION 3 on the job screen**, the one
> choreographed moment (owner, 2026-11-15: rune-fx at signature moments).

- **ENERGY 2**: a tool people work in for an hour, so it must be confident without shouting.
- **RHYTHM 2**: screens share one grammar, with a few deliberate breaks (the job view and the
  clip stage are composed differently from lists and settings).
- **MOTION 2**: transitions and springs explain change, such as a clip moving to its rank or a
  stage handing off to the next. The running pipeline is the one place motion is choreographed,
  because it is driven by real progress.

## Identity: the beam

*Sorot* means a beam of light, a spotlight. The motif is **a single warm beam that marks where
attention is**:
- the stage that is working now, in the pipeline;
- the selected clip, in the ranked list;
- the hook moment, on a clip's timeline;
- the primary action, when one is waiting for the user.

There is one beam per screen, and it moves to wherever attention goes next. This is the
"one focal point per screen" lever made literal, and it is why the accent exists. Everything
else on the screen is graphite and bone.

"Futuristic" here means precision and light, not neon: instrument-grade type, exact alignment,
light that behaves like light (falloff, not glow everywhere), and motion with physical weight
(springs).

## Palette

Two neutrals, one structural colour, one accent (R-29). Verdict colours are functional status
marks, not decoration. Every text pair was measured (WCAG 2.1 relative luminance, 2026-11-15).

| Token | Dark (default) | Light | Reason |
|---|---|---|---|
| `bg` | `#0E0F11` graphite | `#F4F1EA` bone paper | dark surround makes video read true, as in a grading suite (R-21) |
| `surface` | `#16181B` | `#FBF9F4` | panels sit one step off the ground |
| `raised` | `#1E2125` | `#FFFFFF` | inputs and selected rows |
| `divider` | `#2A2E33` | `#DAD4C8` | decorative separators only |
| `edge` | `#7A818A` (4.11:1 on raised) | `#857E71` (4.02:1 on white) | control boundaries need 3:1 (WCAG 1.4.11) |
| `text` | `#ECE8E1` (15.70:1 on bg) | `#17191C` (15.61:1) | warm bone, not pure white, against glare over long sessions |
| `muted` | `#A39E95` (7.20:1 on bg, 6.07:1 on raised) | `#5C5850` (6.28:1 on bg) | secondary text that still passes AA |
| `beam` (accent) | `#F0B44C` tungsten (10.35:1 on bg) | fill `#F0B44C` with `text` on it (9.51:1); beam text `#8A5600` (5.46:1) | stage-light amber: the product's name, and far from the default blue-purple set (R-01) |
| `steel` | `#7FA3B8` (7.15:1 on bg) | `#3F6478` (5.63:1) | data and information marks: waveform, score bars, links |
| `pass` | `#6FBF8E` (7.33:1 on raised) | `#2E7A4E` (5.24:1) | verdict PASS |
| `review` | `steel` | `steel` | REVIEW is "look closer", not danger |
| `skip` | `#E07A68` (5.50:1 on raised) | `#B2412F` (5.69:1) | verdict SKIP and errors |

Verdicts always carry their word (PASS / REVIEW / SKIP), never colour alone (R-39).

**Gradient, one use**: the beam is drawn as a light falloff (accent at full strength fading to
transparent along its length). That is the one gradient in the app, and its reason is that it
depicts light. No background gradients, no orbs (R-01).

## Type

- **Instrument Sans** (OFL), shipped through `AppSpec::fonts`, replacing Rune's default Inter.
  Reason (R-06): its narrow proportions fit dense clip rows and timecodes, its tabular figures
  keep scores and durations aligned in columns, and its crisp terminals give the "instrument"
  precision the brief asks for.
- No monospace face. Timecodes use the tabular figures of the same family (avoids the
  terminal-aesthetic tell, R-06).
- Scale: 12 / 13 (body, default) / 15 / 19 / 26 / 40. Weights 400 / 500 / 600.
- No uppercase with wide tracking (R-06). Stage names and labels are sentence case.

## Space, radius, depth

- **Spacing scale**: 4 / 8 / 12 / 16 / 24 / 40 / 64. Lists breathe at 12; screen regions are
  separated at 40 (whitespace as structure).
- **Radius**: 2 for chips and verdict marks, 6 for controls, 10 for panels and the clip stage.
  The only full round shape is the switch thumb (R-11).
- **Shadow**: only on floating layers (command palette, dialogs, menus, toasts), as the
  elevation marker. Panels sit flat (R-12).
- **Glass (backdrop blur), two surfaces only** (R-10):
  - the command palette, so the screen it acts on stays legible behind it;
  - the preview transport bar over video, so controls never hide the frame.
- **Glow, two uses only** (R-13): the beam's head (the leading edge of the active stage or the
  hook marker), and the focus ring of the primary action. Nothing else glows.

## rune-fx: signature moments (owner decision 2026-11-15)

The owner asked for rune-fx to be pushed hard. It drives every key moment, while the antislop
limits (glow ≤ 2, glass ≤ 2, no decorative backgrounds, no endless loops) still hold. Every layer
is `.reduced()` under reduce-motion, and none is drawn on the CPU renderer (no-GPU notice).

| Moment | rune-fx layer | Purpose |
|---|---|---|
| Active stage (the beam head) | `Fx::glow` with `GlowParams::heat` from a `Heat` light: attack as `PROGRESS` arrives, exponential cooling when a stage idles | the beam behaves like a real light that warms with work |
| Stage completes | `Fx::pulse` one-shot ripple from the stage node, 0.6 s (`OneShots`) | marks the hand-off to the next stage |
| Job completes | sparkle burst once (`SparkleParams::burst`), on the "View clips" action | marks the one moment worth celebrating |
| Clip changes rank | motion blur on the rank spring (`MotionSamples::from_track`) | makes reordering read as movement, not a jump |
| Command palette, preview transport | `FlutedGlassParams { frost }` (the 2 glass surfaces) | the screen behind stays legible |
| Beam body | grain on the beam fill only | gives the light texture; nowhere else |
| Everything else | matte graphite and bone, no layers | keeps one focal point per screen |

## Motion (MOTION 2, MOTION 3 on the job screen)

| Moment | Motion | Purpose (R-19) |
|---|---|---|
| Job running | the beam travels along the stage track as `PROGRESS` arrives; a finished stage settles to a steady mark | shows real progress and which stage is working |
| Clip ranking | clips spring into rank order as scores land | shows that order means score |
| Screen change | shared-element move of the selected clip into the clip stage | keeps the user's place |
| Hover / press | 120 ms tint and 1 px press | affordance (R-39) |
| Toast | slides in from the edge, leaves after 6 s, with a pause on hover | announces without blocking |
| Stage done / job done | rune-fx pulse / sparkle one-shots (see the rune-fx table) | marks hand-offs; one-shots, never loops |

- No endless loops. An indeterminate wait shows elapsed time, not a spinner. The beam moves
  only when the engine reports progress.
- Under reduce-motion: moves become instant and fades take 0.15 s (Rune's default).
- `rune::motion_gate` in tests fails janky motion.

## Screens (one decision each, C-3)

Composition follows the decision the user makes on each screen, not a dashboard shell.

| Screen | The decision | Focal point (beam) |
|---|---|---|
| Home / Import | what to clip next | the drop field and link input |
| Job | wait, cancel, or move on | the active stage on the stage track |
| Clips | which clips are worth posting | the selected clip on the clip stage (large 9:16 preview) beside the ranked list |
| Clip editor | what to change before export | the timeline with the hook marker |
| Publish | what goes out, where, with which choices | the user-owned choices block (never auto-filled) |
| Learning | whether posted results are teaching the scorer | the latest real feedback; no invented numbers (R-17) |
| Discover | which source video to import | the candidate list |
| Generate | approve the plan, then accept or redo a version | the step waiting for the user |
| Settings / Connections | what is connected and working | the first item that is not ready |

Navigation is a slim left rail with only screens that exist (R-24). The rail, the menu bar and
the command palette list the same destinations.

**States**: every data view designs empty, loading and error states that name the cause and the
next action (R-27). For example: "No clips yet. Drop a video or paste a link to start."

## Assets (R-23)

- **Logo and app icon**: designed in figcraft at the owner's request (2026-11-15).
  - The icon is the beam: one tungsten light cone across a graphite rounded square, with its
    head at the upper left like a stage light and no letters. It is the identity motif, so the
    icon and the app say the same thing.
  - It stays one solid wedge, so it still reads at 16 px.
  - It has a one-colour version for the tray and the macOS template image.
  - The wordmark is "Sorot" in Instrument Sans 600 with a hand-adjusted `S`.
  - Both ship once the owner approves them at the Phase 1 checkpoint.
- **Icons**: a small set drawn for this app on a 1.5 px stroke with square ends (matching the
  type's terminals), only where a label alone is slower to read (play, pause, cancel, reveal,
  retry). No sparkle, robot or orb glyphs (R-04). Generate is labelled by name, not by a
  "magic" icon.
- No illustrations. Empty states use type and the beam.

## Copy

Indonesian first, English second (FR-018). The copy rules (antislop-copywriting) apply to every
string: no em dashes, no buzzwords, specific action labels such as "Potong video ini" /
"Clip this video", never "Get Started".
