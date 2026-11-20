//! First run only: the libraries the engine found from the web version, and what to do with them.
//! Every choice is an engine startup command; the app reads none of those files.

use rune::tok::type_;
use rune::{El, col, row, text};
use sorot_desktop_core::workspace::{Candidate, EngineKind, Source, Workspace};

use crate::app::{Cmd, State};
use crate::i18n::{tr, trf};
use crate::ui::focus;
use crate::ui::kit::{button, pal};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum How {
    Use,
    Copy,
    Fresh,
}

/// What the screen holds while it is up.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Welcome {
    pub candidates: Vec<Candidate>,
    pub keys: bool,
    /// Percent of a running copy.
    pub copying: Option<u8>,
    /// Files a finished copy could not read; the screen stays until "Continue".
    pub skipped: Option<Vec<String>>,
    pub error: Option<String>,
}

impl Welcome {
    pub fn new(candidates: Vec<Candidate>) -> Self {
        Welcome { keys: candidates.iter().any(|c| c.has_keys), candidates, copying: None, skipped: None, error: None }
    }
}

/// The workspace a choice makes. `data_dir` is the engine's default data folder.
pub fn workspace_for(how: How, from: &str, data_dir: &str) -> Workspace {
    let (dir, source, adopted_from) = match how {
        How::Use => (from, Source::Adopted, Some(from.to_string())),
        How::Copy => (data_dir, Source::Copied, Some(from.to_string())),
        How::Fresh => (data_dir, Source::New, None),
    };
    Workspace { data_dir: dir.into(), source, adopted_from, engine: EngineKind::Local }
}

fn key(i: usize, name: &str) -> String { focus::welcome(i, name) }

fn candidate(s: &State, w: &Welcome, i: usize, c: &Candidate) -> El {
    let p = pal(s.dark());
    let broken = !c.ok || c.problem.is_some();
    let l = s.lang;
    let (videos, clips) = (c.videos.to_string(), c.clips.to_string());
    let keys = if c.has_keys { tr(l, "welcome.facts.keys") } else { String::new() };
    let facts = trf(l, "welcome.facts", &[
        ("videos", videos.as_str()),
        ("clips", clips.as_str()),
        ("keys", keys.as_str()),
    ]);
    let note = match (&c.problem, i) {
        (Some(why), _) => trf(l, "welcome.problem", &[("why", why.as_str())]),
        (None, 0) if !broken => tr(l, "welcome.suggested"),
        _ => String::new(),
    };
    let from = c.path.clone();
    let choose = |how: How, label: &str, name: &str, primary: bool| {
        let (from, keys) = (from.clone(), w.keys && c.has_keys);
        button(s.dark(), key(i, name), label, primary, move |s: &mut State| s.send(Cmd::Choose { how, from: from.clone(), keys }))
    };
    let mut actions = row().gap(10.0).child(choose(How::Copy, &tr(l, "welcome.copy"), "copy", false));
    if !broken {
        actions = actions.child(choose(How::Use, &tr(l, "welcome.use-here"), "use-here", i == 0));
    }
    let mut body = col().gap(4.0).grow(1.0)
        .child(text(&c.path).key(key(i, "path")).font(type_::TITLE).color(p.text).wrap())
        .child(text(facts).font(type_::BODY).color(p.muted).wrap());
    if !note.is_empty() {
        body = body.child(text(note).key(key(i, "note")).font(type_::BODY).color(if c.problem.is_some() { p.skip } else { p.muted }).wrap());
    }
    let border = if i == 0 && !broken { p.beam } else { p.divider };
    row().key(key(i, "library")).gap(16.0).padding(16.0).items_center().w_full().fill(p.surface).border(1.0, border).radius(10.0).child(body).child(actions)
}

fn done(s: &State, skipped: &[String]) -> El {
    let p = pal(s.dark());
    let l = s.lang;
    let mut list = col().key("welcome/skipped").role("list").gap(2.0).label(trf(l, "welcome.skipped.label", &[("n", skipped.len().to_string().as_str())]));
    for f in skipped.iter().take(8) {
        list = list.child(text(f).font(type_::BODY).color(p.muted).wrap());
    }
    col().gap(12.0).child(text(trf(l, "welcome.skipped.title", &[("n", skipped.len().to_string().as_str())])).key("welcome/skipped/title").font(type_::TITLE).color(p.text).wrap())
        .child(list).child(button(s.dark(), "welcome/continue", &tr(l, "welcome.continue"), true, |s: &mut State| s.finish_welcome()))
}

pub fn view(s: &State, w: &Welcome) -> El {
    let p = pal(s.dark());
    let l = s.lang;
    let n = w.candidates.len();
    let mut screen = col().gap(16.0).padding(40.0).w_full().max_w(960.0)
        .child(text(tr(l, "welcome.title")).key("welcome/title").role("heading").level(1).font(type_::TITLE).color(p.text))
        .child(text(trf(l, "welcome.summary", &[("n", n.to_string().as_str())])).key("welcome/summary").font(type_::BODY).color(p.muted).wrap());
    if let Some(skipped) = &w.skipped {
        return screen.child(done(s, skipped));
    }
    if let Some(percent) = w.copying {
        return screen.child(text(trf(l, "welcome.copying", &[("percent", percent.to_string().as_str())])).key("welcome/copying").role("status").font(type_::TITLE).color(p.text));
    }
    if let Some(why) = &w.error {
        screen = screen.child(col().key("welcome/error").role("alert").label(why.as_str()).gap(2.0)
            .child(text(why).font(type_::BODY).color(p.skip).wrap())
            .child(text(tr(l, "welcome.retry")).font(type_::BODY).color(p.muted)));
    }
    for (i, c) in w.candidates.iter().enumerate() {
        screen = screen.child(candidate(s, w, i, c));
    }
    if w.candidates.iter().any(|c| c.has_keys) {
        let on = w.keys;
        screen = screen.child(
            row().gap(16.0).padding(16.0).items_center().w_full().fill(p.surface).border(1.0, p.divider).radius(10.0)
                .child(col().gap(2.0).grow(1.0)
                    .child(text(tr(l, "welcome.keys.title")).font(type_::TITLE).color(p.text))
                    .child(text(tr(l, "welcome.keys.about")).font(type_::BODY).color(p.muted).wrap()))
                .child(button(s.dark(), "welcome/keys", tr(l, if on { "welcome.keys.on" } else { "welcome.keys.off" }).as_str(), on, |s: &mut State| s.toggle_keys())),
        );
    }
    screen.child(button(s.dark(), "welcome/fresh", &tr(l, "welcome.fresh"), false, |s: &mut State| s.send(Cmd::Choose { how: How::Fresh, from: String::new(), keys: false })))
}
