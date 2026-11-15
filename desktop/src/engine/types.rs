//! Payloads of the settings, Generate status, publish, learning and discover routes, as the
//! engine sends them (`backend/src/app.ts`). Keys are camelCase; unknown fields are ignored.

use serde::{Deserialize, Serialize};

/// `POST /api/settings/:kind/test`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ConnTest {
    pub ok: bool,
    #[serde(default)]
    pub ms: u64,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

/// One row of a model's record: how it fared at one level.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRecord {
    pub level: String,
    pub asked: u32,
    pub first_pass: u32,
    pub repaired: u32,
    pub dropped: u32,
    pub malformed: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelRow {
    pub model: String,
    #[serde(default)]
    pub pin: Option<String>,
    pub auto: String,
    #[serde(default)]
    pub proven: Option<String>,
    #[serde(default)]
    pub records: Vec<ModelRecord>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Calibration {
    pub model: String,
    pub done: bool,
    #[serde(default)]
    pub error: Option<String>,
}

/// `GET /api/generate/models`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GenModels {
    pub current: String,
    pub models: Vec<ModelRow>,
    #[serde(default)]
    pub calibration: Option<Calibration>,
}

/// `GET /api/social/accounts`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SocialAccount {
    pub id: String,
    pub platform: String,
    pub name: String,
    #[serde(default)]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub profile_name: Option<String>,
    pub supported: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SocialAccounts {
    pub enabled: bool,
    pub accounts: Vec<SocialAccount>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Needs {
    #[serde(default)]
    pub tiktok_privacy: Option<Vec<String>>,
    #[serde(default)]
    pub made_for_kids: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftTarget {
    pub account_id: String,
    pub platform: String,
    pub name: String,
    pub content: String,
    #[serde(default)]
    pub title: Option<String>,
    pub copy_by: String,
    #[serde(default)]
    pub needs: Needs,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(default)]
    pub blockers: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftClip {
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub gate_verdict: Option<String>,
    #[serde(default)]
    pub gate_reasons: Vec<String>,
}

/// `POST /api/clips/:id/publish/draft`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishDraft {
    pub clip: DraftClip,
    pub targets: Vec<DraftTarget>,
    #[serde(default)]
    pub copy_checked_by: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SocialPost {
    pub id: String,
    pub clip_id: String,
    pub status: String,
    #[serde(default)]
    pub scheduled_at: Option<String>,
    /// JSON text: one entry per account with its own status and link.
    #[serde(default)]
    pub targets: Option<String>,
    #[serde(default)]
    pub error_message: Option<String>,
    #[serde(default)]
    pub profile_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PostList {
    pub posts: Vec<SocialPost>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PostOne {
    pub post: SocialPost,
}

/// One posted clip's logged numbers (`GET /api/feedback`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoggedResult {
    pub clip_id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub viral_score: Option<f64>,
    pub views: u64,
    #[serde(default)]
    pub posted_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FeedbackList {
    pub results: Vec<LoggedResult>,
}

/// `GET /api/feedback/weights`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Weights {
    pub version: u32,
    pub trained_on: u32,
    pub total_feedback: u32,
    pub with_actual_scores: u32,
}

/// What a person typed into the results sheet (`POST /api/clips/:id/feedback`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub views: u64,
    pub likes: u64,
    pub comments: u64,
    pub shares: u64,
    pub saves: u64,
    pub posted_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackSaved {
    pub viral_score: Option<f64>,
}

/// One discovered video (`discover/candidates`, and the lists search and trending answer).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub id: String,
    pub title: String,
    pub url: String,
    #[serde(default)]
    pub duration: f64,
    #[serde(default)]
    pub channel: String,
    #[serde(default)]
    pub view_count: Option<u64>,
    #[serde(default)]
    pub relevance_score: f64,
    pub status: String,
    #[serde(default)]
    pub why: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CandidateList {
    pub videos: Vec<Candidate>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DrainFailure {
    #[serde(rename = "discoveredId")]
    pub discovered_id: String,
    pub error: String,
}

/// `POST /api/discover/queue/drain`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Drained {
    pub started: Vec<serde_json::Value>,
    pub failed: Vec<DrainFailure>,
}

/// One auto-discover run (`POST /api/discover/auto`, `GET /api/discover/auto/:id`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoRun {
    pub id: String,
    /// RUNNING, DONE or FAILED.
    pub status: String,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub llm_error: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub count: u32,
}
