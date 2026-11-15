//! `Engine` over HTTP: the engine's own API, a bearer token, the `{status, data|error}` envelope.

use std::time::Duration;

use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use sorot_desktop_core::model::*;

use std::path::Path;

use sorot_desktop_core::clips::Options;

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
        let sent = if method == "GET" {
            let mut req = self.agent.get(&url);
            if let Some(a) = &auth {
                req = req.header("Authorization", a);
            }
            req.call()
        } else {
            let mut req = self.agent.post(&url).header("Content-Type", "application/json");
            if let Some(a) = &auth {
                req = req.header("Authorization", a);
            }
            req.send(body.unwrap_or(json!({})).to_string())
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
}
