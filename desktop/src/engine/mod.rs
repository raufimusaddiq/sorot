//! The seam to the engine: one method per route the screens use, returning `core::model` types.
//! The app holds an `Arc<dyn Engine>`; `http` talks to a real engine, `fake` plays a scene.

pub mod http;
pub mod sidecar;

#[cfg(any(test, feature = "headless", debug_assertions))]
pub mod fake;

use sorot_desktop_core::model::*;

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum EngineError {
    /// 401: the token does not match.
    #[error("The engine refused the connection token")]
    Unauthorized,
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

pub type Result<T> = std::result::Result<T, EngineError>;

pub trait Engine: Send + Sync {
    fn health(&self) -> Result<Health>;
    fn readiness(&self) -> Result<Readiness>;
    fn fix_readiness(&self, id: &str) -> Result<FixStarted>;
    fn settings(&self) -> Result<Settings>;
    fn videos(&self) -> Result<Vec<Video>>;
    fn jobs(&self) -> Result<Vec<Job>>;
    fn job(&self, id: &str) -> Result<JobDetail>;
    fn clips(&self, video_id: &str) -> Result<Vec<Clip>>;
    fn import_url(&self, url: &str) -> Result<Imported>;
    fn process(&self, video_id: &str) -> Result<JobRef>;
    fn cancel_job(&self, id: &str) -> Result<JobRef>;
    fn retry_job(&self, id: &str) -> Result<JobRef>;
}

#[cfg(test)]
mod sidecar_tests;
