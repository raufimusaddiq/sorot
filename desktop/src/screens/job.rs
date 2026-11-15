//! One job: the stage track with the beam, what the engine last reported, Cancel, and the way back
//! when it stopped. Time passing shows as elapsed seconds, never as a spinner.

use rune::tok::type_;
use rune::{El, col, row, text};
use crate::i18n::{tr, trf};
use crate::screens::home;
use crate::ui::controls::{DISPLAY_BIG, centered, page_head};
use crate::ui::form::btn;
use rune_fx::{Heat, OneShots};
use sorot_desktop_core::job::JobView;
use sorot_desktop_core::job::StageState;
use sorot_desktop_core::model::{JobDetail, JobPhase};

use crate::app::{Cmd, Route, State};
use crate::ui::beam::heat_light;
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

    /// Retry on an interrupted job from Home: its screen opens and the engine starts it over.
    pub fn retry_interrupted(&mut self, id: &str) {
        self.route = Route::Job(id.to_string());
        self.job = JobScreen { id: id.to_string(), opened: self.now, last_poll: self.now, ..JobScreen::default() };
        self.send(Cmd::RetryJob(id.to_string()));
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

fn mmss(seconds: f64) -> String {
    let n = seconds.max(0.0).round() as u64;
    format!("{:02}:{:02}", n / 60, n % 60)
}

/// The last lines the engine gave, newest stage first: what finished and what runs now.
fn notes(s: &State, jv: &JobView, report: &Option<(String, Option<u8>)>) -> Vec<String> {
    let mut lines = vec![];
    for v in jv.stages.iter().rev() {
        let name = stage_name(s.lang, &v.stage);
        match v.state {
            StageState::Done => lines.push(trf(s.lang, "job.note.done", &[("stage", &name)])),
            StageState::Active => {
                if let Some((label, pct)) = report {
                    let report = pct.map_or(label.clone(), |n| format!("{label} {n}%"));
                    lines.push(trf(s.lang, "job.note.running", &[("stage", &name), ("report", &report)]));
                }
            }
            _ => {}
        }
    }
    lines.truncate(4);
    lines
}

pub fn view(s: &State) -> El {
    let p = pal(s.dark());
    let Some(detail) = &s.job.detail else {
        return state_block::<State>(s.dark(), "job/loading", Kind::Loading, &tr(s.lang, "job.loading.cause"), &tr(s.lang, "job.loading.next"), None);
    };
    let jv = JobView::from_detail(detail);
    let report = running_report(&jv, &detail.stages);
    let percent = report.as_ref().and_then(|r| r.1);
    let elapsed = (s.now - s.job.opened).max(0.0);
    let active = jv.active.and_then(|i| jv.stages.get(i)).map(|v| v.stage.clone());
    let name = active.as_deref().map(|id| stage_name(s.lang, id)).unwrap_or_default();
    let what = active.as_deref().map(|id| tr(s.lang, &format!("stage.{id}.what"))).unwrap_or_default();

    let (big, ink) = match (jv.phase, jv.interrupted) {
        (_, true) => (tr(s.lang, "job.head.interrupted"), p.skip),
        (JobPhase::Failed, _) => (tr(s.lang, "job.head.failed"), p.skip),
        (JobPhase::Cancelled, _) => (tr(s.lang, "job.head.cancelled"), p.muted),
        (JobPhase::Completed, _) => (tr(s.lang, "job.head.done"), p.pass),
        (JobPhase::Queued, _) => (tr(s.lang, "job.head.queued"), p.muted),
        _ => (format!("{}%", percent.unwrap_or(jv.percent)), p.beam_text),
    };
    let running = detail.job.is_running();
    let ran = trf(s.lang, "job.elapsed", &[("t", &mmss(elapsed))]);
    let mut words = col().gap(2.0).child(text(name).key("job/stage-name").font(type_::TITLE).color(p.text))
        .child(text(format!("{what} {ran}").trim().to_string()).key("job/elapsed").font(type_::BODY).color(p.muted).wrap());
    if jv.interrupted {
        words = words.child(text(tr(s.lang, "job.interrupted")).key("job/interrupted").role("alert").font(type_::BODY).color(p.skip).wrap());
    } else if let Some(why) = detail.job.error_message.as_deref().filter(|_| jv.phase == JobPhase::Failed) {
        words = words.child(text(why).key("job/error").role("alert").font(type_::BODY).color(p.skip).wrap());
    }
    let headline = row().gap(16.0).items_end()
        .child(text(big).key("job/progress").role("status").font(DISPLAY_BIG).color(ink))
        .child(words);

    let mut log = col().key("job/notes").role("group").label(tr(s.lang, "job.notes")).gap(8.0).padding(16.0).w_full().fill(p.surface).border(1.0, p.divider).radius(8.0)
        .child(text(tr(s.lang, "job.notes")).font(type_::TITLE).color(p.text));
    for line in notes(s, &jv, &report) {
        log = log.child(text(line).font(type_::LABEL).color(p.muted).wrap());
    }

    let mut actions = row().gap(10.0).items_center().justify_end().w_full();
    if jv.retry_offered {
        actions = actions.child(centered(button(s.dark(), "job/retry", &tr(s.lang, "job.retry"), true, |s: &mut State| s.retry_shown_job())));
    }
    if running {
        actions = actions.child(centered(button(s.dark(), "job/cancel", &tr(s.lang, "job.cancel"), false, |s: &mut State| s.cancel_shown_job())));
    }
    let done = jv.phase == JobPhase::Completed;
    let video = detail.job.video_id.clone();
    actions = actions.child(btn(s.dark(), "job/clips", &tr(s.lang, "job.view"), false, done, move |s: &mut State| s.show_clips(&video)));
    let mut page = col().gap(28.0).padding(40.0).w_full().h_full()
        .child(page_head(s.dark(), "job/title", &home::video_name(s, &detail.job.video_id), &tr(s.lang, "job.sub")))
        .child(col().h(8.0))
        .child(headline)
        .child(stage_track::track(s.dark(), s.lang, &jv, percent, &s.job.track_fx(s.now)))
        .child(log)
        .child(actions);
    if !done {
        page = page.child(text(tr(s.lang, "job.view.note")).key("job/clips-note").font(type_::LABEL).color(p.muted).wrap());
    }
    page
}
