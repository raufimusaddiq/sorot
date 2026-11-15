# Look-and-fix review (T077)

Each scene was rendered with `--snap` in both themes and set beside its frame in `design/frames/`.
The approved images are `tests/snapshots/*.png` (made with `SOROT_APPROVE=1 cargo test --test suite snapshots::`
after this review; the test then holds them). Scene to frame: `job-running` to `job-*`,
`clips-ranked` to `clips-*`, `editor-hook` to `editor-*`, `home-empty` to `home-*`,
`readiness-missing` to `readiness-*`, `first-run` to `welcome-library-*`, `engine-failed` to none.

## What matches the design, and how it was checked

| Piece | Verdict | Evidence |
|---|---|---|
| Beam on the job (one per screen, grain on the fill only, hot head dot, falloff toward the tail) | matches | `job-running` snapshots; `ui/beam.rs` debug-asserts one per screen |
| Beam head glow (heat 0 cool to 1 hot: radius 4 to 20 pt, 33% to 80%) | drawn by `rune_fx::Fx::glow`; snapshots are at rest (cool) | `fx_moments` tests; `tests/us3_screens.rs` warms and cools it |
| Stage-done ring, job-done sparkle | one-shots, gone after 0.6 s / the burst life; not in the at-rest snapshots by design | `design_rules.rs` |
| Transport bar glass | on the clips stage only; matte `surface` fill under it (CPU fallback) | `design_rules.rs` counts glass 1 on clips, 0 elsewhere |
| Hook marker on the editor timeline (a vertical line, its dot and "Hook m:ss") | matches | `editor-hook` snapshots; the hook is the editor's beam: a line fading from amber to clear and a head dot with the glow; no transport bar, so `design_rules.rs` counts glass 0 and glow 1 there |
| Tokens (bg, surface, raised, divider, text, beam, pass, skip) | match | the screens read `theme/sorot.json`; `core::contrast` holds the ratios |
| Hover 120 ms, press 1 px (scale 0.985), rank spring 260/26 | in `ui/kit.rs`, `ui/fx_moments.rs` | `tests/motion.rs` |

## Per-screen status (round 2)

Round 2 landed the shell and the language layer; every screen's own re-skin is a separate ticket.
"matches" means layout, hierarchy and tokens equal the frame; otherwise the differences are named.
The 28 px display title with its one-line subtitle, the 104 px content gutter and Indonesian copy are
common to every frame. Home, Job, Clips and the editor have them (T-19); the other screens still use the smaller title, the old gutter and English copy
unless a row says otherwise.

| Screen (scene, frame) | Status | Differences |
|---|---|---|
| Shell: menu bar, rail, logo (all scenes, `shell-*`) | matches | Menu bar (Berkas, Sunting, Tampilan, Jendela, Bantuan) with working lists, 64 pt rail, the approved icon (`assets/icon/icon-512.png`) at 32 pt, Indonesian labels from `i18n/id.json`, English from `en.json`. The frames' "Pratinjau desain, data contoh" note is the design file's own label and is not shipped. Generate has no screen, so the rail omits it (R-24) |
| Home (`home-empty`, `home-*`) | matches, one named difference | 28 pt title and subtitle, 104 pt gutter, dashed drop field, link and "Potong video ini" row, direction box with its note and counter, "Opsi impor" card (dropdowns, switches), "Terakhir dipotong" two-column list, all copy from `i18n/*.json`. Difference: the frame's "Rentang waktu" and "Bahasa subtitel" dropdowns are not engine import options (`ImportRequest` has no range or language), so the card holds Gaya subtitel and Pembingkaian in their place |
| Job (`job-running`, `job-*`) | matches, one named difference | Video name as title, large percent beside the stage name and what it does with the running time, stage rail with marks on the beam and the percent under the running stage, "Catatan terakhir" (finished stages and the running report), Batalkan (Ctrl+.) and the disabled "Lihat klip" with its note. Difference: eleven engine stages at 72 pt each, where the frame draws seven across the row |
| Clips (`clips-ranked`, `clips-*`) | matches, one named difference | Filter tabs, rows with rank, thumbnail, title, duration and hook, outlined verdict pill, score bar and two-decimal score (comma in Indonesian), beam line on the chosen row, stage with the sample caption and the transport bar on it, Edit klip, Ekspor (Ctrl+E), Terbitkan (opens the publish panel), Tampilkan di folder after an export, Catat hasil unggahan (opens the results sheet above the stage). Difference: the row thumbnails are empty frames, the engine serves no thumbnails |
| Clip editor (`editor-hook`, `editor-*`) | matches, one named difference | Stage, Linimasa with the hook marker and its time, Opsi klip card (two dropdowns, two switches, music dropdown), Batal and "Render ulang klip". Difference: the waveform is a stand-in shape drawn from the clip's id, the engine reports no audio peaks, and without trim handles the frame's "Tarik gagang" line is not shown |
| Publish (`publish`, `publish-*`) | differs (round 3) | Now: 28 pt title, 40 pt gutter beside the rail, Indonesian copy, TikTok / YouTube tabs, right column with "Akun tersambung" and "Posting sebelumnya", send time in date boxes. Left: choices are chips, not a privacy dropdown (Rune has no select); the right card is 360 pt, not full height; "Video Generate" card is the labelled placeholder until the Generate window exists |
| Settings connections, Generate settings (`connections`, `generate-settings`) | differs (round 3) | Now: display title, Indonesian copy, Koneksi / Generate tabs; the Generate frame shows the voice card with the Kenari model and voice pickers (the images and commands cards sit below the 800 px fold, and the Kenari balance sits on the Koneksi card; none of those three is in a frame, they are covered by L2 tests). Left: the "Umum" tab (T082), one card with divided rows (they are separate cards), dropdowns for the per-role models (text fields), no field-by-field pass |
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
