//! L2: the app's screens on Rune's headless `Runtime`, against `FakeEngine`.

mod support;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use rune::Runtime;
use sorot_desktop::app::*;
use sorot_desktop::engine::sidecar::{LaunchConfig, Out, Sidecar};
use sorot_desktop::engine::{Engine, EngineError};
use sorot_desktop_core::handshake::Ready;
use sorot_desktop_core::model::Job;
use sorot_desktop_core::toast::ToastKind;
use support::*;

fn has(rt: &Runtime<State>, key: &str) -> bool {
    rt.find(key).is_some()
}

#[test]
fn each_scene_lands_on_its_screen() {
    let cases = [
        ("home-empty", Screen::Home, "home/empty"),
        ("readiness-missing", Screen::Readiness, "readiness/items"),
        ("engine-failed", Screen::EngineFailed, "engine/failed"),
    ];
    for (scene, screen, key) in cases {
        let rt = runtime(scene);
        assert_eq!((rt.state.screen(), has(&rt, key)), (screen, true), "{scene}");
    }
    assert_eq!(State::default().screen(), Screen::Starting);
    let mut listed: Vec<&str> = SCENES.iter().map(|(n, _)| *n).collect();
    listed.sort();
    assert_eq!(sorot_desktop::engine::fake::scene_names(), listed, "SCENES lists every scenes/ folder");
}

#[test]
fn a_job_shows_on_home_and_a_fix_asks_the_engine_then_refreshes() {
    let job = Job { id: "j1".into(), video_id: "v".into(), status: "RUNNING".into(), current_stage: None, error_message: None, created_at: String::new(), updated_at: String::new() };
    let mut rt = runtime("home-empty");
    rt.update(|s, _| s.apply(Msg::Snapshot(Snapshot { jobs: vec![job], videos: vec![], readiness: vec![] })));
    rt.frame(0.0);
    assert!(has(&rt, "home/job/j1") && !has(&rt, "home/empty"));

    let fake = Arc::new(FakeEngine::scene("readiness-missing"));
    let mut rt = runtime_of(State::with_engine(fake.clone()));
    click(&mut rt, "readiness/ffmpeg/fix");
    assert_eq!(fake.calls(), ["jobs", "videos", "readiness", "fix_readiness(ffmpeg)", "jobs", "videos", "readiness"]);
    assert_eq!(rt.state.toasts[0].toast.text, "Started: ffmpeg");

    fake.fail_once("fix_readiness", EngineError::Network("down".into()));
    rt.state.send(Cmd::FixReadiness("ffmpeg".into()));
    assert_eq!(rt.state.toasts[1].toast.kind, ToastKind::Failed);
    assert!(rt.state.toasts[1].toast.text.starts_with("Could not fix ffmpeg"));

    fake.fail_once("jobs", EngineError::Network("down".into()));
    rt.state.send(Cmd::Refresh);
    assert_eq!(rt.state.toasts[2].toast.kind, ToastKind::Failed);
}

#[test]
fn a_toast_lasts_six_seconds_and_waits_while_the_pointer_is_on_it() {
    let mut rt = runtime("home-empty");
    rt.update(|s, _| s.apply(Msg::Toast(ToastKind::Done, "Exported".into())));
    rt.frame(0.0);
    hover(&mut rt, Some("toast/0"));
    assert!(rt.state.toasts[0].hovered);
    for t in 1..=10 {
        rt.update(|s, _| {
            s.tick(t as f64);
        });
    }
    assert_eq!(rt.state.toasts.len(), 1, "ten seconds hovered, still there");
    hover(&mut rt, None);
    rt.update(|s, _| assert!(!s.tick(14.0)));
    rt.update(|s, _| assert!(s.tick(17.0), "six seconds after the pointer left, gone"));
    assert!(rt.state.toasts.is_empty());
    rt.frame(0.0);
    assert!(!has(&rt, "toast/0"));
}

#[test]
fn restart_engine_shows_the_loading_state() {
    let mut rt = runtime("engine-failed");
    click(&mut rt, "engine/restart");
    assert_eq!((rt.state.screen(), has(&rt, "engine/starting")), (Screen::Starting, true));
}

thread_local! {
    /// The engine every restart "connects" to, so a test can script it.
    static ENGINE: Arc<FakeEngine> = Arc::new(FakeEngine::scene("home-empty"));
}

fn make_engine(_: &Ready, _: &str) -> Arc<dyn Engine> {
    ENGINE.with(Clone::clone)
}

fn supervisor(spawn: Arc<FakeSpawn>, clock: Arc<FakeClock>) -> Supervisor {
    let cfg = LaunchConfig {
        program: "engine".into(),
        args: vec![],
        data_dir: ".".into(),
        pipeline_dir: ".".into(),
        generator_dir: ".".into(),
        python_path: "py".into(),
        ffmpeg_path: "ff".into(),
        gpu: false,
    };
    Supervisor::new(Sidecar::new(spawn, clock, cfg).with_token_source(|| "t".into()).with_grace(Duration::from_secs(1)), make_engine)
}

const READY: &str = r#"SOROT_READY {"port":9,"version":"1","api":1}"#;

fn engine_script(clock: &Arc<FakeClock>) -> FakeProc {
    FakeProc::new(clock.clone(), vec![(Duration::from_secs(1), Out::Line(READY.into()))], vec![])
}

fn summary(msgs: &[Msg]) -> Vec<String> {
    msgs.iter()
        .map(|m| match m {
            Msg::Engine(_) => "engine".to_string(),
            Msg::Conn(c) => format!("{c:?}"),
            Msg::Snapshot(_) => "snapshot".into(),
            Msg::Toast(..) => "toast".into(),
            _ => "first-run".into(),
        })
        .collect()
}

#[test]
fn the_supervisor_boots_polls_and_recovers_the_engine() {
    let (clock, spawn) = (Arc::new(FakeClock::default()), Arc::new(FakeSpawn::default()));
    let mut sup = supervisor(spawn.clone(), clock.clone());
    assert_eq!(sup.tick().1, Duration::from_secs(1), "nothing to poll before the engine is up");

    spawn.queue(engine_script(&clock));
    assert_eq!(summary(&sup.boot()), ["engine", "Ready"]);
    let (msgs, wait) = sup.tick();
    assert_eq!((summary(&msgs), wait), (vec!["snapshot".to_string()], Duration::from_secs(5)));

    // Three failed health checks lose the engine; the supervisor restarts it.
    let fake = ENGINE.with(Clone::clone);
    sup.engine = Some(fake.clone());
    spawn.queue(engine_script(&clock));
    for _ in 0..3 {
        fake.fail_once("jobs", EngineError::Network("gone".into()));
        sup.tick();
    }
    assert_eq!(sup.sidecar.conn.restarts, 1);

    // A 401 restarts once and the second fails with words a person can read.
    spawn.queue(engine_script(&clock));
    fake.fail_once("jobs", EngineError::Unauthorized);
    let (msgs, _) = sup.tick();
    assert_eq!(summary(&msgs), ["engine", "Ready"]);
    fake.fail_once("jobs", EngineError::Unauthorized);
    let (msgs, _) = sup.tick();
    assert!(matches!(&msgs[..], [Msg::Conn(Conn::Failed(t))] if t.contains("refused")));

    spawn.queue(engine_script(&clock));
    assert_eq!(summary(&sup.user_restart()), ["engine", "Ready"]);
    sup.quit();
}

#[test]
fn a_boot_that_fails_says_why() {
    let (clock, spawn) = (Arc::new(FakeClock::default()), Arc::new(FakeSpawn::default()));
    let mut sup = supervisor(spawn.clone(), clock.clone());
    spawn.queue(FakeProc::new(clock.clone(), vec![(Duration::from_secs(1), Out::Exited(1))], vec![]));
    let msgs = sup.boot();
    let [Msg::Conn(Conn::Failed(text))] = &msgs[..] else { panic!("{:?}", summary(&msgs)) };
    assert!(text.starts_with("The engine stopped before it was ready."));
    let reasons = [
        (sorot_desktop_core::engine_conn::FailReason::ExitedEarly, "right after"),
        (sorot_desktop_core::engine_conn::FailReason::StartTimeout, "30 seconds"),
        (sorot_desktop_core::engine_conn::FailReason::EngineTooNew, "Update Sorot"),
        (sorot_desktop_core::engine_conn::FailReason::TooManyRestarts, "keeps stopping"),
    ];
    for (reason, part) in reasons {
        assert!(failure_text(&reason, "stderr line").contains(part) && failure_text(&reason, "stderr line").ends_with("\nstderr line"));
    }
}

#[test]
fn work_goes_through_the_bus_and_back_into_state() {
    struct Collect(Mutex<Vec<Msg>>);
    impl Bus for Collect {
        fn background(&self, work: Box<dyn FnOnce() -> Vec<Msg> + Send>) {
            self.0.lock().unwrap().extend(work());
        }
    }
    let (clock, spawn) = (Arc::new(FakeClock::default()), Arc::new(FakeSpawn::default()));
    let sup = Arc::new(Mutex::new(supervisor(spawn.clone(), clock.clone())));
    let bus = Arc::new(Collect(Mutex::new(vec![])));
    spawn.queue(FakeProc::new(clock.clone(), vec![(Duration::from_secs(1), Out::Exited(1))], vec![]));
    sup.lock().unwrap().boot();
    let mut state = State::live(bus.clone(), sup);
    state.send(Cmd::Refresh);
    assert!(bus.0.lock().unwrap().is_empty(), "no engine yet, nothing to ask");
    state.apply(Msg::Engine(Arc::new(FakeEngine::scene("home-empty"))));
    state.send(Cmd::Refresh);
    assert_eq!(summary(&bus.0.lock().unwrap()), ["snapshot"]);

    spawn.queue(engine_script(&clock));
    state.conn = Conn::Failed("x".into());
    state.restart_engine();
    assert_eq!(state.conn, Conn::Starting);
    assert_eq!(summary(&bus.0.lock().unwrap()), ["snapshot", "engine", "Ready"]);
}

#[test]
fn rune_runs_background_work_and_polling_on_task_threads() {
    let app = rune::App::new(spec());
    let bus = RuneBus(app.handle());
    let (tx, rx) = std::sync::mpsc::channel();
    bus.background(Box::new(move || {
        tx.send(()).unwrap();
        vec![]
    }));
    rx.recv_timeout(Duration::from_secs(5)).expect("the work ran");
    bus.post(vec![]);

    let (clock, spawn) = (Arc::new(FakeClock::default()), Arc::new(FakeSpawn::default()));
    let mut sup = supervisor(spawn, clock);
    let fake = Arc::new(FakeEngine::scene("home-empty"));
    sup.engine = Some(fake.clone());
    schedule(app.handle(), Arc::new(Mutex::new(sup)), Duration::ZERO);
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while fake.calls().is_empty() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(fake.calls().contains(&"jobs".to_string()));
}

#[test]
fn the_fake_engine_answers_every_route_from_its_scene() {
    let fake = FakeEngine::scene("readiness-missing");
    assert!(fake.health().unwrap().healthy);
    assert_eq!(fake.readiness().unwrap().items.len(), 4);
    assert_eq!(fake.fix_readiness("gpu").unwrap().task_id, "task-gpu");
    assert!(fake.settings().is_err() && fake.job("j").is_err(), "this scene has no settings or job");
    assert!(fake.videos().unwrap().is_empty() && fake.jobs().unwrap().is_empty() && fake.clips("v").unwrap().is_empty());
    assert_eq!(fake.import_url("u").unwrap().video_id, "vnew");
    assert_eq!(fake.process("v").unwrap().status, "QUEUED");
    assert_eq!(fake.cancel_job("j").unwrap().status, "CANCELLED");
    assert_eq!(fake.retry_job("j").unwrap().status, "QUEUED");
    assert_eq!(fake.calls().len(), 12);

    // Scripted progress: each readiness call answers the next step.
    let step = |pct: u8| {
        let mut r = fake.readiness().unwrap();
        r.items[0].progress = Some(sorot_desktop_core::model::Progress { percent: pct, label: "x".into() });
        r
    };
    fake.readiness_steps(vec![step(10), step(90)]);
    let seen: Vec<u8> = (0..3).map(|_| fake.readiness().unwrap().items[0].progress.as_ref().unwrap().percent).collect();
    assert_eq!(seen, [10, 90, 90]);
    let proc = FakeProc::new(Arc::new(FakeClock::default()), vec![], vec!["a", "b", "c"]);
    assert_eq!(sorot_desktop::engine::sidecar::Proc::stderr_tail(&proc, 2), ["b", "c"]);
}

#[test]
fn snapshots_report_running_work_and_quit_stops_the_engine() {
    let snap = |readiness| Snapshot { jobs: vec![], videos: vec![], readiness };
    let fixing = FakeEngine::scene("readiness-missing").readiness().unwrap().items;
    assert!(snap(fixing).any_running() && !snap(vec![]).any_running());

    let (clock, spawn) = (Arc::new(FakeClock::default()), Arc::new(FakeSpawn::default()));
    spawn.queue(engine_script(&clock));
    let mut sup = supervisor(spawn, clock);
    sup.boot();
    let sup = Arc::new(Mutex::new(sup));
    let mut state = State::live(Arc::new(NoBus), sup.clone());
    state.quit();
    assert_eq!(sup.lock().unwrap().sidecar.conn.state, sorot_desktop_core::engine_conn::State::Stopped);
    let http = http_engine(&Ready { port: 1, version: "v".into() }, "t");
    assert!(matches!(http.health(), Err(EngineError::Network(_))));
}

struct NoBus;
impl Bus for NoBus {
    fn background(&self, _: Box<dyn FnOnce() -> Vec<Msg> + Send>) {}
}

#[test]
fn the_real_supervisor_is_built_from_the_environment() {
    assert_eq!(sorot_desktop::live().supervisor.sidecar.conn.restarts, 0);
}

#[test]
fn a_live_state_boots_the_engine_on_a_task_thread() {
    let (clock, spawn) = (Arc::new(FakeClock::default()), Arc::new(FakeSpawn::default()));
    spawn.queue(engine_script(&clock));
    let sup = supervisor(spawn.clone(), clock);
    let state = start_live(rune::App::new(spec()).handle(), live_of(sup));
    assert_eq!(state.screen(), Screen::Starting);
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while spawn.launches.lock().unwrap().is_empty() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(spawn.launches.lock().unwrap().len(), 1);
}

#[test]
fn the_sidecar_notices_its_own_exit_and_library_commands_report_failures() {
    let (clock, spawn) = (Arc::new(FakeClock::default()), Arc::new(FakeSpawn::default()));
    let mut sup = supervisor(spawn.clone(), clock.clone());
    let proc = engine_script(&clock);
    let log = proc.log();
    spawn.queue(proc);
    sup.boot();
    assert_eq!(sup.sidecar.token(), "t");
    sup.sidecar.exited();
    assert_eq!(sup.sidecar.conn.state, sorot_desktop_core::engine_conn::State::Failed(sorot_desktop_core::engine_conn::FailReason::ExitedEarly));
    assert!(log.lock().unwrap().is_empty());

    spawn.queue(FakeProc::new(clock.clone(), vec![(Duration::from_secs(1), Out::Exited(9))], vec!["boom"]));
    let cfg = sorot_desktop::launch_config(|_| None);
    let got = sorot_desktop::engine::sidecar::run_library_command(spawn.as_ref(), clock.as_ref(), &cfg, &["--copy-library"], vec![]);
    assert!(got.error.unwrap().contains("boom"));
}

#[test]
fn worker_messages_land_in_state_on_the_ui_thread() {
    let mut rt = runtime("home-empty");
    rt.update(apply_msgs(vec![Msg::Toast(ToastKind::Info, "hi".into()), Msg::Conn(Conn::Ready)]));
    assert_eq!(rt.state.toasts.len(), 1);
}
