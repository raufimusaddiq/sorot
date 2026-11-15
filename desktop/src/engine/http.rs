//! `Engine` over HTTP: the engine's own API, a bearer token, the `{status, data|error}` envelope.

use std::time::Duration;

use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use sorot_desktop_core::model::*;

use std::path::Path;

use sorot_desktop_core::clips::Options;

use super::types::*;
use super::{EditOptions, Engine, EngineError, ImportRequest, Result, Source, Started};

fn malformed(e: serde_json::Error) -> EngineError {
    EngineError::Malformed(e.to_string())
}

#[derive(serde::Deserialize)]
struct ClipOnly {
    clip: Clip,
}

#[derive(serde::Deserialize)]
struct Exported {
    exported: Vec<Clip>,
}

/// The 507 body: `{"status":"error","error":..,"data":{"needBytes":..,"freeBytes":..}}`.
fn disk_full(body: &str) -> EngineError {
    let data = serde_json::from_str::<Value>(body).ok().map(|v| v["data"].clone()).unwrap_or(Value::Null);
    EngineError::DiskFull { need: data["needBytes"].as_u64().unwrap_or(0), free: data["freeBytes"].as_u64().unwrap_or(0) }
}

pub struct HttpEngine {
    base: String,
    token: Option<String>,
    agent: ureq::Agent,
}

impl HttpEngine {
    /// `base` is `http://127.0.0.1:<port>`; `token` goes in `Authorization: Bearer`, never a URL.
    pub fn new(base: impl Into<String>, token: Option<String>) -> Self {
        let agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(30)))
            .build()
            .into();
        HttpEngine { base: base.into().trim_end_matches('/').to_string(), token, agent }
    }

    /// The status and body of one request; everything that does not depend on the payload type.
    fn raw(&self, method: &str, path: &str, body: Option<Value>) -> Result<(u16, String)> {
        let url = format!("{}{path}", self.base);
        let auth = self.token.as_ref().map(|t| format!("Bearer {t}"));
        let sent = match method {
            "GET" | "DELETE" => {
                let mut req = if method == "GET" { self.agent.get(&url) } else { self.agent.delete(&url) };
                if let Some(a) = &auth {
                    req = req.header("Authorization", a);
                }
                req.call()
            }
            _ => {
                let mut req = match method {
                    "PUT" => self.agent.put(&url),
                    "PATCH" => self.agent.patch(&url),
                    _ => self.agent.post(&url),
                }
                .header("Content-Type", "application/json");
                if let Some(a) = &auth {
                    req = req.header("Authorization", a);
                }
                req.send(body.unwrap_or(json!({})).to_string())
            }
        };
        let mut resp = sent.map_err(|e| EngineError::Network(e.to_string()))?;
        let status = resp.status().as_u16();
        let text = resp.body_mut().read_to_string().map_err(|e| EngineError::Network(e.to_string()))?;
        match status {
            401 => Err(EngineError::Unauthorized),
            507 => Err(disk_full(&text)),
            _ => Ok((status, text)),
        }
    }

    /// A file route into `dest`, written to a sibling first so a cut download never looks whole.
    fn download(&self, path: &str, dest: &Path) -> Result<u64> {
        let mut req = self.agent.get(format!("{}{path}", self.base));
        if let Some(t) = &self.token {
            req = req.header("Authorization", format!("Bearer {t}"));
        }
        let mut resp = req.call().map_err(|e| EngineError::Network(e.to_string()))?;
        match resp.status().as_u16() {
            200 | 206 => {}
            401 => return Err(EngineError::Unauthorized),
            status => return Err(EngineError::Api { status, message: resp.body_mut().read_to_string().unwrap_or_default() }),
        }
        let part = dest.with_extension("part");
        let io = |e: std::io::Error| EngineError::Network(e.to_string());
        let mut file = std::fs::File::create(&part).map_err(io)?;
        let n = std::io::copy(&mut resp.body_mut().as_reader(), &mut file).map_err(io)?;
        std::fs::rename(&part, dest).map_err(io)?;
        Ok(n)
    }

    /// Multipart by hand: one file part named `file`, then a text part for each of `fields`.
    fn upload(&self, path: &str, file: &Path, fields: &[(&str, &str)]) -> Result<Value> {
        let io = |e: std::io::Error| EngineError::Network(e.to_string());
        let bytes = std::fs::read(file).map_err(io)?;
        let name = file.file_name().map(|n| n.to_string_lossy().replace('"', "_")).unwrap_or_default();
        let boundary = format!("sorot-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos()));
        let mut body = Vec::new();
        for (k, v) in fields {
            body.extend(format!("--{boundary}
Content-Disposition: form-data; name=\"{k}\"

{v}
").into_bytes());
        }
        body.extend(format!("--{boundary}
Content-Disposition: form-data; name=\"file\"; filename=\"{name}\"
Content-Type: application/octet-stream

").into_bytes());
        body.extend(bytes);
        body.extend(format!("
--{boundary}--
").into_bytes());
        let mut req = self.agent.post(format!("{}{path}", self.base)).header("Content-Type", format!("multipart/form-data; boundary={boundary}"));
        if let Some(t) = &self.token {
            req = req.header("Authorization", format!("Bearer {t}"));
        }
        let mut resp = req.send(&body[..]).map_err(|e| EngineError::Network(e.to_string()))?;
        let status = resp.status().as_u16();
        let text = resp.body_mut().read_to_string().map_err(|e| EngineError::Network(e.to_string()))?;
        if status == 401 {
            return Err(EngineError::Unauthorized);
        }
        let env: Envelope<Value> = serde_json::from_str(&text).map_err(malformed)?;
        env.into_result().map_err(|message| EngineError::Api { status, message })
    }

    fn call<T: DeserializeOwned>(&self, method: &str, path: &str, body: Option<Value>) -> Result<T> {
        let (status, text) = self.raw(method, path, body)?;
        let env: Envelope<T> = serde_json::from_str(&text).map_err(malformed)?;
        env.into_result().map_err(|message| EngineError::Api { status, message })
    }

    fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        self.call("GET", path, None)
    }

    fn post<T: DeserializeOwned>(&self, path: &str, body: Value) -> Result<T> {
        self.call("POST", path, Some(body))
    }

    fn put<T: DeserializeOwned>(&self, path: &str, body: Value) -> Result<T> {
        self.call("PUT", path, Some(body))
    }
}

/// Percent-encodes what a path segment or query value may not hold (model ids carry `/`).
pub fn encode(s: &str) -> String {
    s.bytes().fold(String::new(), |mut out, b| {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
        out
    })
}

impl Engine for HttpEngine {
    fn health(&self) -> Result<Health> {
        self.get("/api/health")
    }
    fn readiness(&self) -> Result<Readiness> {
        self.get("/api/readiness")
    }
    fn fix_readiness(&self, id: &str) -> Result<FixStarted> {
        self.post(&format!("/api/readiness/{id}/fix"), json!({}))
    }
    fn settings(&self) -> Result<Settings> {
        self.get("/api/settings")
    }
    fn videos(&self) -> Result<Vec<Video>> {
        Ok(self.get::<VideoList>("/api/videos")?.videos)
    }
    fn jobs(&self) -> Result<Vec<Job>> {
        Ok(self.get::<JobList>("/api/jobs")?.jobs)
    }
    fn job(&self, id: &str) -> Result<JobDetail> {
        self.get(&format!("/api/jobs/{id}"))
    }
    fn clips(&self, video_id: &str) -> Result<Vec<Clip>> {
        Ok(self.get::<ClipList>(&format!("/api/videos/{video_id}/clips"))?.clips)
    }
    fn import(&self, req: &ImportRequest) -> Result<Started> {
        let body = match &req.source {
            Source::Url(url) => json!({ "url": url }),
            Source::File(path) => json!({ "localPath": path.to_string_lossy() }),
        };
        let video: Imported = self.post("/api/import", body)?;
        let mut options = req.options.clone();
        if !req.direction.is_empty() {
            options.insert("direction".into(), req.direction.clone().into());
        }
        let job: JobRef = self.post("/api/process", json!({ "videoId": video.video_id, "options": options }))?;
        Ok(Started { video_id: video.video_id, job_id: job.job_id })
    }
    fn options(&self) -> Result<EditOptions> {
        self.get("/api/options")
    }
    fn music(&self) -> Result<Vec<String>> {
        #[derive(serde::Deserialize)]
        struct Tracks {
            tracks: Vec<String>,
        }
        Ok(self.get::<Tracks>("/api/music")?.tracks)
    }
    fn rerender(&self, clip_id: &str, delta: &Options) -> Result<Clip> {
        Ok(self.post::<ClipOnly>(&format!("/api/clips/{clip_id}/rerender"), Value::Object(delta.clone()))?.clip)
    }
    fn export(&self, clip_id: &str) -> Result<String> {
        let done: Exported = self.post("/api/clips/export", json!({ "clipIds": [clip_id] }))?;
        done.exported.into_iter().find_map(|c| c.export_path).ok_or(EngineError::Api { status: 200, message: "The clip has no rendered file to export yet.".into() })
    }
    fn download_preview(&self, clip_id: &str, dest: &Path) -> Result<u64> {
        self.download(&format!("/api/clips/{clip_id}/preview"), dest)
    }
    fn download_export(&self, clip_id: &str, dest: &Path) -> Result<u64> {
        self.download(&format!("/api/clips/{clip_id}/export"), dest)
    }
    fn cancel_job(&self, id: &str) -> Result<JobRef> {
        self.post(&format!("/api/jobs/{id}/cancel"), json!({}))
    }
    fn retry_job(&self, id: &str) -> Result<JobRef> {
        self.post(&format!("/api/jobs/{id}/retry"), json!({}))
    }
    fn update_settings(&self, kind: &str, patch: &Value) -> Result<Settings> {
        self.put(&format!("/api/settings/{kind}"), patch.clone())
    }
    fn test_connection(&self, kind: &str) -> Result<ConnTest> {
        self.post(&format!("/api/settings/{kind}/test"), json!({}))
    }
    fn generate_status(&self) -> Result<GenerateStatus> {
        self.get("/api/generate/status")
    }
    fn generate_models(&self) -> Result<GenModels> {
        self.get("/api/generate/models")
    }
    fn calibrate(&self) -> Result<()> {
        self.post::<Value>("/api/generate/models/calibrate", json!({})).map(drop)
    }
    fn pin_model(&self, model: &str, level: Option<&str>) -> Result<()> {
        self.put::<Value>(&format!("/api/generate/models/{}/level", encode(model)), json!({ "level": level })).map(drop)
    }
    fn social_accounts(&self) -> Result<SocialAccounts> {
        self.get("/api/social/accounts")
    }
    fn publish_draft(&self, clip_id: &str, account_ids: &[String]) -> Result<PublishDraft> {
        self.post(&format!("/api/clips/{clip_id}/publish/draft"), json!({ "accountIds": account_ids }))
    }
    fn publish(&self, clip_id: &str, body: &Value) -> Result<SocialPost> {
        Ok(self.post::<PostOne>(&format!("/api/clips/{clip_id}/publish"), body.clone())?.post)
    }
    fn clip_posts(&self, clip_id: &str) -> Result<Vec<SocialPost>> {
        Ok(self.get::<PostList>(&format!("/api/clips/{clip_id}/posts"))?.posts)
    }
    fn retry_post(&self, id: &str) -> Result<SocialPost> {
        Ok(self.post::<PostOne>(&format!("/api/social/posts/{id}/retry"), json!({}))?.post)
    }
    fn cancel_post(&self, id: &str) -> Result<SocialPost> {
        Ok(self.post::<PostOne>(&format!("/api/social/posts/{id}/cancel"), json!({}))?.post)
    }
    fn feedback(&self) -> Result<Vec<LoggedResult>> {
        Ok(self.get::<FeedbackList>("/api/feedback")?.results)
    }
    fn weights(&self) -> Result<Weights> {
        self.get("/api/feedback/weights")
    }
    fn train(&self) -> Result<()> {
        self.post::<Value>("/api/feedback/train", json!({})).map(drop)
    }
    fn submit_feedback(&self, clip_id: &str, metrics: &Metrics) -> Result<FeedbackSaved> {
        self.post(&format!("/api/clips/{clip_id}/feedback"), json!(metrics))
    }
    fn discover(&self, mode: &str, arg: &str) -> Result<Vec<Candidate>> {
        let body = match mode {
            "search" => json!({ "query": arg }),
            "channel" => json!({ "channelUrl": arg }),
            _ => json!({}),
        };
        Ok(self.post::<CandidateList>(&format!("/api/discover/{mode}"), body)?.videos)
    }
    fn candidates(&self, status: Option<&str>) -> Result<Vec<Candidate>> {
        let query = status.map(|s| format!("?status={}", encode(s))).unwrap_or_default();
        Ok(self.get::<CandidateList>(&format!("/api/discover/candidates{query}"))?.videos)
    }
    fn set_candidate_status(&self, id: &str, status: &str) -> Result<()> {
        self.post::<Value>(&format!("/api/discover/candidates/{id}/status"), json!({ "status": status })).map(drop)
    }
    fn queue_candidates(&self, ids: &[String]) -> Result<()> {
        self.post::<Value>("/api/discover/queue", json!({ "ids": ids })).map(drop)
    }
    fn drain_queue(&self) -> Result<Drained> {
        self.post("/api/discover/queue/drain", json!({}))
    }
    fn discover_auto(&self, goal: &str) -> Result<AutoRun> {
        self.post("/api/discover/auto", json!({ "goal": goal }))
    }
    fn download(&self, path: &str, dest: &Path) -> Result<u64> {
        HttpEngine::download(self, path, dest)
    }
    fn call(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value> {
        HttpEngine::call::<Value>(self, method, path, body)
    }
    fn upload(&self, path: &str, file: &Path, fields: &[(&str, &str)]) -> Result<Value> {
        HttpEngine::upload(self, path, file, fields)
    }
    fn auto_status(&self, id: &str) -> Result<AutoRun> {
        self.get(&format!("/api/discover/auto/{id}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::sync::{Arc, Mutex};

    type Seen = Arc<Mutex<Vec<(String, String, Option<String>)>>>;

    /// One in-process stub answering every request with `(status, body)`, recording each one.
    fn stub(status: u16, body: &'static str) -> (String, Seen) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://127.0.0.1:{}", server.server_addr().to_ip().unwrap().port());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for mut req in server.incoming_requests() {
                let auth = req.headers().iter().find(|h| h.field.equiv("Authorization")).map(|h| h.value.to_string());
                let mut sent = String::new();
                let _ = std::io::Read::read_to_string(req.as_reader(), &mut sent);
                log.lock().unwrap().push((req.method().to_string(), format!("{} {sent}", req.url()), auth));
                let _ = req.respond(tiny_http::Response::new(status.into(), vec![], Cursor::new(body), None, None));
            }
        });
        (base, seen)
    }

    #[test]
    fn statuses_and_bodies_map_to_engine_errors() {
        let api = |s: u16, m: &str| EngineError::Api { status: s, message: m.into() };
        let cases: [(u16, &str, std::result::Result<bool, EngineError>); 6] = [
            (200, r#"{"status":"ok","data":{"healthy":true}}"#, Ok(true)),
            (401, r#"{"status":"error","error":"unauthorized"}"#, Err(EngineError::Unauthorized)),
            (400, r#"{"status":"error","error":"Can only retry failed jobs"}"#, Err(api(400, "Can only retry failed jobs"))),
            (507, r#"{"status":"error","error":"not enough disk space"}"#, Err(EngineError::DiskFull { need: 0, free: 0 })),
            (200, "<html>", Err(EngineError::Malformed(String::new()))),
            (200, r#"{"status":"ok"}"#, Err(api(200, "the engine sent no data"))),
        ];
        for (status, body, want) in cases {
            let (base, _) = stub(status, body);
            let got = HttpEngine::new(base, None).health().map(|h| h.healthy);
            match (&got, &want) {
                (Err(EngineError::Malformed(_)), Err(EngineError::Malformed(_))) => {}
                _ => assert_eq!(got, want, "{status} {body}"),
            }
        }
        let dead = HttpEngine::new("http://127.0.0.1:1", None).health();
        assert!(matches!(dead, Err(EngineError::Network(_))));
    }

    /// A file import sends its path; a full disk becomes the sentence the person reads; a file route
    /// writes its bytes (and nothing on an error status).
    #[test]
    fn files_disk_errors_and_downloads() {
        let (base, seen) = stub(200, r#"{"status":"ok","data":{"videoId":"v","sourceType":"LOCAL","jobId":"j","status":"QUEUED"}}"#);
        let file = ImportRequest { source: Source::File("C:/v/a b.mp4".into()), direction: String::new(), options: Options::new() };
        assert_eq!(HttpEngine::new(base, None).import(&file), Ok(Started { video_id: "v".into(), job_id: "j".into() }));
        let sent: Vec<_> = seen.lock().unwrap().iter().map(|(_, p, _)| p.clone()).collect();
        assert_eq!(sent, [r#"/api/import {"localPath":"C:/v/a b.mp4"}"#, r#"/api/process {"options":{},"videoId":"v"}"#]);

        let (base, _) = stub(507, r#"{"status":"error","error":"not enough disk space","data":{"needBytes":2000000000,"freeBytes":500000000}}"#);
        let full = HttpEngine::new(base, None).import(&file).unwrap_err();
        assert_eq!((full.to_string(), full), ("Not enough disk space: needs 2.0 GB, 0.5 GB free".to_string(), EngineError::DiskFull { need: 2_000_000_000, free: 500_000_000 }));

        let dir = std::env::temp_dir().join(format!("sorot-http-dl-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for (status, body, want) in [(200, "mp4bytes", Ok(8)), (404, r#"{"status":"error","error":"No rendered file available"}"#, Err(404)), (401, "", Err(401))] {
            let (base, seen) = stub(status, body);
            let dest = dir.join(format!("out{status}.mp4"));
            let got = HttpEngine::new(base, Some("tok".into())).download_preview("c1", &dest);
            let got = got.map_err(|e| match e {
                EngineError::Api { status, .. } => status,
                EngineError::Unauthorized => 401,
                other => panic!("{other:?}"),
            });
            assert_eq!((got, dest.exists()), (want, want.is_ok()), "{status}");
            assert_eq!(seen.lock().unwrap()[0].1, "/api/clips/c1/preview ");
        }
        assert_eq!(std::fs::read_to_string(dir.join("out200.mp4")).unwrap(), "mp4bytes");
        let (base, seen) = stub(200, "x");
        assert_eq!(HttpEngine::new(base, None).download_export("c1", &dir.join("e.mp4")), Ok(1));
        assert_eq!(seen.lock().unwrap()[0].1, "/api/clips/c1/export ");
        // an unreachable engine and a folder that does not exist are network-style errors, not panics
        let gone = HttpEngine::new("http://127.0.0.1:1", None).download_preview("c1", &dir.join("x.mp4"));
        assert!(matches!(gone, Err(EngineError::Network(_))));
        let (base, _) = stub(200, "x");
        let nowhere = HttpEngine::new(base, None).download_preview("c1", &dir.join("missing").join("x.mp4"));
        assert!(matches!(nowhere, Err(EngineError::Network(_))));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn every_route_sends_its_request_with_the_token() {
        let (base, seen) = stub(200, r#"{"status":"ok","data":{"healthy":true,"items":[],"videos":[],"jobs":[],"clips":[],"taskId":"t","videoId":"v","sourceType":"YOUTUBE","jobId":"j","status":"QUEUED"}}"#);
        let e = HttpEngine::new(format!("{base}/"), Some("tok".into()));
        let _ = (e.health(), e.readiness(), e.fix_readiness("ffmpeg"), e.videos(), e.jobs(), e.clips("v1"));
        let req = ImportRequest { source: Source::Url("https://youtu.be/x".into()), direction: "Ringkas bagian yang lucu".into(), options: Options::new() };
        let delta: Options = serde_json::from_value(json!({"style": "plain"})).unwrap();
        let _ = (e.import(&req), e.options(), e.music(), e.rerender("c1", &delta), e.export("c1"), e.cancel_job("j1"), e.retry_job("j1"));
        assert!(e.settings().is_err() && e.job("j1").is_err(), "payloads of the wrong shape are malformed");
        let got: Vec<_> = seen.lock().unwrap().iter().map(|(m, p, a)| format!("{m} {p} {}", a.as_deref().unwrap_or(""))).collect();
        let want = [
            "GET /api/health  Bearer tok",
            "GET /api/readiness  Bearer tok",
            "POST /api/readiness/ffmpeg/fix {} Bearer tok",
            "GET /api/videos  Bearer tok",
            "GET /api/jobs  Bearer tok",
            "GET /api/videos/v1/clips  Bearer tok",
            r#"POST /api/import {"url":"https://youtu.be/x"} Bearer tok"#,
            r#"POST /api/process {"options":{"direction":"Ringkas bagian yang lucu"},"videoId":"v"} Bearer tok"#,
            "GET /api/options  Bearer tok",
            "GET /api/music  Bearer tok",
            r#"POST /api/clips/c1/rerender {"style":"plain"} Bearer tok"#,
            r#"POST /api/clips/export {"clipIds":["c1"]} Bearer tok"#,
            "POST /api/jobs/j1/cancel {} Bearer tok",
            "POST /api/jobs/j1/retry {} Bearer tok",
            "GET /api/settings  Bearer tok",
            "GET /api/jobs/j1  Bearer tok",
        ];
        assert_eq!(got, want);
    }

    /// The Generate routes: every method the screens use goes through `call`, with its body.
    #[test]
    fn generate_routes_send_their_requests() {
        use crate::engine::generate as g;
        let (base, seen) = stub(
            200,
            r#"{"status":"ok","data":{"projects":[],"project":{"id":"p","brief":"b","status":"WAITING"},"recipe":{"id":"r"},"facts":[],"events":[],"ideas":[],"recipes":[],"parts":[],"export":{"id":"x","versionId":"v"}}}"#,
        );
        let e = HttpEngine::new(base, None);
        let plan = g::Plan { title: "t".into(), ..g::Plan::default() };
        let brief = g::Brief { brief: "b".into(), format: "9:16".into(), target_sec: 30, language: "id".into(), style_notes: String::new() };
        let _ = (g::projects(&e), g::create_project(&e, &brief), g::project(&e, "p"), g::delete_project(&e, "p"), g::retry_project(&e, "p"), g::more_storylines(&e, "p", "n"), g::pick_storyline(&e, "p", 1, "n"));
        let _ = (g::save_plan(&e, "p", &plan), g::revise_plan(&e, "p", "r"), g::approve_plan(&e, "p", "pl"), g::estimate(&e, "p"), g::build(&e, "p"), g::version(&e, "v"), g::version_action(&e, "v", "cancel"));
        let _ = (g::fix(&e, "v", &["f".to_string()], "n"), g::fix(&e, "v", &[], ""), g::export_version(&e, "v"), g::events(&e, "p"), g::ideas(&e), g::add_idea(&e, "s", "b"), g::delete_idea(&e, "i"));
        let _ = (g::run_idea(&e, Some("i")), g::run_idea(&e, None), g::facts(&e, "p"), g::add_fact(&e, "p", "c", "v", "u"), g::add_fact(&e, "p", "c", "", "u"), g::delete_fact(&e, "f"), g::verify_facts(&e, "p"));
        let r = json!({"id": "r"});
        let _ = (g::recipes(&e), g::validate_recipe(&e, &r), g::copy_recipe(&e, "a", "b", "n"), g::save_recipe(&e, "r", &r), g::delete_recipe(&e, "r"), g::import_recipe(&e, &r), g::export_recipe(&e, "r"));
        let _ = (g::kit_parts(&e), g::remove_kit_part(&e, "a b"), g::steps(&e), g::delete_asset(&e, "a1"));
        let file = std::env::temp_dir().join(format!("sorot-up-{}.png", std::process::id()));
        std::fs::write(&file, b"PNGDATA").unwrap();
        let _ = g::upload_asset(&e, "p", &file, "logo");
        let _ = std::fs::remove_file(&file);
        let got: Vec<_> = seen.lock().unwrap().iter().map(|(m, p, _)| format!("{m} {p}")).collect();
        let want = [
            "GET /api/generate/projects ",
            r#"POST /api/generate/projects {"brief":"b","format":"9:16","language":"id","targetSec":30}"#,
            "GET /api/generate/projects/p ",
            "DELETE /api/generate/projects/p ",
            "POST /api/generate/projects/p/retry {}",
            r#"POST /api/generate/projects/p/storylines {"note":"n"}"#,
            r#"POST /api/generate/projects/p/storylines/1/pick {"note":"n"}"#,
            r#"PUT /api/generate/projects/p/plan {"plan":{"assumptions":[],"message":"","shots":[],"title":"t"}}"#,
            r#"POST /api/generate/projects/p/plan/revise {"request":"r"}"#,
            r#"POST /api/generate/projects/p/plan/approve {"planId":"pl"}"#,
            "GET /api/generate/projects/p/estimate ",
            "POST /api/generate/projects/p/versions {}",
            "GET /api/generate/versions/v ",
            "POST /api/generate/versions/v/cancel {}",
            r#"POST /api/generate/versions/v/fix {"findingIds":["f"],"note":"n"}"#,
            "POST /api/generate/versions/v/fix {}",
            "POST /api/generate/versions/v/export {}",
            "GET /api/generate/projects/p/events?limit=100 ",
            "GET /api/generate/ideas ",
            r#"POST /api/generate/ideas {"brief":"b","slug":"s"}"#,
            "DELETE /api/generate/ideas/i ",
            r#"POST /api/generate/run {"ideaId":"i"}"#,
            "POST /api/generate/run {}",
            "GET /api/generate/projects/p/facts ",
            r#"POST /api/generate/projects/p/facts {"claim":"c","sourceUrl":"u","value":"v"}"#,
            r#"POST /api/generate/projects/p/facts {"claim":"c","sourceUrl":"u"}"#,
            "DELETE /api/generate/facts/f ",
            "POST /api/generate/projects/p/facts/verify {}",
            "GET /api/generate/recipes ",
            r#"POST /api/generate/recipes/validate {"recipe":{"id":"r"}}"#,
            r#"POST /api/generate/recipes {"fromId":"a","id":"b","name":"n"}"#,
            r#"PUT /api/generate/recipes/r {"recipe":{"id":"r"}}"#,
            "DELETE /api/generate/recipes/r ",
            r#"POST /api/generate/recipes/import {"recipe":{"id":"r"}}"#,
            "GET /api/generate/recipes/r/export ",
            "GET /api/generate/kit ",
            "DELETE /api/generate/kit/a%20b ",
            "GET /api/generate/steps ",
            "DELETE /api/generate/assets/a1 ",
        ];
        assert_eq!(&got[..want.len()], want);
        let up = got.last().unwrap();
        assert!(up.starts_with("POST /api/generate/projects/p/assets --sorot-") && up.contains("name=\"kind\"

logo") && up.contains("filename=\"sorot-up-") && up.contains("PNGDATA"), "{up}");
    }

    /// The settings, publish, learning and discover routes: method, path and body of each.
    #[test]
    fn panel_routes_send_their_requests() {
        let (base, seen) = stub(200, r#"{"status":"ok","data":{"posts":[],"post":{"id":"p","clipId":"c","status":"X"},"results":[],"videos":[],"started":[],"failed":[]}}"#);
        let e = HttpEngine::new(base, None);
        let _ = e.update_settings("llm", &json!({"model": "m"}));
        let _ = (e.test_connection("jev"), e.generate_status(), e.generate_models(), e.calibrate(), e.pin_model("a/b", Some("free")), e.pin_model("c", None));
        let _ = (e.social_accounts(), e.publish_draft("c1", &["a1".to_string()]), e.publish("c1", &json!({"targets": []})), e.clip_posts("c1"), e.retry_post("p1"), e.cancel_post("p1"));
        let _ = (e.feedback(), e.weights(), e.train(), e.submit_feedback("c1", &Metrics { views: 3, posted_at: "2026-11-14T19:00:00Z".into(), ..Metrics::default() }));
        let _ = (e.discover("search", "q"), e.discover("channel", "u"), e.discover("trending", ""), e.candidates(None), e.candidates(Some("NEW")));
        let _ = (e.set_candidate_status("d1", "SKIPPED"), e.queue_candidates(&["d1".to_string()]), e.drain_queue(), e.discover_auto("g"), e.auto_status("r1"));
        let got: Vec<_> = seen.lock().unwrap().iter().map(|(m, p, _)| format!("{m} {p}")).collect();
        let want = [
            r#"PUT /api/settings/llm {"model":"m"}"#,
            "POST /api/settings/jev/test {}",
            "GET /api/generate/status ",
            "GET /api/generate/models ",
            "POST /api/generate/models/calibrate {}",
            r#"PUT /api/generate/models/a%2Fb/level {"level":"free"}"#,
            r#"PUT /api/generate/models/c/level {"level":null}"#,
            "GET /api/social/accounts ",
            r#"POST /api/clips/c1/publish/draft {"accountIds":["a1"]}"#,
            r#"POST /api/clips/c1/publish {"targets":[]}"#,
            "GET /api/clips/c1/posts ",
            "POST /api/social/posts/p1/retry {}",
            "POST /api/social/posts/p1/cancel {}",
            "GET /api/feedback ",
            "GET /api/feedback/weights ",
            "POST /api/feedback/train {}",
            r#"POST /api/clips/c1/feedback {"comments":0,"likes":0,"postedAt":"2026-11-14T19:00:00Z","saves":0,"shares":0,"views":3}"#,
            r#"POST /api/discover/search {"query":"q"}"#,
            r#"POST /api/discover/channel {"channelUrl":"u"}"#,
            "POST /api/discover/trending {}",
            "GET /api/discover/candidates ",
            "GET /api/discover/candidates?status=NEW ",
            r#"POST /api/discover/candidates/d1/status {"status":"SKIPPED"}"#,
            r#"POST /api/discover/queue {"ids":["d1"]}"#,
            "POST /api/discover/queue/drain {}",
            r#"POST /api/discover/auto {"goal":"g"}"#,
            "GET /api/discover/auto/r1 ",
        ];
        assert_eq!(got, want);
    }
}
