//! Learning: log how posted clips did and retrain the scoring on them. Only numbers the engine
//! sent are shown (R-17); with nothing logged the screen says so and what to do next.

use rune::tok::type_;
use rune::{El, col, row, text};

use crate::engine::types::{LoggedResult, Weights};
use crate::screens::feedback;
use crate::screens::panels::{Host, Load, answer, go};
use crate::i18n::{Lang, tr, trf};
use crate::ui::focus;
use crate::ui::form::{Tone, btn, card, heading, note, page};
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
    let lang = h.lang();
    go(h, move |e| {
        let all = e.feedback().and_then(|results| {
            let weights = e.weights()?;
            let mut waiting = vec![];
            for v in e.videos()? {
                for c in e.clips(&v.id).unwrap_or_default() {
                    if c.export_path.is_some() && !results.iter().any(|r| r.clip_id == c.id) {
                        let title = c.title.clone().or(c.text_content.clone()).unwrap_or_else(|| trf(lang, "learning.untitled-clip", &[("n", c.rank_pos.unwrap_or(0).to_string().as_str())]));
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
    go(h, move |e| {
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

/// The day of an ISO time (`2026-11-14T19:00:00Z`), or a dash.
pub fn day(iso: Option<&str>) -> String {
    iso.and_then(|s| s.get(..10)).filter(|d| d.as_bytes().get(4) == Some(&b'-')).map_or("-".into(), String::from)
}

fn teach_card<H: Host>(dark: bool, l: Lang, s: &Learning) -> El {
    let p = pal(dark);
    let have = s.weights.as_ref().map_or(0, |w| w.with_actual_scores);
    let ready = have >= RESULTS_TO_TRAIN;
    let need = RESULTS_TO_TRAIN.to_string();
    let mut c = card(dark, "learning/teach", &tr(l, "learning.teach.title"))
        .child(text(trf(l, "learning.teach.about", &[("n", &need)])).font(type_::BODY).color(p.muted).wrap())
        .child(text(trf(l, if ready { "learning.progress-ready" } else { "learning.progress" }, &[("have", &have.to_string()), ("n", &need)])).key("learning/progress").role("status").font(type_::TITLE).color(p.text));
    if let Some(w) = &s.weights {
        let words = if w.trained_on > 0 { trf(l, "learning.version-trained", &[("v", &w.version.to_string()), ("n", &w.trained_on.to_string())]) } else { trf(l, "learning.version-new", &[("v", &w.version.to_string())]) };
        c = c.child(text(words).key("learning/version").font(type_::BODY).color(p.muted).wrap());
    }
    let mut actions = row().gap(10.0).items_center().child(btn(dark, "learning/train", &tr(l, if s.training { "learning.retraining" } else { "learning.retrain" }), true, ready && !s.training, train::<H>));
    if !ready {
        actions = actions.child(text(trf(l, "learning.more", &[("n", &(RESULTS_TO_TRAIN - have).to_string())])).key("learning/more").font(type_::LABEL).color(p.muted));
    }
    c = c.child(actions);
    if s.trained {
        c = c.child(note(dark, "learning/trained", Tone::Ok, &tr(l, "learning.trained")));
    }
    if let Some(why) = &s.error {
        c = c.child(note(dark, "learning/error", Tone::Bad, &trf(l, "learning.train-failed", &[("why", why)])));
    }
    c
}

fn results_card(dark: bool, l: Lang, s: &Learning) -> El {
    let p = pal(dark);
    let mut c = card(dark, "learning/results", &tr(l, "learning.results.title"));
    if s.results.is_empty() {
        return c.child(text(tr(l, "learning.results.empty")).key("learning/results/empty").font(type_::BODY).color(p.muted).wrap());
    }
    let cell = |words: String, w: f32, ink: rune::Color| text(words).font(type_::BODY).color(ink).w(w);
    c = c.child(row().key("learning/results/head").gap(12.0).w_full()
        .child(text(tr(l, "learning.col.clip")).font(type_::LABEL).color(p.muted).grow(1.0))
        .child(text(tr(l, "learning.col.posted")).font(type_::LABEL).color(p.muted).w(110.0))
        .child(text(tr(l, "learning.col.views")).font(type_::LABEL).color(p.muted).w(90.0))
        .child(text(tr(l, "learning.col.score")).font(type_::LABEL).color(p.muted).w(90.0)));
    for r in &s.results {
        let score = r.viral_score.map_or(tr(l, "learning.no-score"), |v| format!("{:.0}%", v * 100.0));
        let title = r.title.clone().unwrap_or_else(|| r.clip_id.chars().take(8).collect());
        let k = |n: &str| format!("learning/result/{}/{n}", r.clip_id);
        c = c.child(row().key(format!("learning/result/{}", r.clip_id)).role("listitem").label(title.as_str()).gap(12.0).w_full()
            .child(text(&title).font(type_::BODY).color(p.text).wrap().grow(1.0))
            .child(cell(day(r.posted_at.as_deref()), 110.0, p.muted).key(k("posted")))
            .child(cell(count(r.views), 90.0, p.text).key(k("views")))
            .child(cell(score, 90.0, p.text).key(k("score"))));
    }
    c
}

fn waiting_card<H: Host>(h: &H, l: Lang, s: &Learning) -> El {
    let dark = h.dark();
    let p = pal(dark);
    let mut c = card(dark, "learning/waiting", &tr(l, "learning.waiting.title"));
    if h.panels().feedback.clip_id.is_some() {
        c = c.child(feedback::view(h));
    }
    if s.waiting.is_empty() {
        return c.child(text(tr(l, "learning.waiting.empty")).key("learning/waiting/empty").font(type_::BODY).color(p.muted).wrap());
    }
    for w in &s.waiting {
        let (id, title) = (w.clip_id.clone(), w.title.clone());
        c = c.child(row().key(format!("learning/waiting/{}", w.clip_id)).role("listitem").label(w.title.as_str()).gap(10.0).items_center().w_full()
            .child(col().gap(2.0).grow(1.0).child(text(&w.title).font(type_::TITLE).color(p.text).wrap()).child(text(&w.video).font(type_::LABEL).color(p.muted).wrap()))
            .child(btn(dark, focus::polish_result(&w.clip_id), &tr(l, "learning.log"), false, true, move |h: &mut H| feedback::open(h, &id, &title))));
    }
    c
}

pub fn view<H: Host>(h: &H) -> El {
    let (dark, l) = (h.dark(), h.lang());
    let s = &h.panels().learning;
    let head = heading(dark, "learning/title", &tr(l, "learning.title"), &tr(l, "learning.sub"));
    let body = match &s.load {
        Load::Failed(why) => state_block::<H>(dark, "learning/failed", Kind::Error, &tr(l, "learning.read-failed"), &trf(l, "state.try-again-after", &[("why", why)]), Some(("learning/retry", &tr(l, "state.retry"), open::<H>))),
        Load::Ready => col().gap(16.0).w_full().child(teach_card::<H>(dark, l, s)).child(results_card(dark, l, s)).child(waiting_card(h, l, s)),
        _ => state_block::<H>(dark, "learning/loading", Kind::Loading, &tr(l, "learning.reading"), &tr(l, "state.moment"), None),
    };
    page().child(head).child(body)
}
