# Sorot desktop: design

The approved-for-review design of the native desktop app (`specs/003-native-desktop-app/`, direction in `design.md`).

**File**: `desktop/design/sorot-desktop.figcraft` (a local figcraft file, not a hosted Figma URL).
Open it with the figcraft app (File > Open), inspect it headless with
`figcraft-cli info desktop/design/sorot-desktop.figcraft`, or drive it through the `figcraft-cli mcp` server.
Text uses Instrument Sans (OFL), loaded per session from `desktop/design/fonts/InstrumentSans.ttf`
(`text.loadFont`), so the file renders the same without installing the font.

## Pages
`Foundations` (variables, text styles, type, space, radius) · `Brand` (icon, tray template, wordmark) ·
`Components` (beam, controls with states, verdict, stage track, clip row and stage, transport, palette, menu bar, rail, toast, dialog, state blocks, icons) ·
`Screens: dark` and `Screens: light` (every screen in `contracts/desktop-screens.md` at 1280x800; home, job, clips, editor also at 1920x1080; plus a states sheet) · `Motion notes`.

Screens are native frames bound to the same `color` variables as the components (light = the `light` mode on the frame), not component instances, so a change to a component is made in both places.
Every value on a screen is a labelled sample ("Pratinjau desain, data contoh" in the menu bar); no number is a real result.

## Exports
| Path | What |
|---|---|
| `tokens.json` | W3C design tokens (`$type`/`$value`), hex verbatim from `design.md`, `color.dark`, `color.light`, `space`, `radius` |
| `tokens.figma.json` | the figcraft `variable.export {format: json}` of the same variables (floats), kept so `verify.ts` can prove both agree |
| `frames/{screen}-{dark\|light}-{w}x{h}.png` | every screen frame, plus `states-*` and `wordmark-light.svg` |
| `../assets/icon/` | `icon-1024.png` (macOS, full bleed), `icns/icon-{16..1024}.png`, `ico/icon-{16,24,32,48,256}.png` (Windows, transparent corners), `icon-512.png` (Linux), `tray-template.svg` (one colour) |
| `../assets/wordmark.svg` | "Sorot" outlines for dark surfaces (`frames/wordmark-light.svg` for light) |

## Rebuild
The file and every export come from one script, so the design is reproducible and reviewable as code:
```
bun desktop/design/gen/build.ts --export     # needs figcraft-cli (FIGCRAFT_CLI, default D:/VibeCoding/figcraft/target/release)
bun desktop/design/gen/verify.ts             # tokens.json == design.md == figcraft export
bun desktop/design/gen/contrast.ts           # WCAG 2.1 contrast of every pair the screens use
```
`build.ts` writes its command script and scratch previews to `.scratch/` at the worktree root (not committed).
Edits made by hand in the figcraft app are lost on the next rebuild; change the generator or stop using it, not both.

## Notes for the code phases
* `fx.md` maps every rune-fx moment (heat glow, grain, ripple, burst, motion blur, fluted glass) to its layer and parameters.
* The file is rewritten by every build: close and reopen it in the figcraft app after a rebuild.
* The icon's one-colour variant is black on transparent; macOS uses it as a template image, Linux tints it.
* `beamText` (not `beam`) is the focus-ring and selected-edge colour, because amber on bone measures 1.64:1 in light mode.
* Rune has no backdrop blur token set yet; the two glass surfaces (transport bar, command palette) are `backgroundBlur` 14 and 20 in the file.

## Contrast (measured by `gen/contrast.ts`)

| Pair | Dark | Light | Need |
|---|---|---|---|
| text on bg (text) | 15.70 | 15.61 | 4.5 |
| text on surface (text) | 14.57 | 16.74 | 4.5 |
| text on raised (text) | 13.23 | 17.61 | 4.5 |
| muted on bg (text) | 7.20 | 6.28 | 4.5 |
| muted on surface (text) | 6.68 | 6.73 | 4.5 |
| muted on raised (text) | 6.07 | 7.08 | 4.5 |
| beamText on bg (text) | 10.35 | 5.46 | 4.5 |
| beamText on surface (text) | 9.60 | 5.85 | 4.5 |
| beamText on raised (text) | 8.73 | 6.16 | 4.5 |
| steel on bg (text) | 7.15 | 5.63 | 4.5 |
| steel on surface (text) | 6.64 | 6.04 | 4.5 |
| steel on raised (text) | 6.03 | 6.35 | 4.5 |
| pass on bg (text) | 8.69 | 4.64 | 4.5 |
| pass on surface (text) | 8.06 | 4.98 | 4.5 |
| pass on raised (text) | 7.33 | 5.24 | 4.5 |
| skip on bg (text) | 6.53 | 5.04 | 4.5 |
| skip on surface (text) | 6.06 | 5.41 | 4.5 |
| skip on raised (text) | 5.50 | 5.69 | 4.5 |
| review on bg (text) | 7.15 | 5.63 | 4.5 |
| review on surface (text) | 6.64 | 6.04 | 4.5 |
| review on raised (text) | 6.03 | 6.35 | 4.5 |
| #17191C on beam (label on beam fill) | 9.51 | same (video stays dark) | 4.5 |
| edge on raised (control boundary) | 4.11 | 4.02 | 3 |
| edge on surface (control boundary) | 4.52 | 3.82 | 3 |
| beamText on bg (focus ring, selected-control edge) | 10.35 | 5.46 | 3 |
| #ECE8E1 on #0E0F11 (text on video) | 15.70 | same (video stays dark) | 4.5 |
| #A39E95 on #0E0F11 (muted on video) | 7.20 | same (video stays dark) | 4.5 |
| #E07A68 on #0E0F11 (error on video) | 6.53 | same (video stays dark) | 4.5 |

all pairs meet their minimum
