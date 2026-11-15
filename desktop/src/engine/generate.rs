//! The Generate routes as the screens use them: payload types (`backend/src/generate`, as the web
//! UI's `types.ts` reads them) and one function per route over `Engine::call`. Fields the screens
//! do not edit ride along in `rest`, so a plan saved back is the plan that was read.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::{Engine, EngineError, Result};

const BASE: &str = "/api/generate";

fn parse<T: serde::de::DeserializeOwned>(v: Value) -> Result<T> {
    serde_json::from_value(v).map_err(|e| EngineError::Malformed(e.to_string()))
}

/// One field of a payload: `v[key]` read as `T`.
fn field<T: serde::de::DeserializeOwned>(mut v: Value, key: &str) -> Result<T> {
    parse(v[key].take())
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Storyline {
    pub title: String,
    #[serde(default)]
    pub pitch: String,
    #[serde(default)]
    pub opening: String,
    #[serde(default)]
    pub beats: Vec<String>,
    #[serde(default)]
    pub look: String,
    #[serde(default)]
    pub sound: String,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub recommended: bool,
    #[serde(default)]
    pub reason: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Step {
    #[serde(rename = "use")]
    pub kind: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RecipeRef {
    #[serde(default)]
    pub steps: Vec<Step>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    pub brief: String,
    #[serde(default)]
    pub format: String,
    #[serde(default)]
    pub target_sec: f64,
    #[serde(default)]
    pub language: String,
    /// RUNNING, WAITING, BUILDING, BUILT, ACCEPTED, EXPORTED or FAILED.
    pub status: String,
    #[serde(default)]
    pub storylines: Option<Vec<Storyline>>,
    #[serde(default)]
    pub picked_storyline: Option<usize>,
    #[serde(default)]
    pub current_plan_id: Option<String>,
    #[serde(default)]
    pub error_message: Option<String>,
    #[serde(default)]
    pub recipe: Option<RecipeRef>,
    #[serde(default)]
    pub updated_at: String,
}

impl Project {
    /// The name in the list: the title, or the start of the brief.
    pub fn name(&self) -> String {
        match &self.title {
            Some(t) => t.clone(),
            None if self.brief.chars().count() > 40 => format!("{}…", self.brief.chars().take(40).collect::<String>()),
            None => self.brief.clone(),
        }
    }

    /// The director is at work: the screen follows along until it stops.
    pub fn working(&self) -> bool {
        matches!(self.status.as_str(), "RUNNING" | "BUILDING")
    }

    /// The recipe has a facts step.
    pub fn has_facts(&self) -> bool {
        self.recipe.as_ref().is_some_and(|r| r.steps.iter().any(|s| s.kind == "facts"))
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ShotText {
    pub role: String,
    pub value: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Visual {
    #[serde(default)]
    pub description: String,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shot {
    pub id: String,
    #[serde(default)]
    pub purpose: String,
    pub duration_sec: f64,
    #[serde(default)]
    pub text: Vec<ShotText>,
    #[serde(default)]
    pub visual: Visual,
    #[serde(default)]
    pub motion: String,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub title: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub shots: Vec<Shot>,
    #[serde(default)]
    pub assumptions: Vec<String>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

impl Plan {
    /// Seconds the shots add up to, to one decimal.
    pub fn total(&self) -> f64 {
        (self.shots.iter().map(|s| s.duration_sec).sum::<f64>() * 10.0).round() / 10.0
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanRow {
    pub id: String,
    pub revision: u32,
    pub plan: Plan,
    #[serde(default)]
    pub change_request: Option<String>,
    #[serde(default)]
    pub change_summary: Option<String>,
    #[serde(default)]
    pub approved_at: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub id: String,
    pub number: u32,
    #[serde(default)]
    pub plan_id: String,
    #[serde(default)]
    pub parent_version_id: Option<String>,
    /// QUEUED, BUILDING, BUILT, FAILED or CANCELLED.
    pub status: String,
    #[serde(default)]
    pub step: Option<String>,
    #[serde(default)]
    pub progress: Option<f64>,
    #[serde(default)]
    pub draft_path: Option<String>,
    #[serde(default)]
    pub error_message: Option<String>,
}

impl Version {
    pub fn working(&self) -> bool {
        matches!(self.status.as_str(), "QUEUED" | "BUILDING")
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Export {
    pub id: String,
    pub version_id: String,
    #[serde(default)]
    pub path: String,
}

/// `{version id: {TECHNICAL: PASS, CREATIVE: REVIEW}}`.
pub type VerdictStatuses = HashMap<String, HashMap<String, String>>;

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Detail {
    pub project: Project,
    #[serde(default)]
    pub plans: Vec<PlanRow>,
    #[serde(default)]
    pub versions: Vec<Version>,
    #[serde(default)]
    pub exports: Vec<Export>,
    #[serde(default)]
    pub verdict_statuses: VerdictStatuses,
}

impl Detail {
    /// The plan the project builds from now: the current one, else the newest.
    pub fn current_plan(&self) -> Option<&PlanRow> {
        self.project.current_plan_id.as_ref().and_then(|id| self.plans.iter().find(|p| &p.id == id)).or_else(|| self.plans.first())
    }

    pub fn approved(&self) -> bool {
        self.current_plan().is_some_and(|p| p.approved_at.is_some())
    }
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub id: String,
    pub severity: String,
    #[serde(default)]
    pub shot_id: Option<String>,
    #[serde(default)]
    pub from_sec: Option<f64>,
    #[serde(default)]
    pub to_sec: Option<f64>,
    #[serde(default)]
    pub code: String,
    pub description: String,
    #[serde(default)]
    pub suggested_fix: Option<String>,
    /// open, fixed or kept.
    pub state: String,
    #[serde(default)]
    pub kept_reason: Option<String>,
    #[serde(default)]
    pub count: Option<u32>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    /// TECHNICAL or CREATIVE.
    pub kind: String,
    /// PASS, REVIEW or FAIL.
    pub status: String,
    #[serde(default)]
    pub findings: Vec<Finding>,
    #[serde(default)]
    pub judged_by: String,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct Built {
    pub version: Version,
    #[serde(default)]
    pub verdicts: Vec<Verdict>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Estimate {
    pub draft_sec: u64,
    pub export_sec: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixResult {
    pub needs_approval: bool,
    #[serde(default)]
    pub summary: String,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Idea {
    pub id: String,
    pub slug: String,
    pub brief: String,
    /// new, used, built or posted.
    pub status: String,
    #[serde(default)]
    pub project_id: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fact {
    pub id: String,
    pub claim: String,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub source_url: Option<String>,
    /// unverified, verified, corrected or unverifiable.
    pub status: String,
    #[serde(default)]
    pub original_value: Option<String>,
    #[serde(default)]
    pub evidence: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct Event {
    pub id: String,
    pub kind: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub ok: u8,
    #[serde(default)]
    pub ms: Option<f64>,
    #[serde(default)]
    pub request: Option<String>,
    #[serde(default)]
    pub response: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeItem {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub built_in: bool,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub available: bool,
    #[serde(default)]
    pub reasons: Vec<String>,
    #[serde(default)]
    pub recipe: Value,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct Checked {
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub errors: Vec<String>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct Manifest {
    #[serde(default)]
    pub does: String,
    #[serde(default)]
    pub runtime: String,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct KitPart {
    pub name: String,
    /// builtIn or user.
    pub source: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub manifest: Manifest,
}

/// What `POST /projects` takes.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Brief {
    pub brief: String,
    pub format: String,
    pub target_sec: u32,
    pub language: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub style_notes: String,
}

pub fn projects(e: &dyn Engine) -> Result<Vec<Project>> {
    field(e.call("GET", &format!("{BASE}/projects"), None)?, "projects")
}

pub fn create_project(e: &dyn Engine, b: &Brief) -> Result<Project> {
    field(e.call("POST", &format!("{BASE}/projects"), Some(json!(b)))?, "project")
}

pub fn project(e: &dyn Engine, id: &str) -> Result<Detail> {
    parse(e.call("GET", &format!("{BASE}/projects/{id}"), None)?)
}

pub fn delete_project(e: &dyn Engine, id: &str) -> Result<()> {
    e.call("DELETE", &format!("{BASE}/projects/{id}"), None).map(drop)
}

pub fn retry_project(e: &dyn Engine, id: &str) -> Result<()> {
    e.call("POST", &format!("{BASE}/projects/{id}/retry"), None).map(drop)
}

pub fn more_storylines(e: &dyn Engine, id: &str, note: &str) -> Result<()> {
    e.call("POST", &format!("{BASE}/projects/{id}/storylines"), Some(json!({ "note": note }))).map(drop)
}

pub fn pick_storyline(e: &dyn Engine, id: &str, index: usize, note: &str) -> Result<()> {
    e.call("POST", &format!("{BASE}/projects/{id}/storylines/{index}/pick"), Some(json!({ "note": note }))).map(drop)
}

pub fn save_plan(e: &dyn Engine, id: &str, plan: &Plan) -> Result<()> {
    e.call("PUT", &format!("{BASE}/projects/{id}/plan"), Some(json!({ "plan": plan }))).map(drop)
}

pub fn revise_plan(e: &dyn Engine, id: &str, request: &str) -> Result<()> {
    e.call("POST", &format!("{BASE}/projects/{id}/plan/revise"), Some(json!({ "request": request }))).map(drop)
}

pub fn approve_plan(e: &dyn Engine, id: &str, plan_id: &str) -> Result<()> {
    e.call("POST", &format!("{BASE}/projects/{id}/plan/approve"), Some(json!({ "planId": plan_id }))).map(drop)
}

pub fn estimate(e: &dyn Engine, id: &str) -> Result<Estimate> {
    parse(e.call("GET", &format!("{BASE}/projects/{id}/estimate"), None)?)
}

pub fn build(e: &dyn Engine, id: &str) -> Result<()> {
    e.call("POST", &format!("{BASE}/projects/{id}/versions"), None).map(drop)
}

pub fn version(e: &dyn Engine, id: &str) -> Result<Built> {
    parse(e.call("GET", &format!("{BASE}/versions/{id}"), None)?)
}

/// `cancel`, `retry`, `accept` or `restore` on one version.
pub fn version_action(e: &dyn Engine, id: &str, action: &str) -> Result<()> {
    e.call("POST", &format!("{BASE}/versions/{id}/{action}"), None).map(drop)
}

/// Asks the director to fix findings (none = every must-fix) or to change what a note says.
pub fn fix(e: &dyn Engine, id: &str, finding_ids: &[String], note: &str) -> Result<FixResult> {
    let mut body = Map::new();
    if !finding_ids.is_empty() {
        body.insert("findingIds".into(), json!(finding_ids));
    }
    if !note.is_empty() {
        body.insert("note".into(), json!(note));
    }
    parse(e.call("POST", &format!("{BASE}/versions/{id}/fix"), Some(Value::Object(body)))?)
}

pub fn export_version(e: &dyn Engine, id: &str) -> Result<Export> {
    field(e.call("POST", &format!("{BASE}/versions/{id}/export"), Some(json!({})))?, "export")
}

pub fn events(e: &dyn Engine, id: &str) -> Result<Vec<Event>> {
    field(e.call("GET", &format!("{BASE}/projects/{id}/events?limit=100"), None)?, "events")
}

pub fn ideas(e: &dyn Engine) -> Result<Vec<Idea>> {
    field(e.call("GET", &format!("{BASE}/ideas"), None)?, "ideas")
}

pub fn add_idea(e: &dyn Engine, slug: &str, brief: &str) -> Result<()> {
    e.call("POST", &format!("{BASE}/ideas"), Some(json!({ "slug": slug, "brief": brief }))).map(drop)
}

pub fn delete_idea(e: &dyn Engine, id: &str) -> Result<()> {
    e.call("DELETE", &format!("{BASE}/ideas/{id}"), None).map(drop)
}

/// Runs the next new idea, or the named one; answers the video it made or resumed.
pub fn run_idea(e: &dyn Engine, idea_id: Option<&str>) -> Result<Project> {
    let body = idea_id.map(|i| json!({ "ideaId": i })).unwrap_or_else(|| json!({}));
    field(e.call("POST", &format!("{BASE}/run"), Some(body))?, "project")
}

pub fn facts(e: &dyn Engine, project_id: &str) -> Result<Vec<Fact>> {
    field(e.call("GET", &format!("{BASE}/projects/{project_id}/facts"), None)?, "facts")
}

pub fn add_fact(e: &dyn Engine, project_id: &str, claim: &str, value: &str, source_url: &str) -> Result<()> {
    let mut body = json!({ "claim": claim, "sourceUrl": source_url });
    if !value.is_empty() {
        body["value"] = json!(value);
    }
    e.call("POST", &format!("{BASE}/projects/{project_id}/facts"), Some(body)).map(drop)
}

pub fn delete_fact(e: &dyn Engine, id: &str) -> Result<()> {
    e.call("DELETE", &format!("{BASE}/facts/{id}"), None).map(drop)
}

pub fn verify_facts(e: &dyn Engine, project_id: &str) -> Result<Vec<Fact>> {
    field(e.call("POST", &format!("{BASE}/projects/{project_id}/facts/verify"), None)?, "facts")
}

pub fn recipes(e: &dyn Engine) -> Result<Vec<RecipeItem>> {
    field(e.call("GET", &format!("{BASE}/recipes"), None)?, "recipes")
}

pub fn validate_recipe(e: &dyn Engine, recipe: &Value) -> Result<Checked> {
    parse(e.call("POST", &format!("{BASE}/recipes/validate"), Some(json!({ "recipe": recipe })))?)
}

pub fn copy_recipe(e: &dyn Engine, from: &str, id: &str, name: &str) -> Result<String> {
    field(field::<Value>(e.call("POST", &format!("{BASE}/recipes"), Some(json!({ "fromId": from, "id": id, "name": name })))?, "recipe")?, "id")
}

pub fn save_recipe(e: &dyn Engine, id: &str, recipe: &Value) -> Result<()> {
    e.call("PUT", &format!("{BASE}/recipes/{id}"), Some(json!({ "recipe": recipe }))).map(drop)
}

pub fn delete_recipe(e: &dyn Engine, id: &str) -> Result<()> {
    e.call("DELETE", &format!("{BASE}/recipes/{id}"), None).map(drop)
}

pub fn import_recipe(e: &dyn Engine, recipe: &Value) -> Result<String> {
    field(field::<Value>(e.call("POST", &format!("{BASE}/recipes/import"), Some(json!({ "recipe": recipe })))?, "recipe")?, "id")
}

/// The recipe as shareable JSON.
pub fn export_recipe(e: &dyn Engine, id: &str) -> Result<Value> {
    e.call("GET", &format!("{BASE}/recipes/{id}/export"), None)
}

pub fn kit_parts(e: &dyn Engine) -> Result<Vec<KitPart>> {
    field(e.call("GET", &format!("{BASE}/kit"), None)?, "parts")
}

pub fn remove_kit_part(e: &dyn Engine, name: &str) -> Result<()> {
    e.call("DELETE", &format!("{BASE}/kit/{}", super::http::encode(name)), None).map(drop)
}
