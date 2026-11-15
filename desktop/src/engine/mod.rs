//! The seam to the engine: one method per route the screens use, returning `core::model` types.
//! The app holds an `Arc<dyn Engine>`; `http` talks to a real engine, `fake` plays a scene.

pub mod http;
pub mod sidecar;

#[cfg(any(test, feature = "headless", debug_assertions))]
pub mod fake;

use std::path::{Path, PathBuf};

use serde::Deserialize;
use sorot_desktop_core::clips::Options;
use sorot_desktop_core::model::*;

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum EngineError {
    /// 401: the token does not match.
    #[error("The engine refused the connection token")]
    Unauthorized,
    /// 507: DATA_DIR lacks the room the job needs.
    #[error("Not enough disk space: needs {} GB, {} GB free", gb(*need), gb(*free))]
    DiskFull { need: u64, free: u64 },
    /// The engine answered with an error envelope.
    #[error("{message}")]
    Api { status: u16, message: String },
    /// The engine could not be reached.
    #[error("Cannot reach the engine: {0}")]
    Network(String),
    /// The engine answered with something that is not its envelope.
    #[error("The engine sent an unreadable answer: {0}")]
    Malformed(String),
}

/// Bytes as the one-decimal gigabytes a person reads.
pub fn gb(bytes: u64) -> String {
    format!("{:.1}", bytes as f64 / 1e9)
}

pub type Result<T> = std::result::Result<T, EngineError>;

/// What the person gave Home to clip.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Source {
    Url(String),
    File(PathBuf),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportRequest {
    pub source: Source,
    /// What the clips should be about; at most 500 characters (checked on Home).
    pub direction: String,
    /// The import options sheet: only what differs from the engine's defaults.
    pub options: Options,
}

/// The video and the job one import started.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Started {
    pub video_id: String,
    pub job_id: String,
}

/// `GET /api/options`.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditOptions {
    pub styles: Vec<String>,
    pub reframe_modes: Vec<String>,
    pub defaults: Options,
}

pub trait Engine: Send + Sync {
    fn health(&self) -> Result<Health>;
    fn readiness(&self) -> Result<Readiness>;
    fn fix_readiness(&self, id: &str) -> Result<FixStarted>;
    fn settings(&self) -> Result<Settings>;
    fn videos(&self) -> Result<Vec<Video>>;
    fn jobs(&self) -> Result<Vec<Job>>;
    fn job(&self, id: &str) -> Result<JobDetail>;
    fn clips(&self, video_id: &str) -> Result<Vec<Clip>>;
    /// Imports `req.source`, then starts the job with the direction and options.
    fn import(&self, req: &ImportRequest) -> Result<Started>;
    /// `GET /api/options`: the caption styles, reframe modes and the engine's defaults.
    fn options(&self) -> Result<EditOptions>;
    /// `GET /api/music`: the file names under `data/music`.
    fn music(&self) -> Result<Vec<String>>;
    /// `POST /api/clips/:id/rerender` with only the clip-layer delta.
    fn rerender(&self, clip_id: &str, delta: &Options) -> Result<Clip>;
    /// `POST /api/clips/export`: the engine's path of the exported file.
    fn export(&self, clip_id: &str) -> Result<String>;
    /// `GET /api/clips/:id/preview` into `dest`; the bytes written.
    fn download_preview(&self, clip_id: &str, dest: &Path) -> Result<u64>;
    /// `GET /api/clips/:id/export` into `dest` (a remote engine's "save as").
    fn download_export(&self, clip_id: &str, dest: &Path) -> Result<u64>;
    fn cancel_job(&self, id: &str) -> Result<JobRef>;
    fn retry_job(&self, id: &str) -> Result<JobRef>;
}

#[cfg(test)]
mod sidecar_tests;
