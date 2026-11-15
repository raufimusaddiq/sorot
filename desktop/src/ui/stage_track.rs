//! The stage track of a job: one cell per pipeline stage, the beam on the active one. The beam sits
//! where the engine last said it is (a stage's `PROGRESS` text, "Transcribing 37%"); it does not
//! creep on a timer, so a stuck stage looks stuck.

use rune::tok::type_;
use rune::{El, col, row, text};
use sorot_desktop_core::job::{JobView, StageState};
use sorot_desktop_core::model::JobStage;

use crate::i18n::{Lang, tr};
use crate::ui::beam::{Variant, beam};
use crate::ui::fx_moments::{Moment, slot};
use crate::ui::kit::pal;

pub const CELL: f32 = 72.0;

/// The name a person reads for an engine stage id (an unknown id reads as itself).
pub fn stage_name(lang: Lang, id: &str) -> String {
    let key = format!("stage.{id}");
    let words = tr(lang, &key);
    if words == key { id.to_string() } else { words }
}

/// What a stage reports while it runs: the words, and the percent when they end in one.
pub fn progress_of(output: &str) -> (String, Option<u8>) {
    let text = output.trim();
    match text.strip_suffix('%').and_then(|t| t.rsplit_once(' ')) {
        Some((label, n)) => match n.parse::<u8>() {
            Ok(n) if n <= 100 => (label.to_string(), Some(n)),
            _ => (text.to_string(), None),
        },
        None => (text.to_string(), None),
    }
}

/// The running stage's report from the job's stage rows.
pub fn running_report(view: &JobView, stages: &[JobStage]) -> Option<(String, Option<u8>)> {
    let active = view.stages.get(view.active?)?;
    if active.state != StageState::Active {
        return None;
    }
    let out = stages.iter().find(|s| s.stage == active.stage)?.output_path.as_deref()?;
    (!out.trim().is_empty()).then(|| progress_of(out))
}

/// How many cells the beam has crossed: the active stage's index plus its reported percent.
pub fn beam_position(view: &JobView, percent: Option<u8>) -> f32 {
    match view.active {
        Some(i) => i as f32 + percent.map_or(0.0, |p| f32::from(p) / 100.0),
        None => view.stages.len() as f32,
    }
}

fn state_word(lang: Lang, s: StageState) -> String {
    tr(lang, match s {
        StageState::Pending => "stage.state.waiting",
        StageState::Active => "stage.state.running",
        StageState::Done => "stage.state.done",
        StageState::Failed => "stage.state.failed",
    })
}

/// What the track shows besides the engine's words: the beam head's heat, and the rings of stages
/// that just finished as `(stage index, start, opacity, seed)`.
#[derive(Clone, Debug, Default)]
pub struct TrackFx {
    pub heat: f32,
    pub rings: Vec<(usize, f32, f32, u32)>,
}

/// The rail with a mark on it for each stage (a square for a finished one, the beam's head for the
/// running one) and the stage names under it; the running stage's percent sits under its name.
pub fn track(dark: bool, lang: Lang, view: &JobView, percent: Option<u8>, fx: &TrackFx) -> El {
    let p = pal(dark);
    let n = view.stages.len();
    let mut cells = row().key("job/track").role("list").label(tr(lang, "stages.label"));
    for (i, s) in view.stages.iter().enumerate() {
        let name_ink = match s.state {
            StageState::Pending => p.muted,
            StageState::Active => p.beam_text,
            _ => p.text,
        };
        let mut cell = col().key(format!("job/stage/{}", s.stage)).role("listitem").label(format!("{}, {}", stage_name(lang, &s.stage), state_word(lang, s.state)))
            .w(CELL).gap(6.0).items_center();
        for (_, t0, k, seed) in fx.rings.iter().filter(|r| r.0 == i) {
            cell = cell.child(slot(Moment::StagePulse, [*t0, *k, *seed as f32, 0.0]).w(20.0).h(20.0).absolute(CELL / 2.0 - 10.0, -3.0));
        }
        let mark = match s.state {
            StageState::Done => col().w(10.0).h(10.0).radius(2.0).fill(p.beam),
            StageState::Failed => col().w(10.0).h(10.0).radius(2.0).fill(p.skip),
            // The running stage's mark is the beam's head; a waiting one has none.
            StageState::Active | StageState::Pending => col().w(10.0).h(10.0),
        };
        cell = cell.child(col().h(14.0).items_center().justify_center().child(mark))
            .child(text(stage_name(lang, &s.stage)).font(type_::LABEL).color(name_ink));
        if let (StageState::Active, Some(pct)) = (s.state, percent) {
            cell = cell.child(text(format!("{pct}%")).key("job/stage-percent").font(type_::LABEL).color(p.beam_text));
        }
        cells = cells.child(cell);
    }
    let span = n.saturating_sub(1) as f32 * CELL;
    let beam_len = (beam_position(view, percent) * CELL).min(span);
    let rail = col().w(span + 10.0).h(14.0).absolute(CELL / 2.0 - 5.0, 0.0)
        .child(col().w(span).h(4.0).fill(p.divider).radius(2.0).absolute(5.0, 5.0))
        .child(beam(dark, "job/beam", Variant::Stage, beam_len, fx.heat, format!("{}%", view.percent)).absolute(0.0, 0.0));
    col().w(n as f32 * CELL).child(rail).child(cells)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sorot_desktop_core::job::StageView;
    use sorot_desktop_core::model::JobPhase;

    fn view(states: &[StageState]) -> JobView {
        JobView {
            phase: JobPhase::Running, interrupted: false, retry_offered: false, percent: 0,
            active: sorot_desktop_core::job::active_index(states),
            stages: states.iter().enumerate().map(|(i, s)| StageView { stage: ["IMPORT", "SCORE", "EXPORT"][i % 3].into(), state: *s }).collect(),
        }
    }

    #[test]
    fn reports_and_beam_follow_the_engine_only() {
        for (text, want) in [
            ("Transcribing 37%", ("Transcribing".to_string(), Some(37))),
            ("Jev reading moments 10/40", ("Jev reading moments 10/40".to_string(), None)),
            ("Working 250%", ("Working 250%".to_string(), None)),
            ("100%", ("100%".to_string(), None)),
        ] {
            assert_eq!(progress_of(text), want, "{text}");
        }
        let v = view(&[StageState::Done, StageState::Active, StageState::Pending]);
        assert_eq!((beam_position(&v, None), beam_position(&v, Some(50))), (1.0, 1.5));
        assert_eq!(beam_position(&view(&[StageState::Done, StageState::Done]), None), 2.0);
        let stages = vec![JobStage { id: "s".into(), job_id: "j".into(), stage: "SCORE".into(), status: "IN_PROGRESS".into(), started_at: None, completed_at: None, output_path: Some("Scoring 20%".into()) }];
        assert_eq!(running_report(&v, &stages), Some(("Scoring".into(), Some(20))));
        assert_eq!(running_report(&view(&[StageState::Done, StageState::Done]), &stages), None);
        assert_eq!((stage_name(Lang::Id, "TRANSCRIBE"), stage_name(Lang::En, "TRANSCRIBE"), stage_name(Lang::Id, "X")), ("Transkrip".into(), "Transcribe".into(), "X".into()));
    }
}
