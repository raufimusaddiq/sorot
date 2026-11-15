//! One job: the stage track with the beam, what the engine last reported, Cancel, and the way back
//! when it stopped. Time passing shows as elapsed seconds, never as a spinner.

use rune::tok::type_;
use rune::{El, col, row, text};
use rune_fx::{Heat, OneShots};
use sorot_desktop_core::job::JobView;
use sorot_desktop_core::job::StageState;
use sorot_desktop_core::model::{JobDetail, JobPhase};

use crate::app::{Cmd, Route, State};
use crate::ui::beam::heat_light;
use crate::ui::clip_stage::clock;
use crate::ui::fx_moments::PULSE_LIFE;
use crate::ui::kit::{button, pal};
use crate::ui::stage_track::{self, TrackFx, running_report, stage_name};
use crate::ui::states::{Kind, state_block};

pub struct JobScreen {
    pub id: String,
    pub detail: Option<JobDetail>,
    /// App clock when the screen opened.
    pub opened: f64,
    pub last_poll: f64,
    /// The beam head's light: warms when the engine reports progress, cools when it stops.
    pub heat: Heat,
    /// The active stage and percent of the last report; a change is progress.
    sig: Option<(Option<usize>, Option<u8>)>,
    last_progress: f64,
    /// Stages that just finished, for the one-shot ring (`StagePulse`).
    pub rings: OneShots<usize>,
}

impl Default for JobScreen {
    fn default() -> Self {
        JobScreen { id: String::new(), detail: None, opened: 0.0, last_poll: 0.0, heat: heat_light(), sig: None, last_progress: 0.0, rings: OneShots::new(4) }
    }
}

impl JobScreen {
    /// A report arrived: warm the light on progress, ring the stages that finished.
    fn feel(&mut self, now: f64, detail: &JobDetail) {
        let (t, view) = (now as f32, JobView::from_detail(detail));
        if let Some(before) = self.detail.as_ref().map(JobView::from_detail) {
            for (i, (a, b)) in before.stages.iter().zip(&view.stages).enumerate() {
                if a.state != StageState::Done && b.state == StageState::Done {
                    self.rings.trigger(t, i);
                }
            }
        }
        let sig = (view.active, running_report(&view, &detail.stages).and_then(|r| r.1));
        if self.sig != Some(sig) && detail.job.is_running() {
            self.heat.set(t, true);
            self.last_progress = now;
        }
        self.sig = Some(sig);
    }

    /// Cools an idle light, and says whether anything on the track still moves at `now`.
    pub fn moving(&mut self, now: f64) -> bool {
        if now - self.last_progress > 1.0 {
            self.heat.set(now as f32, false);
        }
        self.heat.is_active(now as f32) || self.rings.is_animating(now as f32, PULSE_LIFE)
    }

    pub fn track_fx(&self, now: f64) -> TrackFx {
        let t = now as f32;
        TrackFx { heat: self.heat.at(t), rings: self.rings.live(t, PULSE_LIFE).map(|(s, k)| (s.data, s.t0, k, s.seed)).collect() }
    }
}

impl State {
    pub fn open_job(&mut self, id: &str) {
        self.route = Route::Job(id.to_string());
        self.job = JobScreen { id: id.to_string(), opened: self.now, last_poll: self.now, ..JobScreen::default() };
        self.send(Cmd::PollJob(id.to_string()));
    }

    pub fn go_home(&mut self) {
        self.route = Route::Home;
    }

    /// The job's rows arrived; a finished job moves on to its clips.
    pub fn apply_job(&mut self, detail: JobDetail) {
        if detail.job.id != self.job.id || !matches!(self.route, Route::Job(_)) {
            return;
        }
        let done = detail.job.phase() == JobPhase::Completed;
        self.job.feel(self.now, &detail);
        if done {
            self.bursts.trigger(self.now as f32, ());
        }
        let video = detail.job.video_id.clone();
        self.job.detail = Some(detail);
        if done {
            self.show_clips(&video);
        }
    }

    pub fn cancel_shown_job(&mut self) {
        let id = self.job.id.clone();
        self.send(Cmd::CancelJob(id));
    }

    pub fn retry_shown_job(&mut self) {
        let id = self.job.id.clone();
        self.send(Cmd::RetryJob(id));
    }

    /// Reads the open job again while it runs.
    pub fn poll_job(&mut self, t: f64) -> bool {
        let running = self.job.detail.as_ref().is_none_or(|d| d.job.is_running());
        if matches!(self.route, Route::Job(_)) && running && t - self.job.last_poll >= 0.5 {
            self.job.last_poll = t;
            let id = self.job.id.clone();
            self.send(Cmd::PollJob(id));
            return true;
        }
        false
    }
}

pub fn view(s: &State) -> El {
    let p = pal(s.dark);
    let Some(detail) = &s.job.detail else {
        return state_block::<State>(s.dark, "job/loading", Kind::Loading, "Reading the job", "This takes a moment.", None);
    };
    let jv = JobView::from_detail(detail);
    let report = running_report(&jv, &detail.stages);
    let percent = report.as_ref().and_then(|r| r.1);
    let elapsed = (s.now - s.job.opened).max(0.0);
    let active_name = jv.active.and_then(|i| jv.stages.get(i)).map(|v| stage_name(&v.stage)).unwrap_or("Done");

    let headline = match (jv.phase, jv.interrupted) {
        (_, true) => "Interrupted".to_string(),
        (JobPhase::Failed, _) => "Failed".to_string(),
        (JobPhase::Cancelled, _) => "Cancelled".to_string(),
        (JobPhase::Completed, _) => "Done".to_string(),
        (JobPhase::Queued, _) => "Waiting to start".to_string(),
        _ => match &report {
            Some((label, Some(n))) => format!("{label} {n}%"),
            Some((label, None)) => label.clone(),
            None => active_name.to_string(),
        },
    };
    let mut head = col().gap(6.0)
        .child(text(headline).key("job/progress").role("status").font(type_::TITLE).color(p.text))
        .child(text(format!("Elapsed {}", clock(elapsed))).key("job/elapsed").font(type_::LABEL).color(p.muted));
    if jv.interrupted {
        head = head.child(text("The engine stopped while this job ran. Retry starts it again.").key("job/interrupted").role("alert").font(type_::BODY).color(p.skip).wrap());
    } else if let Some(why) = detail.job.error_message.as_deref().filter(|_| jv.phase == JobPhase::Failed) {
        head = head.child(text(why).key("job/error").role("alert").font(type_::BODY).color(p.skip).wrap());
    }
    let mut actions = row().gap(10.0).items_center();
    if detail.job.is_running() {
        actions = actions.child(button(s.dark, "job/cancel", "Cancel", false, |s: &mut State| s.cancel_shown_job()));
    }
    if jv.retry_offered {
        actions = actions.child(button(s.dark, "job/retry", "Retry", true, |s: &mut State| s.retry_shown_job()));
    }
    actions = actions.child(button(s.dark, "job/home", "Back to Home", false, |s: &mut State| s.go_home()));
    col().gap(24.0).padding(24.0).w_full().h_full()
        .child(text("Making clips").role("heading").level(1).font(type_::TITLE).color(p.text))
        .child(head)
        .child(stage_track::track(s.dark, &jv, percent, &s.job.track_fx(s.now)))
        .child(actions)
}
