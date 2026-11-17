//! L2 for User Story 1: readiness, welcome, shell and the close flow, in process against fakes.


use std::sync::{Arc, Mutex};
use std::time::Duration;

use rune::Runtime;
use sorot_desktop::app::*;
use sorot_desktop::engine::sidecar::{LaunchConfig, Out, Sidecar};
use sorot_desktop::engine::Engine;
use sorot_desktop::library::ProcLibrary;
use sorot_desktop::platform::tray::TrayCmd;
use sorot_desktop::screens::shell::CloseAnswer;
use sorot_desktop_core::model::Job;
use sorot_desktop_core::readiness::ItemState;
use sorot_desktop_core::toast::ToastKind;
use sorot_desktop_core::workspace::Source;
use crate::support::*;

fn has(rt: &Runtime<State>, key: &str) -> bool {
    rt.find(key).is_some()
}

/// Changes the state the way a message would, so the next frame rebuilds the view.
fn poke(rt: &mut Runtime<State>, f: impl FnOnce(&mut State) + Send + 'static) {
    rt.update(move |s, _| f(s));
    rt.frame(1.0 / 60.0);
}

fn cfg() -> LaunchConfig {
    LaunchConfig {
        program: "engine".into(), args: vec![], data_dir: "data".into(), pipeline_dir: ".".into(), generator_dir: ".".into(),
        python_path: "py".into(), ffmpeg_path: "ff".into(), gpu: false,
    }
}

fn job(id: &str, status: &str) -> Job {
    Job { id: id.into(), video_id: "v".into(), status: status.into(), current_stage: None, error_message: None, created_at: String::new(), updated_at: String::new() }
}

fn temp(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("sorot-us1-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

/// Readiness rows through the state machine: a failed fix says why and offers Retry; Fix all asks
/// only for what is fixable and idle.
#[test]
fn readiness_shows_each_state_and_asks_the_engine_for_the_fixes() {
    for (reason, fragment) in [("offline", "Needs internet once"), ("checksum mismatch", "damaged"), ("disk full", "disk full")] {
        let fake = Arc::new(FakeEngine::scene("readiness-missing"));
        let running = fake.readiness().unwrap();
        let mut failed = running.clone();
        failed.items[2].progress = None;
        failed.items[2].detail = reason.into();
        fake.readiness_steps(vec![running, failed]);
        let mut rt = runtime_of(State::with_engine(fake.clone()));
        assert!(has(&rt, "readiness/whisperModel/progress") && !has(&rt, "readiness/whisperModel/retry"), "{reason}");
        poke(&mut rt, |s| s.send(Cmd::Refresh));
        assert_eq!(rt.state.item_states.iter().find(|(id, _)| id == "whisperModel").unwrap().1.state, ItemState::FixFailed { reason: reason.into() });
        assert!(sorot_desktop::screens::readiness::failure(reason).contains(fragment));
        click(&mut rt, "readiness/whisperModel/retry");
        assert!(fake.calls().contains(&"fix_readiness(whisperModel)".to_string()), "{reason}");
    }
    let fake = Arc::new(FakeEngine::scene("readiness-missing"));
    let mut rt = runtime_of(State::with_engine(fake.clone()));
    click(&mut rt, "readiness/fix-all");
    let fixes: Vec<_> = fake.calls().into_iter().filter(|c| c.starts_with("fix_readiness")).collect();
    assert_eq!(fixes, ["fix_readiness(ffmpeg)"], "the model is already downloading");
    fake.fail_once("fix_readiness", sorot_desktop::engine::EngineError::Network("down".into()));
    rt.state.send(Cmd::FixAll(vec!["ffmpeg".into()]));
    assert_eq!(rt.state.toasts.last().unwrap().toast.kind, ToastKind::Failed);
}

const FOUND: &str = r#"{"status":"ok","data":{"candidates":[{"path":"/old","ok":true,"videos":2,"clips":9,"hasKeys":true},{"path":"/older","ok":true,"videos":1,"clips":2,"hasKeys":false},{"path":"/bad","ok":false,"videos":0,"clips":0,"hasKeys":false,"problem":"database is locked"}]}}"#;

/// A state on a `FakeSpawn`-backed library: the first process answers `--find-libraries`, the next
/// ones answer `script`.
fn welcome_state(name: &str, answers: Vec<Vec<(Duration, Out)>>, found: &str) -> (Runtime<State>, Arc<FakeSpawn>, std::path::PathBuf) {
    let (clock, spawn) = (Arc::new(FakeClock::default()), Arc::new(FakeSpawn::default()));
    let line = |s: &str| (Duration::from_secs(1), Out::Line(s.into()));
    let done = (Duration::from_secs(1), Out::Exited(0));
    spawn.queue(FakeProc::new(clock.clone(), vec![line(found), done.clone()], vec![]));
    for mut a in answers {
        a.push(done.clone());
        spawn.queue(FakeProc::new(clock.clone(), a, vec![]));
    }
    let lib = Arc::new(ProcLibrary { spawn: spawn.clone(), clock, cfg: cfg() });
    let dir = temp(name);
    let mut state = State::with_engine(Arc::new(FakeEngine::scene("readiness-missing"))).with_library(lib, dir.clone(), "data".into(), None);
    state.maybe_first_run();
    (runtime_of(state), spawn, dir)
}

/// The three choices: the workspace file and the engine commands each one runs.
#[test]
fn each_welcome_choice_saves_its_workspace_and_runs_only_its_commands() {
    let ok = |data: &str| (Duration::from_secs(1), Out::Line(format!(r#"{{"status":"ok","data":{data}}}"#)));
    let progress = (Duration::from_secs(1), Out::Line("PROGRESS 50".into()));
    type Row = (&'static str, bool, &'static str, Source, &'static str, Vec<Vec<(Duration, Out)>>, Vec<Vec<&'static str>>);
    let rows: Vec<Row> = vec![
        ("welcome/use-here", true, "/old", Source::Adopted, "/old", vec![vec![ok(r#"{"imported":[{"key":"LLM_API_KEY","masked":"sk-•••"}]}"#)]], vec![vec!["--import-keys", "/old"]]),
        ("welcome/use-here", false, "/old", Source::Adopted, "/old", vec![], vec![]),
        ("welcome/copy", false, "/old", Source::Copied, "data", vec![vec![progress, ok(r#"{"copied":3,"skipped":["a.mp4"]}"#)], vec![ok(r#"{"imported":[]}"#)]], vec![vec!["--copy-library", "/old", "data"], vec!["--import-keys", "/old"]]),
        ("welcome/fresh", false, "", Source::New, "data", vec![], vec![]),
    ];
    for (i, (key, keys_on, from, source, data_dir, answers, commands)) in rows.into_iter().enumerate() {
        let (mut rt, spawn, dir) = welcome_state(&format!("choice{i}"), answers, FOUND);
        assert_eq!(rt.state.screen(), Screen::Welcome);
        rt.frame(1.0 / 60.0);
        assert!(has(&rt, "welcome/2/copy") && !has(&rt, "welcome/2/use-here") && has(&rt, "welcome/1/use-here"), "a library with a problem can only be copied");
        if !keys_on && key == "welcome/use-here" {
            click(&mut rt, "welcome/keys");
        }
        click(&mut rt, key);
        let ws = sorot_desktop::workspace::load(&dir).unwrap();
        assert_eq!((ws.source, ws.data_dir.as_str(), ws.adopted_from.as_deref().unwrap_or("")), (source, data_dir, from), "{key}");
        let launches = spawn.launches.lock().unwrap();
        let args: Vec<Vec<String>> = launches[1..].iter().map(|l| l.args.clone()).collect();
        assert_eq!(args, commands.iter().map(|c| c.iter().map(|s| s.to_string()).collect::<Vec<_>>()).collect::<Vec<_>>(), "{key}");
        if keys_on && key == "welcome/use-here" {
            assert!(launches[1].env.contains(&("DATA_DIR".into(), "/old".into())), "keys go into the library being used");
        }
        drop(launches);
        if source == Source::Copied {
            assert!(has(&rt, "welcome/skipped"), "the skipped files are listed");
            click(&mut rt, "welcome/continue");
        }
        assert!(rt.state.welcome.is_none(), "{key}");
    }
}

/// Nothing found, a failed search and a failed copy: each says what happened and what to do next.
#[test]
fn welcome_handles_no_library_a_failed_search_and_a_failed_copy() {
    let (rt, _, dir) = welcome_state("empty", vec![], r#"{"status":"ok","data":{"candidates":[]}}"#);
    assert!(rt.state.welcome.is_none());
    assert_eq!(sorot_desktop::workspace::load(&dir).unwrap().source, Source::New, "nothing to choose, so a new library");

    let (rt, _, dir) = welcome_state("failed-find", vec![], r#"{"status":"error","error":"no engine"}"#);
    assert!(rt.state.welcome.is_none() && sorot_desktop::workspace::load(&dir).is_none());
    assert!(rt.state.toasts[0].toast.text.starts_with("Could not look for older libraries"));

    let failed = (Duration::from_secs(1), Out::Line(r#"{"status":"error","error":"disk full"}"#.into()));
    let (mut rt, _, dir) = welcome_state("failed-copy", vec![vec![failed]], FOUND);
    click(&mut rt, "welcome/copy");
    assert!(has(&rt, "welcome/error") && sorot_desktop::workspace::load(&dir).is_none());
    poke(&mut rt, |s| s.apply(Msg::Copying(40)));
    assert!(has(&rt, "welcome/copying") && !has(&rt, "welcome/copy"));
}

/// The banner shows for the two lost states with its two actions; the rail has Home.
#[test]
fn the_banner_follows_the_connection_and_its_buttons_work() {
    for (conn, banner) in [(Conn::Starting, false), (Conn::Ready, false), (Conn::Lost, true), (Conn::Failed("x".into()), true)] {
        let mut rt = runtime("home-empty");
        let c = conn.clone();
        poke(&mut rt, move |s| s.conn = c);
        assert_eq!(has(&rt, "shell/banner"), banner, "{conn:?}");
    }
    let mut rt = runtime("home-empty");
    assert!(has(&rt, "shell/rail/home"));
    poke(&mut rt, |s| s.conn = Conn::Lost);
    click(&mut rt, "shell/export-diagnostic");
    assert_eq!(rt.state.toasts[0].toast.kind, ToastKind::Failed, "no engine log without a supervisor");
    click(&mut rt, "engine/restart");
    assert_eq!(rt.state.screen(), Screen::Starting);
}

fn live_state(dir: std::path::PathBuf) -> (State, Arc<Mutex<Supervisor>>, Arc<FakeEngine>) {
    let (clock, spawn) = (Arc::new(FakeClock::default()), Arc::new(FakeSpawn::default()));
    let ready = r#"SOROT_READY {"port":9,"version":"1","api":1}"#;
    spawn.queue(FakeProc::new(clock.clone(), vec![(Duration::from_secs(1), Out::Line(ready.into()))], vec!["engine said hi"]));
    let mut sup = Supervisor::new(Sidecar::new(spawn, clock, cfg()).with_token_source(|| "t".into()).with_grace(Duration::from_secs(1)), |_, _| Arc::new(FakeEngine::scene("home-empty")));
    sup.boot();
    let sup = Arc::new(Mutex::new(sup));
    struct Inline;
    impl Bus for Inline {
        fn background(&self, work: Box<dyn FnOnce() -> Vec<Msg> + Send>) {
            work();
        }
    }
    let fake = Arc::new(FakeEngine::scene("home-empty"));
    let scene = sorot_desktop::engine::fake::scenes_dir().join("first-run");
    let mut s = State::live(Arc::new(Inline), sup.clone()).with_library(Arc::new(sorot_desktop::library::SceneLibrary::new(scene)), dir, "data".into(), None);
    s.apply(Msg::Engine(fake.clone()));
    (s, sup, fake)
}

#[test]
fn the_diagnostic_report_is_saved_beside_the_workspace_or_says_why_not() {
    let dir = temp("diag");
    let (mut s, _, _) = live_state(dir.clone());
    s.export_diagnostic();
    assert!(std::fs::read_to_string(dir.join("diagnostic-report.txt")).unwrap().contains("engine said hi"));
    assert_eq!(s.toasts[0].toast.kind, ToastKind::Done);
    std::fs::write(temp("diag-file"), "x").unwrap();
    let (mut s, _, _) = live_state(temp("diag-file"));
    s.export_diagnostic();
    assert_eq!(s.toasts[0].toast.kind, ToastKind::Failed);
}

/// The three answers of the close dialog: what is cancelled and whether the engine is shut down.
#[test]
fn the_close_dialog_answers_cancel_jobs_and_stop_the_engine_as_asked() {
    let rows = [
        (CloseAnswer::Background, vec![], false),
        (CloseAnswer::Wait, vec![], false),
        (CloseAnswer::CancelAndQuit, vec!["cancel_job(j1)".to_string(), "cancel_job(j2)".to_string()], true),
    ];
    for (answer, cancels, quits) in rows {
        let (mut s, sup, fake) = live_state(temp("close"));
        s.apply(Msg::Snapshot(Snapshot { jobs: vec![job("j1", "RUNNING"), job("j2", "QUEUED"), job("j3", "COMPLETED")], videos: vec![], readiness: vec![] }));
        assert!(!s.closing() && s.close_dialog, "jobs run and the preference is to ask");
        s.answer_close(answer);
        let calls: Vec<_> = fake.calls().into_iter().filter(|c| c.starts_with("cancel")).collect();
        assert_eq!((calls, s.quit_asked, s.close_dialog), (cancels, quits, false));
        if quits {
            s.quit();
            assert_eq!(sup.lock().unwrap().sidecar.conn.state, sorot_desktop_core::engine_conn::State::Stopped);
        }
        if answer == CloseAnswer::Wait {
            assert!(!s.idle_quit_due());
            s.apply(Msg::Snapshot(Snapshot { jobs: vec![], videos: vec![], readiness: vec![] }));
            assert!(s.idle_quit_due());
        }
    }
}

/// How the window's close button is routed: the dialog's choices follow what the machine can do.
#[test]
fn closing_follows_the_preference_and_whether_a_tray_exists() {
    use sorot_desktop_core::close::ClosePref;
    let running = Snapshot { jobs: vec![job("j1", "RUNNING")], videos: vec![], readiness: vec![] };
    let mut s = State::with_engine(Arc::new(FakeEngine::scene("home-empty")));
    assert!(s.closing(), "no jobs: quit");
    s.apply(Msg::Snapshot(running));
    s.close_pref = ClosePref::Background;
    assert!(!s.closing() && s.close_dialog, "no tray: a background preference cannot hide the app");
    let mut rt = runtime_of(s);
    assert!(has(&rt, "close/dialog") && !has(&rt, "close/background") && has(&rt, "close/wait") && has(&rt, "close/cancel-quit"));
    rt.state.background_ok = true;
    rt.state.close_dialog = false;
    assert!(!rt.state.closing() && !rt.state.close_dialog, "tray present: hide and keep running");
    poke(&mut rt, |s| s.close_dialog = true);
    assert!(has(&rt, "close/background"));
    click(&mut rt, "close/wait");
    assert!(rt.state.idle_quit);
    poke(&mut rt, |s| s.close_dialog = true);
    click(&mut rt, "close/background");
    poke(&mut rt, |s| s.close_dialog = true);
    click(&mut rt, "close/cancel-quit");
    assert!(rt.state.quit_asked);
    rt.state.close_pref = ClosePref::Quit;
    assert!(rt.state.closing(), "quit preference cancels the jobs and goes");
    rt.update(|s, tx| {
        s.idle_quit = true;
        s.jobs.clear();
        let poll = spec().poll.unwrap();
        poll(s, 1.0, tx);
    });
}

#[test]
fn the_tray_opens_and_quits_and_installs_once() {
    let fake = Arc::new(FakeTray { works: true, ..Default::default() });
    let handle = rune::App::new(spec()).handle();
    assert!(install_tray(&handle, fake.as_ref()));
    // macOS has no tray: the Dock is the way back, so nothing is installed and the tray is never asked.
    let installed = fake.installed.lock().unwrap().clone();
    assert_eq!(installed.is_some(), !cfg!(target_os = "macos"));
    if let Some(on) = installed {
        on(TrayCmd::Open);
    }
    let mut s = State::with_engine(Arc::new(FakeEngine::scene("home-empty")));
    s.tray(TrayCmd::Open);
    s.tray(TrayCmd::Quit);
    assert!(s.quit_asked);
    assert_eq!(install_tray(&handle, &FakeTray::default()), cfg!(target_os = "macos"));
}

#[test]
fn losing_the_engine_is_reported_before_the_restart_finishes() {
    let (_, sup, fake) = live_state(temp("lost"));
    let mut sup = sup.lock().unwrap();
    sup.engine = Some(fake.clone());
    let mut early = vec![];
    for _ in 0..3 {
        fake.fail_once("jobs", sorot_desktop::engine::EngineError::Network("gone".into()));
        sup.tick_with(&mut |m| early.extend(m));
    }
    assert!(matches!(&early[..], [Msg::Conn(Conn::Lost)]));
    assert!(sup.relaunch_in("elsewhere".into()).iter().any(|m| matches!(m, Msg::Conn(Conn::Failed(_)))), "no engine to start in this fake");
}

#[test]
fn an_item_that_cannot_be_fixed_says_so_and_offers_no_fix() {
    let fake = Arc::new(FakeEngine::scene("readiness-missing"));
    let mut r = fake.readiness().unwrap();
    r.items[3].ok = false;
    fake.readiness_steps(vec![r]);
    let rt = runtime_of(State::with_engine(fake));
    assert!(has(&rt, "readiness/gpu/status") && !has(&rt, "readiness/gpu/fix"));
    assert_eq!(rt.state.screen(), Screen::Readiness, "ffmpeg and the model are still missing");

    // The GPU only picks speed: with everything else ready, it not being ok still leads to Home.
    let fake = Arc::new(FakeEngine::scene("readiness-missing"));
    let mut r = fake.readiness().unwrap();
    for (i, item) in r.items.iter_mut().enumerate() {
        (item.ok, item.progress) = (i != 3, None);
    }
    fake.readiness_steps(vec![r]);
    assert_eq!(runtime_of(State::with_engine(fake)).state.screen(), Screen::Home);
}

struct Broken;
impl sorot_desktop::library::Library for Broken {
    fn find(&self) -> Result<Vec<sorot_desktop_core::workspace::Candidate>, String> {
        Err("no".into())
    }
    fn copy(&self, _: &str, _: &str, _: &mut dyn FnMut(u8)) -> Result<Vec<String>, String> {
        Ok(vec![])
    }
    fn import_keys(&self, _: &str, _: &str) -> Result<usize, String> {
        Err("locked".into())
    }
}

/// Keys that cannot be imported are reported but do not stop the choice; an unwritable
/// `workspace.json` does stop it.
#[test]
fn library_work_reports_failed_keys_and_a_failed_save() {
    let choose = Cmd::Choose { how: sorot_desktop::screens::welcome::How::Use, from: "/old".into(), keys: true };
    let dir = temp("work");
    let msgs = library_work(&Broken, &dir, "data", choose.clone(), &mut |_| {});
    assert!(matches!(&msgs[..], [Msg::Toast(ToastKind::Failed, t), Msg::Workspace { .. }] if t.contains("locked")));
    std::fs::write(temp("work-file"), "x").unwrap();
    let msgs = library_work(&Broken, &temp("work-file"), "data", choose, &mut |_| {});
    assert!(matches!(&msgs[..], [Msg::WelcomeFailed(t)] if t.contains("Could not save")));
    assert!(library_work(&Broken, &dir, "data", Cmd::Refresh, &mut |_| {}).is_empty());
}

/// The scene library plays `libraries.json` back and says what it was asked.
#[test]
fn the_scene_library_replays_its_file_and_a_proc_library_rejects_odd_answers() {
    use sorot_desktop::library::{Library, SceneLibrary};
    let lib = SceneLibrary::new(sorot_desktop::engine::fake::scenes_dir().join("first-run"));
    let mut seen = vec![];
    assert_eq!(lib.find().unwrap().len(), 1);
    assert_eq!(lib.copy("/a", "/b", &mut |n| seen.push(n)).unwrap(), ["exports/old-clip.mp4"]);
    assert_eq!(lib.import_keys("/a", "/b").unwrap(), 0);
    assert_eq!((seen, lib.calls()), (vec![100], vec!["find".to_string(), "copy(/a,/b)".into(), "import_keys(/a,/b)".into()]));
    let missing = SceneLibrary::new(temp("none"));
    assert!(missing.find().is_err());
    let odd_dir = temp("odd");
    std::fs::create_dir_all(&odd_dir).unwrap();
    std::fs::write(odd_dir.join("libraries.json"), "{").unwrap();
    assert!(SceneLibrary::new(odd_dir).find().is_err());

    let odd = |answer: &str| welcome_state("odd-answer", vec![], answer).0.state.toasts.len();
    assert_eq!(odd(r#"{"status":"ok","data":{"nothing":1}}"#), 1, "an answer without candidates is an error");
}
