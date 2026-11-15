//! `Sidecar` against `FakeProc` / `FakeClock`: no process, no sleeping.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use sorot_desktop_core::engine_conn::{FailReason, State};
use sorot_desktop_core::handshake::HandshakeError;
use sorot_desktop_core::model::Status;

use super::fake::{FakeClock, FakeProc, FakeSpawn, Step};
use super::sidecar::*;

const READY: &str = r#"SOROT_READY {"port":54321,"version":"1.9.0","api":1}"#;

fn secs(n: u64) -> Duration {
    Duration::from_secs(n)
}

fn line(after: u64, l: &str) -> Step {
    (secs(after), Out::Line(l.into()))
}

fn cfg() -> LaunchConfig {
    LaunchConfig {
        program: "engine".into(),
        args: vec![],
        data_dir: "D".into(),
        pipeline_dir: "P".into(),
        generator_dir: "G".into(),
        python_path: "py".into(),
        ffmpeg_path: "ff".into(),
        gpu: true,
    }
}

struct Rig {
    clock: Arc<FakeClock>,
    spawn: Arc<FakeSpawn>,
    sidecar: Sidecar,
}

fn rig() -> Rig {
    let (clock, spawn) = (Arc::new(FakeClock::default()), Arc::new(FakeSpawn::default()));
    let sidecar = Sidecar::new(spawn.clone(), clock.clone(), cfg()).with_token_source(|| "tok-1".into()).with_grace(secs(5));
    Rig { clock, spawn, sidecar }
}

impl Rig {
    fn queue(&self, script: Vec<Step>, stderr: Vec<&str>) -> Arc<Mutex<Vec<String>>> {
        let p = FakeProc::new(self.clock.clone(), script, stderr);
        let log = p.log();
        self.spawn.queue(p);
        log
    }
}

type Case = (&'static str, Vec<Step>, Result<u16, StartError>, State);

fn ready_state() -> State {
    State::Ready { port: 54321, version: "1.9.0".into() }
}

#[test]
fn starting_the_engine_ends_ready_or_failed_by_cause() {
    let too_new = r#"SOROT_READY {"port":5,"version":"9","api":2}"#;
    let cases: Vec<Case> = vec![
        ("ready after noise", vec![line(1, "booting"), line(2, READY)], Ok(54321), ready_state()),
        ("exit before ready", vec![line(1, "booting"), (secs(1), Out::Exited(3))], Err(StartError::Exited(3)), State::Failed(FailReason::ExitedBeforeReady)),
        ("silence for 30 s", vec![], Err(StartError::Timeout), State::Failed(FailReason::StartTimeout)),
        ("ready line too late", vec![line(31, READY)], Err(StartError::Timeout), State::Failed(FailReason::StartTimeout)),
        ("garbled ready line", vec![line(1, r#"SOROT_READY {"port":0,"version":"1","api":1}"#)], Err(StartError::Handshake(HandshakeError::Malformed)), State::Failed(FailReason::ExitedBeforeReady)),
        ("newer engine", vec![line(1, too_new)], Err(StartError::Handshake(HandshakeError::TooNew)), State::Failed(FailReason::EngineTooNew)),
    ];
    for (name, script, want, state) in cases {
        let mut r = rig();
        r.queue(script, vec![]);
        assert_eq!(r.sidecar.start().map(|x| x.port), want, "{name}");
        assert_eq!(r.sidecar.conn.state, state, "{name}");
    }
    let mut r = rig();
    assert!(matches!(r.sidecar.start(), Err(StartError::Spawn(_))), "no binary");
    assert_eq!(r.sidecar.conn.state, State::Failed(FailReason::ExitedBeforeReady));
}

#[test]
fn the_launch_env_is_the_contract_table_and_the_token_is_new_each_time() {
    let mut r = rig();
    r.queue(vec![line(1, READY)], vec![]);
    r.sidecar.start().unwrap();
    let env: std::collections::HashMap<_, _> = r.spawn.launches.lock().unwrap()[0].env.iter().cloned().collect();
    let want = [
        ("SERVER_HOST", "127.0.0.1"), ("SERVER_PORT", "0"), ("SOROT_TOKEN", "tok-1"), ("STATIC_DIR", ""), ("SOROT_PARENT_PIPE", "1"),
        ("SOROT_SOLE_OWNER", "1"), ("DATA_DIR", "D"), ("PIPELINE_DIR", "P"), ("GENERATOR_DIR", "G"), ("PYTHON_PATH", "py"),
        ("FFMPEG_PATH", "ff"), ("WHISPER_DEVICE", "cuda"),
    ];
    assert_eq!(env.len(), want.len());
    for (k, v) in want {
        assert_eq!(env.get(k).map(String::as_str), Some(v), "{k}");
    }
    let (a, b) = (new_token(), new_token());
    assert!(a.len() == 43 && a != b && a.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'), "{a}");
}

#[test]
fn a_401_restarts_once_then_fails_and_the_diagnostic_hides_the_token() {
    let stderr = vec!["listening", "bad header Bearer tok-1", "token tok-1 seen"];
    let mut r = rig();
    r.queue(vec![line(1, READY)], stderr.clone());
    r.sidecar.start().unwrap();
    assert_eq!(r.sidecar.diagnostic(), "listening\nbad header Bearer •••\ntoken ••• seen");
    r.queue(vec![line(1, READY)], vec![]);
    let again = r.sidecar.unauthorized();
    assert_eq!(again.map(|x| x.unwrap().port), Some(54321));
    assert_eq!((r.sidecar.conn.state.clone(), r.sidecar.conn.restarts), (ready_state(), 1));
    assert!(r.sidecar.unauthorized().is_none(), "the second 401 does not restart");
    assert_eq!(r.sidecar.conn.state, State::Failed(FailReason::Unauthorized));
}

#[test]
fn losing_the_engine_restarts_it_twice_and_the_user_can_restart_after() {
    let mut r = rig();
    r.queue(vec![line(1, READY)], vec![]);
    r.sidecar.start().unwrap();
    for round in 1..=2 {
        r.queue(vec![line(1, READY)], vec![]);
        (0..3).for_each(|_| r.sidecar.health(false));
        assert_eq!(r.sidecar.conn.state, State::Lost, "round {round}");
        assert!(r.sidecar.recover().unwrap().is_ok());
    }
    (0..3).for_each(|_| r.sidecar.health(false));
    assert!(r.sidecar.recover().is_none());
    assert_eq!(r.sidecar.conn.state, State::Failed(FailReason::TooManyRestarts));
    r.queue(vec![line(1, READY)], vec![]);
    assert!(r.sidecar.user_restart().unwrap().is_ok());
    r.sidecar.health(true);
    r.clock.advance(secs(60));
    r.sidecar.exited();
    assert_eq!(r.sidecar.conn.state, State::Lost, "a late exit is a loss, not a crash");
}

#[test]
fn quit_closes_stdin_and_terminates_only_after_the_grace() {
    let mut r = rig();
    let polite = r.queue(vec![line(1, READY), (secs(2), Out::Exited(0))], vec![]);
    r.sidecar.start().unwrap();
    r.sidecar.quit();
    assert_eq!((polite.lock().unwrap().clone(), r.sidecar.conn.state.clone()), (vec!["close_stdin".to_string()], State::Stopped));

    let mut r = rig();
    let stubborn = r.queue(vec![line(1, READY)], vec![]);
    r.sidecar.start().unwrap();
    let before = r.clock.now();
    r.sidecar.quit();
    assert_eq!(stubborn.lock().unwrap().clone(), ["close_stdin", "terminate"]);
    assert_eq!(r.clock.now() - before, secs(5));
}

#[test]
fn library_commands_return_the_one_envelope_the_engine_printed() {
    let envelope = r#"{"status":"ok","data":{"candidates":[]}}"#;
    type Lib = (&'static str, Option<Vec<Step>>, Status, &'static str);
    let cases: Vec<Lib> = vec![
        ("answer", Some(vec![line(1, "PROGRESS 5"), line(1, envelope), (secs(1), Out::Exited(0))]), Status::Ok, ""),
        ("engine error", Some(vec![line(1, r#"{"status":"error","error":"no library"}"#), (secs(1), Out::Exited(2))]), Status::Error, "no library"),
        ("no answer", Some(vec![(secs(1), Out::Exited(4))]), Status::Error, "code 4"),
        ("never ends", Some(vec![]), Status::Error, "did not answer"),
        ("cannot start", None, Status::Error, "no engine binary"),
    ];
    for (name, script, status, contains) in cases {
        let (clock, spawn) = (Arc::new(FakeClock::default()), FakeSpawn::default());
        if let Some(s) = script {
            spawn.queue(FakeProc::new(clock.clone(), s, vec![]));
        }
        let got = run_library_command(&spawn, clock.as_ref(), &cfg(), &["--find-libraries"], vec![]);
        assert_eq!(got.status, status, "{name}");
        assert!(got.error.unwrap_or_default().contains(contains), "{name}");
    }
}

#[test]
fn the_system_clock_moves_forward() {
    let c = SystemClock::default();
    let a = c.now();
    std::thread::sleep(Duration::from_millis(2));
    assert!(c.now() > a);
}
