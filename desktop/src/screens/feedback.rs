//! The results sheet: log how a posted clip did. The viral score is by the day, so the post time is
//! required, picked in date and time boxes and never in the future. Learning shows it under a clip;
//! the clips screen can open the same sheet.

use rune::tok::type_;
use rune::{El, TextEdit, col, edit_access, row, text};
use sorot_desktop_core::datetime::Why;

use crate::engine::types::Metrics;
use crate::i18n::{Lang, tr, trf};
use crate::screens::panels::{Host, answer, go};
use crate::ui::datetime::{DateBoxes, picker};
use crate::ui::focus;
use crate::ui::form::{Tone, btn, field, note};
use crate::ui::kit::pal;

/// Engine name, text key.
pub const METRICS: [(&str, &str); 5] = [("views", "feedback.views"), ("likes", "feedback.likes"), ("comments", "feedback.comments"), ("shares", "feedback.shares"), ("saves", "feedback.saves")];

/// What stops the sheet from being sent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Problem {
    TimeMissing,
    TimeInvalid,
    TimeFuture,
    /// The text key of the metric that is not a whole number.
    NotNumber(&'static str),
    /// The engine's own words.
    Engine(String),
}

pub struct Sheet {
    /// The clip the sheet is open for; `None` when closed.
    pub clip_id: Option<String>,
    pub title: String,
    pub numbers: [TextEdit; 5],
    pub posted: DateBoxes,
    pub busy: bool,
    pub error: Option<Problem>,
    /// The engine's score for what was just saved, in percent; `Some(None)` when it gave none.
    pub saved: Option<Option<f64>>,
}

impl Default for Sheet {
    fn default() -> Self {
        Sheet { clip_id: None, title: String::new(), numbers: std::array::from_fn(|_| TextEdit::new("")), posted: DateBoxes::default(), busy: false, error: None, saved: None }
    }
}

impl Sheet {
    /// What the sheet holds as the engine wants it, or what is wrong.
    pub fn metrics(&self) -> Result<Metrics, Problem> {
        let at = self.posted.parse().map_err(|w| if w == Why::Missing { Problem::TimeMissing } else { Problem::TimeInvalid })?;
        if self.posted.in_future() {
            return Err(Problem::TimeFuture);
        }
        let mut n = [0u64; 5];
        for (((_, label), edit), slot) in METRICS.iter().zip(&self.numbers).zip(&mut n) {
            let t = edit.text.trim();
            *slot = if t.is_empty() { 0 } else { t.parse().map_err(|_| Problem::NotNumber(label))? };
        }
        Ok(Metrics { views: n[0], likes: n[1], comments: n[2], shares: n[3], saves: n[4], posted_at: at.iso() })
    }
}

/// The words for a problem.
pub fn problem_words(l: Lang, p: &Problem) -> String {
    match p {
        Problem::TimeMissing => tr(l, "feedback.time-missing"),
        Problem::TimeInvalid => tr(l, "feedback.time-invalid"),
        Problem::TimeFuture => tr(l, "feedback.time-future"),
        Problem::NotNumber(label) => trf(l, "feedback.not-number", &[("name", &tr(l, label))]),
        Problem::Engine(why) => why.clone(),
    }
}

/// Opens an empty sheet for a clip.
pub fn open<H: Host>(h: &mut H, clip_id: &str, title: &str) {
    h.panels_mut().feedback = Sheet { clip_id: Some(clip_id.into()), title: title.into(), ..Sheet::default() };
}

pub fn close<H: Host>(h: &mut H) {
    h.panels_mut().feedback = Sheet::default();
}

/// Sends the numbers; Learning then shows the new row and the new count.
pub fn submit<H: Host>(h: &mut H) {
    let s = &mut h.panels_mut().feedback;
    let Some(clip) = s.clip_id.clone() else { return };
    let metrics = match s.metrics() {
        Ok(m) => m,
        Err(why) => return s.error = Some(why),
    };
    (s.busy, s.error) = (true, None);
    go(h, move |e| {
        let saved = e.submit_feedback(&clip, &metrics);
        let fresh = saved.is_ok().then(|| (e.feedback(), e.weights()));
        answer(saved, move |p, r| {
            p.feedback.busy = false;
            match r {
                Ok(done) => {
                    p.feedback.saved = Some(done.viral_score.map(|v| v * 100.0));
                    if let Some((Ok(results), Ok(weights))) = fresh {
                        (p.learning.results, p.learning.weights) = (results, Some(weights));
                        p.learning.waiting.retain(|w| Some(&w.clip_id) != p.feedback.clip_id.as_ref());
                    }
                }
                Err(why) => p.feedback.error = Some(Problem::Engine(why)),
            }
        })
    });
}

fn posted<H: Host>(h: &mut H) -> &mut DateBoxes {
    &mut h.panels_mut().feedback.posted
}

pub fn view<H: Host>(h: &H) -> El {
    let (dark, l) = (h.dark(), h.lang());
    let p = pal(dark);
    let s = &h.panels().feedback;
    let mut numbers = row().gap(8.0).w_full();
    for (i, (name, label)) in METRICS.iter().enumerate() {
        numbers = numbers.child(field(dark, &focus::feedback_field(name), &tr(l, label), &s.numbers[i], "0", false, edit_access(move |h: &mut H| &mut h.panels_mut().feedback.numbers[i])));
    }
    let mut sheet = col().key("feedback/sheet").role("group").label(tr(l, "feedback.title")).gap(12.0).padding(16.0).w_full().fill(p.raised).radius(8.0)
        .child(text(trf(l, "feedback.for", &[("title", &s.title)])).key("feedback/for").font(type_::TITLE).color(p.text).wrap())
        .child(picker::<H>(dark, l, "feedback/posted", &tr(l, "feedback.posted-at"), &s.posted, posted::<H>))
        .child(numbers)
        .child(text(tr(l, "feedback.about")).font(type_::LABEL).color(p.muted).wrap())
        .child(row().gap(8.0)
            .child(btn(dark, "feedback/submit", &tr(l, "feedback.save"), true, !s.busy, submit::<H>))
            .child(btn(dark, "feedback/close", &tr(l, "feedback.close"), false, true, close::<H>)));
    if let Some(why) = &s.error {
        sheet = sheet.child(note(dark, "feedback/error", Tone::Bad, &problem_words(l, why)));
    }
    match s.saved {
        Some(Some(score)) => sheet = sheet.child(note(dark, "feedback/saved", Tone::Ok, &trf(l, "feedback.saved", &[("score", &format!("{score:.1}"))]))),
        Some(None) => sheet = sheet.child(note(dark, "feedback/saved", Tone::Ok, &tr(l, "feedback.saved-no-score"))),
        None => {}
    }
    sheet
}
