//! Discover: find videos worth clipping (search, trending, a channel, or an auto run), keep a list
//! of candidates, queue some, and start them. Every step is an engine route; the ranking and the
//! reasons are the engine's.

use rune::tok::type_;
use rune::{El, TextEdit, col, edit_access, row, text};

use crate::engine::types::{AutoRun, Candidate};
use crate::screens::panels::{Host, Load, Panels, answer, go};
use crate::ui::form::{Tone, btn, card, choice, field, heading, note, toggle};
use crate::ui::kit::pal;
use crate::ui::states::{Kind as StateKind, state_block};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Mode {
    #[default]
    Auto,
    Search,
    Trending,
    Channel,
}

pub const MODES: [(Mode, &str, &str); 4] = [(Mode::Auto, "auto", "Auto"), (Mode::Search, "search", "Search"), (Mode::Trending, "trending", "Trending"), (Mode::Channel, "channel", "Channel")];

/// The status filter: the engine's own words, `None` for all.
pub const FILTERS: [(Option<&str>, &str); 5] = [(None, "All"), (Some("NEW"), "New"), (Some("QUEUED"), "Queued"), (Some("IMPORTED"), "Imported"), (Some("SKIPPED"), "Skipped")];

/// Candidates shown before "Show all".
const SHOWN: usize = 20;

pub struct Discover {
    pub load: Load,
    pub mode: Mode,
    pub goal: TextEdit,
    pub query: TextEdit,
    pub channel: TextEdit,
    pub filter: Option<&'static str>,
    pub candidates: Vec<Candidate>,
    pub selected: Vec<String>,
    pub run: Option<AutoRun>,
    pub show_all: bool,
    pub busy: bool,
    pub error: Option<String>,
    pub notice: Option<String>,
}

impl Default for Discover {
    fn default() -> Self {
        Discover {
            load: Load::Idle, mode: Mode::Auto, goal: TextEdit::new(""), query: TextEdit::new(""), channel: TextEdit::new(""), filter: None,
            candidates: vec![], selected: vec![], run: None, show_all: false, busy: false, error: None, notice: None,
        }
    }
}

impl Discover {
    /// An auto run is going: the app polls it until it finishes.
    pub fn running(&self) -> bool {
        self.run.as_ref().is_some_and(|r| r.status == "RUNNING")
    }
}

fn listed(p: &mut Panels, r: Result<Vec<Candidate>, String>) {
    let d = &mut p.discover;
    d.busy = false;
    d.load = Load::of(&r);
    if let Ok(list) = r {
        d.selected.retain(|id| list.iter().any(|c| &c.id == id));
        d.candidates = list;
    }
}

pub fn open<H: Host>(h: &mut H) {
    refresh(h);
}

fn refresh<H: Host>(h: &mut H) {
    let status = h.panels().discover.filter;
    h.panels_mut().discover.load = Load::Loading;
    go(h, move |e| answer(e.candidates(status), listed));
}

pub fn set_mode<H: Host>(h: &mut H, mode: Mode) {
    h.panels_mut().discover.mode = mode;
}

pub fn set_filter<H: Host>(h: &mut H, filter: Option<&'static str>) {
    h.panels_mut().discover.filter = filter;
    refresh(h);
}

pub fn pick<H: Host>(h: &mut H, id: &str) {
    let d = &mut h.panels_mut().discover;
    match d.selected.iter().position(|x| x == id) {
        Some(i) => drop(d.selected.remove(i)),
        None => d.selected.push(id.to_string()),
    }
}

/// Runs the chosen way of finding videos.
pub fn find<H: Host>(h: &mut H) {
    let d = &mut h.panels_mut().discover;
    let (mode, arg) = match d.mode {
        Mode::Auto => ("auto", d.goal.text.trim().to_string()),
        Mode::Search => ("search", d.query.text.trim().to_string()),
        Mode::Trending => ("trending", String::new()),
        Mode::Channel => ("channel", d.channel.text.trim().to_string()),
    };
    if arg.is_empty() && matches!(d.mode, Mode::Search | Mode::Channel) {
        d.error = Some(if d.mode == Mode::Search { "Type what to search for, then press Discover." } else { "Paste a channel link, then press Discover." }.into());
        return;
    }
    (d.busy, d.error, d.notice) = (true, None, None);
    go(h, move |e| {
        if mode == "auto" {
            return answer(e.discover_auto(&arg), |p, r| {
                p.discover.busy = false;
                match r {
                    Ok(run) => p.discover.run = Some(run),
                    Err(why) => p.discover.error = Some(why),
                }
            });
        }
        answer(e.discover(mode, &arg).and_then(|_| e.candidates(None)), |p, r| {
            p.discover.filter = None;
            listed(p, r.clone());
            if let Err(why) = r {
                p.discover.error = Some(why);
            }
        })
    });
}

/// While an auto run goes, the app calls this on its poll; when it finishes the list is read again.
pub fn poll<H: Host>(h: &mut H) {
    let Some(id) = h.panels().discover.run.as_ref().filter(|r| r.status == "RUNNING").map(|r| r.id.clone()) else { return };
    go(h, move |e| {
        let r = e.auto_status(&id).and_then(|run| {
            let list = if run.status == "RUNNING" { None } else { Some(e.candidates(None)?) };
            Ok((run, list))
        });
        answer(r, |p, r| match r {
            Ok((run, list)) => {
                p.discover.run = Some(run);
                if let Some(list) = list {
                    p.discover.filter = None;
                    listed(p, Ok(list));
                }
            }
            Err(why) => p.discover.error = Some(why),
        })
    });
}

pub fn queue<H: Host>(h: &mut H) {
    let d = &mut h.panels_mut().discover;
    if d.selected.is_empty() {
        return;
    }
    let ids = std::mem::take(&mut d.selected);
    (d.busy, d.error) = (true, None);
    let status = d.filter;
    go(h, move |e| answer(e.queue_candidates(&ids).and_then(|()| e.candidates(status)), listed));
}

/// Starts a job for every queued candidate.
pub fn drain<H: Host>(h: &mut H) {
    let d = &mut h.panels_mut().discover;
    (d.busy, d.error, d.notice) = (true, None, None);
    let status = d.filter;
    go(h, move |e| {
        let r = e.drain_queue().and_then(|done| Ok((done, e.candidates(status)?)));
        answer(r, |p, r| match r {
            Ok((done, list)) => {
                let failed = done.failed.iter().map(|f| f.error.as_str()).collect::<Vec<_>>().join("; ");
                let tail = if failed.is_empty() { String::new() } else { format!(" {} could not start: {failed}.", done.failed.len()) };
                p.discover.notice = Some(format!("Started {} job(s).{tail}", done.started.len()));
                listed(p, Ok(list));
            }
            Err(why) => (p.discover.busy, p.discover.error) = (false, Some(why)),
        })
    });
}

/// Keeps a candidate out of the way (`SKIPPED`) or brings it back (`NEW`).
pub fn set_status<H: Host>(h: &mut H, id: &str, status: &'static str) {
    let (id, filter) = (id.to_string(), h.panels().discover.filter);
    h.panels_mut().discover.busy = true;
    go(h, move |e| answer(e.set_candidate_status(&id, status).and_then(|()| e.candidates(filter)), listed));
}

/// "Make clips" for one candidate: queue it and start the queue, so the engine marks it and links the job.
pub fn import<H: Host>(h: &mut H, id: &str) {
    let d = &mut h.panels_mut().discover;
    let Some(c) = d.candidates.iter().find(|c| c.id == id).cloned() else { return };
    (d.busy, d.error, d.notice) = (true, None, None);
    let status = d.filter;
    go(h, move |e| {
        let r = e.queue_candidates(std::slice::from_ref(&c.id)).and_then(|()| e.drain_queue()).and_then(|done| Ok((done, e.candidates(status)?)));
        answer(r, move |p, r| match r {
            Ok((done, list)) => {
                match done.failed.first() {
                    Some(f) => p.discover.error = Some(format!("Could not import \"{}\": {}", c.title, f.error)),
                    None => p.discover.notice = Some(format!("Started \"{}\". Follow it on Home.", c.title)),
                }
                listed(p, Ok(list));
            }
            Err(why) => (p.discover.busy, p.discover.error) = (false, Some(format!("Could not import \"{}\": {why}", c.title))),
        })
    });
}

fn clock(secs: f64) -> String {
    let s = secs.round() as u64;
    format!("{}:{:02}", s / 60, s % 60)
}

fn finder<H: Host>(dark: bool, d: &Discover) -> El {
    let p = pal(dark);
    let mut modes = row().gap(8.0);
    for (m, key, label) in MODES {
        modes = modes.child(choice(dark, &format!("discover/mode/{key}"), label, d.mode == m, move |h: &mut H| set_mode(h, m)));
    }
    let input = match d.mode {
        Mode::Auto => field(dark, "discover/goal", "What are you looking for? (optional)", &d.goal, "Leave empty and Sorot decides from your past clips", false, edit_access(|h: &mut H| &mut h.panels_mut().discover.goal)),
        Mode::Search => field(dark, "discover/query", "Search YouTube", &d.query, "A topic, a name, a question", false, edit_access(|h: &mut H| &mut h.panels_mut().discover.query)),
        Mode::Channel => field(dark, "discover/channel", "Channel link", &d.channel, "https://www.youtube.com/@channel", false, edit_access(|h: &mut H| &mut h.panels_mut().discover.channel)),
        Mode::Trending => text("Trending videos in Indonesia, read from YouTube.").font(type_::BODY).color(p.muted).wrap(),
    };
    let label = match (d.mode, d.running()) {
        (Mode::Auto, true) => "Researching",
        (Mode::Auto, false) => "Auto-discover",
        _ => "Discover",
    };
    let mut c = card(dark, "discover/find", "Find videos").child(modes).child(input)
        .child(btn(dark, "discover/run", label, true, !d.busy && !d.running(), find::<H>));
    if let Some(run) = &d.run {
        let (tone, words) = match run.status.as_str() {
            "RUNNING" => (Tone::Plain, "Researching. This takes a minute; the list fills in when it is done.".to_string()),
            "FAILED" => (Tone::Bad, format!("The run failed: {}. Run it again.", run.error.clone().unwrap_or_else(|| "no reason given".into()))),
            _ => (Tone::Ok, format!("Done. {} candidate(s) picked.", run.count)),
        };
        c = c.child(note(dark, "discover/run-status", tone, &words));
        if let Some(why) = &run.llm_error {
            c = c.child(note(dark, "discover/llm-error", Tone::Plain, &format!("The LLM did not answer ({why}), so the rules picked.")));
        }
    }
    c
}

fn candidate_row<H: Host>(dark: bool, c: &Candidate, picked: bool, busy: bool) -> El {
    let p = pal(dark);
    let k = |n: &str| format!("discover/c/{}/{n}", c.id);
    let views = c.view_count.map(|v| format!(", {v} views")).unwrap_or_default();
    let facts = format!("{}, {}{views}, relevance {:.0}%, {}", c.channel, clock(c.duration), c.relevance_score * 100.0, c.status.to_lowercase());
    let id = c.id.clone();
    let mut body = col().gap(2.0).grow(1.0).child(text(&c.title).font(type_::TITLE).color(p.text).wrap()).child(text(facts).font(type_::LABEL).color(p.muted).wrap());
    for (n, why) in c.why.iter().take(3).enumerate() {
        body = body.child(text(why).key(k(&format!("why/{n}"))).font(type_::LABEL).color(p.muted).wrap());
    }
    let mut actions = row().gap(8.0);
    let new = c.status == "NEW";
    if new {
        let iid = id.clone();
        actions = actions.child(btn(dark, k("import"), "Import", false, !busy, move |h: &mut H| import(h, &iid)));
        let sid = id.clone();
        actions = actions.child(btn(dark, k("status"), "Skip", false, !busy, move |h: &mut H| set_status(h, &sid, "SKIPPED")));
    } else if c.status == "SKIPPED" {
        let sid = id.clone();
        actions = actions.child(btn(dark, k("status"), "Restore", false, !busy, move |h: &mut H| set_status(h, &sid, "NEW")));
    }
    let mut line = row().key(k("row")).role("listitem").label(c.title.as_str()).gap(12.0).items_center().w_full();
    if new {
        line = line.child(toggle(dark, &k("pick"), &format!("Select {}", c.title), picked, move |h: &mut H| pick(h, &id)));
    }
    line.child(body).child(actions)
}

fn list_card<H: Host>(dark: bool, d: &Discover) -> El {
    let p = pal(dark);
    let mut filters = row().gap(8.0);
    for (f, label) in FILTERS {
        filters = filters.child(choice(dark, &format!("discover/filter/{}", label.to_lowercase()), label, d.filter == f, move |h: &mut H| set_filter(h, f)));
    }
    let mut c = card(dark, "discover/candidates", &format!("Candidates ({})", d.candidates.len())).child(filters);
    if d.candidates.is_empty() {
        return c.child(state_block::<H>(dark, "discover/empty", StateKind::Empty, "No candidates yet.", "Run a search, trending, a channel or Auto-discover above.", None));
    }
    let shown = if d.show_all { d.candidates.len() } else { SHOWN };
    for cand in d.candidates.iter().take(shown) {
        c = c.child(candidate_row::<H>(dark, cand, d.selected.contains(&cand.id), d.busy));
    }
    if d.candidates.len() > shown {
        c = c.child(btn(dark, "discover/show-all", &format!("Show all {}", d.candidates.len()), false, true, |h: &mut H| h.panels_mut().discover.show_all = true));
    }
    let queued = d.candidates.iter().filter(|c| c.status == "QUEUED").count();
    let bar = row().gap(10.0).items_center()
        .child(btn(dark, "discover/queue", &format!("Queue {} selected", d.selected.len()), false, !d.busy && !d.selected.is_empty(), queue::<H>))
        .child(btn(dark, "discover/drain", &format!("Start {queued} queued"), true, !d.busy && queued > 0, drain::<H>));
    c.child(bar).child(text("Starting imports each queued video and begins its job.").font(type_::LABEL).color(p.muted).wrap())
}

pub fn view<H: Host>(h: &H) -> El {
    let dark = h.dark();
    let d = &h.panels().discover;
    let head = heading(dark, "discover/title", "Discover", "Find videos worth clipping, queue the good ones, and start them.");
    let mut page = col().gap(16.0).w_full();
    match &d.load {
        Load::Failed(why) => page = page.child(state_block::<H>(dark, "discover/failed", StateKind::Error, "Could not read the candidates.", &format!("{why}. Try again."), Some(("discover/retry", "Try again", open::<H>)))),
        _ => page = page.child(finder::<H>(dark, d)).child(list_card::<H>(dark, d)),
    }
    if let Some(why) = &d.error {
        page = page.child(note(dark, "discover/error", Tone::Bad, why));
    }
    if let Some(done) = &d.notice {
        page = page.child(note(dark, "discover/notice", Tone::Ok, done));
    }
    col().gap(20.0).padding(40.0).w_full().max_w(960.0).child(head).child(page)
}
