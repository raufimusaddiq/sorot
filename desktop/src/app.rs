//! The app: state, routing between screens, the work that talks to the engine off the UI thread,
//! and the headless mode (a `FakeEngine` scene, no sidecar, no tray, no notifications, no updates).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use rune::tok::{self, type_};
use rune::{AppSpec, Cx, El, Tx, col, row, text};
use sorot_desktop_core::engine_conn::{FailReason, State as ConnState};
use sorot_desktop_core::handshake::Ready;
use sorot_desktop_core::model::{Job, ReadinessItem, Video};
use sorot_desktop_core::polling::next_poll;
use sorot_desktop_core::toast::{Toast, ToastKind};

use crate::engine::http::HttpEngine;
use crate::engine::sidecar::{Sidecar, StartError};
use crate::engine::{Engine, EngineError};
use crate::ui::states::{Kind, state_block};
use crate::ui::toast::{ToastItem, toast_stack};

/// What the user sees of the engine connection.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Conn {
    Starting,
    Ready,
    /// The message to show, already in words a person can act on.
    Failed(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Screen {
    Starting,
    EngineFailed,
    Readiness,
    Home,
}

/// Everything one poll of the engine reads.
#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    pub jobs: Vec<Job>,
    pub videos: Vec<Video>,
    pub readiness: Vec<ReadinessItem>,
}

impl Snapshot {
    pub fn any_running(&self) -> bool {
        self.jobs.iter().any(Job::is_running) || self.readiness.iter().any(|i| i.progress.is_some())
    }
}

pub fn fetch_snapshot(engine: &dyn Engine) -> Result<Snapshot, EngineError> {
    Ok(Snapshot { jobs: engine.jobs()?, videos: engine.videos()?, readiness: engine.readiness()?.items })
}

/// What a worker hands back to the UI thread.
pub enum Msg {
    Engine(Arc<dyn Engine>),
    Conn(Conn),
    Snapshot(Snapshot),
    Toast(ToastKind, String),
}

/// Work the UI asks for; it runs off the UI thread and answers with messages.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Cmd {
    FixReadiness(String),
    Refresh,
}

pub fn execute(engine: &dyn Engine, cmd: Cmd) -> Vec<Msg> {
    let refresh = |mut msgs: Vec<Msg>| {
        match fetch_snapshot(engine) {
            Ok(s) => msgs.push(Msg::Snapshot(s)),
            Err(e) => msgs.push(Msg::Toast(ToastKind::Failed, e.to_string())),
        }
        msgs
    };
    match cmd {
        Cmd::Refresh => refresh(vec![]),
        Cmd::FixReadiness(id) => match engine.fix_readiness(&id) {
            Ok(_) => refresh(vec![Msg::Toast(ToastKind::Info, format!("Started: {id}"))]),
            Err(e) => vec![Msg::Toast(ToastKind::Failed, format!("Could not fix {id}: {e}"))],
        },
    }
}

/// What a worker's messages do on the UI thread.
pub fn apply_msgs(msgs: Vec<Msg>) -> impl FnOnce(&mut State, &mut Tx) + Send + 'static {
    move |s, _| msgs.into_iter().for_each(|m| s.apply(m))
}

/// Runs a closure off the UI thread and applies what it returns. Production runs it on a Rune
/// task and `AppHandle::update`; tests and headless runs have none, and apply it inline.
pub trait Bus: Send + Sync {
    fn background(&self, work: Box<dyn FnOnce() -> Vec<Msg> + Send>);
}

pub struct RuneBus(pub rune::AppHandle<State>);

impl Bus for RuneBus {
    fn background(&self, work: Box<dyn FnOnce() -> Vec<Msg> + Send>) {
        let handle = self.0.clone();
        let _ = rune::task::spawn("sorot-engine", move || {
            let msgs = work();
            handle.update(apply_msgs(msgs));
        });
    }
}

/// Owns the sidecar and turns each poll into messages and the wait until the next one.
pub struct Supervisor {
    pub sidecar: Sidecar,
    pub engine: Option<Arc<dyn Engine>>,
    make_engine: fn(&Ready, &str) -> Arc<dyn Engine>,
}

pub fn http_engine(ready: &Ready, token: &str) -> Arc<dyn Engine> {
    Arc::new(HttpEngine::new(format!("http://127.0.0.1:{}", ready.port), Some(token.to_string())))
}

/// What a person reads when the engine cannot run.
pub fn failure_text(reason: &FailReason, diagnostic: &str) -> String {
    let what = match reason {
        FailReason::ExitedBeforeReady => "The engine stopped before it was ready.",
        FailReason::ExitedEarly => "The engine stopped right after it started.",
        FailReason::StartTimeout => "The engine was not ready after 30 seconds.",
        FailReason::EngineTooNew => "This engine is newer than the app. Update Sorot.",
        FailReason::TooManyRestarts => "The engine keeps stopping.",
        FailReason::Unauthorized => "The engine refused the app's connection token.",
    };
    if diagnostic.is_empty() { what.to_string() } else { format!("{what}\n{diagnostic}") }
}

impl Supervisor {
    pub fn new(sidecar: Sidecar, make_engine: fn(&Ready, &str) -> Arc<dyn Engine>) -> Self {
        Supervisor { sidecar, engine: None, make_engine }
    }

    /// Starts the engine; the messages say how it went.
    pub fn boot(&mut self) -> Vec<Msg> {
        let started = self.sidecar.start();
        self.after_start(Some(started))
    }

    fn after_start(&mut self, started: Option<Result<Ready, StartError>>) -> Vec<Msg> {
        let mut msgs = vec![];
        if let Some(Ok(ready)) = &started {
            let engine = (self.make_engine)(ready, self.sidecar.token());
            self.engine = Some(engine.clone());
            msgs.push(Msg::Engine(engine));
            msgs.push(Msg::Conn(Conn::Ready));
        }
        if let ConnState::Failed(reason) = &self.sidecar.conn.state {
            msgs.push(Msg::Conn(Conn::Failed(failure_text(reason, &self.sidecar.diagnostic()))));
        }
        msgs
    }

    /// One look at the engine: its state, the health count, and a restart when it is due.
    pub fn tick(&mut self) -> (Vec<Msg>, Duration) {
        let Some(engine) = self.engine.clone() else { return (vec![], next_poll(true)) };
        match fetch_snapshot(engine.as_ref()) {
            Ok(snap) => {
                self.sidecar.health(true);
                let wait = next_poll(snap.any_running());
                (vec![Msg::Snapshot(snap)], wait)
            }
            Err(EngineError::Unauthorized) => {
                let started = self.sidecar.unauthorized();
                (self.after_start(started), next_poll(false))
            }
            Err(_) => {
                self.sidecar.health(false);
                let started = self.sidecar.recover();
                (self.after_start(started), next_poll(true))
            }
        }
    }

    pub fn user_restart(&mut self) -> Vec<Msg> {
        let started = self.sidecar.user_restart();
        self.after_start(started)
    }

    pub fn quit(&mut self) {
        self.sidecar.quit();
    }
}

pub struct State {
    pub engine: Option<Arc<dyn Engine>>,
    pub conn: Conn,
    pub jobs: Vec<Job>,
    pub videos: Vec<Video>,
    pub readiness: Vec<ReadinessItem>,
    pub toasts: Vec<ToastItem>,
    pub dark: bool,
    now: f64,
    bus: Option<Arc<dyn Bus>>,
    supervisor: Option<Arc<Mutex<Supervisor>>>,
}

impl Default for State {
    fn default() -> Self {
        State { engine: None, conn: Conn::Starting, jobs: vec![], videos: vec![], readiness: vec![], toasts: vec![], dark: true, now: 0.0, bus: None, supervisor: None }
    }
}

impl State {
    /// A state that applies work inline, against `engine`, already connected.
    pub fn with_engine(engine: Arc<dyn Engine>) -> Self {
        let mut s = State { engine: Some(engine), conn: Conn::Ready, ..State::default() };
        s.send(Cmd::Refresh);
        s
    }

    /// A state for a real engine: work runs on `bus`, restarts go through `supervisor`.
    pub fn live(bus: Arc<dyn Bus>, supervisor: Arc<Mutex<Supervisor>>) -> Self {
        State { bus: Some(bus), supervisor: Some(supervisor), ..State::default() }
    }

    /// The scene `name` under `desktop/scenes/`, played by a `FakeEngine`.
    #[cfg(any(test, feature = "headless", debug_assertions))]
    pub fn scene(name: &str) -> Self {
        use crate::engine::fake::FakeEngine;
        let fake = Arc::new(FakeEngine::scene(name));
        match fake.failure() {
            Some(message) => State { engine: Some(fake), conn: Conn::Failed(message), ..State::default() },
            None => State::with_engine(fake),
        }
    }

    pub fn screen(&self) -> Screen {
        match &self.conn {
            Conn::Starting => Screen::Starting,
            Conn::Failed(_) => Screen::EngineFailed,
            Conn::Ready if self.readiness.iter().any(|i| i.required && !i.ok) => Screen::Readiness,
            Conn::Ready => Screen::Home,
        }
    }

    pub fn apply(&mut self, msg: Msg) {
        match msg {
            Msg::Engine(e) => self.engine = Some(e),
            Msg::Conn(c) => self.conn = c,
            Msg::Snapshot(s) => (self.jobs, self.videos, self.readiness) = (s.jobs, s.videos, s.readiness),
            Msg::Toast(kind, text) => self.toasts.push(ToastItem { toast: Toast::new(kind, text, None), hovered: false }),
        }
    }

    pub fn send(&mut self, cmd: Cmd) {
        let Some(engine) = self.engine.clone() else { return };
        match self.bus.clone() {
            Some(bus) => bus.background(Box::new(move || execute(engine.as_ref(), cmd))),
            None => execute(engine.as_ref(), cmd).into_iter().for_each(|m| self.apply(m)),
        }
    }

    /// "Restart engine" on the failed screen.
    pub fn restart_engine(&mut self) {
        match (self.supervisor.clone(), self.bus.clone()) {
            (Some(sup), Some(bus)) => {
                self.conn = Conn::Starting;
                bus.background(Box::new(move || sup.lock().unwrap().user_restart()));
            }
            _ => self.conn = Conn::Starting,
        }
    }

    /// The toast clock: `t` is seconds since the app started.
    pub fn tick(&mut self, t: f64) -> bool {
        let dt_ms = ((t - self.now).max(0.0) * 1000.0) as u32;
        self.now = t;
        for item in &mut self.toasts {
            item.toast.tick(dt_ms, item.hovered);
        }
        let before = self.toasts.len();
        self.toasts.retain(|i| !i.toast.expired());
        self.toasts.len() != before
    }

    pub fn quit(&mut self) {
        if let Some(sup) = &self.supervisor {
            sup.lock().unwrap().quit();
        }
    }
}

pub fn view(s: &State, _: &mut Cx<State>) -> El {
    let t = tok::theme(s.dark);
    let screen = match s.screen() {
        Screen::Starting => state_block::<State>(s.dark, "engine/starting", Kind::Loading, "Starting the engine", "This takes a few seconds the first time.", None),
        Screen::EngineFailed => {
            let Conn::Failed(why) = &s.conn else { unreachable!("EngineFailed needs Failed") };
            let (cause, rest) = why.split_once('\n').unwrap_or((why, "Restart it, or export a diagnostic report."));
            state_block(s.dark, "engine/failed", Kind::Error, cause, rest, Some(("engine/restart", "Restart engine", State::restart_engine)))
        }
        Screen::Readiness => readiness_view(s),
        Screen::Home => home_view(s),
    };
    col().w_full().h_full().fill(t.bg).child(col().grow(1.0).w_full().center().child(screen)).child(toast_stack(s.dark, &s.toasts))
}

fn home_view(s: &State) -> El {
    let t = tok::theme(s.dark);
    if s.jobs.is_empty() && s.videos.is_empty() {
        return state_block::<State>(s.dark, "home/empty", Kind::Empty, "No videos yet", "Paste a link or choose a file to make your first clips.", None);
    }
    let mut list = col().key("home/jobs").role("list").gap(6.0).w(420.0);
    for j in &s.jobs {
        list = list.child(
            row().key(format!("home/job/{}", j.id)).role("listitem").label(format!("{} {}", j.status, j.current_stage.as_deref().unwrap_or(""))).gap(8.0)
                .child(text(&j.status).font(type_::LABEL).color(t.text)).child(text(j.current_stage.as_deref().unwrap_or("")).font(type_::BODY).color(t.text_secondary)),
        );
    }
    list
}

fn readiness_view(s: &State) -> El {
    let t = tok::theme(s.dark);
    let mut list = col().key("readiness/items").gap(10.0).w(520.0)
        .child(text("Sorot needs a few things first").key("readiness/title").role("heading").level(1).font(type_::TITLE).color(t.text));
    for item in &s.readiness {
        let id = item.id.clone();
        let tail = match (&item.progress, item.ok, item.fixable) {
            (Some(p), _, _) => text(format!("{} {}%", p.label, p.percent)).key(format!("readiness/{id}/progress")).font(type_::LABEL).color(t.text),
            (None, true, _) => text("Ready").font(type_::LABEL).color(t.text_secondary),
            (None, false, true) => {
                let fix_id = id.clone();
                col().key(format!("readiness/{id}/fix")).role("button").label(format!("Fix {id}")).focusable(true).padding(6.0).radius(6.0)
                    .fill(t.card).border(1.0, t.card_border).on_press(move |s: &mut State| s.send(Cmd::FixReadiness(fix_id.clone())))
                    .child(text("Fix").font(type_::LABEL).color(t.text))
            }
            (None, false, false) => text("Needs attention").font(type_::LABEL).color(t.text_secondary),
        };
        list = list.child(
            row().key(format!("readiness/{id}")).gap(12.0).items_center()
                .child(text(&item.detail).font(type_::BODY).color(t.text).wrap().grow(1.0)).child(tail),
        );
    }
    list
}

/// Scene functions are plain `fn`s; each folder under `desktop/scenes/` has one here, and a test
/// holds the list equal to the folders.
pub type Scene = (&'static str, fn(&mut State));

pub const SCENES: &[Scene] = &[
    ("home-empty", |s| *s = State::scene("home-empty")),
    ("readiness-missing", |s| *s = State::scene("readiness-missing")),
    ("engine-failed", |s| *s = State::scene("engine-failed")),
];

pub fn spec() -> AppSpec<State> {
    AppSpec {
        scenes: SCENES,
        min_size: Some((720.0, 480.0)),
        fonts: &[include_bytes!("../assets/fonts/InstrumentSans.ttf")],
        families: ("Instrument Sans", "monospace"),
        poll: Some(|s: &mut State, t: f64, _: &mut Tx| s.tick(t)),
        ..AppSpec::new("Sorot", (1100.0, 720.0), State::default, view)
    }
}

/// Polls the engine again after `wait`, for as long as the app runs.
pub fn schedule(handle: rune::AppHandle<State>, sup: Arc<Mutex<Supervisor>>, wait: Duration) {
    let _ = rune::task::spawn_after("sorot-poll", wait, move || {
        let (msgs, next) = sup.lock().unwrap().tick();
        handle.update(apply_msgs(msgs));
        if !rune::quitting() {
            schedule(handle, sup, next);
        }
    });
}

/// A state for a real engine: boots it on a task thread and keeps polling it.
pub fn start_live(handle: rune::AppHandle<State>, supervisor: Supervisor) -> State {
    let sup = Arc::new(Mutex::new(supervisor));
    let (boot, bus) = (handle.clone(), Arc::new(RuneBus(handle)));
    let worker = sup.clone();
    let _ = rune::task::spawn("sorot-boot", move || {
        let msgs = worker.lock().unwrap().boot();
        boot.update(apply_msgs(msgs));
        schedule(boot, worker, Duration::from_secs(1));
    });
    State::live(bus, sup)
}

pub fn run(supervisor: fn() -> Supervisor) {
    let app = rune::App::new(spec()).on_quit(|s: &mut State, _| s.quit());
    let handle = app.handle();
    // Rune knows it is headless only once `run` has started, so the choice is made in `init`.
    app.init(move || match rune::tooling::headless_run() {
        Some(_) => State::scene("home-empty"),
        None => start_live(handle, supervisor()),
    })
    .run();
}

/// The generated theme (`theme/sorot.json`) in both appearances.
pub const THEME_JSON: &str = include_str!("../theme/sorot.json");

#[cfg(test)]
mod theme_tests {
    use super::*;

    #[test]
    fn generated_theme_loads_in_both_modes() {
        for dark in [true, false] {
            let t = rune::Theme::from_json(THEME_JSON, dark).unwrap();
            assert_eq!(t.num("space-16"), 16.0);
            t.color("beam");
        }
    }
}
