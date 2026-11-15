//! The local engine as a child process: launch env (contracts/engine-connection.md §1), the
//! ready line (§2), stdin held open (§4), the library commands that run before the server (§7).
//! Everything goes through `Spawn`/`Proc`/`Clock`, so tests play it with `FakeProc`/`FakeClock`.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;
use sorot_desktop_core::engine_conn::{EngineConn, Event};
use sorot_desktop_core::handshake::{HandshakeError, Ready, parse_ready};
use sorot_desktop_core::model::{Envelope, Status};
use sorot_desktop_core::redact::redact;

use crate::platform::process;

/// The contract version of `SOROT_READY`'s `api` this app speaks.
pub const SUPPORTED_API: u32 = 1;
pub const READY_TIMEOUT: Duration = Duration::from_secs(30);
pub const QUIT_GRACE: Duration = Duration::from_secs(5);
const LIBRARY_TIMEOUT: Duration = Duration::from_secs(600);
const DIAGNOSTIC_LINES: usize = 50;

/// What a process printed or did, as `Proc::next` sees it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Out {
    Line(String),
    Exited(i32),
    /// Nothing happened within the wait.
    Idle,
}

pub trait Proc: Send {
    /// The next stdout line or the exit, waiting at most `wait`.
    fn next(&mut self, wait: Duration) -> Out;
    fn stderr_tail(&self, n: usize) -> Vec<String>;
    fn close_stdin(&mut self);
    /// Ends it and everything it started (Job Object / process group).
    fn terminate(&mut self);
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

pub trait Spawn: Send + Sync {
    fn spawn(&self, launch: &Launch) -> std::io::Result<Box<dyn Proc>>;
}

pub trait Clock: Send + Sync {
    /// Time since an arbitrary start; only differences matter.
    fn now(&self) -> Duration;
}

pub struct SystemClock(Instant);

impl Default for SystemClock {
    fn default() -> Self {
        SystemClock(Instant::now())
    }
}

impl Clock for SystemClock {
    fn now(&self) -> Duration {
        self.0.elapsed()
    }
}

/// The engine as a real child process.
pub struct OsSpawn;

struct OsProc {
    child: Child,
    guard: process::Guard,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
    stderr: Arc<Mutex<VecDeque<String>>>,
}

impl Spawn for OsSpawn {
    fn spawn(&self, launch: &Launch) -> std::io::Result<Box<dyn Proc>> {
        let mut cmd = Command::new(&launch.program);
        cmd.args(&launch.args).envs(launch.env.iter().map(|(k, v)| (k, v)))
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        process::prepare(&mut cmd);
        let mut child = cmd.spawn()?;
        let guard = process::adopt(&child);
        let stdin = child.stdin.take();
        let (tx, lines) = channel();
        let out = child.stdout.take().expect("piped");
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(|l| l.ok()) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        let stderr: Arc<Mutex<VecDeque<String>>> = Default::default();
        let (err, ring) = (child.stderr.take().expect("piped"), stderr.clone());
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(|l| l.ok()) {
                let mut r = ring.lock().unwrap();
                r.push_back(line);
                if r.len() > 200 {
                    r.pop_front();
                }
            }
        });
        Ok(Box::new(OsProc { child, guard, stdin, lines, stderr }))
    }
}

impl Proc for OsProc {
    fn next(&mut self, wait: Duration) -> Out {
        match self.lines.recv_timeout(wait) {
            Ok(line) => Out::Line(line),
            Err(RecvTimeoutError::Timeout) => match self.child.try_wait() {
                Ok(Some(s)) => Out::Exited(s.code().unwrap_or(-1)),
                _ => Out::Idle,
            },
            Err(RecvTimeoutError::Disconnected) => Out::Exited(self.child.wait().ok().and_then(|s| s.code()).unwrap_or(-1)),
        }
    }

    fn stderr_tail(&self, n: usize) -> Vec<String> {
        let r = self.stderr.lock().unwrap();
        r.iter().skip(r.len().saturating_sub(n)).cloned().collect()
    }

    fn close_stdin(&mut self) {
        self.stdin = None;
    }

    fn terminate(&mut self) {
        process::terminate(&self.guard, &mut self.child);
    }
}

/// Where the engine and its tools live; everything the launch env needs.
#[derive(Clone, Debug)]
pub struct LaunchConfig {
    pub program: PathBuf,
    /// `["run", "backend/src/index.ts"]` in development, empty for the bundled engine.
    pub args: Vec<String>,
    pub data_dir: PathBuf,
    pub pipeline_dir: PathBuf,
    pub generator_dir: PathBuf,
    pub python_path: PathBuf,
    pub ffmpeg_path: PathBuf,
    /// The readiness check found an NVIDIA GPU.
    pub gpu: bool,
}

/// The env table of contracts/engine-connection.md §1.
pub fn launch_env(cfg: &LaunchConfig, token: &str) -> Vec<(String, String)> {
    let path = |p: &PathBuf| p.to_string_lossy().into_owned();
    [
        ("SERVER_HOST", "127.0.0.1".to_string()),
        ("SERVER_PORT", "0".into()),
        ("SOROT_TOKEN", token.into()),
        ("STATIC_DIR", String::new()),
        ("SOROT_PARENT_PIPE", "1".into()),
        ("SOROT_SOLE_OWNER", "1".into()),
        ("DATA_DIR", path(&cfg.data_dir)),
        ("PIPELINE_DIR", path(&cfg.pipeline_dir)),
        ("GENERATOR_DIR", path(&cfg.generator_dir)),
        ("PYTHON_PATH", path(&cfg.python_path)),
        ("FFMPEG_PATH", path(&cfg.ffmpeg_path)),
        ("WHISPER_DEVICE", if cfg.gpu { "cuda" } else { "cpu" }.into()),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect()
}

/// 32 random bytes as base64url, new on every launch.
pub fn new_token() -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("the OS has randomness");
    let mut out = String::with_capacity(43);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().fold(0u32, |acc, b| acc << 8 | *b as u32) << (8 * (3 - chunk.len()));
        for i in 0..=chunk.len() {
            out.push(ABC[(n >> (18 - 6 * i) & 63) as usize] as char);
        }
    }
    out
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum StartError {
    #[error("The engine could not be started: {0}")]
    Spawn(String),
    #[error("The engine stopped before it was ready (exit {0})")]
    Exited(i32),
    #[error("The engine was not ready after 30 seconds")]
    Timeout,
    #[error("{0}")]
    Handshake(HandshakeError),
}

/// Reads stdout until the ready line. Other lines are ignored.
fn await_ready(proc: &mut dyn Proc, clock: &dyn Clock) -> std::result::Result<Ready, StartError> {
    let deadline = clock.now() + READY_TIMEOUT;
    loop {
        let left = deadline.saturating_sub(clock.now());
        if left.is_zero() {
            return Err(StartError::Timeout);
        }
        match proc.next(left) {
            Out::Idle => {}
            Out::Exited(code) => return Err(StartError::Exited(code)),
            Out::Line(l) => match parse_ready(&l, SUPPORTED_API) {
                Err(HandshakeError::NotReady) => {}
                Ok(r) => return Ok(r),
                Err(e) => return Err(StartError::Handshake(e)),
            },
        }
    }
}

/// The running engine and the connection state machine it drives.
pub struct Sidecar {
    spawn: Arc<dyn Spawn>,
    clock: Arc<dyn Clock>,
    cfg: LaunchConfig,
    make_token: fn() -> String,
    grace: Duration,
    token: String,
    proc: Option<Box<dyn Proc>>,
    ready_at: Duration,
    pub conn: EngineConn,
}

impl Sidecar {
    pub fn new(spawn: Arc<dyn Spawn>, clock: Arc<dyn Clock>, cfg: LaunchConfig) -> Self {
        Sidecar { spawn, clock, cfg, make_token: new_token, grace: QUIT_GRACE, token: String::new(), proc: None, ready_at: Duration::ZERO, conn: EngineConn::default() }
    }

    pub fn with_token_source(mut self, make: fn() -> String) -> Self {
        self.make_token = make;
        self
    }

    pub fn with_grace(mut self, grace: Duration) -> Self {
        self.grace = grace;
        self
    }

    /// Stops the engine (as a quit does) and starts it again on another data folder.
    pub fn relaunch_in(&mut self, dir: PathBuf) -> std::result::Result<Ready, StartError> {
        self.quit();
        self.conn = EngineConn::default();
        self.cfg.data_dir = dir;
        self.start()
    }

    /// The token of the current launch.
    pub fn token(&self) -> &str {
        &self.token
    }

    /// Launches the engine with a new token and waits for its ready line.
    pub fn start(&mut self) -> std::result::Result<Ready, StartError> {
        self.stop_process();
        self.token = (self.make_token)();
        let launch = Launch { program: self.cfg.program.clone(), args: self.cfg.args.clone(), env: launch_env(&self.cfg, &self.token) };
        let mut proc = match self.spawn.spawn(&launch) {
            Ok(p) => p,
            Err(e) => {
                self.conn.apply(Event::Exited { uptime_secs: 0 });
                return Err(StartError::Spawn(e.to_string()));
            }
        };
        let result = await_ready(proc.as_mut(), self.clock.as_ref());
        match &result {
            Ok(r) => {
                self.ready_at = self.clock.now();
                self.conn.apply(Event::Ready { port: r.port, version: r.version.clone() });
            }
            Err(e) => {
                self.conn.apply(match e {
                    StartError::Timeout => Event::StartTimeout,
                    StartError::Handshake(HandshakeError::TooNew) => Event::TooNew,
                    _ => Event::Exited { uptime_secs: 0 },
                });
            }
        }
        self.proc = Some(proc);
        if result.is_err() {
            self.stop_process();
        }
        result
    }

    pub fn health(&mut self, ok: bool) {
        self.conn.apply(if ok { Event::HealthOk } else { Event::HealthFailed });
    }

    /// A 401: restarts the engine once, then fails.
    pub fn unauthorized(&mut self) -> Option<std::result::Result<Ready, StartError>> {
        self.conn.apply(Event::Unauthorized);
        self.restart_if_due()
    }

    /// The engine process ended on its own.
    pub fn exited(&mut self) {
        let uptime = self.clock.now().saturating_sub(self.ready_at).as_secs() as u32;
        self.conn.apply(Event::Exited { uptime_secs: uptime });
        self.proc = None;
    }

    /// Acts on `Lost`: restarts when the budget allows.
    pub fn recover(&mut self) -> Option<std::result::Result<Ready, StartError>> {
        self.conn.apply(Event::Recover);
        self.restart_if_due()
    }

    /// "Restart engine" on a failed connection.
    pub fn user_restart(&mut self) -> Option<std::result::Result<Ready, StartError>> {
        self.conn.apply(Event::UserRestart);
        self.restart_if_due()
    }

    fn restart_if_due(&mut self) -> Option<std::result::Result<Ready, StartError>> {
        (self.conn.state == sorot_desktop_core::engine_conn::State::Restarting).then(|| self.start())
    }

    /// Closes stdin, gives the engine its grace to shut down, then ends the process tree.
    pub fn quit(&mut self) {
        self.conn.apply(Event::Quit);
        if let Some(mut p) = self.proc.take() {
            p.close_stdin();
            let deadline = self.clock.now() + self.grace;
            let mut gone = false;
            while !gone {
                let left = deadline.saturating_sub(self.clock.now());
                if left.is_zero() {
                    break;
                }
                gone = matches!(p.next(left), Out::Exited(_));
            }
            if !gone {
                p.terminate();
            }
        }
        self.conn.apply(Event::Gone);
    }

    /// The last 50 stderr lines with the token and every `Bearer` removed.
    pub fn diagnostic(&self) -> String {
        let lines = self.proc.as_ref().map(|p| p.stderr_tail(DIAGNOSTIC_LINES)).unwrap_or_default();
        redact(&lines.join("\n"), &[&self.token])
    }

    fn stop_process(&mut self) {
        if let Some(mut p) = self.proc.take() {
            p.terminate();
        }
    }
}

/// Runs `sorot-engine <args>` (the startup commands of §7) and returns the one envelope it
/// printed (the last line that is one). A process that cannot start, never answers or prints no envelope is an error one.
pub fn run_library_command(spawn: &dyn Spawn, clock: &dyn Clock, cfg: &LaunchConfig, args: &[&str], env: Vec<(String, String)>) -> Envelope<Value> {
    run_library_command_with(spawn, clock, cfg, args, env, &mut |_| {})
}

/// As `run_library_command`, and `on_progress` hears every `PROGRESS <n>` line (0..=100).
pub fn run_library_command_with(spawn: &dyn Spawn, clock: &dyn Clock, cfg: &LaunchConfig, args: &[&str], env: Vec<(String, String)>, on_progress: &mut dyn FnMut(u8)) -> Envelope<Value> {
    let fail = |e: String| Envelope { status: Status::Error, data: None, error: Some(e) };
    let mut a = cfg.args.clone();
    a.extend(args.iter().map(|s| s.to_string()));
    let mut proc = match spawn.spawn(&Launch { program: cfg.program.clone(), args: a, env }) {
        Ok(p) => p,
        Err(e) => return fail(e.to_string()),
    };
    let deadline = clock.now() + LIBRARY_TIMEOUT;
    let mut lines = Vec::new();
    let code = loop {
        let left = deadline.saturating_sub(clock.now());
        if left.is_zero() {
            proc.terminate();
            return fail("The engine did not answer".into());
        }
        match proc.next(left) {
            Out::Line(l) => match l.strip_prefix("PROGRESS ").and_then(|n| n.split_whitespace().next()?.parse::<u8>().ok()) {
                Some(n) => on_progress(n.min(100)),
                None => lines.push(l),
            },
            Out::Exited(c) => break c,
            Out::Idle => {}
        }
    };
    match lines.iter().rev().find_map(|l| serde_json::from_str::<Envelope<Value>>(l).ok()) {
        Some(env) => env,
        None => fail(format!("The engine exited with code {code} and no answer: {}", proc.stderr_tail(3).join(" "))),
    }
}
