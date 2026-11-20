//! The seam to the engine: one method per route the screens use, returning `core::model` types.
//! The app holds an `Arc<dyn Engine>`; `http` talks to a real engine, `fake` plays a scene.

pub mod generate;
pub mod http;
pub mod sidecar;
pub mod types;

#[cfg(any(test, feature = "headless", debug_assertions))]
pub mod fake;

use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;
use sorot_desktop_core::clips::Options;
use sorot_desktop_core::model::*;

use types::*;

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
    // Settings and Generate status.
    fn update_settings(&self, kind: &str, patch: &Value) -> Result<Settings>;
    fn test_connection(&self, kind: &str) -> Result<ConnTest>;
    /// Kenari's chat models (`kind` = `llm`) or image models (`image`).
    fn kenari_models(&self, kind: &str) -> Result<Vec<KenariModel>>;
    fn kenari_voice_models(&self) -> Result<Vec<KenariVoiceModel>>;
    /// The saved Kenari connection's balance and quota; `None` when it is not Kenari or cannot be read.
    fn kenari_account(&self) -> Result<Option<KenariAccount>>;
    /// Tries a candidate model and key before they are saved.
    fn probe_llm(&self, model: &str, api_key: &str) -> Result<ConnTest>;
    fn generate_status(&self) -> Result<GenerateStatus>;
    fn generate_models(&self) -> Result<GenModels>;
    fn calibrate(&self) -> Result<()>;
    /// `None` hands the model back to `auto`.
    fn pin_model(&self, model: &str, level: Option<&str>) -> Result<()>;
    // Publishing through Tebar.
    fn social_accounts(&self) -> Result<SocialAccounts>;
    fn publish_draft(&self, clip_id: &str, account_ids: &[String]) -> Result<PublishDraft>;
    fn publish(&self, clip_id: &str, body: &Value) -> Result<SocialPost>;
    fn clip_posts(&self, clip_id: &str) -> Result<Vec<SocialPost>>;
    fn refresh_post(&self, id: &str) -> Result<SocialPost>;
    fn retry_post(&self, id: &str) -> Result<SocialPost>;
    fn cancel_post(&self, id: &str) -> Result<SocialPost>;
    // Learning.
    fn feedback(&self) -> Result<Vec<LoggedResult>>;
    fn weights(&self) -> Result<Weights>;
    fn train(&self) -> Result<()>;
    fn submit_feedback(&self, clip_id: &str, metrics: &Metrics) -> Result<FeedbackSaved>;
    // Discover.
    /// `mode` is `search` (`arg` = the query), `trending` or `channel` (`arg` = the channel URL).
    fn discover(&self, mode: &str, arg: &str) -> Result<Vec<Candidate>>;
    fn candidates(&self, status: Option<&str>) -> Result<Vec<Candidate>>;
    fn set_candidate_status(&self, id: &str, status: &str) -> Result<()>;
    fn queue_candidates(&self, ids: &[String]) -> Result<()>;
    fn drain_queue(&self) -> Result<Drained>;
    fn discover_auto(&self, goal: &str) -> Result<AutoRun>;
    fn auto_status(&self, id: &str) -> Result<AutoRun>;
    /// Any engine route, answering its `data`: the one seam of the Generate screens (`generate.rs`
    /// has the typed route wrappers). `method` is GET, POST, PUT, PATCH or DELETE.
    /// `GET path` into `dest` (a file route: a kit part's zip); the bytes written.
    fn download(&self, path: &str, dest: &Path) -> Result<u64>;
    fn call(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value>;
    /// `POST path` as multipart form data: the file in the field `file`, plus `fields`.
    fn upload(&self, path: &str, file: &Path, fields: &[(&str, &str)]) -> Result<Value>;
}

#[cfg(test)]
mod sidecar_tests;
