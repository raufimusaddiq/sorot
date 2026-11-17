//! L2 for the session parts of User Story 4: the view that comes back, "Open with Sorot", and the
//! taskbar progress, in process against fakes. The OS shims behind them are out of coverage.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use sorot_desktop::app::{Msg, Route, Snapshot, State, fetch_snapshot};
use sorot_desktop::engine::fake::scenes_dir;
use sorot_desktop::library::SceneLibrary;
use sorot_desktop::session::{NoTaskbar, Progress, Taskbar, ViewMemory, leave_open};
use sorot_desktop_core::model::{Job, JobDetail, JobStage};
use crate::support::*;

fn snapshot(s: &State) -> Snapshot {
    fetch_snapshot(s.engine.as_ref().unwrap().as_ref()).unwrap()
}

/// Every view comes back as it was; a job that is gone, a screen holding a clip, and a view this
/// version does not know come back as Home; and it happens once, not at every poll.
#[test]
fn the_last_view_comes_back_once_the_engine_answers() {
    let j1 = || Route::Job("j1".into());
    for (was, back) in [
        (Route::Home, Route::Home),
        (j1(), j1()),
        (Route::Job("gone".into()), Route::Home),
        (Route::Clips("vnew".into()), Route::Home),
        (Route::Editor("c1".into()), Route::Home),
        (Route::Connections, Route::Connections),
        (Route::GenerateSettings, Route::GenerateSettings),
        (Route::Learning, Route::Learning),
        (Route::Discover, Route::Discover),
        (Route::Generate, Route::Generate),
    ] {
        let mut closed = State::scene("job-running");
        closed.route = was.clone();
        let mut s = State::scene("job-running").with_view(closed.view_memory());
        s.apply(Msg::Snapshot(snapshot(&s)));
        assert_eq!(s.route, back, "{was:?}");
        s.route = Route::Home;
        s.apply(Msg::Snapshot(snapshot(&s)));
        assert_eq!(s.route, Route::Home, "{was:?} again");
    }
    let mut s = State::scene("job-running").with_view(ViewMemory { last_view: "from-a-later-version".into(), last_job_id: None });
    s.apply(Msg::Snapshot(snapshot(&s)));
    assert_eq!(s.route, Route::Home);
}

/// A state with a config folder that other launches write into.
fn with_folder(name: &str) -> (State, PathBuf) {
    let dir = std::env::temp_dir().join(format!("sorot-us4-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let lib = Arc::new(SceneLibrary::new(scenes_dir().join("home-empty")));
    (State::scene("home-empty").with_library(lib, dir.clone(), "data".into(), None), dir)
}

/// A video sent by another launch shows on Home as the file to import, with the options beside
/// it; a file that is not a video says so; pressing Start imports exactly that file.
#[test]
fn a_forwarded_video_opens_the_import_sheet_with_that_file() {
    for (file, sheet) in [("talk.mp4", true), ("notes.txt", false)] {
        let (state, dir) = with_folder(file);
        leave_open(&dir, &[PathBuf::from("C:/videos").join(file)]);
        let mut rt = runtime_of(state);
        rt.update(|s, _| {
            s.tick(2.0);
        });
        rt.frame(1.0 / 60.0);
        assert_eq!(rt.find("home/opened/name").is_some(), sheet, "{file}");
        assert_eq!(rt.find("home/error").is_some(), !sheet, "{file}");
        if sheet {
            for _ in 0..20 {
                rt.frame(0.1);
            }
            click(&mut rt, "home/opened/import");
            assert_eq!(rt.state.route, Route::Job("jnew".into()));
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[derive(Default)]
struct FakeTaskbar(Mutex<Vec<Progress>>);

impl Taskbar for FakeTaskbar {
    fn set(&self, progress: Progress) {
        self.0.lock().unwrap().push(progress);
    }
}

/// The taskbar is told only when what it shows changes: nothing, a bar with no end, the share of
/// stages done, then nothing again.
#[test]
fn the_taskbar_follows_the_running_job() {
    let job = |status: &str| Job {
        id: "j1".into(), video_id: "vnew".into(), status: status.into(), current_stage: None, error_message: None, created_at: String::new(), updated_at: String::new(),
    };
    let detail = |status: &str, done: usize| JobDetail {
        job: job(status),
        stages: ["DOWNLOAD", "AUDIO", "TRANSCRIBE", "SEGMENT"].iter().enumerate().map(|(i, stage)| JobStage {
            id: String::new(), job_id: "j1".into(), stage: (*stage).into(), status: if i < done { "COMPLETED" } else { "PENDING" }.into(),
            started_at: None, completed_at: None, output_path: None,
        }).collect(),
    };
    let snap = |jobs: Vec<Job>| Msg::Snapshot(Snapshot { jobs, videos: vec![], readiness: vec![] });
    let mut s = State::scene("home-empty");
    s.open_job("j1");
    let bar = Arc::new(FakeTaskbar::default());
    s = s.with_taskbar(bar.clone());
    NoTaskbar.set(Progress::None);
    let steps = [
        ("idle", snap(vec![]), None),
        ("a job starts", snap(vec![job("RUNNING")]), Some(Progress::Busy)),
        ("nothing changed", snap(vec![job("RUNNING")]), None),
        ("two stages done", Msg::JobDetail(detail("RUNNING", 2)), Some(Progress::Percent(50))),
        ("three stages done", Msg::JobDetail(detail("RUNNING", 3)), Some(Progress::Percent(75))),
        ("the list says it ended", snap(vec![job("COMPLETED")]), None),
        ("its stages say so too", Msg::JobDetail(detail("COMPLETED", 4)), Some(Progress::None)),
    ];
    for (step, msg, call) in steps {
        let before = bar.0.lock().unwrap().len();
        s.apply(msg);
        let calls = bar.0.lock().unwrap().split_off(before);
        assert_eq!(calls, call.into_iter().collect::<Vec<_>>(), "{step}");
    }
}
