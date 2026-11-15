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
use sorot_desktop_core::clips::Options;
use sorot_desktop_core::job::STAGE_ORDER;

use super::{EditOptions, Engine, EngineError, ImportRequest, Result, Source, Started};

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
    /// Items whose fix was asked for, and how many readiness calls came since.
    fixing: HashMap<String, u8>,
    /// Each `job` call after an import answers the next step; the last one repeats.
    job_steps: VecDeque<JobDetail>,
    job: Option<JobDetail>,
    imported: bool,
}

/// What the engine shows while one job walks every stage: each stage reports `PROGRESS` (50%),
/// then finishes; the last step is the completed job.
pub fn stage_script(job_id: &str, video_id: &str) -> Vec<JobDetail> {
    let stage = |i: usize, status: &str, out: Option<String>| JobStage {
        id: format!("s{i}"), job_id: job_id.into(), stage: STAGE_ORDER[i].into(), status: status.into(),
        started_at: None, completed_at: None, output_path: out,
    };
    let detail = |status: &str, current: Option<usize>, stages: Vec<JobStage>| JobDetail {
        job: Job {
            id: job_id.into(), video_id: video_id.into(), status: status.into(), current_stage: current.map(|i| STAGE_ORDER[i].to_string()),
            error_message: None, created_at: String::new(), updated_at: String::new(),
        },
        stages,
    };
    let mut steps = vec![detail("QUEUED", None, (0..STAGE_ORDER.len()).map(|i| stage(i, "PENDING", None)).collect())];
    for active in 0..STAGE_ORDER.len() {
        for percent in [Some(50), None] {
            let stages = (0..STAGE_ORDER.len())
                .map(|i| match i.cmp(&active) {
                    std::cmp::Ordering::Less => stage(i, "COMPLETED", None),
                    std::cmp::Ordering::Equal => stage(i, "IN_PROGRESS", percent.map(|p| format!("Working {p}%"))),
                    std::cmp::Ordering::Greater => stage(i, "PENDING", None),
                })
                .collect();
            steps.push(detail("RUNNING", Some(active), stages));
        }
    }
    steps.push(detail("COMPLETED", None, (0..STAGE_ORDER.len()).map(|i| stage(i, "COMPLETED", None)).collect()));
    steps
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

    /// Each `job` call answers the next step; the last one repeats.
    pub fn job_steps(&self, steps: Vec<JobDetail>) {
        let mut i = self.inner.lock().unwrap();
        (i.job_steps, i.job) = (steps.into(), None);
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
        let mut r = match step {
            Some(r) => r,
            None => self.load("readiness", r#"{"status":"ok","data":{"items":[]}}"#)?,
        };
        // A fix that was asked for shows progress once, then is done.
        let mut i = self.inner.lock().unwrap();
        for item in &mut r.items {
            if let Some(n) = i.fixing.get_mut(&item.id) {
                *n = n.saturating_add(1);
                item.ok = *n > 1;
                item.progress = (*n == 1).then(|| Progress { percent: 50, label: "Downloading".into() });
            }
        }
        Ok(r)
    }

    fn fix_readiness(&self, id: &str) -> Result<FixStarted> {
        self.enter(format!("fix_readiness({id})"), "fix_readiness")?;
        self.inner.lock().unwrap().fixing.insert(id.into(), 0);
        Ok(FixStarted { task_id: format!("task-{id}") })
    }

    fn settings(&self) -> Result<Settings> {
        self.enter("settings".into(), "settings")?;
        self.load("settings", r#"{"status":"error","error":"no settings in this scene"}"#)
    }

    fn videos(&self) -> Result<Vec<Video>> {
        self.enter("videos".into(), "videos")?;
        let mut videos = self.load::<VideoList>("videos", r#"{"status":"ok","data":{"videos":[]}}"#)?.videos;
        if self.inner.lock().unwrap().imported {
            videos.push(Video { id: "vnew".into(), source_type: "LOCAL".into(), source_url: None, title: Some("Imported".into()), file_path: None, created_at: String::new() });
        }
        Ok(videos)
    }

    fn jobs(&self) -> Result<Vec<Job>> {
        self.enter("jobs".into(), "jobs")?;
        let mut jobs = self.load::<JobList>("jobs", r#"{"status":"ok","data":{"jobs":[]}}"#)?.jobs;
        let i = self.inner.lock().unwrap();
        if let (true, Some(d)) = (i.imported, i.job.as_ref().or(i.job_steps.front())) {
            jobs.push(d.job.clone());
        }
        Ok(jobs)
    }

    fn job(&self, id: &str) -> Result<JobDetail> {
        self.enter(format!("job({id})"), "job")?;
        {
            let mut i = self.inner.lock().unwrap();
            if i.imported {
                if let Some(next) = i.job_steps.pop_front() {
                    i.job = Some(next);
                }
                if let Some(d) = i.job.clone().filter(|d| d.job.id == id) {
                    return Ok(d);
                }
            }
        }
        self.load("job", r#"{"status":"error","error":"Job not found"}"#)
    }

    fn clips(&self, video_id: &str) -> Result<Vec<Clip>> {
        self.enter(format!("clips({video_id})"), "clips")?;
        Ok(self.load::<ClipList>("clips", r#"{"status":"ok","data":{"clips":[]}}"#)?.clips)
    }

    fn import(&self, req: &ImportRequest) -> Result<Started> {
        let what = match &req.source {
            Source::Url(u) => u.clone(),
            Source::File(p) => format!("file:{}", p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()),
        };
        let options = if req.options.is_empty() { String::new() } else { format!("|{}", serde_json::Value::Object(req.options.clone())) };
        self.enter(format!("import({what}|{}{options})", req.direction), "import")?;
        let mut i = self.inner.lock().unwrap();
        i.imported = true;
        if i.job_steps.is_empty() && i.job.is_none() {
            i.job_steps = stage_script("jnew", "vnew").into();
        }
        Ok(Started { video_id: "vnew".into(), job_id: "jnew".into() })
    }

    fn options(&self) -> Result<EditOptions> {
        self.enter("options".into(), "options")?;
        self.load("options", r#"{"status":"ok","data":{"styles":["karaoke","plain"],"reframeModes":["face","center"],"defaults":{"style":"karaoke","reframe":"face","silenceTrim":false,"hookFirst":false,"bgm":""}}}"#)
    }

    fn music(&self) -> Result<Vec<String>> {
        self.enter("music".into(), "music")?;
        #[derive(serde::Deserialize)]
        struct Tracks {
            tracks: Vec<String>,
        }
        Ok(self.load::<Tracks>("music", r#"{"status":"ok","data":{"tracks":[]}}"#)?.tracks)
    }

    fn rerender(&self, clip_id: &str, delta: &Options) -> Result<Clip> {
        self.enter(format!("rerender({clip_id}|{})", serde_json::Value::Object(delta.clone())), "rerender")?;
        let clips = self.load::<ClipList>("clips", r#"{"status":"ok","data":{"clips":[]}}"#)?.clips;
        clips.into_iter().find(|c| c.id == clip_id).ok_or(EngineError::Api { status: 404, message: "Clip not found".into() })
    }

    fn export(&self, clip_id: &str) -> Result<String> {
        self.enter(format!("export({clip_id})"), "export")?;
        Ok(format!("/exports/{clip_id}_final.mp4"))
    }

    fn download_preview(&self, clip_id: &str, dest: &Path) -> Result<u64> {
        self.enter(format!("download_preview({clip_id})"), "download_preview")?;
        write_fake(dest)
    }

    fn download_export(&self, clip_id: &str, dest: &Path) -> Result<u64> {
        self.enter(format!("download_export({clip_id})"), "download_export")?;
        write_fake(dest)
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

fn write_fake(dest: &Path) -> Result<u64> {
    const BYTES: &[u8] = b"fake-mp4";
    match std::fs::write(dest, BYTES) {
        Ok(()) => Ok(BYTES.len() as u64),
        Err(e) => Err(EngineError::Network(e.to_string())),
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

/// Remembers every path it was asked to show; with `SOROT_REVEAL_LOG` set (headless journeys) it
/// appends each path to that file too, so a binary-only test can see the call.
#[derive(Default)]
pub struct RecordReveal {
    pub shown: Mutex<Vec<PathBuf>>,
}

impl crate::platform::reveal::Reveal for RecordReveal {
    fn reveal(&self, path: &Path) -> std::result::Result<(), String> {
        self.shown.lock().unwrap().push(path.to_path_buf());
        if let Ok(log) = std::env::var("SOROT_REVEAL_LOG") {
            use std::io::Write;
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(log) {
                let _ = writeln!(f, "{}", path.display());
            }
        }
        Ok(())
    }
}

/// Remembers every notification: `(job id, title, body)`.
#[derive(Default)]
pub struct RecordNotifier {
    pub sent: Mutex<Vec<(String, String, String)>>,
    pub clicked: Mutex<Option<crate::app::ClickFn>>,
}

impl crate::app::Notifier for RecordNotifier {
    fn notify(&self, job_id: &str, title: &str, body: &str) {
        self.sent.lock().unwrap().push((job_id.into(), title.into(), body.into()));
    }

    fn on_click(&self, f: crate::app::ClickFn) {
        *self.clicked.lock().unwrap() = Some(f);
    }
}
