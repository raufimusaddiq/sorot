//! The job as the app shows it: phase flags, stages in build order, one overall percent.

use crate::model::{JobDetail, JobPhase};

/// Engine stage ids in build order (`backend/src/types.ts` STAGES), then the two clip-level steps.
pub const STAGE_ORDER: [&str; 11] = [
    "IMPORT", "AUDIO_EXTRACT", "TRANSCRIBE", "SEGMENT", "SCORE", "RENDER", "SUBTITLE", "VARIATION",
    "ANALYTICS", "PREVIEW", "EXPORT",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StageState {
    Pending,
    Active,
    Done,
    Failed,
}

impl StageState {
    fn parse(status: &str) -> Self {
        match status {
            "COMPLETED" => Self::Done,
            "IN_PROGRESS" => Self::Active,
            "FAILED" => Self::Failed,
            _ => Self::Pending,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StageView {
    pub stage: String,
    pub state: StageState,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JobView {
    pub phase: JobPhase,
    pub interrupted: bool,
    pub retry_offered: bool,
    pub stages: Vec<StageView>,
    /// The first stage not done: the one running, or the one that stopped; `None` when all are done.
    pub active: Option<usize>,
    pub percent: u8,
}

/// Index of the first stage that is not done.
pub fn active_index(states: &[StageState]) -> Option<usize> {
    states.iter().position(|s| *s != StageState::Done)
}

/// Share of stages done, 0..=100.
pub fn percent(states: &[StageState]) -> u8 {
    if states.is_empty() {
        return 0;
    }
    let done = states.iter().filter(|s| **s == StageState::Done).count();
    (done * 100 / states.len()) as u8
}

fn order_of(stage: &str) -> usize {
    STAGE_ORDER.iter().position(|s| *s == stage).unwrap_or(STAGE_ORDER.len())
}

impl JobView {
    pub fn from_detail(detail: &JobDetail) -> Self {
        let phase = detail.job.phase();
        let mut stages: Vec<StageView> = detail
            .stages
            .iter()
            .map(|s| StageView { stage: s.stage.clone(), state: StageState::parse(&s.status) })
            .collect();
        stages.sort_by_key(|s| order_of(&s.stage));
        let states: Vec<StageState> = stages.iter().map(|s| s.state).collect();
        JobView {
            phase,
            interrupted: phase == JobPhase::Interrupted,
            retry_offered: matches!(phase, JobPhase::Failed | JobPhase::Interrupted | JobPhase::Cancelled),
            active: active_index(&states),
            percent: if phase == JobPhase::Completed { 100 } else { percent(&states) },
            stages,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Job, JobStage};

    fn detail(status: &str, err: Option<&str>, stages: &[(&str, &str)]) -> JobDetail {
        JobDetail {
            job: Job {
                id: "j".into(), video_id: "v".into(), status: status.into(), current_stage: None,
                error_message: err.map(Into::into), created_at: String::new(), updated_at: String::new(),
            },
            stages: stages
                .iter()
                .map(|(stage, status)| JobStage {
                    id: String::new(), job_id: "j".into(), stage: (*stage).into(), status: (*status).into(),
                    started_at: None, completed_at: None, output_path: None,
                })
                .collect(),
        }
    }

    #[test]
    fn rows_to_view() {
        let rows = [
            // queued: no stage has started
            (detail("QUEUED", None, &[("IMPORT", "PENDING")]), false, false, Some(0), 0),
            // rows out of order are shown in build order
            (detail("RUNNING", None, &[("SCORE", "PENDING"), ("IMPORT", "COMPLETED"), ("SEGMENT", "IN_PROGRESS")]), false, false, Some(1), 33),
            (detail("FAILED", Some("interrupted"), &[("IMPORT", "COMPLETED"), ("AUDIO_EXTRACT", "FAILED")]), true, true, Some(1), 50),
            (detail("FAILED", Some("boom"), &[("IMPORT", "FAILED")]), false, true, Some(0), 0),
            (detail("CANCELLED", None, &[("IMPORT", "COMPLETED"), ("AUDIO_EXTRACT", "PENDING")]), false, true, Some(1), 50),
            (detail("COMPLETED", None, &[("IMPORT", "COMPLETED"), ("ANALYTICS", "COMPLETED")]), false, false, None, 100),
        ];
        for (d, interrupted, retry, active, pct) in rows {
            let v = JobView::from_detail(&d);
            assert_eq!((v.interrupted, v.retry_offered, v.active, v.percent), (interrupted, retry, active, pct), "{}", d.job.status);
        }
        let v = JobView::from_detail(&detail("RUNNING", None, &[("SCORE", "PENDING"), ("IMPORT", "COMPLETED")]));
        assert_eq!(v.stages.iter().map(|s| s.stage.as_str()).collect::<Vec<_>>(), ["IMPORT", "SCORE"]);
        assert_eq!(percent(&[]), 0);
    }
}

#[cfg(kani)]
mod proofs {
    use super::*;

    fn any_state() -> StageState {
        match kani::any::<u8>() % 4 {
            0 => StageState::Pending,
            1 => StageState::Active,
            2 => StageState::Done,
            _ => StageState::Failed,
        }
    }

    #[kani::proof]
    #[kani::unwind(10)]
    fn percent_stays_within_0_to_100() {
        let states: [StageState; 9] = std::array::from_fn(|_| any_state());
        let n: usize = kani::any();
        kani::assume(n <= 9);
        assert!(percent(&states[..n]) <= 100);
    }

    #[kani::proof]
    #[kani::unwind(10)]
    fn the_active_stage_never_moves_back_on_monotone_progress() {
        let mut done: usize = 0;
        let mut last = 0;
        for _ in 0..6 {
            let next: usize = kani::any();
            kani::assume(next >= done && next <= 9);
            done = next;
            let states: [StageState; 9] = std::array::from_fn(|i| if i < done { StageState::Done } else { StageState::Active });
            let idx = active_index(&states).unwrap_or(9);
            assert!(idx >= last);
            last = idx;
        }
    }
}
