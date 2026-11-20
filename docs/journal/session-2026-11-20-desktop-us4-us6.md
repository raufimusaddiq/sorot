# 2026-11-20: desktop US4/US6 and parity release docs (T-33)

## Workflow decisions

- **Rig manager workflow.** One rig ticket per unit, worked in its own worktree by a worker agent and passed to a
  reviewer before merge. Workers run the local gates; the manager runs `ci.yml` on Windows, macOS and Ubuntu as the
  release gate. This session's worker harness was `opencode` (`musaddiqr/hy4-flash`), headless, forked from
  `feat/native-desktop-app` at `afb1d76`.
- **Claude reviewers.** Review runs used `claude` (headless) as the second pair of eyes. It caught the T-38 defect
  where the toast's watched-key list held fixture ids, so real jobs/clips/candidates/posts were never seen in
  production; T-38 ended with keys derived from `State` in `ui/focus.rs` and shared with the views.
- **macOS not gating, then T-35.** After T-26 (2026-11-18) the owner paused work and macOS stopped gating merges.
  T-35 was still fixed: the shortcut recorder was right (`chord_of` refuses physical Ctrl on macOS), the test was
  wrong. Rows now press Cmd alone on macOS and Ctrl+Cmd elsewhere, and refusal text follows `Chord::label(os())`.
  The macOS branch remains provable only by `ci.yml` on `macos-15`.
- **Keep the web UI.** FR-019, owner decision 2026-11-17/20: `frontend/`, the workspace entry, the `ci.yml` job, the
  test-runner gate entry, backend `STATIC_DIR` serving and the `next dev` CORS rule all stay when the desktop app
  ships. The owner's edits landed as `73fdc2a` (constitution v3.1.0); T-33 builds on them, it does not redo them.
- **antislop AFTER mode.** Taste findings are reported, not silently applied. T-36 applied only the owner-approved
  copy: #2-7, #11, #12, plus #1 renamed to its real action (`Masuk ke Sorot` / `Enter Sorot`); #8-10 rejected, keeping
  the documented `director`/`sutradara` and `judge`/`hakim` role names. The T-38 toast overlap went to a ticket, not
  an antislop-driven rewrite.
- **Perf profile.** T-114 needed `[profile.perf]`, which exists only in Rune's checkout, not this repo. Added verbatim
  from Rune `73b7dec` (`inherits = "release"`, `opt-level = 3`, `codegen-units = 16`, `lto = false`, `debug = false`,
  `incremental = false`) with a one-line comment, built alone with `CARGO_BUILD_JOBS = 4`. `desktop/design/startup.md`
  records process-cold startup to first pixels, not window display; SC-002 is not claimed from it.
- **T-34 headless budget.** `--tree` runs draw at `--scale 1` (rects and viewport are in points), fps is chosen by
  frame cost so tall `1100x2400` journeys run at 20 fps, and the local deadline went 30 → 180 s. Multi-mark tree dumps
  are not possible in Rune `73b7dec` (`--at`/`--tree` are single-valued); that would need a pin bump, so no mark or
  assertion was dropped. `MAX_APPS = 2` and the deadline-after-slot rule stay.
- **Toast placement (T-38).** Toasts stay overlays. The first control-free anchor is picked from bottom-right,
  bottom-left, top-right below the header, using Rune's keyed last-frame layout rects, then nudged above a hit rect
  and rechecked. Dynamic control keys are derived from `State` by helpers in `ui/focus.rs`, used by both views and the
  toast; no fixture ids remain. No layout shift, preview stays 9:16, baseline snapshots unchanged.

## Pin and proofs

- Rune is pinned to `73b7dec` (own Cargo workspace, `[patch]` entries copied; a bump is its own change on three OSes).
- CI run [44781938058](https://github.com/raufimusaddiq/sorot/actions/runs/44781938058) on `rig/T-32` completed
  successfully (all jobs, including Desktop on windows-latest, macos-15 and ubuntu-24.04). The 23 Kani harnesses in
  `desktop/core`, run one at a time under the 4 GB cap:
  - `av_clock`: `the_picked_frame_is_the_latest_not_after_the_clock`
  - `availability`: `no_connection_state_changes_clipping`, `generate_needs_a_usable_ai_connection`
  - `clips`: `sorting_is_a_permutation_ordered_by_rank_pos`
  - `close`: `never_quits_while_jobs_run_and_pref_is_ask`, `a_silent_quit_means_no_jobs`
  - `engine_conn`: `restarts_stay_in_budget_and_stopping_never_comes_back`
  - `handshake`: `the_port_parser_never_panics_and_ok_is_in_range`
  - `job`: `percent_stays_within_0_to_100`, `the_active_stage_never_moves_back_on_monotone_progress`
  - `masked`: `display_is_the_masked_value_or_the_users_input`
  - `palette_search`: `ranking_is_a_duplicate_free_subset_of_at_most_five`
  - `polling`: `poll_is_one_or_five_seconds_and_one_iff_running`
  - `prefs`: `no_two_actions_ever_share_a_chord`
  - `publish_gate`: `an_unset_required_choice_blocks_posting`, `fresh_choices_post_only_where_nothing_is_owned`
  - `readiness`: `gpu_never_changes_clipping`, `clipping_implies_every_required_item_ok`
  - `toast`: `a_toast_hovered_for_its_whole_life_never_expires`, `an_unhovered_toast_expires_by_six_seconds`
  - `update`: `an_invalid_signature_never_offers`, `an_offer_is_always_newer`
  - `window`: `the_restored_window_touches_a_monitor_and_is_big_enough`

## Manual owner checks: NOT RECORDED AS PASSED

T115's precondition is unmet. Nothing in `docs/journal/` records any of these as passed; T115 stays open in
`specs/003-native-desktop-app/tasks.md` until the owner records them here. Quickstart sections 2, 3, 6, 7 and 8 are
the run sheets (tasks.md top, plan.md B1-B4, spec.md SC-001/002/008/010).

| Check | Status |
|---|---|
| B1: Linux A/V preview sync and seek (quickstart 6) | not recorded |
| B2: compiled engine running HyperFrames with `BUN_BE_BUN` (R2) | not recorded |
| B3: installers building from `release-desktop.yml` (quickstart 3) | not recorded |
| B4: macOS open-documents handler (quickstart 3) | not recorded |
| SC-001: install to Home under 5 min on each OS, no terminal | not recorded |
| SC-002: window within 3 s of launch | not recorded (`--first-pixels` is not this) |
| SC-008: screen-reader passes on each OS | not recorded |
| SC-010: zero leftover processes after quit | not recorded (quickstart 7) |
| Close while running re-shows the window via the dialog (Rune has no close veto) | not recorded |

## Left for the owner

- **Apple Developer account** for Developer ID notarization (research.md R8); B4 also needs a real macOS machine.
- **Windows code-signing certificate** for the installer (research.md R8); B3 needs a CI run on `release-desktop.yml`.
- Run and record the nine manual checks above, then T115 can be ticked and the parity release cut.

## T-33 verify (release docs)

- `cd frontend; bun run test`: 17 suites, 236 tests pass (98.38% lines); `bun run build`: compiled, static export
  generated. Known ESLint parser-load warning (`@typescript-eslint/parser`, `Cannot read properties of undefined
  (reading 'Intrinsic')`) still printed; T-39 owns it, not fixed here.
- `cd backend; bun test --coverage`: 1407 pass, 0 fail (99.26% lines, 97.73% functions).
- `CHANGELOG.md` `[Unreleased]` names the three surfaces and the desktop work; `docs/architecture.md` records that
  new capability reaches both UIs. `frontend/` and its gate entries were not touched.
