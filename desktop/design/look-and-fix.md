# Look-and-fix review (T077)

Each scene was rendered with `--snap` in both themes and set beside its frame in `design/frames/`.
The approved images are `tests/snapshots/*.png` (made with `SOROT_APPROVE=1 cargo test --test snapshots`
after this review; the test then holds them). Scene to frame: `job-running` to `job-*`,
`clips-ranked` to `clips-*`, `editor-hook` to `editor-*`, `home-empty` to `home-*`,
`readiness-missing` to `readiness-*`, `first-run` to `welcome-library-*`, `engine-failed` to none.

## What matches the design, and how it was checked

| Piece | Verdict | Evidence |
|---|---|---|
| Beam on the job (one per screen, grain on the fill only, hot head dot, falloff toward the tail) | matches | `job-running` snapshots; `ui/beam.rs` debug-asserts one per screen |
| Beam head glow (heat 0 cool to 1 hot: radius 4 to 20 pt, 33% to 80%) | drawn by `rune_fx::Fx::glow`; snapshots are at rest (cool) | `fx_moments` tests; `tests/us3_screens.rs` warms and cools it |
| Stage-done ring, job-done sparkle | one-shots, gone after 0.6 s / the burst life; not in the at-rest snapshots by design | `design_rules.rs` |
| Transport bar glass | on the clips and editor stage only; matte `surface` fill under it (CPU fallback) | `design_rules.rs` counts glass 1 on clips and editor, 0 elsewhere |
| Hook beam on the editor timeline (variant `hook`) | matches | `editor-hook` snapshots |
| Tokens (bg, surface, raised, divider, text, beam, pass, skip) | match | the screens read `theme/sorot.json`; `core::contrast` holds the ratios |
| Hover 120 ms, press 1 px (scale 0.985), rank spring 260/26 | in `ui/kit.rs`, `ui/fx_moments.rs` | `tests/motion.rs` |

## Per-screen status (round 2)

Round 2 landed the shell and the language layer; every screen's own re-skin is a separate ticket.
"matches" means layout, hierarchy and tokens equal the frame; otherwise the differences are named.
The 28 px display title with its one-line subtitle, the 104 px content gutter and Indonesian copy are
common to every frame; the screens below still use the smaller title, the old gutter and English copy
unless a row says otherwise.

| Screen (scene, frame) | Status | Differences |
|---|---|---|
| Shell: menu bar, rail, logo (all scenes, `shell-*`) | matches | Menu bar (Berkas, Sunting, Tampilan, Jendela, Bantuan) with working lists, 64 pt rail, the approved icon (`assets/icon/icon-512.png`) at 32 pt, Indonesian labels from `i18n/id.json`, English from `en.json`. The frames' "Pratinjau desain, data contoh" note is the design file's own label and is not shipped. Generate has no screen, so the rail omits it (R-24) |
| Home (`home-empty`, `home-*`) | differs | No right "Opsi impor" card with dropdowns and toggles (the options are a sheet); no "Terakhir dipotong" list; English copy; no dashed drop field |
| Job (`job-running`, `job-*`) | differs | Beam, head glow and stage ring match; missing the large percent beside the stage name, the "Catatan terakhir" panel, the elapsed time sentence and the disabled "Lihat klip" action; English copy |
| Clips (`clips-ranked`, `clips-*`) | differs | Missing the filter tabs (Semua, PASS, REVIEW, SKIP), row thumbnails, the score bar, outlined verdict pills, the subtitle sample on the stage, Terbitkan and "Tampilkan di folder" placement; the transport bar sits under the stage, not on it; English copy |
| Clip editor (`editor-hook`, `editor-*`) | differs | No waveform timeline (the hook is a beam on a plain bar), options are buttons not dropdowns and toggles, the options card and the Batal / "Render ulang klip" footer are missing; English copy |
| Publish (`publish`, `publish-*`) | differs (round 3) | Now: 28 pt title, 40 pt gutter beside the rail, Indonesian copy, TikTok / YouTube tabs, right column with "Akun tersambung" and "Posting sebelumnya", send time in date boxes. Left: choices are chips, not a privacy dropdown (Rune has no select); the right card is 360 pt, not full height; "Video Generate" card is the labelled placeholder until the Generate window exists |
| Settings connections, Generate settings (`connections`, `generate-settings`) | differs (round 3) | Now: display title, Indonesian copy, Koneksi / Generate tabs, Kenari picker and balance, voice, images and commands cards. Left: the "Umum" tab (T082), one card with divided rows (they are separate cards), dropdowns for the per-role models (text fields), no field-by-field pass |
| Learning, Discover (`learning`, `discover`) | differs (round 3) | Now: display title, Indonesian copy, posted-day column, predicted / enriching score, picked-by chip, "+N more", YouTube link, auto-run log. Left: the Discover frame is a single search with an Import row per video (the app keeps its four modes and filters); no field-by-field pass |
| Readiness, first run, engine failed, states | differs | Indonesian copy and display title are missing; the rail now matches |

## What the beam and moments cover

Everything in the first table above holds on these screens too: one beam per screen, glow only on the
beam head, glass only on the transport bar (palette ready), one-shots only at their moments, nothing
animating at rest (`tests/design_rules.rs`).

## Rank blur (done)

Rows that change rank are blurred along their spring. The pinned Rune has no node capture, but a
`RankBlur` effect slot with `El::effect_backdrop(true)` receives a copy of the frame drawn so far; the
blur samples it as a whole-viewport source (`FxLayer::source(0, viewport)`). A second `FxRenderer` draws
it, because its buffers would be rewritten mid-frame if the first did. See `fx.md`. The `clips-reranked`
scene captures it: its snapshot is taken at the first frame of the move.

## Fixes made in this pass

- The stage track cell narrowed from 84 to 72 pt so 11 stages fit the 960 pt minimum width (reflow rows).
- The stage rail is one beam component instead of a plain bar.
- A CPU renderer draws no layer and turns the notice on; previews go to the video player on Play.
- The menu bar and the rail follow the frames; the rail's content area no longer forces full height under the bar.
