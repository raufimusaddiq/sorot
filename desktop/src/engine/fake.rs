//! Test doubles: `FakeEngine` plays a scene folder (`desktop/scenes/{scene}/*.json`, canned
//! engine answers), `FakeProc` plays a sidecar process, `FakeClock` is time that only moves
//! when a test says so. No network, no process, no sleeping.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::de::DeserializeOwned;
use sorot_desktop_core::model::*;

use super::sidecar::{Clock, Launch, Out, Proc, Spawn};
use super::{Engine, EngineError, Result};

/// Where the scenes live.
pub fn scenes_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("scenes")
}

/// Names of the folders under `desktop/scenes/`, sorted.
pub fn scene_names() -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(scenes_dir())
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[derive(Default)]
struct Inner {
    calls: Vec<String>,
    fail: HashMap<String, EngineError>,
    readiness_steps: VecDeque<Readiness>,
    readiness: Option<Readiness>,
}

pub struct FakeEngine {
    dir: PathBuf,
    inner: Mutex<Inner>,
}

impl FakeEngine {
    /// Answers come from `desktop/scenes/{scene}/{route}.json` (the engine's own payloads).
    pub fn scene(name: &str) -> Self {
        let dir = scenes_dir().join(name);
        assert!(dir.is_dir(), "no scene folder {}", dir.display());
        FakeEngine { dir, inner: Mutex::new(Inner::default()) }
    }

    /// `scene.json`'s `engineFailure`: the engine of this scene never came up, and why.
    pub fn failure(&self) -> Option<String> {
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(self.dir.join("scene.json")).ok()?).ok()?;
        v["engineFailure"].as_str().map(String::from)
    }

    /// Every call so far, as `method(arg)`.
    pub fn calls(&self) -> Vec<String> {
        self.inner.lock().unwrap().calls.clone()
    }

    /// The next call of `method` fails with `error`, then the one after succeeds.
    pub fn fail_once(&self, method: &str, error: EngineError) {
        self.inner.lock().unwrap().fail.insert(method.into(), error);
    }

    /// Each readiness call answers the next step; the last one repeats.
    pub fn readiness_steps(&self, steps: Vec<Readiness>) {
        self.inner.lock().unwrap().readiness_steps = steps.into();
    }

    fn enter(&self, call: String, method: &str) -> Result<()> {
        let mut i = self.inner.lock().unwrap();
        i.calls.push(call);
        match i.fail.remove(method) {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }

    /// `{route}.json` as the envelope's data; a missing file is the empty answer `empty`.
    fn load<T: DeserializeOwned>(&self, route: &str, empty: &str) -> Result<T> {
        let text = std::fs::read_to_string(self.dir.join(format!("{route}.json"))).unwrap_or_else(|_| empty.to_string());
        let env: Envelope<T> = serde_json::from_str(&text).map_err(|e| EngineError::Malformed(format!("{route}.json: {e}")))?;
        env.into_result().map_err(|message| EngineError::Api { status: 400, message })
    }
}

impl Engine for FakeEngine {
    fn health(&self) -> Result<Health> {
        self.enter("health".into(), "health")?;
        self.load("health", r#"{"status":"ok","data":{"healthy":true}}"#)
    }

    fn readiness(&self) -> Result<Readiness> {
        self.enter("readiness".into(), "readiness")?;
        let step = {
            let mut i = self.inner.lock().unwrap();
            if let Some(next) = i.readiness_steps.pop_front() {
                i.readiness = Some(next);
            }
            i.readiness.clone()
        };
        match step {
            Some(r) => Ok(r),
            None => self.load("readiness", r#"{"status":"ok","data":{"items":[]}}"#),
        }
    }

    fn fix_readiness(&self, id: &str) -> Result<FixStarted> {
        self.enter(format!("fix_readiness({id})"), "fix_readiness")?;
        Ok(FixStarted { task_id: format!("task-{id}") })
    }

    fn settings(&self) -> Result<Settings> {
        self.enter("settings".into(), "settings")?;
        self.load("settings", r#"{"status":"error","error":"no settings in this scene"}"#)
    }

    fn videos(&self) -> Result<Vec<Video>> {
        self.enter("videos".into(), "videos")?;
        Ok(self.load::<VideoList>("videos", r#"{"status":"ok","data":{"videos":[]}}"#)?.videos)
    }

    fn jobs(&self) -> Result<Vec<Job>> {
        self.enter("jobs".into(), "jobs")?;
        Ok(self.load::<JobList>("jobs", r#"{"status":"ok","data":{"jobs":[]}}"#)?.jobs)
    }

    fn job(&self, id: &str) -> Result<JobDetail> {
        self.enter(format!("job({id})"), "job")?;
        self.load("job", r#"{"status":"error","error":"Job not found"}"#)
    }

    fn clips(&self, video_id: &str) -> Result<Vec<Clip>> {
        self.enter(format!("clips({video_id})"), "clips")?;
        Ok(self.load::<ClipList>("clips", r#"{"status":"ok","data":{"clips":[]}}"#)?.clips)
    }

    fn import_url(&self, url: &str) -> Result<Imported> {
        self.enter(format!("import_url({url})"), "import_url")?;
        Ok(Imported { video_id: "vnew".into(), source_type: "YOUTUBE".into() })
    }

    fn process(&self, video_id: &str) -> Result<JobRef> {
        self.enter(format!("process({video_id})"), "process")?;
        Ok(JobRef { job_id: "jnew".into(), status: "QUEUED".into() })
    }

    fn cancel_job(&self, id: &str) -> Result<JobRef> {
        self.enter(format!("cancel_job({id})"), "cancel_job")?;
        Ok(JobRef { job_id: id.into(), status: "CANCELLED".into() })
    }

    fn retry_job(&self, id: &str) -> Result<JobRef> {
        self.enter(format!("retry_job({id})"), "retry_job")?;
        Ok(JobRef { job_id: id.into(), status: "QUEUED".into() })
    }
}

/// Time as a counter of milliseconds that a test (or `FakeProc`) advances.
#[derive(Default)]
pub struct FakeClock(AtomicU64);

impl FakeClock {
    pub fn advance(&self, d: Duration) {
        self.0.fetch_add(d.as_millis() as u64, Ordering::SeqCst);
    }
}

impl Clock for FakeClock {
    fn now(&self) -> Duration {
        Duration::from_millis(self.0.load(Ordering::SeqCst))
    }
}

/// What a `FakeProc` does, in order: after `.0` of fake time, `.1` happens.
pub type Step = (Duration, Out);

pub struct FakeProc {
    clock: std::sync::Arc<FakeClock>,
    script: VecDeque<Step>,
    stderr: Vec<String>,
    log: std::sync::Arc<Mutex<Vec<String>>>,
}

impl FakeProc {
    pub fn new(clock: std::sync::Arc<FakeClock>, script: Vec<Step>, stderr: Vec<&str>) -> Self {
        let stderr = stderr.into_iter().map(String::from).collect();
        FakeProc { clock, script: script.into(), stderr, log: Default::default() }
    }

    /// What was done to the process: `close_stdin`, `terminate`.
    pub fn log(&self) -> std::sync::Arc<Mutex<Vec<String>>> {
        self.log.clone()
    }
}

impl Proc for FakeProc {
    fn next(&mut self, wait: Duration) -> Out {
        match self.script.front_mut() {
            Some((after, _)) if *after <= wait => {
                let (after, out) = self.script.pop_front().unwrap();
                self.clock.advance(after);
                out
            }
            Some((after, _)) => {
                *after -= wait;
                self.clock.advance(wait);
                Out::Idle
            }
            None => {
                self.clock.advance(wait);
                Out::Idle
            }
        }
    }

    fn stderr_tail(&self, n: usize) -> Vec<String> {
        self.stderr[self.stderr.len().saturating_sub(n)..].to_vec()
    }

    fn close_stdin(&mut self) {
        self.log.lock().unwrap().push("close_stdin".into());
    }

    fn terminate(&mut self) {
        self.log.lock().unwrap().push("terminate".into());
        self.script.clear();
        self.script.push_back((Duration::ZERO, Out::Exited(1)));
    }
}

/// Hands out the queued processes in order and records each launch.
#[derive(Default)]
pub struct FakeSpawn {
    procs: Mutex<VecDeque<FakeProc>>,
    pub launches: Mutex<Vec<Launch>>,
}

impl FakeSpawn {
    pub fn queue(&self, p: FakeProc) {
        self.procs.lock().unwrap().push_back(p);
    }
}

impl Spawn for FakeSpawn {
    fn spawn(&self, launch: &Launch) -> std::io::Result<Box<dyn Proc>> {
        self.launches.lock().unwrap().push(launch.clone());
        match self.procs.lock().unwrap().pop_front() {
            Some(p) => Ok(Box::new(p)),
            None => Err(std::io::Error::new(std::io::ErrorKind::NotFound, "no engine binary")),
        }
    }
}
