//! `Engine` over HTTP: the engine's own API, a bearer token, the `{status, data|error}` envelope.

use std::time::Duration;

use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use sorot_desktop_core::model::*;

use super::{Engine, EngineError, Result};

fn malformed(e: serde_json::Error) -> EngineError {
    EngineError::Malformed(e.to_string())
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
            req.send(body.unwrap_or_else(|| json!({})).to_string())
        };
        let mut resp = sent.map_err(|e| EngineError::Network(e.to_string()))?;
        let status = resp.status().as_u16();
        let text = resp.body_mut().read_to_string().map_err(|e| EngineError::Network(e.to_string()))?;
        match status {
            401 => Err(EngineError::Unauthorized),
            _ => Ok((status, text)),
        }
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
    fn import_url(&self, url: &str) -> Result<Imported> {
        self.post("/api/import", json!({ "url": url }))
    }
    fn process(&self, video_id: &str) -> Result<JobRef> {
        self.post("/api/process", json!({ "videoId": video_id }))
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
            (507, r#"{"status":"error","error":"not enough disk space"}"#, Err(api(507, "not enough disk space"))),
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

    #[test]
    fn every_route_sends_its_request_with_the_token() {
        let (base, seen) = stub(200, r#"{"status":"ok","data":{"healthy":true,"items":[],"videos":[],"jobs":[],"clips":[],"taskId":"t","videoId":"v","sourceType":"YOUTUBE","jobId":"j","status":"QUEUED"}}"#);
        let e = HttpEngine::new(format!("{base}/"), Some("tok".into()));
        let _ = (e.health(), e.readiness(), e.fix_readiness("ffmpeg"), e.videos(), e.jobs(), e.clips("v1"));
        let _ = (e.import_url("https://youtu.be/x"), e.process("v1"), e.cancel_job("j1"), e.retry_job("j1"));
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
            r#"POST /api/process {"videoId":"v1"} Bearer tok"#,
            "POST /api/jobs/j1/cancel {} Bearer tok",
            "POST /api/jobs/j1/retry {} Bearer tok",
            "GET /api/settings  Bearer tok",
            "GET /api/jobs/j1  Bearer tok",
        ];
        assert_eq!(got, want);
    }
}
