//! Learning: log how posted clips did and retrain the scoring on them. Only numbers the engine
//! sent are shown (R-17); with nothing logged the screen says so and what to do next.

use rune::tok::type_;
use rune::{El, col, row, text};

use crate::engine::types::{LoggedResult, Weights};
use crate::screens::feedback;
use crate::screens::panels::{Host, Load, answer, go};
use crate::ui::form::{Tone, btn, card, heading, note};
use crate::ui::kit::pal;
use crate::ui::states::{Kind, state_block};

/// The engine retrains from this many logged results (its own minimum).
pub const RESULTS_TO_TRAIN: u32 = 5;
/// Clips offered under "Waiting for results".
const WAITING_SHOWN: usize = 12;

/// An exported clip with no logged result yet.
#[derive(Clone, Debug, PartialEq)]
pub struct Waiting {
    pub clip_id: String,
    pub title: String,
    pub video: String,
    pub score: f64,
}

#[derive(Default)]
pub struct Learning {
    pub load: Load,
    pub results: Vec<LoggedResult>,
    pub weights: Option<Weights>,
    pub waiting: Vec<Waiting>,
    pub training: bool,
    pub error: Option<String>,
    pub trained: bool,
}

type Loaded = (Vec<LoggedResult>, Weights, Vec<Waiting>);

/// Reads the logged results, the scoring weights and the clips still waiting for results.
pub fn open<H: Host>(h: &mut H) {
    h.panels_mut().learning.load = Load::Loading;
    go(h, |e| {
        let all = e.feedback().and_then(|results| {
            let weights = e.weights()?;
            let mut waiting = vec![];
            for v in e.videos()? {
                for c in e.clips(&v.id).unwrap_or_default() {
                    if c.export_path.is_some() && !results.iter().any(|r| r.clip_id == c.id) {
                        let title = c.title.clone().or(c.text_content.clone()).unwrap_or_else(|| format!("Clip {}", c.rank_pos.unwrap_or(0)));
                        waiting.push(Waiting { clip_id: c.id, title, video: v.title.clone().or(v.source_url.clone()).unwrap_or_default(), score: c.score.unwrap_or(0.0) });
                    }
                }
            }
            waiting.sort_by(|a, b| b.score.total_cmp(&a.score));
            waiting.truncate(WAITING_SHOWN);
            Ok((results, weights, waiting))
        });
        answer(all, |p, r: Result<Loaded, String>| {
            let l = &mut p.learning;
            l.load = Load::of(&r);
            if let Ok((results, weights, waiting)) = r {
                (l.results, l.weights, l.waiting) = (results, Some(weights), waiting);
            }
        })
    });
}

pub fn train<H: Host>(h: &mut H) {
    let l = &mut h.panels_mut().learning;
    (l.training, l.error, l.trained) = (true, None, false);
    go(h, |e| {
        let r = e.train().and_then(|()| Ok((e.feedback()?, e.weights()?)));
        answer(r, |p, r| {
            let l = &mut p.learning;
            l.training = false;
            match r {
                Ok((results, weights)) => (l.results, l.weights, l.trained) = (results, Some(weights), true),
                Err(why) => l.error = Some(why),
            }
        })
    });
}

fn count(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push('.');
        }
        out.push(c);
    }
    out
}

fn teach_card<H: Host>(dark: bool, l: &Learning) -> El {
    let p = pal(dark);
    let have = l.weights.as_ref().map_or(0, |w| w.with_actual_scores);
    let ready = have >= RESULTS_TO_TRAIN;
    let mut c = card(dark, "learning/teach", "Teach Sorot what works")
        .child(text(format!("Log how a posted clip did. With {RESULTS_TO_TRAIN} results Sorot can retrain its scoring on what your audience watches.")).font(type_::BODY).color(p.muted).wrap())
        .child(text(format!("{have} of {RESULTS_TO_TRAIN} results logged{}", if ready { ", ready to retrain" } else { "" })).key("learning/progress").role("status").font(type_::TITLE).color(p.text));
    if let Some(w) = &l.weights {
        let words = if w.trained_on > 0 { format!("Scoring version {}, last retrained on {} results.", w.version, w.trained_on) } else { format!("Scoring version {}, not retrained yet.", w.version) };
        c = c.child(text(words).key("learning/version").font(type_::BODY).color(p.muted).wrap());
    }
    let mut actions = row().gap(10.0).items_center().child(btn(dark, "learning/train", if l.training { "Retraining" } else { "Retrain scoring" }, true, ready && !l.training, train::<H>));
    if !ready {
        actions = actions.child(text(format!("Log {} more to retrain.", RESULTS_TO_TRAIN - have)).key("learning/more").font(type_::LABEL).color(p.muted));
    }
    c = c.child(actions);
    if l.trained {
        c = c.child(note(dark, "learning/trained", Tone::Ok, "Scoring retrained on your results."));
    }
    if let Some(why) = &l.error {
        c = c.child(note(dark, "learning/error", Tone::Bad, &format!("Retraining failed: {why}. Try again, or log more results first.")));
    }
    c
}

fn results_card(dark: bool, l: &Learning) -> El {
    let p = pal(dark);
    let mut c = card(dark, "learning/results", "Logged results");
    if l.results.is_empty() {
        return c.child(text("Nothing logged yet. Post a clip, then log how it did under Waiting for results.").key("learning/results/empty").font(type_::BODY).color(p.muted).wrap());
    }
    for r in &l.results {
        let score = r.viral_score.map_or("no score".to_string(), |s| format!("{:.0}%", s * 100.0));
        let line = format!("{}: {} views, viral score {score}", r.title.clone().unwrap_or_else(|| r.clip_id.chars().take(8).collect()), count(r.views));
        c = c.child(text(line).key(format!("learning/result/{}", r.clip_id)).role("listitem").font(type_::BODY).color(p.text).wrap());
    }
    c
}

fn waiting_card<H: Host>(h: &H, l: &Learning) -> El {
    let dark = h.dark();
    let p = pal(dark);
    let mut c = card(dark, "learning/waiting", "Waiting for results");
    if h.panels().feedback.clip_id.is_some() {
        c = c.child(feedback::view(h));
    }
    if l.waiting.is_empty() {
        return c.child(text("No exported clips are waiting. Export a clip, post it, then come back to log how it did.").key("learning/waiting/empty").font(type_::BODY).color(p.muted).wrap());
    }
    for w in &l.waiting {
        let (id, title) = (w.clip_id.clone(), w.title.clone());
        c = c.child(row().key(format!("learning/waiting/{}", w.clip_id)).role("listitem").label(w.title.as_str()).gap(10.0).items_center().w_full()
            .child(col().gap(2.0).grow(1.0).child(text(&w.title).font(type_::TITLE).color(p.text).wrap()).child(text(&w.video).font(type_::LABEL).color(p.muted).wrap()))
            .child(btn(dark, format!("learning/log/{}", w.clip_id), "Log results", false, true, move |h: &mut H| feedback::open(h, &id, &title))));
    }
    c
}

pub fn view<H: Host>(h: &H) -> El {
    let dark = h.dark();
    let l = &h.panels().learning;
    let head = heading(dark, "learning/title", "Learning", "Tell Sorot how your posts did, and it scores the next clips by what worked.");
    let body = match &l.load {
        Load::Failed(why) => state_block::<H>(dark, "learning/failed", Kind::Error, "Could not read your results.", &format!("{why}. Try again."), Some(("learning/retry", "Try again", open::<H>))),
        Load::Ready => col().gap(16.0).w_full().child(teach_card::<H>(dark, l)).child(results_card(dark, l)).child(waiting_card(h, l)),
        _ => state_block::<H>(dark, "learning/loading", Kind::Loading, "Reading your results.", "This takes a moment.", None),
    };
    col().gap(20.0).padding(40.0).w_full().max_w(960.0).child(head).child(body)
}
