//! The app: state, routing between screens, the work that talks to the engine off the UI thread,
//! and the headless mode (a `FakeEngine` scene, no sidecar, no tray, no notifications, no updates).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rune::{AppSpec, Cx, El, KeyEvent, Tx, col};
use rune_fx::OneShots;
use sorot_desktop_core::close::{CloseAction, ClosePref, on_close};
use sorot_desktop_core::engine_conn::{FailReason, State as ConnState};
use sorot_desktop_core::handshake::Ready;
use sorot_desktop_core::clips::Options;
use sorot_desktop_core::model::{Clip, Job, JobDetail, JobPhase, ReadinessItem, Video};
use sorot_desktop_core::polling::next_poll;
use sorot_desktop_core::readiness::{Item, ItemId};
use sorot_desktop_core::toast::{Toast, ToastKind};
use sorot_desktop_core::workspace::{Candidate, Workspace, rank_candidates};

use crate::engine::http::HttpEngine;
use crate::engine::sidecar::{Sidecar, StartError};
use crate::engine::{EditOptions, Engine, EngineError, ImportRequest, Started};
use crate::library::Library;
use crate::platform::gpu_probe::GpuProbe;
use crate::platform::reveal::Reveal;
use crate::platform::tray::{Tray, TrayCmd};
use crate::preview::{NullPreview, Preview, PreviewCache};
use crate::screens::shell::CloseAnswer;
use crate::screens::welcome::{How, Welcome, workspace_for};
use crate::screens::clips::ClipsScreen;
use crate::screens::editor::Editor;
use crate::screens::home::{Home, HomeError};
use crate::screens::job::JobScreen;
use crate::screens::panels::{Apply, Host, Panels, Work};
#[cfg(any(test, feature = "headless", debug_assertions))]
use crate::screens::panels::Page;
use crate::screens::settings::{connections, generate};
use crate::screens::{clips, discover, editor, home, job, learning, publish, readiness, shell, welcome};
use crate::ui::kit::pal;
use crate::ui::states::{Kind, state_block};
use crate::ui::toast::{ToastItem, toast_stack};

/// What the user sees of the engine connection.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Conn {
    Starting,
    Ready,
    /// The engine was up and stopped answering; the app is bringing it back.
    Lost,
    /// The message to show, already in words a person can act on.
    Failed(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Screen {
    Starting,
    EngineFailed,
    Welcome,
    Readiness,
    Home,
    Job,
    Clips,
    Editor,
    Connections,
    GenerateSettings,
    Publish,
    Learning,
    Discover,
}

/// Which working screen is open once the engine is ready.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum Route {
    #[default]
    Home,
    /// A job id.
    Job(String),
    /// A video id.
    Clips(String),
    /// A clip id.
    Editor(String),
    Connections,
    GenerateSettings,
    /// A clip id.
    Publish(String),
    Learning,
    Discover,
}

/// What the OS tells the app when a person clicks a notification: the job to open.
pub type ClickFn = Arc<dyn Fn(String) + Send + Sync>;

/// Desktop notifications: `rune-notify` on Windows and macOS, `notify-rust` on Linux.
pub trait Notifier: Send + Sync {
    fn notify(&self, job_id: &str, title: &str, body: &str);
    fn on_click(&self, f: ClickFn);
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
    /// The libraries `--find-libraries` found, best first.
    Candidates(Vec<Candidate>),
    /// Percent of a running library copy.
    Copying(u8),
    /// The first-run choice failed; the screen says why and stays.
    WelcomeFailed(String),
    /// The choice was made and saved; `skipped` are the files a copy could not read.
    Workspace { ws: Workspace, skipped: Vec<String> },
    /// An import started this job.
    Started(Started),
    ImportFailed(EngineError),
    JobDetail(JobDetail),
    Clips { video_id: String, clips: Vec<Clip> },
    Rerendered(Box<Clip>),
    RerenderFailed(String),
    Exported { clip_id: String, path: String },
    ExportFailed(String),
    Options { options: EditOptions, music: Vec<String> },
    /// The local file of a clip's preview, or why there is none.
    PreviewReady { clip_id: String, path: Result<PathBuf, String> },
    /// A notification was clicked.
    OpenJob(String),
    /// What the GPU probe found: Rune draws on a CPU renderer.
    Gpu { software: bool },
    /// A change to the settings, publish, learning or discover panels.
    Panel(Apply),
}

/// Work the UI asks for; it runs off the UI thread and answers with messages.
#[derive(Clone, Debug, PartialEq)]
pub enum Cmd {
    FixReadiness(String),
    FixAll(Vec<String>),
    Refresh,
    /// Ask the engine for older libraries (first run).
    Find,
    /// The first-run choice; `keys` brings the API keys along.
    Choose { how: How, from: String, keys: bool },
    Import(ImportRequest),
    LoadOptions,
    PollJob(String),
    CancelJob(String),
    RetryJob(String),
    LoadClips(String),
    Rerender { clip_id: String, delta: Options },
    Export(String),
    DownloadExport { clip_id: String, dest: PathBuf },
    /// Handled by `State::send`, which owns the cache.
    Preview(Box<Clip>),
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
        Cmd::Refresh | Cmd::Find | Cmd::Choose { .. } | Cmd::Preview(_) => refresh(vec![]),
        Cmd::Import(req) => match engine.import(&req) {
            Ok(started) => refresh(vec![Msg::Started(started)]),
            Err(e) => vec![Msg::ImportFailed(e)],
        },
        Cmd::LoadOptions => match engine.options() {
            Ok(options) => vec![Msg::Options { options, music: engine.music().unwrap_or_default() }],
            Err(e) => vec![Msg::Toast(ToastKind::Failed, format!("Could not read the options: {e}"))],
        },
        Cmd::PollJob(id) => engine.job(&id).map(|d| vec![Msg::JobDetail(d)]).unwrap_or_default(),
        Cmd::CancelJob(id) => match engine.cancel_job(&id) {
            Ok(_) => refresh(engine.job(&id).map(|d| vec![Msg::JobDetail(d)]).unwrap_or_default()),
            Err(e) => vec![Msg::Toast(ToastKind::Failed, format!("Could not cancel: {e}"))],
        },
        Cmd::RetryJob(id) => match engine.retry_job(&id) {
            Ok(_) => refresh(engine.job(&id).map(|d| vec![Msg::JobDetail(d)]).unwrap_or_default()),
            Err(e) => vec![Msg::Toast(ToastKind::Failed, format!("Could not retry: {e}"))],
        },
        Cmd::LoadClips(video_id) => match engine.clips(&video_id) {
            Ok(clips) => vec![Msg::Clips { video_id, clips }],
            Err(e) => vec![Msg::Toast(ToastKind::Failed, format!("Could not read the clips: {e}"))],
        },
        Cmd::Rerender { clip_id, delta } => match engine.rerender(&clip_id, &delta) {
            Ok(clip) => vec![Msg::Rerendered(Box::new(clip))],
            Err(e) => vec![Msg::RerenderFailed(format!("Could not render again: {e}"))],
        },
        Cmd::Export(clip_id) => match engine.export(&clip_id) {
            Ok(path) => vec![Msg::Exported { clip_id, path }],
            Err(e) => vec![Msg::ExportFailed(format!("Could not export: {e}"))],
        },
        Cmd::DownloadExport { clip_id, dest } => match engine.download_export(&clip_id, &dest) {
            Ok(_) => vec![Msg::Toast(ToastKind::Done, format!("Saved to {}", dest.display()))],
            Err(e) => vec![Msg::Toast(ToastKind::Failed, format!("Could not save the clip: {e}"))],
        },
        Cmd::FixAll(ids) => {
            let failed = ids.iter().filter_map(|id| engine.fix_readiness(id).err().map(|e| Msg::Toast(ToastKind::Failed, format!("Could not fix {id}: {e}")))).collect();
            refresh(failed)
        }
        Cmd::FixReadiness(id) => match engine.fix_readiness(&id) {
            Ok(_) => refresh(vec![Msg::Toast(ToastKind::Info, format!("Started: {id}"))]),
            Err(e) => vec![Msg::Toast(ToastKind::Failed, format!("Could not fix {id}: {e}"))],
        },
    }
}

/// The first-run commands, against the engine's startup commands. `data_dir` is where a new or
/// copied library lives; `config` is where `workspace.json` is saved.
pub fn library_work(lib: &dyn Library, config: &Path, data_dir: &str, cmd: Cmd, progress: &mut dyn FnMut(u8)) -> Vec<Msg> {
    let failed = |m: String| vec![Msg::WelcomeFailed(m)];
    match cmd {
        Cmd::Find => match lib.find() {
            Ok(found) => vec![Msg::Candidates(rank_candidates(&found))],
            Err(e) => vec![Msg::Toast(ToastKind::Failed, format!("Could not look for older libraries: {e}"))],
        },
        Cmd::Choose { how, from, keys } => {
            let ws = workspace_for(how, &from, data_dir);
            let mut msgs = vec![];
            let skipped = match how {
                How::Copy => match lib.copy(&from, data_dir, progress) {
                    Ok(skipped) => skipped,
                    Err(e) => return failed(format!("Copying failed: {e}")),
                },
                How::Use | How::Fresh => vec![],
            };
            if keys && let Err(e) = lib.import_keys(&from, &ws.data_dir) {
                msgs.push(Msg::Toast(ToastKind::Failed, format!("The API keys were not brought over: {e}")));
            }
            if let Err(e) = crate::workspace::save(config, &ws) {
                return failed(format!("Could not save your choice: {e}"));
            }
            msgs.push(Msg::Workspace { ws, skipped });
            msgs
        }
        _ => vec![],
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
    /// Hands messages to the UI thread while a background job still runs (progress).
    fn post(&self, _msgs: Vec<Msg>) {}
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

    fn post(&self, msgs: Vec<Msg>) {
        self.0.update(apply_msgs(msgs));
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
        self.tick_with(&mut |_| {})
    }

    /// As `tick`; `early` hears `Lost` before the restart it starts, which takes a while.
    pub fn tick_with(&mut self, early: &mut dyn FnMut(Vec<Msg>)) -> (Vec<Msg>, Duration) {
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
                if self.sidecar.conn.state == ConnState::Lost {
                    early(vec![Msg::Conn(Conn::Lost)]);
                }
                let started = self.sidecar.recover();
                (self.after_start(started), next_poll(true))
            }
        }
    }

    pub fn user_restart(&mut self) -> Vec<Msg> {
        let started = self.sidecar.user_restart();
        self.after_start(started)
    }

    /// The engine again, on another data folder (the first-run choice).
    pub fn relaunch_in(&mut self, dir: PathBuf) -> Vec<Msg> {
        let started = Some(self.sidecar.relaunch_in(dir));
        self.after_start(started)
    }

    /// The last engine log lines, secrets removed.
    pub fn diagnostic(&self) -> String {
        self.sidecar.diagnostic()
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
    /// One state machine per readiness row (`core::readiness`), so a failed fix is told from a missing item.
    pub item_states: Vec<(String, Item)>,
    pub toasts: Vec<ToastItem>,
    pub dark: bool,
    /// First run: the older libraries on offer.
    pub welcome: Option<Welcome>,
    pub workspace: Option<Workspace>,
    pub close_pref: ClosePref,
    pub close_dialog: bool,
    /// A tray (Windows, Linux) or the Dock (macOS) can keep the app alive with its window closed.
    pub background_ok: bool,
    /// "Wait for the jobs": quit when none is running.
    pub idle_quit: bool,
    /// Set when the app was asked to quit.
    pub quit_asked: bool,
    pub route: Route,
    pub home: Home,
    pub job: JobScreen,
    pub clips: ClipsScreen,
    pub editor: Editor,
    pub panels: Panels,
    /// The engine's caption styles, framing modes and defaults, and the music it has.
    pub edit_options: Option<EditOptions>,
    pub music: Vec<String>,
    pub preview: Box<dyn Preview>,
    pub reveal: Option<Arc<dyn Reveal>>,
    pub notifier: Option<Arc<dyn Notifier>>,
    /// The window has focus: a finished job is told by the screen, not the OS.
    pub focused: bool,
    /// Preferences: notify when a job ends while the window is not in front.
    pub notifications: bool,
    /// The engine runs on another machine: its files are downloaded, not shown in a folder.
    pub remote: bool,
    /// Rune draws on a CPU renderer: no blur or glow, and previews open in the video player.
    /// The job-done sparkle, thrown once when a job completes.
    pub bursts: OneShots<()>,
    pub cpu_renderer: bool,
    /// The language of every string (Indonesian unless the person chose English).
    pub lang: crate::i18n::Lang,
    /// The menu whose list is open under the menu bar.
    pub menu_open: Option<crate::screens::shell::Menu>,
    /// The key of the dropdown whose list is open (one at a time).
    pub open_select: Option<String>,
    /// App clock of the last read of the import options (read while Home shows and none are loaded).
    pub options_polled: f64,
    /// The one dismissible "no graphics acceleration" notice.
    pub gpu_notice: bool,
    pub now: f64,
    last_poll: f64,
    searched: bool,
    data_dir: String,
    config_dir: Option<PathBuf>,
    library: Option<Arc<dyn Library>>,
    handle: Option<rune::AppHandle<State>>,
    bus: Option<Arc<dyn Bus>>,
    supervisor: Option<Arc<Mutex<Supervisor>>>,
    preview_cache: Option<Arc<Mutex<PreviewCache>>>,
}

impl Default for State {
    fn default() -> Self {
        State {
            engine: None, conn: Conn::Starting, jobs: vec![], videos: vec![], readiness: vec![], item_states: vec![], toasts: vec![], dark: true,
            welcome: None, workspace: None, close_pref: ClosePref::Ask, close_dialog: false, background_ok: false, idle_quit: false, quit_asked: false,
            route: Route::Home, home: Home::default(), job: JobScreen::default(), clips: ClipsScreen::default(), editor: Editor::default(), panels: Panels::default(),
            edit_options: None, music: vec![], preview: Box::new(NullPreview::default()), reveal: None, notifier: None, focused: true, notifications: true, remote: false,
            bursts: OneShots::new(1), cpu_renderer: false, lang: crate::i18n::Lang::default(), menu_open: None, open_select: None, options_polled: -10.0, gpu_notice: false, now: 0.0, last_poll: 0.0, searched: false, data_dir: String::new(), config_dir: None, library: None, handle: None, bus: None, supervisor: None, preview_cache: None,
        }
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

    /// Where first-run looks for older libraries and keeps `workspace.json`. `data_dir` is the
    /// folder the engine runs on until a choice says otherwise. A saved workspace skips the welcome.
    pub fn with_library(mut self, library: Arc<dyn Library>, config_dir: PathBuf, data_dir: String, saved: Option<Workspace>) -> Self {
        (self.library, self.config_dir, self.data_dir, self.workspace) = (Some(library), Some(config_dir), data_dir, saved);
        self
    }

    /// What the OS gives the app: the file manager, notifications, the preview player.
    pub fn with_platform(mut self, reveal: Arc<dyn Reveal>, notifier: Arc<dyn Notifier>, preview: Box<dyn Preview>) -> Self {
        (self.reveal, self.notifier, self.preview) = (Some(reveal), Some(notifier), preview);
        self
    }

    pub fn with_handle(mut self, handle: rune::AppHandle<State>, background_ok: bool) -> Self {
        (self.handle, self.background_ok) = (Some(handle), background_ok);
        self
    }

    /// The scene `name` under `desktop/scenes/`, played by a `FakeEngine`. A scene with
    /// `libraries.json` is a first run: it never reads or writes the real `workspace.json`.
    #[cfg(any(test, feature = "headless", debug_assertions))]
    pub fn scene(name: &str) -> Self {
        use crate::engine::fake::{FakeEngine, scenes_dir};
        use crate::library::SceneLibrary;
        let fake = Arc::new(FakeEngine::scene(name));
        if let Some(message) = fake.failure() {
            return State { engine: Some(fake), conn: Conn::Failed(message), ..State::default() };
        }
        let dir = scenes_dir().join(name);
        let mut s = State::with_engine(fake);
        s.reveal = Some(Arc::new(crate::engine::fake::RecordReveal::default()));
        if dir.join("libraries.json").is_file() {
            let config = std::env::var("SOROT_CONFIG_DIR").map(PathBuf::from).unwrap_or_else(|_| std::env::temp_dir().join(format!("sorot-scene-{name}")));
            s = s.with_library(Arc::new(SceneLibrary::new(dir)), config, "scene-data".into(), None);
            s.maybe_first_run();
        }
        s
    }

    pub fn screen(&self) -> Screen {
        match &self.conn {
            Conn::Starting => Screen::Starting,
            Conn::Failed(_) => Screen::EngineFailed,
            Conn::Ready | Conn::Lost if self.welcome.is_some() => Screen::Welcome,
            Conn::Ready | Conn::Lost if !self.clipping_allowed() => Screen::Readiness,
            Conn::Ready | Conn::Lost => match self.route {
                Route::Home => Screen::Home,
                Route::Job(_) => Screen::Job,
                Route::Clips(_) => Screen::Clips,
                Route::Editor(_) => Screen::Editor,
                Route::Connections => Screen::Connections,
                Route::GenerateSettings => Screen::GenerateSettings,
                Route::Publish(_) => Screen::Publish,
                Route::Learning => Screen::Learning,
                Route::Discover => Screen::Discover,
            },
        }
    }

    pub fn apply(&mut self, msg: Msg) {
        match msg {
            Msg::Engine(e) => self.engine = Some(e),
            Msg::Conn(c) => {
                self.conn = c;
                self.maybe_first_run();
            }
            Msg::Snapshot(snap) => {
                self.notify_ended(&snap.jobs);
                (self.jobs, self.videos, self.readiness) = (snap.jobs, snap.videos, snap.readiness);
                self.track_readiness();
            }
            Msg::Toast(kind, text) => self.toasts.push(ToastItem { toast: Toast::new(kind, text, None), hovered: false }),
            Msg::Candidates(found) if found.is_empty() => self.send(Cmd::Choose { how: How::Fresh, from: String::new(), keys: false }),
            Msg::Candidates(found) => self.welcome = Some(Welcome::new(found)),
            Msg::Copying(n) => self.with_welcome(|w| w.copying = Some(n)),
            Msg::WelcomeFailed(why) => self.with_welcome(|w| (w.copying, w.error) = (None, Some(why))),
            Msg::Workspace { ws, skipped } => {
                let moved = ws.data_dir != self.data_dir;
                self.workspace = Some(ws.clone());
                if skipped.is_empty() {
                    self.welcome = None;
                } else {
                    self.with_welcome(|w| (w.copying, w.skipped) = (None, Some(skipped)));
                }
                if moved {
                    self.data_dir = ws.data_dir.clone();
                    self.relaunch_engine(ws.data_dir);
                }
            }
            Msg::Panel(change) => change(&mut self.panels),
            Msg::Started(started) => {
                self.home = Home::default();
                self.open_job(&started.job_id);
            }
            Msg::ImportFailed(e) => self.home.error = Some(HomeError::Engine(e)),
            Msg::JobDetail(detail) => self.apply_job(detail),
            Msg::Clips { video_id, clips } => self.apply_clips(&video_id, clips),
            Msg::Rerendered(clip) => self.rerendered(*clip),
            Msg::RerenderFailed(why) => {
                self.editor.rendering = false;
                self.apply(Msg::Toast(ToastKind::Failed, why));
            }
            Msg::Exported { clip_id, path } => self.exported(&clip_id, &path),
            Msg::ExportFailed(why) => {
                self.clips.exporting = None;
                self.apply(Msg::Toast(ToastKind::Failed, why));
            }
            Msg::Options { options, music } => (self.edit_options, self.music) = (Some(options), music),
            Msg::PreviewReady { clip_id, path } => {
                if let Some(clip) = self.selected_clip().filter(|c| c.id == clip_id).cloned() {
                    match path {
                        Ok(file) if self.cpu_renderer => self.clips.external = Some(file),
                        Ok(file) => self.preview.open(&file, Some(clip.duration_sec)),
                        Err(why) => self.clips.preview_error = Some(why),
                    }
                }
            }
            Msg::Gpu { software } => (self.cpu_renderer, self.gpu_notice) = (software, software),
            Msg::OpenJob(id) => {
                if let Some(h) = &self.handle {
                    h.show();
                    h.focus();
                }
                self.open_job(&id);
            }
        }
    }

    /// A job that was running and has ended tells the person, when the window is not in front.
    fn notify_ended(&self, now: &[Job]) {
        let (Some(notifier), false, true) = (&self.notifier, self.focused, self.notifications) else { return };
        for j in now.iter().filter(|j| !j.is_running() && self.jobs.iter().any(|o| o.id == j.id && o.is_running())) {
            match j.phase() {
                JobPhase::Completed => notifier.notify(&j.id, "Your clips are ready", "Open Sorot to see them ranked."),
                JobPhase::Failed | JobPhase::Interrupted => notifier.notify(&j.id, "A job stopped", j.error_message.as_deref().unwrap_or("Open Sorot to retry it.")),
                _ => {}
            }
        }
    }

    fn preview_dir(&self) -> PathBuf {
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.config_dir.as_ref().map_or_else(|| std::env::temp_dir().join(format!("sorot-preview-{}-{n}", std::process::id())), |d| d.join("preview"))
    }

    fn send_preview(&mut self, clip: Clip) {
        let Some(engine) = self.engine.clone() else { return };
        let dir = self.preview_dir();
        let cache = self.preview_cache.get_or_insert_with(|| Arc::new(Mutex::new(PreviewCache::new(dir)))).clone();
        let work = move || {
            let path = cache.lock().unwrap().fetch(engine.as_ref(), &clip).map_err(|e| e.to_string());
            vec![Msg::PreviewReady { clip_id: clip.id, path }]
        };
        match self.bus.clone() {
            Some(bus) => bus.background(Box::new(work)),
            None => work().into_iter().for_each(|m| self.apply(m)),
        }
    }

    /// `core::readiness`'s gate over the engine's rows (the GPU only picks speed, so it never blocks).
    pub fn clipping_allowed(&self) -> bool {
        let items: Vec<Item> = self.item_states.iter().map(|(_, i)| i.clone()).collect();
        sorot_desktop_core::readiness::clipping_allowed(&items)
    }

    fn with_welcome(&mut self, f: impl FnOnce(&mut Welcome)) {
        if let Some(w) = &mut self.welcome {
            f(w);
        }
    }

    fn track_readiness(&mut self) {
        for row in &self.readiness {
            match self.item_states.iter_mut().find(|(id, _)| *id == row.id) {
                Some((_, item)) => item.apply(row),
                None => {
                    let mut item = Item::new(ItemId::parse(&row.id), row.required);
                    item.apply(row);
                    self.item_states.push((row.id.clone(), item));
                }
            }
        }
    }

    /// With no saved workspace, asks the engine once for older libraries.
    pub fn maybe_first_run(&mut self) {
        if self.workspace.is_none() && self.library.is_some() && !self.searched && self.conn == Conn::Ready {
            self.searched = true;
            self.send(Cmd::Find);
        }
    }

    pub fn send(&mut self, cmd: Cmd) {
        if matches!(cmd, Cmd::Find | Cmd::Choose { .. }) {
            return self.send_library(cmd);
        }
        if let Cmd::Preview(clip) = cmd {
            return self.send_preview(*clip);
        }
        let Some(engine) = self.engine.clone() else { return };
        match self.bus.clone() {
            Some(bus) => bus.background(Box::new(move || execute(engine.as_ref(), cmd))),
            None => execute(engine.as_ref(), cmd).into_iter().for_each(|m| self.apply(m)),
        }
    }

    fn send_library(&mut self, cmd: Cmd) {
        let (Some(lib), Some(config)) = (self.library.clone(), self.config_dir.clone()) else { return };
        if matches!(cmd, Cmd::Choose { how: How::Copy, .. }) {
            self.with_welcome(|w| (w.copying, w.error) = (Some(0), None));
        }
        let data_dir = self.data_dir.clone();
        match self.bus.clone() {
            Some(bus) => {
                let post = bus.clone();
                bus.background(Box::new(move || library_work(lib.as_ref(), &config, &data_dir, cmd, &mut |n| post.post(vec![Msg::Copying(n)]))));
            }
            None => library_work(lib.as_ref(), &config, &data_dir, cmd, &mut |_| {}).into_iter().for_each(|m| self.apply(m)),
        }
    }

    /// A CPU renderer cannot play video well: Play hands the clip to the system's video player.
    pub fn open_externally(&mut self) {
        let Some(file) = self.clips.external.clone() else { return };
        if let Some(Err(e)) = self.reveal.as_ref().map(|r| r.open(&file)) {
            self.clips.preview_error = Some(format!("Could not open your video player: {e}"));
        }
    }

    pub fn hide_window(&mut self) {
        if let Some(h) = &self.handle {
            h.hide();
        }
    }

    pub fn dismiss_gpu_notice(&mut self) {
        self.gpu_notice = false;
    }

    pub fn toggle_keys(&mut self) {
        self.with_welcome(|w| w.keys = !w.keys);
    }

    /// "Continue" after a copy that skipped files.
    pub fn finish_welcome(&mut self) {
        self.welcome = None;
    }

    fn relaunch_engine(&mut self, dir: String) {
        if let (Some(sup), Some(bus)) = (self.supervisor.clone(), self.bus.clone()) {
            self.conn = Conn::Starting;
            bus.background(Box::new(move || sup.lock().unwrap().relaunch_in(dir.into())));
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

    /// "Export diagnostic report": the engine's last log lines, secrets removed, saved beside `workspace.json`.
    pub fn export_diagnostic(&mut self) {
        let report = self.supervisor.as_ref().map(|s| s.lock().unwrap().diagnostic());
        let toast = match (report, &self.config_dir) {
            (Some(text), Some(dir)) => {
                let path = dir.join("diagnostic-report.txt");
                match std::fs::create_dir_all(dir).and_then(|()| std::fs::write(&path, text)) {
                    Ok(()) => Msg::Toast(ToastKind::Done, format!("Saved the report to {}", path.display())),
                    Err(e) => Msg::Toast(ToastKind::Failed, format!("Could not save the report: {e}")),
                }
            }
            _ => Msg::Toast(ToastKind::Failed, "There is no engine log to export yet.".into()),
        };
        self.apply(toast);
    }

    pub fn running_jobs(&self) -> usize {
        self.jobs.iter().filter(|j| j.is_running()).count()
    }

    /// Cancels every running job. Failures are ignored: the app is on its way out.
    pub fn cancel_running(&mut self) {
        if let Some(engine) = self.engine.clone() {
            self.jobs.iter().filter(|j| j.is_running()).for_each(|j| drop(engine.cancel_job(&j.id)));
        }
    }

    /// What closing the window does now. Without a tray a "background" preference cannot hide the app.
    pub fn close_action(&self) -> CloseAction {
        let pref = if self.background_ok || self.close_pref != ClosePref::Background { self.close_pref } else { ClosePref::Ask };
        on_close(self.running_jobs(), pref)
    }

    /// The window is closing: true when the app should quit with it.
    pub fn closing(&mut self) -> bool {
        if rune::quitting() {
            return false;
        }
        match self.close_action() {
            CloseAction::Quit => true,
            CloseAction::QuitCancelJobs => {
                self.cancel_running();
                true
            }
            CloseAction::HideKeepRunning => false,
            CloseAction::AskDialog => {
                self.close_dialog = true;
                if let Some(h) = &self.handle {
                    h.show();
                }
                false
            }
        }
    }

    /// A press on one of the close dialog's three answers.
    pub fn answer_close(&mut self, answer: CloseAnswer) {
        self.close_dialog = false;
        match answer {
            CloseAnswer::Background => {
                if let Some(h) = &self.handle {
                    h.hide();
                }
            }
            CloseAnswer::Wait => {
                self.idle_quit = true;
                self.apply(Msg::Toast(ToastKind::Info, "Sorot will close when the jobs finish.".into()));
            }
            CloseAnswer::CancelAndQuit => self.tray(TrayCmd::Quit),
        }
    }

    /// True once "Wait for the jobs" has nothing left to wait for.
    pub fn idle_quit_due(&self) -> bool {
        self.idle_quit && self.running_jobs() == 0
    }

    /// The tray's two menu items (and "Cancel the jobs and quit", which is the second one).
    pub fn tray(&mut self, cmd: TrayCmd) {
        match cmd {
            TrayCmd::Open => {
                if let Some(h) = &self.handle {
                    h.show();
                    h.focus();
                }
            }
            TrayCmd::Quit => {
                self.cancel_running();
                self.quit_asked = true;
                if let Some(h) = &self.handle {
                    h.quit();
                }
            }
        }
    }

    /// The toast clock: `t` is seconds since the app started. A run with no supervisor (a scene)
    /// also reads the engine again twice a second while a fix is running.
    pub fn tick(&mut self, t: f64) -> bool {
        let dt_ms = ((t - self.now).max(0.0) * 1000.0) as u32;
        self.now = t;
        for item in &mut self.toasts {
            item.toast.tick(dt_ms, item.hovered);
        }
        self.preview.pump();
        let before = self.toasts.len();
        self.toasts.retain(|i| !i.toast.expired());
        let mut changed = self.toasts.len() != before;
        if self.supervisor.is_none() && self.conn == Conn::Ready && self.readiness.iter().any(|i| i.progress.is_some()) && t - self.last_poll >= 0.5 {
            self.last_poll = t;
            self.send(Cmd::Refresh);
            changed = true;
        }
        if self.conn == Conn::Ready && t - self.panels.polled >= 2.0 {
            self.panels.polled = t;
            match self.route {
                Route::GenerateSettings if self.panels.generate.calibrating() => generate::poll(self),
                Route::Discover if self.panels.discover.polling() => discover::poll(self),
                _ => {}
            }
        }
        if self.conn == Conn::Ready && matches!(self.route, Route::Home) && self.edit_options.is_none() && t - self.options_polled >= 5.0 {
            self.options_polled = t;
            self.load_options();
        }
        let watching = matches!(self.route, Route::Job(_)) && self.conn == Conn::Ready;
        changed |= watching && (self.poll_job(t) || self.job.detail.as_ref().is_some_and(|d| d.job.is_running()));
        let sparkling = self.bursts.is_animating(t as f32, crate::ui::fx_moments::sparkle_params(0.0).burst_life());
        changed |= (watching && self.job.moving(t)) || sparkling || (matches!(self.route, Route::Clips(_)) && self.clips.moving(t as f32));
        changed || self.preview.state() == crate::preview::PreviewState::Playing
    }

    pub fn quit(&mut self) {
        if let Some(sup) = &self.supervisor {
            sup.lock().unwrap().quit();
        }
    }
}

pub fn view(s: &State, _: &mut Cx<State>) -> El {
    crate::ui::beam::begin_screen();
    let p = pal(s.dark);
    let body = match s.screen() {
        Screen::Home => shell::with_rail(s, home::view(s)),
        Screen::Job => shell::with_rail(s, job::view(s)),
        Screen::Clips => shell::with_rail(s, clips::view(s)),
        Screen::Editor => shell::with_rail(s, editor::view(s)),
        Screen::Connections => shell::with_rail(s, connections::view(s)),
        Screen::GenerateSettings => shell::with_rail(s, generate::view(s)),
        Screen::Publish => shell::with_rail(s, publish::view(s)),
        Screen::Learning => shell::with_rail(s, learning::view(s)),
        Screen::Discover => shell::with_rail(s, discover::view(s)),
        screen => {
            let content = match screen {
                Screen::Starting => state_block::<State>(s.dark, "engine/starting", Kind::Loading, "Starting the engine", "This takes a few seconds the first time.", None),
                Screen::EngineFailed => {
                    let Conn::Failed(why) = &s.conn else { unreachable!("EngineFailed needs Failed") };
                    let (cause, rest) = why.split_once('\n').unwrap_or((why, "Restart it, or export a diagnostic report."));
                    state_block::<State>(s.dark, "engine/failed", Kind::Error, cause, rest, None)
                }
                Screen::Welcome => welcome::view(s, s.welcome.as_ref().expect("Welcome needs its state")),
                _ => readiness::view(s),
            };
            col().grow(1.0).w_full().center().child(content)
        }
    };
    let body = if s.close_dialog { col().grow(1.0).w_full().center().child(shell::close_dialog(s)) } else { body };
    let mut root = col().w_full().h_full().fill(p.bg).child(shell::menu_bar(s));
    if let Some(list) = shell::menu_list(s) {
        root = root.child(list);
    }
    if let Some(banner) = shell::banner(s) {
        root = root.child(banner);
    }
    if let Some(notice) = shell::gpu_notice(s) {
        root = root.child(notice);
    }
    root.child(body).child(toast_stack(s.dark, &s.toasts).pin(Some(0.0), None, Some(0.0), Some(0.0)))
}

impl Host for State {
    fn panels(&self) -> &Panels {
        &self.panels
    }

    fn panels_mut(&mut self) -> &mut Panels {
        &mut self.panels
    }

    fn dark(&self) -> bool {
        self.dark
    }

    fn lang(&self) -> crate::i18n::Lang {
        self.lang
    }

    fn engine(&self) -> Option<Arc<dyn Engine>> {
        self.engine.clone()
    }

    fn run(&mut self, work: Work) {
        let Some(engine) = self.engine.clone() else { return };
        match self.bus.clone() {
            Some(bus) => bus.background(Box::new(move || vec![Msg::Panel(work(engine.as_ref()))])),
            None => self.apply(Msg::Panel(work(engine.as_ref()))),
        }
    }

    fn remembered(&self) -> Vec<String> {
        self.config_dir.as_deref().map(crate::remembered::load).unwrap_or_default()
    }

    fn remember(&mut self, ids: &[String]) {
        if let Some(dir) = &self.config_dir {
            crate::remembered::store(dir, ids);
        }
    }

    fn open_url(&mut self, url: &str) -> Result<(), String> {
        self.reveal.as_ref().ok_or_else(|| "no browser to open it in".to_string())?.open_url(url)
    }

    fn show(&mut self, page: crate::screens::panels::Page) {
        use crate::screens::panels::Page;
        match page {
            Page::Connections => {
                self.route = Route::Connections;
                connections::open(self);
            }
            Page::GenerateSettings => {
                self.route = Route::GenerateSettings;
                generate::open(self);
            }
            Page::Learning => {
                self.route = Route::Learning;
                learning::open(self);
            }
            Page::Discover => {
                self.route = Route::Discover;
                discover::open(self);
            }
        }
    }
}

impl State {
    /// The publish panel for one clip (the clips screen opens it).
    pub fn open_publish(&mut self, clip_id: &str, title: &str) {
        self.route = Route::Publish(clip_id.to_string());
        publish::open(self, clip_id, title);
    }
}

/// Scene functions are plain `fn`s; each folder under `desktop/scenes/` has one here, and a test
/// holds the list equal to the folders.
pub type Scene = (&'static str, fn(&mut State));

#[cfg(any(test, feature = "headless", debug_assertions))]
pub const SCENES: &[Scene] = &[
    ("home-empty", |s| *s = State::scene("home-empty")),
    ("readiness-missing", |s| *s = State::scene("readiness-missing")),
    ("engine-failed", |s| *s = State::scene("engine-failed")),
    ("first-run", |s| *s = State::scene("first-run")),
    ("job-running", |s| {
        *s = State::scene("job-running");
        s.open_job("j1");
    }),
    ("clips-ranked", |s| {
        *s = State::scene("clips-ranked");
        s.show_clips("vnew");
    }),
    ("clips-reranked", |s| {
        *s = State::scene("clips-reranked");
        s.show_clips("vnew");
        let mut clips = s.clips.clips.clone();
        (clips[0].rank_pos, clips[1].rank_pos) = (Some(2), Some(1));
        s.apply(Msg::Clips { video_id: "vnew".into(), clips });
    }),
    ("editor-hook", |s| {
        *s = State::scene("editor-hook");
        s.show_clips("vnew");
        s.open_editor("c1");
    }),
    ("connections", |s| {
        *s = State::scene("connections");
        s.show(Page::Connections);
    }),
    ("generate-settings", |s| {
        *s = State::scene("generate-settings");
        s.show(Page::GenerateSettings);
    }),
    ("learning", |s| {
        *s = State::scene("learning");
        s.show(Page::Learning);
    }),
    ("discover", |s| {
        *s = State::scene("discover");
        s.show(Page::Discover);
        s.panels.discover.run = s.engine.as_ref().and_then(|e| e.auto_status("run1").ok());
    }),
    ("publish", |s| {
        *s = State::scene("publish");
        s.open_publish("c1", "Kenapa orang menunda mulai");
        publish::select_account(s, "tt");
        publish::select_account(s, "yt");
        publish::write_copy(s);
    }),
];

/// A release build without `headless` has no scenes (they are played by `FakeEngine`).
#[cfg(not(any(test, feature = "headless", debug_assertions)))]
pub const SCENES: &[Scene] = &[];

pub fn spec() -> AppSpec<State> {
    AppSpec {
        scenes: SCENES,
        min_size: Some((720.0, 480.0)),
        fonts: &[include_bytes!("../assets/fonts/InstrumentSans.ttf")],
        families: ("Instrument Sans", "monospace"),
        on_key: Some(|s: &mut State, key: &KeyEvent, tx: &mut Tx| s.keys(key, tx)),
        poll: Some(|s: &mut State, t: f64, tx: &mut Tx| {
            let changed = s.tick(t);
            if s.idle_quit_due() {
                tx.quit();
            }
            changed
        }),
        ..AppSpec::new("Sorot", (1100.0, 720.0), State::default, view)
    }
}

/// Polls the engine again after `wait`, for as long as the app runs.
pub fn schedule(handle: rune::AppHandle<State>, sup: Arc<Mutex<Supervisor>>, wait: Duration) {
    let _ = rune::task::spawn_after("sorot-poll", wait, move || {
        let (msgs, next) = sup.lock().unwrap().tick_with(&mut |early| handle.update(apply_msgs(early)));
        handle.update(apply_msgs(msgs));
        if !rune::quitting() {
            schedule(handle, sup, next);
        }
    });
}

/// A state for a real engine: boots it on a task thread and keeps polling it.
/// Everything a real launch brings besides the engine: where older libraries are found, where
/// `workspace.json` lives (and what it said), and the tray.
pub struct Live {
    pub supervisor: Supervisor,
    pub library: Arc<dyn Library>,
    pub config_dir: PathBuf,
    pub saved: Option<Workspace>,
    pub data_dir: String,
    pub tray: Arc<dyn Tray>,
    pub reveal: Arc<dyn Reveal>,
    pub notifier: Arc<dyn Notifier>,
    pub preview: fn() -> Box<dyn Preview>,
    pub gpu: Arc<dyn GpuProbe>,
}

/// Puts the tray up. On macOS the Dock is the way back, so no tray is needed there.
pub fn install_tray(handle: &rune::AppHandle<State>, tray: &dyn Tray) -> bool {
    let h = handle.clone();
    cfg!(target_os = "macos") || tray.install(Arc::new(move |cmd| h.update(move |s: &mut State, _: &mut Tx| s.tray(cmd))))
}

/// A state for a real engine: boots it on a task thread and keeps polling it.
pub fn start_live(handle: rune::AppHandle<State>, live: Live) -> State {
    let Live { supervisor, library, config_dir, saved, data_dir, tray, reveal, notifier, preview, gpu } = live;
    let sup = Arc::new(Mutex::new(supervisor));
    let (boot, bus) = (handle.clone(), Arc::new(RuneBus(handle.clone())));
    let worker = sup.clone();
    let _ = rune::task::spawn("sorot-boot", move || {
        let msgs = worker.lock().unwrap().boot();
        boot.update(apply_msgs(msgs));
        schedule(boot, worker, Duration::from_secs(1));
    });
    let probed = handle.clone();
    let _ = rune::task::spawn("sorot-gpu", move || {
        let software = gpu.software();
        probed.update(apply_msgs(vec![Msg::Gpu { software }]));
    });
    let background_ok = install_tray(&handle, tray.as_ref());
    let opener = handle.clone();
    notifier.on_click(Arc::new(move |job| opener.update(move |s: &mut State, _: &mut Tx| s.apply(Msg::OpenJob(job)))));
    State::live(bus, sup).with_library(library, config_dir, data_dir, saved).with_platform(reveal, notifier, preview()).with_handle(handle, background_ok)
}

pub fn run(live: fn() -> Live) {
    // Closing the window hides it; `State::closing` decides whether the app goes with it.
    let app = rune::App::new(spec()).compositor(crate::platform::fx_compositor::FxCompositor::default()).keep_running().on_close(|s: &mut State, tx: &mut Tx| {
        if s.closing() {
            tx.quit();
        }
    }).on_quit(|s: &mut State, _| s.quit()).on_focus(|s: &mut State, focused, _| s.focused = focused);
    let handle = app.handle();
    // Rune knows it is headless only once `run` has started, so the choice is made in `init`.
    app.init(move || {
        #[cfg(any(test, feature = "headless", debug_assertions))]
        if rune::tooling::headless_run().is_some() {
            return State::scene("home-empty");
        }
        start_live(handle, live())
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
