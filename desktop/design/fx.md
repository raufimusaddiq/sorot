# rune-fx: signature moments mapped to the design

Owner decision 2026-11-15 (`specs/003-native-desktop-app/design.md`, "rune-fx: signature moments"). This file maps each moment in `sorot-desktop.figcraft` to its rune-fx layer and the starting parameters the design implies.

Status of the numbers: the layer names (`Fx::glow` with `GlowParams::heat`, `Fx::pulse`, `OneShots`, `SparkleParams::burst`, `MotionSamples::from_track`, `FlutedGlassParams { frost }`) come from the owner's table. The values below are what the design file shows. The code phase read Rune at the pinned rev and mapped these onto the real types (`ui/fx_moments.rs`); the springs use Rune's duration/bounce form, so stiffness and damping go through `Spring::from_stiffness_damping`.

Limits that hold for every moment (antislop R-10, R-13, R-19): glow on at most 2 elements per screen, glass on exactly 2 surfaces, no layer on a background, nothing loops, every layer `.reduced()` under reduce-motion, none drawn on the CPU renderer (no-GPU notice, matte fallback).

| Moment | Where in the file | rune-fx layer | Parameters from the design | Reduced motion / CPU fallback |
|---|---|---|---|---|
| Beam head (the active stage) | `Components > Beam` variants `stage` with `heat=cool / warming / hot`; `Screens > job-*` (hot at 62%); `Motion notes` heat row | `Fx::glow` + `GlowParams::heat` driven by a `Heat` light | cool: head 10 px, glow radius 4, 33% alpha. warming: 12 px, radius 10, 60%. hot: 14 px, radius 20, 80%, core `#FFD98F`. Attack fast as `PROGRESS` arrives; exponential cooling when a stage idles (design intent: about 1.5 s to cool one level) | One steady level chosen from the last `PROGRESS` (no cooling animation); CPU: flat head, no glow |
| Beam body | `Beam` falloff rectangles (`stage`, stage track) | grain layer on the beam fill only | density 0.55, grain 1 px, speck colour `#0E0F11` at 20% | Same (a still texture); CPU: omitted |
| Stage completes | `Motion notes` ripple row; `job-*` frame catches the ripple at 0.2 s | `Fx::pulse`, one-shot through `OneShots` | ring from the stage node, 0.6 s, radius 8 to 32 px, opacity 60% to 5%, stroke 1.5 px `beam` | No ripple; the steady done mark fades in over 0.15 s |
| Job completes | `Motion notes` percikan row (4 frames of 0.5 s) | `SparkleParams::burst`, once, on the "Lihat klip" action | 12 particles, 4 px, radial, 0.5 s, 90% to 10% opacity, particles in `beam`; not an icon, no glyph | No burst; "Lihat klip" becomes active with a 0.15 s fade |
| Clip changes rank | `Motion notes` blur sample | `Fx::motion_blur` + `MotionSamples::from_track` on the rank spring (`Spring::from_stiffness_damping(260, 26, 1)`) | one layer per moving row; samples along the spring path around where the row is, source = a whole-viewport copy of the frame (`FxLayer::source(0, viewport)`) handed by one `RankBlur` effect slot after the rows (`El::effect_backdrop(true)`, `EffectPhase::Backdrop`); a second `FxRenderer` draws it so its buffers are not rewritten mid-frame; the copy is in the other colour encoding than the pass, so its `set_srgb_blend` is the opposite of the frame's | Instant move, no blur; CPU: no blur |
| Command palette | `Components > Command palette`; `shell-*` | `FlutedGlassParams { frost }`: glass surface 1 of 2 | frost 20, ribs every 8 px at 5% white, refraction 0.35, depth 10, dispersion 0.08 | Static glass (no entry animation, 0.15 s fade); CPU: a solid `surface` fill |
| Preview transport bar | `Components > Transport bar`; `clips-*`, `editor-*` | `FlutedGlassParams { frost }`: glass surface 2 of 2 | frost 12, same ribs, refraction 0.35, depth 8 | Static glass; CPU: a solid 67% graphite fill |
| Everything else | all other frames | none | matte graphite and bone | n/a |

## What the design file uses to show them

figcraft has no rune-fx. The stand-ins are: a drop shadow with the heat colour and radius for the glow, the `noise` effect for the grain, the `glass` effect plus a row of 1 px ribs for the fluted glass, concentric rings for the pulse, small rotated squares for the burst, and ghost copies at falling opacity for the motion blur. They show where, when and how strong, not the exact pixels.

## Limit check on the frames

| Frame | Glow elements | Glass surfaces |
|---|---|---|
| job | 1 (beam head); the ripple is a ring, not a glow | 0 |
| clips | 0 | 1 (transport bar) |
| editor | 1 (hook head) | 0 |
| shell | 0 | 1 (palette) |
| home | 0 | 0 |
| Components > Beam | one head per variant by design; a screen draws one | 0 |
