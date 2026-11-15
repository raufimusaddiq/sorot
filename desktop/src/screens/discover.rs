//! Discover: find videos worth clipping (search, trending, a channel, or an auto run), keep a list
//! of candidates, queue some, and start them. Every step is an engine route; the ranking and the
//! reasons are the engine's. While the engine reads the captions of new candidates in the
//! background the list is read again by itself, and a row shows "enriching" until it has a
//! predicted score.

use rune::tok::type_;
use rune::{El, TextEdit, col, edit_access, row, text};

use crate::engine::types::{AutoRun, Candidate};
use crate::i18n::{Lang, tr, trf};
use crate::screens::panels::{Host, Load, Panels, answer, go};
use crate::ui::form::{Tone, btn, card, choice, field, heading, note, page, toggle};
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

/// Mode, element key, text key.
pub const MODES: [(Mode, &str, &str); 4] = [(Mode::Auto, "auto", "discover.mode.auto"), (Mode::Search, "search", "discover.mode.search"), (Mode::Trending, "trending", "discover.mode.trending"), (Mode::Channel, "channel", "discover.mode.channel")];

/// The status filter: the engine's own words (`None` for all), element key, text key.
pub const FILTERS: [(Option<&str>, &str, &str); 5] = [
    (None, "all", "discover.filter.all"), (Some("NEW"), "new", "discover.filter.new"), (Some("QUEUED"), "queued", "discover.filter.queued"),
    (Some("IMPORTED"), "imported", "discover.filter.imported"), (Some("SKIPPED"), "skipped", "discover.filter.skipped"),
];

/// Candidates shown before "Show all", and reasons shown before "+N more".
const SHOWN: usize = 20;
const WHY_SHOWN: usize = 3;
/// The auto run's log lines shown (the last ones).
const STEPS_SHOWN: usize = 8;

/// What went wrong, in words the view puts in the person's language.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Problem {
    TypeQuery,
    PasteChannel,
    /// The engine's own words.
    Engine(String),
    Import { title: String, why: String },
}

/// What went right.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Told {
    Started { jobs: usize, failed: Vec<String> },
    StartedOne(String),
}

pub struct Discover {
    pub load: Load,
    pub mode: Mode,
    pub goal: TextEdit,
    pub query: TextEdit,
    pub channel: TextEdit,
    pub filter: Option<&'static str>,
    pub candidates: Vec<Candidate>,
    pub selected: Vec<String>,
    /// Candidates whose reasons are all shown.
    pub why_open: Vec<String>,
    pub run: Option<AutoRun>,
    pub show_all: bool,
    pub busy: bool,
    pub error: Option<Problem>,
    pub notice: Option<Told>,
}

impl Default for Discover {
    fn default() -> Self {
        Discover {
            load: Load::Idle, mode: Mode::Auto, goal: TextEdit::new(""), query: TextEdit::new(""), channel: TextEdit::new(""), filter: None,
            candidates: vec![], selected: vec![], why_open: vec![], run: None, show_all: false, busy: false, error: None, notice: None,
        }
    }
}

impl Discover {
    /// An auto run is going: the app polls it until it finishes.
    pub fn running(&self) -> bool {
        self.run.as_ref().is_some_and(|r| r.status == "RUNNING")
    }

    /// New candidates are still waiting for their captions to be scored.
    pub fn enriching(&self) -> bool {
        self.candidates.iter().any(|c| c.status == "NEW" && c.transcript_score.is_none())
    }

    /// The app has something to look at again on its poll.
    pub fn polling(&self) -> bool {
        self.running() || self.enriching()
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

/// Shows all of a candidate's reasons, or the first few again.
pub fn flip_why<H: Host>(h: &mut H, id: &str) {
    let d = &mut h.panels_mut().discover;
    match d.why_open.iter().position(|x| x == id) {
        Some(i) => drop(d.why_open.remove(i)),
        None => d.why_open.push(id.to_string()),
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
        d.error = Some(if d.mode == Mode::Search { Problem::TypeQuery } else { Problem::PasteChannel });
        return;
    }
    (d.busy, d.error, d.notice) = (true, None, None);
    go(h, move |e| {
        if mode == "auto" {
            return answer(e.discover_auto(&arg), |p, r| {
                p.discover.busy = false;
                match r {
                    Ok(run) => p.discover.run = Some(run),
                    Err(why) => p.discover.error = Some(Problem::Engine(why)),
                }
            });
        }
        answer(e.discover(mode, &arg).and_then(|_| e.candidates(None)), |p, r| {
            p.discover.filter = None;
            listed(p, r.clone());
            if let Err(why) = r {
                p.discover.error = Some(Problem::Engine(why));
            }
        })
    });
}

/// The app calls this on its poll. A running auto run is asked about (and the list read again when
/// it finishes); otherwise, while candidates are still being enriched, the list is read again.
pub fn poll<H: Host>(h: &mut H) {
    let Some(id) = h.panels().discover.run.as_ref().filter(|r| r.status == "RUNNING").map(|r| r.id.clone()) else {
        if h.panels().discover.enriching() {
            let status = h.panels().discover.filter;
            go(h, move |e| answer(e.candidates(status), listed));
        }
        return;
    };
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
            Err(why) => p.discover.error = Some(Problem::Engine(why)),
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
                p.discover.notice = Some(Told::Started { jobs: done.started.len(), failed: done.failed.iter().map(|f| f.error.clone()).collect() });
                listed(p, Ok(list));
            }
            Err(why) => (p.discover.busy, p.discover.error) = (false, Some(Problem::Engine(why))),
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
                    Some(f) => p.discover.error = Some(Problem::Import { title: c.title.clone(), why: f.error.clone() }),
                    None => p.discover.notice = Some(Told::StartedOne(c.title.clone())),
                }
                listed(p, Ok(list));
            }
            Err(why) => (p.discover.busy, p.discover.error) = (false, Some(Problem::Import { title: c.title.clone(), why })),
        })
    });
}

/// Opens the video on YouTube.
pub fn open_video<H: Host>(h: &mut H, url: &str) {
    if let Err(why) = h.open_url(url) {
        h.panels_mut().discover.error = Some(Problem::Engine(why));
    }
}

fn clock(secs: f64) -> String {
    let s = secs.round() as u64;
    format!("{}:{:02}", s / 60, s % 60)
}

fn problem_words(l: Lang, p: &Problem) -> String {
    match p {
        Problem::TypeQuery => tr(l, "discover.type-query"),
        Problem::PasteChannel => tr(l, "discover.paste-channel"),
        Problem::Engine(why) => why.clone(),
        Problem::Import { title, why } => trf(l, "discover.import-failed", &[("title", title), ("why", why)]),
    }
}

fn told_words(l: Lang, t: &Told) -> String {
    match t {
        Told::Started { jobs, failed } if failed.is_empty() => trf(l, "discover.started", &[("n", &jobs.to_string())]),
        Told::Started { jobs, failed } => trf(l, "discover.started-failed", &[("n", &jobs.to_string()), ("failed", &failed.len().to_string()), ("why", &failed.join("; "))]),
        Told::StartedOne(title) => trf(l, "discover.started-one", &[("title", title)]),
    }
}

/// How an auto run went: who picked, any note on the trend, and the last steps of its log.
fn run_card(dark: bool, l: Lang, run: &AutoRun) -> Vec<El> {
    let p = pal(dark);
    let mut out = vec![];
    let (tone, words) = match run.status.as_str() {
        "RUNNING" => (Tone::Plain, tr(l, "discover.run.running")),
        "FAILED" => (Tone::Bad, trf(l, "discover.run.failed", &[("why", &run.error.clone().unwrap_or_else(|| tr(l, "conn.no-reason")))])),
        _ => {
            let by = match (run.mode.as_deref(), &run.model) {
                (Some("agent"), Some(m)) => m.clone(),
                _ => tr(l, "discover.run.algorithm"),
            };
            (Tone::Ok, trf(l, "discover.run.picked", &[("n", &run.count.to_string()), ("by", &by)]))
        }
    };
    out.push(note(dark, "discover/run-status", tone, &words));
    if let Some(why) = &run.llm_error {
        out.push(note(dark, "discover/llm-error", Tone::Plain, &trf(l, "discover.llm-error", &[("why", why)])));
    }
    if let Some(n) = run.notes.as_ref().filter(|n| !n.is_empty()) {
        out.push(text(trf(l, "discover.run.trend", &[("notes", n)])).key("discover/run-notes").font(type_::BODY).color(p.muted).wrap());
    }
    let from = run.steps.len().saturating_sub(STEPS_SHOWN);
    for (i, s) in run.steps.iter().enumerate().skip(from) {
        let arg = ["query", "video_id", "channel"].iter().find_map(|k| s.args.get(*k).and_then(|v| v.as_str())).unwrap_or("");
        out.push(text(format!("{} {arg} \u{2192} {}", s.tool, s.result)).key(format!("discover/step/{i}")).font(type_::LABEL).color(p.muted).wrap());
    }
    out
}

fn finder<H: Host>(dark: bool, l: Lang, d: &Discover) -> El {
    let p = pal(dark);
    let mut modes = row().gap(8.0);
    for (m, key, label) in MODES {
        modes = modes.child(choice(dark, &format!("discover/mode/{key}"), &tr(l, label), d.mode == m, move |h: &mut H| set_mode(h, m)));
    }
    let input = match d.mode {
        Mode::Auto => field(dark, "discover/goal", &tr(l, "discover.goal"), &d.goal, &tr(l, "discover.goal-hint"), false, edit_access(|h: &mut H| &mut h.panels_mut().discover.goal)),
        Mode::Search => field(dark, "discover/query", &tr(l, "discover.query"), &d.query, &tr(l, "discover.query-hint"), false, edit_access(|h: &mut H| &mut h.panels_mut().discover.query)),
        Mode::Channel => field(dark, "discover/channel", &tr(l, "discover.channel"), &d.channel, "https://www.youtube.com/@channel", false, edit_access(|h: &mut H| &mut h.panels_mut().discover.channel)),
        Mode::Trending => text(tr(l, "discover.trending-about")).font(type_::BODY).color(p.muted).wrap(),
    };
    let label = match (d.mode, d.running()) {
        (Mode::Auto, true) => tr(l, "discover.researching"),
        (Mode::Auto, false) => tr(l, "discover.auto"),
        _ => tr(l, "discover.go"),
    };
    let mut c = card(dark, "discover/find", &tr(l, "discover.find.title")).child(modes).child(input)
        .child(btn(dark, "discover/run", &label, true, !d.busy && !d.running(), find::<H>));
    if let Some(run) = &d.run {
        for el in run_card(dark, l, run) {
            c = c.child(el);
        }
    }
    c.child(text(tr(l, if d.mode == Mode::Auto { "discover.auto-about" } else { "discover.enrich-about" })).font(type_::LABEL).color(p.muted).wrap())
}

/// The score a row shows: the predicted one when the captions were read, else the title's relevance.
fn score_of(c: &Candidate) -> f64 {
    c.predicted_score.unwrap_or(c.relevance_score)
}

fn candidate_row<H: Host>(dark: bool, l: Lang, c: &Candidate, d: &Discover) -> El {
    let p = pal(dark);
    let (picked, busy) = (d.selected.contains(&c.id), d.busy);
    let k = |n: &str| format!("discover/c/{}/{n}", c.id);
    let views = c.view_count.map(|v| trf(l, "discover.views", &[("n", &v.to_string())])).unwrap_or_default();
    let facts = format!("{}, {}{views}, {}", c.channel, clock(c.duration), tr(l, &format!("discover.status.{}", c.status.to_lowercase())));
    let id = c.id.clone();
    let mut body = col().gap(2.0).grow(1.0).child(text(&c.title).font(type_::TITLE).color(p.text).wrap()).child(text(facts).font(type_::LABEL).color(p.muted).wrap());
    if let (Some("auto"), Some(by)) = (c.source_mode.as_deref(), c.picked_by.as_deref()) {
        let words = if by == "algorithm" { tr(l, "discover.run.algorithm") } else { trf(l, "discover.picked-by-llm", &[("model", by)]) };
        body = body.child(text(words).key(k("picked")).role("status").font(type_::LABEL).color(p.beam_text));
    }
    let open = d.why_open.contains(&c.id);
    let shown = if open { c.why.len() } else { WHY_SHOWN };
    for (n, why) in c.why.iter().take(shown).enumerate() {
        body = body.child(text(why).key(k(&format!("why/{n}"))).font(type_::LABEL).color(p.muted).wrap());
    }
    if c.why.len() > WHY_SHOWN {
        let (wid, label) = (id.clone(), if open { tr(l, "discover.less") } else { trf(l, "discover.more", &[("n", &(c.why.len() - WHY_SHOWN).to_string())]) });
        body = body.child(btn(dark, k("more"), &label, false, true, move |h: &mut H| flip_why(h, &wid)));
    }
    let score_label = tr(l, if c.predicted_score.is_some() { "discover.predicted" } else if c.transcript_score.is_none() && c.status == "NEW" { "discover.enriching" } else { "discover.relevance" });
    let score = col().gap(2.0).w(96.0)
        .child(text(format!("{:.0}%", score_of(c) * 100.0)).key(k("score")).font(type_::TITLE).color(p.text))
        .child(text(score_label).key(k("score-label")).font(type_::LABEL).color(p.muted));
    let url = c.url.clone();
    let mut actions = row().gap(8.0).child(btn(dark, k("yt"), &tr(l, "discover.youtube"), false, true, move |h: &mut H| open_video(h, &url)));
    let new = c.status == "NEW";
    if new {
        let iid = id.clone();
        actions = actions.child(btn(dark, k("import"), &tr(l, "discover.import"), false, !busy, move |h: &mut H| import(h, &iid)));
        let sid = id.clone();
        actions = actions.child(btn(dark, k("status"), &tr(l, "discover.skip"), false, !busy, move |h: &mut H| set_status(h, &sid, "SKIPPED")));
    } else if c.status == "SKIPPED" {
        let sid = id.clone();
        actions = actions.child(btn(dark, k("status"), &tr(l, "discover.restore"), false, !busy, move |h: &mut H| set_status(h, &sid, "NEW")));
    }
    let mut line = row().key(k("row")).role("listitem").label(c.title.as_str()).gap(12.0).items_center().w_full();
    if new {
        line = line.child(toggle(dark, l, &k("pick"), &trf(l, "discover.select", &[("title", &c.title)]), picked, move |h: &mut H| pick(h, &id)));
    }
    line.child(body).child(score).child(actions)
}

fn list_card<H: Host>(dark: bool, l: Lang, d: &Discover) -> El {
    let p = pal(dark);
    let mut filters = row().gap(8.0);
    for (f, key, label) in FILTERS {
        filters = filters.child(choice(dark, &format!("discover/filter/{key}"), &tr(l, label), d.filter == f, move |h: &mut H| set_filter(h, f)));
    }
    let mut c = card(dark, "discover/candidates", &trf(l, "discover.candidates", &[("n", &d.candidates.len().to_string())])).child(filters);
    if d.candidates.is_empty() {
        return c.child(state_block::<H>(dark, "discover/empty", StateKind::Empty, &tr(l, "discover.empty"), &tr(l, "discover.empty-next"), None));
    }
    let shown = if d.show_all { d.candidates.len() } else { SHOWN };
    for cand in d.candidates.iter().take(shown) {
        c = c.child(candidate_row::<H>(dark, l, cand, d));
    }
    if d.candidates.len() > shown {
        c = c.child(btn(dark, "discover/show-all", &trf(l, "discover.show-all", &[("n", &d.candidates.len().to_string())]), false, true, |h: &mut H| h.panels_mut().discover.show_all = true));
    }
    let queued = d.candidates.iter().filter(|c| c.status == "QUEUED").count();
    let bar = row().gap(10.0).items_center()
        .child(btn(dark, "discover/queue", &trf(l, "discover.queue", &[("n", &d.selected.len().to_string())]), false, !d.busy && !d.selected.is_empty(), queue::<H>))
        .child(btn(dark, "discover/drain", &trf(l, "discover.start", &[("n", &queued.to_string())]), true, !d.busy && queued > 0, drain::<H>));
    c.child(bar).child(text(tr(l, "discover.start-about")).font(type_::LABEL).color(p.muted).wrap())
}

pub fn view<H: Host>(h: &H) -> El {
    let (dark, l) = (h.dark(), h.lang());
    let d = &h.panels().discover;
    let head = heading(dark, "discover/title", &tr(l, "shell.discover"), &tr(l, "discover.sub"));
    let mut body = col().gap(16.0).w_full();
    match &d.load {
        Load::Failed(why) => body = body.child(state_block::<H>(dark, "discover/failed", StateKind::Error, &tr(l, "discover.read-failed"), &trf(l, "state.try-again-after", &[("why", why)]), Some(("discover/retry", &tr(l, "state.retry"), open::<H>)))),
        _ => body = body.child(finder::<H>(dark, l, d)).child(list_card::<H>(dark, l, d)),
    }
    if let Some(why) = &d.error {
        body = body.child(note(dark, "discover/error", Tone::Bad, &problem_words(l, why)));
    }
    if let Some(done) = &d.notice {
        body = body.child(note(dark, "discover/notice", Tone::Ok, &told_words(l, done)));
    }
    page().child(head).child(body)
}
