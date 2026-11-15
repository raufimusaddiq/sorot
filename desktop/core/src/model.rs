//! The engine's JSON as the app reads it (`docs/api-spec.md`, `backend/src/http.ts`). Keys are
//! camelCase; fields the app does not know are ignored, so the engine can add without breaking it.

use serde::{Deserialize, Serialize};

/// `{status: "ok", data}` or `{status: "error", error}`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Ok,
    Error,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(bound(deserialize = "T: Deserialize<'de>"))]
pub struct Envelope<T> {
    pub status: Status,
    #[serde(default)]
    pub data: Option<T>,
    #[serde(default)]
    pub error: Option<String>,
}

const NO_DATA: &str = "the engine sent no data";

fn blank_error() -> String {
    "the engine reported an error".into()
}

impl<T> Envelope<T> {
    /// The data, or the engine's message.
    pub fn into_result(self) -> Result<T, String> {
        match (self.status, self.data, self.error) {
            (Status::Ok, Some(d), _) => Ok(d),
            (Status::Ok, None, _) => Err(NO_DATA.into()),
            (Status::Error, _, e) => Err(e.unwrap_or_else(blank_error)),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub healthy: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Video {
    pub id: String,
    pub source_type: String,
    pub source_url: Option<String>,
    pub title: Option<String>,
    pub file_path: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct VideoList {
    pub videos: Vec<Video>,
}

/// Engine states plus the one the app shows: a FAILED job whose error is `interrupted`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobPhase {
    Queued,
    Running,
    Completed,
    Failed,
    Interrupted,
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub video_id: String,
    pub status: String,
    /// NULL until the job starts: a queued job has none.
    pub current_stage: Option<String>,
    pub error_message: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl Job {
    pub fn phase(&self) -> JobPhase {
        match self.status.as_str() {
            "QUEUED" => JobPhase::Queued,
            "RUNNING" => JobPhase::Running,
            "COMPLETED" => JobPhase::Completed,
            "CANCELLED" => JobPhase::Cancelled,
            _ if self.error_message.as_deref() == Some("interrupted") => JobPhase::Interrupted,
            _ => JobPhase::Failed,
        }
    }

    pub fn is_running(&self) -> bool {
        matches!(self.phase(), JobPhase::Queued | JobPhase::Running)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct JobList {
    pub jobs: Vec<Job>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobStage {
    pub id: String,
    pub job_id: String,
    pub stage: String,
    pub status: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    #[serde(default)]
    pub output_path: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct JobDetail {
    pub job: Job,
    pub stages: Vec<JobStage>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub id: String,
    pub video_id: String,
    pub rank_pos: Option<u32>,
    pub score: Option<f64>,
    pub tier: String,
    pub start_time: f64,
    pub end_time: f64,
    pub duration_sec: f64,
    pub text_content: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub render_status: String,
    pub render_path: Option<String>,
    pub export_status: String,
    pub export_path: Option<String>,
    pub created_at: String,
    /// JSON text of the options set in the clip editor.
    #[serde(default)]
    pub options: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub hook_start: Option<f64>,
    #[serde(default)]
    pub hook_end: Option<f64>,
    /// PASS, REVIEW or FAIL.
    #[serde(default)]
    pub gate_verdict: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ClipList {
    pub clips: Vec<Clip>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipDetail {
    pub clip: Clip,
    #[serde(default)]
    pub score_breakdown: Option<serde_json::Value>,
}

/// `POST /api/import` answer.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    pub video_id: String,
    pub source_type: String,
}

/// `POST /api/process`, `/jobs/:id/cancel` and `/jobs/:id/retry` answers.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRef {
    pub job_id: String,
    pub status: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Progress {
    pub percent: u8,
    pub label: String,
}

/// One row of `GET /api/readiness`. `id` is ffmpeg, python, whisperModel, gpu or generateBrowser.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadinessItem {
    pub id: String,
    pub required: bool,
    pub ok: bool,
    pub fixable: bool,
    pub detail: String,
    #[serde(default)]
    pub progress: Option<Progress>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Readiness {
    pub items: Vec<ReadinessItem>,
}

/// `POST /api/readiness/:id/fix` answer (202).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixStarted {
    pub task_id: String,
}

/// One connection as `GET /api/settings` shows it. The key is masked.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub active: bool,
    pub enabled: bool,
    #[serde(default)]
    pub saved: Vec<String>,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    pub api_key: String,
    pub api_key_set: bool,
    #[serde(default)]
    pub director: Option<bool>,
    #[serde(default)]
    pub profiles: Option<Vec<Profile>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Profile {
    pub id: String,
    pub name: String,
}

/// `GET /api/settings`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Settings {
    pub llm: Connection,
    pub jev: Connection,
    pub tebar: Connection,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Configured {
    pub configured: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HyperframesStatus {
    pub ok: bool,
    #[serde(default)]
    pub version: Option<String>,
}

/// `GET /api/generate/status`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateStatus {
    pub available: bool,
    pub reasons: Vec<String>,
    pub hyperframes: HyperframesStatus,
    pub llm: Configured,
    pub jev: Configured,
    pub compute: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenProject {
    pub id: String,
    pub title: Option<String>,
    pub brief: String,
    pub format: String,
    pub target_sec: f64,
    pub language: String,
    pub recipe_id: String,
    pub step_index: u32,
    pub status: String,
    pub error_message: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenVersion {
    pub id: String,
    pub project_id: String,
    pub number: u32,
    pub status: String,
    pub step: Option<String>,
    /// NULL until the build reports.
    pub progress: Option<f64>,
    pub draft_path: Option<String>,
    pub error_message: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GenFinding {
    pub id: String,
    pub severity: String,
    pub code: String,
    pub description: String,
    pub state: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenVerdict {
    pub id: String,
    pub version_id: String,
    /// TECHNICAL or CREATIVE.
    pub kind: String,
    pub status: String,
    pub findings: Vec<GenFinding>,
    pub judged_by: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every payload the engine sends the app, copied from `frontend/test/fakeApi.ts`: one row
    /// per file, which must deserialize through the envelope (unknown fields are ignored).
    macro_rules! rows {
        ($($file:literal => $ty:ty),* $(,)?) => {
            vec![$((
                $file,
                (|| serde_json::from_str::<Envelope<$ty>>(include_str!(concat!("../tests/fixtures/api/", $file))).map(|e| e.into_result().map(|_| ())))
                    as fn() -> serde_json::Result<Result<(), String>>,
            )),*]
        };
    }

    #[test]
    fn every_engine_payload_deserializes() {
        let table = rows![
            "health.json" => Health,
            "videos.json" => VideoList,
            "jobs.json" => JobList,
            "job.json" => JobDetail,
            "clips.json" => ClipList,
            "clip.json" => ClipDetail,
            "imported.json" => Imported,
            "job-ref.json" => JobRef,
            "readiness.json" => Readiness,
            "fix-started.json" => FixStarted,
            "settings.json" => Settings,
            "generate-status.json" => GenerateStatus,
            "gen-project.json" => GenProject,
            "gen-version.json" => GenVersion,
            "gen-version-queued.json" => GenVersion,
            "gen-verdict.json" => GenVerdict,
        ];
        for (file, parse) in table {
            assert_eq!(parse().unwrap_or_else(|e| panic!("{file}: {e}")), Ok(()), "{file}");
        }
    }

    #[test]
    fn errors_and_phases() {
        let err: Envelope<Health> = serde_json::from_str(include_str!("../tests/fixtures/api/error.json")).unwrap();
        assert_eq!(err.into_result(), Err("Job not found".to_string()));
        let empty: Envelope<Health> = serde_json::from_str(r#"{"status":"ok"}"#).unwrap();
        assert!(empty.into_result().is_err());
        let blank: Envelope<Health> = serde_json::from_str(r#"{"status":"error"}"#).unwrap();
        assert!(blank.into_result().is_err());

        let job = |status: &str, err: Option<&str>| Job {
            id: "j".into(), video_id: "v".into(), status: status.into(), current_stage: None,
            error_message: err.map(Into::into), created_at: String::new(), updated_at: String::new(),
        };
        let cases = [
            (job("QUEUED", None), JobPhase::Queued, true),
            (job("RUNNING", None), JobPhase::Running, true),
            (job("COMPLETED", None), JobPhase::Completed, false),
            (job("CANCELLED", None), JobPhase::Cancelled, false),
            (job("FAILED", Some("boom")), JobPhase::Failed, false),
            (job("FAILED", Some("interrupted")), JobPhase::Interrupted, false),
        ];
        for (j, phase, running) in cases {
            assert_eq!((j.phase(), j.is_running()), (phase, running), "{}", j.status);
        }
    }
}
