//! `OsSpawn` against a real child process: this test binary run again in a helper mode.

use std::io::{Read, Write};
use std::time::Duration;

use sorot_desktop::engine::sidecar::*;
use sorot_desktop_core::model::Status;

const READY: &str = r#"SOROT_READY {"port":4242,"version":"t","api":1}"#;

/// Not a test when run normally. With `SOROT_HELPER` set it is the stand-in engine.
#[test]
fn helper() {
    let mode = std::env::var("SOROT_HELPER").unwrap_or_default();
    if mode.is_empty() {
        return;
    }
    println!();
    if mode == "library" {
        println!(r#"{{"status":"ok","data":{{"copied":3}}}}"#);
        return;
    }
    println!("{READY}");
    eprintln!("helper stderr line");
    std::io::stdout().flush().unwrap();
    if mode == "hang" {
        std::thread::sleep(Duration::from_secs(120));
    }
    let mut sink = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut sink);
}

fn launch(mode: &str) -> Launch {
    Launch {
        program: std::env::current_exe().unwrap(),
        args: ["--exact", "helper", "--nocapture", "--test-threads=1"].map(String::from).to_vec(),
        env: vec![("SOROT_HELPER".into(), mode.into())],
    }
}

fn until_exit(p: &mut dyn Proc) -> Out {
    loop {
        match p.next(Duration::from_secs(20)) {
            Out::Line(_) => {}
            Out::Idle => panic!("the process never exited"),
            exited => return exited,
        }
    }
}

fn until_ready(p: &mut dyn Proc) {
    loop {
        match p.next(Duration::from_secs(20)) {
            Out::Line(l) if l == READY => return,
            Out::Line(_) => {}
            other => panic!("no ready line: {other:?}"),
        }
    }
}

#[test]
fn an_engine_stays_up_while_stdin_is_open_and_stops_when_it_closes() {
    let mut p = OsSpawn.spawn(&launch("engine")).unwrap();
    until_ready(p.as_mut());
    assert_eq!(p.next(Duration::from_millis(300)), Out::Idle, "stdin held open keeps it running");
    p.close_stdin();
    assert_eq!(until_exit(p.as_mut()), Out::Exited(0));
    assert!(p.stderr_tail(5).iter().any(|l| l == "helper stderr line"));
}

#[test]
fn terminate_ends_a_process_that_ignores_stdin() {
    let mut p = OsSpawn.spawn(&launch("hang")).unwrap();
    until_ready(p.as_mut());
    p.close_stdin();
    assert_eq!(p.next(Duration::from_millis(300)), Out::Idle);
    p.terminate();
    assert!(matches!(until_exit(p.as_mut()), Out::Exited(_)));
}

#[test]
fn a_library_command_runs_through_the_same_process_seam() {
    let l = launch("library");
    let cfg = LaunchConfig {
        program: l.program,
        args: l.args,
        data_dir: ".".into(),
        pipeline_dir: ".".into(),
        generator_dir: ".".into(),
        python_path: "python".into(),
        ffmpeg_path: "ffmpeg".into(),
        gpu: false,
    };
    let got = run_library_command(&OsSpawn, &SystemClock::default(), &cfg, &[], l.env);
    assert_eq!(got.status, Status::Ok);
    assert_eq!(got.data.unwrap()["copied"], 3);

    let missing = LaunchConfig { program: "/no/such/engine".into(), ..cfg };
    assert_eq!(run_library_command(&OsSpawn, &SystemClock::default(), &missing, &[], vec![]).status, Status::Error);
}
