//! L2: the settings, publish, learning and discover screens on Rune's headless `Runtime`, against
//! `FakeEngine`. Each test checks a screen's wiring (control, engine call, what shows after). The
//! rules those screens show are proved in `desktop/core` and are not asserted again here.

use std::sync::Arc;

use rune::{Cx, El, Env, Key, KeyEvent, Mods, Runtime};
use sorot_desktop::engine::fake::FakeEngine;
use sorot_desktop::engine::{Engine, EngineError};
use sorot_desktop::screens::panels::{Host, Page, Panels, Work};
use sorot_desktop::screens::settings::{connections, generate};
use sorot_desktop::screens::{discover, feedback, learning, publish};

/// A stand-in for the app: it holds the panels, runs engine work inline, and shows one screen.
struct Lab {
    panels: Panels,
    engine: Arc<FakeEngine>,
    screen: fn(&Lab) -> El,
    /// Addresses the screen sent to the browser.
    opened: Vec<String>,
    /// The accounts Publish remembers.
    kept: Vec<String>,
}

impl Host for Lab {
    fn panels(&self) -> &Panels {
        &self.panels
    }
    fn panels_mut(&mut self) -> &mut Panels {
        &mut self.panels
    }
    fn dark(&self) -> bool {
        true
    }
    fn engine(&self) -> Option<Arc<dyn Engine>> {
        Some(self.engine.clone())
    }
    fn run(&mut self, work: Work) {
        let apply = work(self.engine.as_ref());
        apply(&mut self.panels);
    }
    fn remembered(&self) -> Vec<String> {
        self.kept.clone()
    }
    fn remember(&mut self, ids: &[String]) {
        self.kept = ids.to_vec();
    }
    fn open_url(&mut self, url: &str) -> Result<(), String> {
        self.opened.push(url.into());
        Ok(())
    }
    fn show(&mut self, _: Page) {}
}

fn show(l: &Lab, _: &mut Cx<Lab>) -> El {
    (l.screen)(l)
}

/// The screen on a blank engine plus the `files` (route, envelope) it should answer with.
fn lab(screen: fn(&Lab) -> El, files: &[(&str, &str)]) -> (Runtime<Lab>, Arc<FakeEngine>) {
    let engine = Arc::new(FakeEngine::blank());
    for (route, body) in files {
        engine.serve(route, body);
    }
    let mut rt = Runtime::new(Lab { panels: Panels::default(), engine: engine.clone(), screen, opened: vec![], kept: vec![] }, show, (1100.0, 6000.0), Env { system_dark: true, scale: 1.0 });
    rt.frame(0.0);
    (rt, engine)
}

fn click(rt: &mut Runtime<Lab>, key: &str) {
    let (x, y) = rt.find(key).unwrap_or_else(|| panic!("no element {key}"));
    rt.pointer_move(x, y);
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(1.0 / 60.0);
}

fn type_into(rt: &mut Runtime<Lab>, key: &str, s: &str) {
    click(rt, key);
    rt.key(KeyEvent { key: Key::Text(s.into()), mods: Mods::default() });
    rt.frame(1.0 / 60.0);
}

/// Fills the day, month, year, hour and minute boxes under `key`.
fn type_date(rt: &mut Runtime<Lab>, key: &str, parts: [&str; 5]) {
    for (name, v) in ["day", "month", "year", "hour", "minute"].into_iter().zip(parts) {
        type_into(rt, &format!("{key}/{name}"), v);
    }
}

fn has(rt: &Runtime<Lab>, key: &str) -> bool {
    rt.find(key).is_some()
}

/// Opens through the screen's own `open`, then draws.
fn open(rt: &mut Runtime<Lab>, f: impl FnOnce(&mut Lab)) {
    rt.update(|l, _| f(l));
    rt.frame(1.0 / 60.0);
}

fn calls(e: &FakeEngine, prefix: &str) -> Vec<String> {
    e.calls().into_iter().filter(|c| c.starts_with(prefix)).collect()
}

fn ok(data: &str) -> String {
    format!(r#"{{"status":"ok","data":{data}}}"#)
}

fn settings_json(saved: &str) -> String {
    ok(&format!(
        r#"{{"llm":{{"active":true,"enabled":true,"saved":{saved},"apiKey":"••••abcd","apiKeySet":true,"baseUrl":"https://llm.example/v1","model":"m1","director":false,"genMaxTokens":32000}},
        "jev":{{"active":false,"enabled":true,"saved":[],"apiKey":"","apiKeySet":false,"url":"https://jev.example","model":"jev-1","director":true}},
        "tebar":{{"active":false,"enabled":true,"saved":[],"apiKey":"","apiKeySet":false,"baseUrl":"","profiles":[{{"id":"p1","name":"Main"}}]}}}}"#
    ))
}

fn connections_lab(saved: &str) -> (Runtime<Lab>, Arc<FakeEngine>) {
    let (mut rt, e) = lab(connections::view, &[("settings", &settings_json(saved))]);
    open(&mut rt, connections::open);
    (rt, e)
}

#[test]
fn every_connection_action_is_one_engine_call_and_shows_its_answer() {
    // (steps: control or (field, typed text), the engine call it ends in, what shows after)
    type Step = (&'static str, Option<&'static str>);
    let rows: [(&[Step], &str, &str); 6] = [
        (&[("conn/llm/model", Some("-b")), ("conn/llm/save", None)], r#"update_settings(llm, {"model":"m1-b"})"#, "conn/llm/notice"),
        (&[("conn/llm/key", Some("sk-new")), ("conn/llm/save", None)], r#"update_settings(llm, {"apiKey":"sk-new"})"#, "conn/llm/notice"),
        (&[("conn/jev/endpoint", Some("/v2")), ("conn/jev/save", None)], r#"update_settings(jev, {"url":"https://jev.example/v2"})"#, "conn/jev/notice"),
        (&[("conn/llm/director", None)], r#"update_settings(llm, {"director":true})"#, "conn/llm/notice"),
        (&[("conn/llm/test", None)], "test_connection(llm)", "conn/llm/result"),
        (&[("conn/llm/env", None)], r#"update_settings(llm, {"baseUrl":null,"model":null})"#, "conn/llm/notice"),
    ];
    for (steps, call, shows) in rows {
        let (mut rt, e) = connections_lab(r#"["baseUrl","model"]"#);
        for (key, typed) in steps {
            match typed {
                Some(text) => type_into(&mut rt, key, text),
                None => click(&mut rt, key),
            }
        }
        assert_eq!(calls(&e, "update_settings").into_iter().chain(calls(&e, "test_connection")).collect::<Vec<_>>(), [call], "{steps:?}");
        assert!(has(&rt, shows), "{shows}");
    }
}

#[test]
fn a_failed_test_a_failed_save_and_a_failed_read_say_why_and_what_next() {
    let (mut rt, e) = connections_lab("[]");
    e.serve("test", r#"{"status":"ok","data":{"ok":false,"ms":0,"error":"401 from the endpoint"}}"#);
    click(&mut rt, "conn/llm/test");
    assert!(has(&rt, "conn/llm/result") && !has(&rt, "conn/llm/notice"));
    e.fail_once("update_settings", EngineError::Api { status: 400, message: "llm has no setting".into() });
    type_into(&mut rt, "conn/llm/model", "x");
    click(&mut rt, "conn/llm/save");
    assert!(has(&rt, "conn/llm/error"));
    e.fail_once("test_connection", EngineError::Network("down".into()));
    click(&mut rt, "conn/jev/test");
    assert!(has(&rt, "conn/jev/result"));

    let (mut rt, e) = connections_lab("[]");
    e.fail_once("settings", EngineError::Network("down".into()));
    open(&mut rt, connections::open);
    assert!(has(&rt, "conn/failed"));
    click(&mut rt, "conn/retry");
    assert!(has(&rt, "conn/llm/card"), "Try again reads the settings again");
}

fn generate_files() -> Vec<(&'static str, String)> {
    vec![
        ("settings", settings_json("[]")),
        ("generate-status", ok(r#"{"available":false,"reasons":["Generate needs an AI connection"],"hyperframes":{"ok":true},"llm":{"configured":false},"jev":{"configured":false},"compute":"cpu"}"#)),
        ("generate-models", ok(r#"{"current":"qwen","models":[{"model":"qwen","pin":null,"auto":"free","proven":"compose","records":[{"level":"free","asked":4,"firstPass":2,"repaired":1,"dropped":1,"malformed":0}]}],"calibration":null}"#)),
    ]
}

fn generate_lab() -> (Runtime<Lab>, Arc<FakeEngine>) {
    let files = generate_files();
    let refs: Vec<(&str, &str)> = files.iter().map(|(r, b)| (*r, b.as_str())).collect();
    let (mut rt, e) = lab(generate::view, &refs);
    open(&mut rt, generate::open);
    (rt, e)
}

#[test]
fn every_generate_setting_action_is_one_engine_call() {
    let rows: [(&str, Option<&str>, &str); 4] = [
        ("gen/calibrate", None, "calibrate"),
        ("gen/model/0/compose", None, "pin_model(qwen, compose)"),
        ("gen/model/0/auto", None, "pin_model(qwen, auto)"),
        ("gen/field/genMaxTokens", Some("0"), r#"update_settings(llm, {"genMaxTokens":"320000"})"#),
    ];
    for (key, typed, call) in rows {
        let (mut rt, e) = generate_lab();
        if let Some(t) = typed {
            type_into(&mut rt, key, t);
            click(&mut rt, "gen/save");
        } else {
            click(&mut rt, key);
        }
        let seen: Vec<String> = e.calls().into_iter().filter(|c| c.starts_with("calibrate") || c.starts_with("pin_model") || c.starts_with("update_settings")).collect();
        assert_eq!(seen, [call], "{key}");
    }
    let (rt, _) = generate_lab();
    assert!(has(&rt, "gen/unavailable") && has(&rt, "gen/reason/0"), "why Generate cannot run is named");
}

#[test]
fn calibrating_follows_the_engine_until_it_is_done() {
    let (mut rt, e) = generate_lab();
    e.serve("generate-models", &ok(r#"{"current":"qwen","models":[],"calibration":{"model":"qwen","done":false}}"#));
    click(&mut rt, "gen/calibrate");
    assert!(rt.state.panels.generate.calibrating() && has(&rt, "gen/calibration"));
    e.serve("generate-models", &ok(r#"{"current":"qwen","models":[],"calibration":{"model":"qwen","done":true,"error":"timed out"}}"#));
    rt.update(|l, _| generate::poll(l));
    rt.update(|l, _| generate::poll(l));
    rt.frame(1.0 / 60.0);
    assert!(!rt.state.panels.generate.calibrating());
    assert_eq!(calls(&e, "generate_models").len(), 3, "the poll stops once the run is done");
}

#[test]
fn a_generate_page_that_cannot_load_or_save_says_so() {
    let (mut rt, e) = generate_lab();
    e.fail_once("pin_model", EngineError::Api { status: 400, message: "no such model".into() });
    click(&mut rt, "gen/model/0/free");
    assert!(has(&rt, "gen/error"));
    let (mut rt, e) = generate_lab();
    e.fail_once("generate_models", EngineError::Network("down".into()));
    open(&mut rt, generate::open);
    assert!(has(&rt, "gen/failed"));
    click(&mut rt, "gen/retry");
    assert!(has(&rt, "gen/status"));
}

fn accounts_json() -> String {
    ok(r#"{"enabled":true,"accounts":[
        {"id":"tt","platform":"tiktok","name":"@a","profileId":"w1","profileName":"Main","supported":true},
        {"id":"yt","platform":"youtube","name":"Channel","profileId":"w1","profileName":"Main","supported":true},
        {"id":"ig","platform":"instagram","name":"@b","profileId":"w2","profileName":"Other","supported":true}]}"#)
}

fn draft_json(gate: &str) -> String {
    ok(&format!(
        r#"{{"clip":{{"id":"c1","title":"T","gateVerdict":"{gate}","gateReasons":["slow start"]}},"copyCheckedBy":"Jev","targets":[
        {{"accountId":"tt","platform":"tiktok","name":"@a","content":"caption","copyBy":"llm","needs":{{"tiktokPrivacy":["PUBLIC","SELF_ONLY"]}},"warnings":["shortened"],"blockers":[]}},
        {{"accountId":"yt","platform":"youtube","name":"Channel","content":"yt caption","title":"Suggested","copyBy":"template","needs":{{"madeForKids":true}},"warnings":[],"blockers":[]}}]}}"#
    ))
}

fn publish_lab(gate: &str, posts: &str) -> (Runtime<Lab>, Arc<FakeEngine>) {
    let post = ok(r#"{"post":{"id":"p9","clipId":"c1","status":"PUBLISHED"}}"#);
    let (mut rt, e) = lab(publish::view, &[("social-accounts", &accounts_json()), ("publish-draft", &draft_json(gate)), ("publish", &post), ("posts", &ok(posts))]);
    open(&mut rt, |l| publish::open(l, "c1", "My clip"));
    (rt, e)
}

/// Post is on only once the owner-made choices are in; the post call carries only one workspace.
#[test]
fn post_follows_the_choices_and_carries_one_workspace() {
    let (mut rt, e) = publish_lab("PASS", r#"{"posts":[]}"#);
    click(&mut rt, "publish/account/tt");
    click(&mut rt, "publish/account/ig");
    click(&mut rt, "publish/account/yt");
    assert_eq!(rt.state.panels.publish.selected, ["tt", "yt"], "the other workspace stays out");
    click(&mut rt, "publish/write");
    assert_eq!(calls(&e, "publish_draft"), ["publish_draft(c1, tt,yt)"]);
    let steps: [(&str, bool); 5] = [("", false), ("publish/0/privacy/1", false), ("publish/tab/1", false), ("publish/1/kids-no", false), ("publish/1/title", true)];
    let mut sent = vec![];
    for (key, typed) in steps {
        match (key, typed) {
            ("", _) => {}
            (k, true) => type_into(&mut rt, k, "Judul"),
            (k, false) => click(&mut rt, k),
        }
        click(&mut rt, "publish/post");
        sent.push(calls(&e, "publish(").len());
    }
    assert_eq!(sent, [0, 0, 0, 0, 1], "Post works only after the last choice");
    let body = calls(&e, "publish(").remove(0);
    assert!(body.contains(r#""accountId":"tt""#) && body.contains(r#""privacyLevel":"SELF_ONLY""#) && body.contains(r#""title":"Judul""#) && body.contains(r#""madeForKids":false"#), "{body}");
    assert!(!body.contains(r#""accountId":"ig""#));
    assert_eq!(rt.state.panels.publish.posts[0].id, "p9");
    assert!(has(&rt, "publish/post/p9/row") && !has(&rt, "publish/post"));
}

#[test]
fn a_review_clip_needs_the_check_and_failed_and_scheduled_posts_can_be_retried_or_cancelled() {
    let posts = r#"{"posts":[{"id":"f1","clipId":"c1","status":"FAILED","targets":"[{\"platform\":\"tiktok\",\"status\":\"FAILED\",\"errorCode\":\"E1\"}]","errorMessage":"nope"},
        {"id":"s1","clipId":"c1","status":"SCHEDULED","scheduledAt":"2026-12-01T10:00:00Z"}]}"#;
    let (mut rt, e) = publish_lab("REVIEW", posts);
    assert!(has(&rt, "publish/post/f1/target/0") && has(&rt, "publish/post/f1/error"));
    e.serve("post", &ok(r#"{"post":{"id":"f1","clipId":"c1","status":"QUEUED"}}"#));
    click(&mut rt, "publish/post/f1/retry");
    click(&mut rt, "publish/post/s1/cancel");
    assert_eq!((calls(&e, "retry_post"), calls(&e, "cancel_post")), (vec!["retry_post(f1)".to_string()], vec!["cancel_post(s1)".to_string()]));

    click(&mut rt, "publish/account/tt");
    click(&mut rt, "publish/write");
    click(&mut rt, "publish/0/privacy/0");
    click(&mut rt, "publish/tab/1");
    click(&mut rt, "publish/1/kids-yes");
    type_into(&mut rt, "publish/1/title", "Judul");
    assert!(!rt.state.panels.publish.post_enabled(), "the gate asks for a check first");
    click(&mut rt, "publish/confirm");
    assert!(rt.state.panels.publish.post_enabled());
}

#[test]
fn a_schedule_is_sent_as_utc_and_a_bad_one_names_the_format_and_the_gate_blocker_is_not_listed() {
    let draft = draft_json("REVIEW").replace(r#""blockers":[]}]"#, r#""blockers":["Held back by the quality gate: slow start"]}]"#);
    let (mut rt, e) = publish_lab("REVIEW", r#"{"posts":[]}"#);
    e.serve("publish-draft", &draft);
    click(&mut rt, "publish/account/tt");
    click(&mut rt, "publish/account/yt");
    click(&mut rt, "publish/write");
    assert!(!has(&rt, "publish/1/blocker/0"), "the confirm toggle resolves the gate, so it is not a blocker line");
    click(&mut rt, "publish/0/privacy/0");
    click(&mut rt, "publish/tab/1");
    click(&mut rt, "publish/1/kids-no");
    type_into(&mut rt, "publish/1/title", "Judul");
    click(&mut rt, "publish/confirm");
    type_date(&mut rt, "publish/schedule", ["31", "2", "2027", "10", "0"]);
    click(&mut rt, "publish/post");
    assert!(has(&rt, "publish/error") && calls(&e, "publish(").is_empty(), "a day the month does not have sends nothing");
    rt.update(|l, _| l.panels.publish.schedule.clear());
    type_date(&mut rt, "publish/schedule", ["14", "11", "2026", "19", "0"]);
    click(&mut rt, "publish/post");
    assert!(calls(&e, "publish(")[0].contains(r#""scheduledAt":"2026-11-14T19:00:00Z""#));
}

#[test]
fn publish_says_what_is_missing_when_tebar_has_nothing_to_post_to() {
    let rows: [(&str, &str); 3] = [
        (r#"{"enabled":false,"accounts":[]}"#, "publish/off"),
        (r#"{"enabled":true,"accounts":[]}"#, "publish/no-accounts"),
        (r#"{"enabled":true,"accounts":[{"id":"x","platform":"threads","name":"@t","supported":false}]}"#, "publish/account/x"),
    ];
    for (accounts, shows) in rows {
        let (mut rt, e) = lab(publish::view, &[("social-accounts", &ok(accounts))]);
        open(&mut rt, |l| publish::open(l, "c1", ""));
        assert!(has(&rt, shows), "{shows}");
        if has(&rt, "publish/account/x") {
            click(&mut rt, "publish/account/x");
        }
        assert!(rt.state.panels.publish.selected.is_empty() && calls(&e, "publish_draft").is_empty());
    }
}

#[test]
fn publish_errors_are_shown_with_a_next_step() {
    let (mut rt, e) = publish_lab("PASS", r#"{"posts":[]}"#);
    e.fail_once("publish_draft", EngineError::Api { status: 400, message: "Tebar is down".into() });
    click(&mut rt, "publish/account/tt");
    click(&mut rt, "publish/write");
    assert!(has(&rt, "publish/error"));
    let (mut rt, e) = lab(publish::view, &[]);
    e.fail_once("social_accounts", EngineError::Network("down".into()));
    open(&mut rt, |l| publish::open(l, "c1", "T"));
    assert!(has(&rt, "publish/failed"));
}

fn learning_lab(results: &str, scores: u32) -> (Runtime<Lab>, Arc<FakeEngine>) {
    let videos = ok(r#"{"videos":[{"id":"v1","sourceType":"YOUTUBE","title":"Video","createdAt":""}]}"#);
    let clips = ok(r#"{"clips":[{"id":"c1","videoId":"v1","rankPos":1,"score":0.8,"tier":"PRIMARY","startTime":0,"endTime":30,"durationSec":30,"title":"Best","renderStatus":"DONE","exportStatus":"DONE","exportPath":"/x.mp4","createdAt":""}]}"#);
    let weights = ok(&format!(r#"{{"version":2,"trained_on":{scores},"total_feedback":{scores},"with_actual_scores":{scores}}}"#));
    let (mut rt, e) = lab(learning::view, &[("feedback", &ok(results)), ("weights", &weights), ("videos", &videos), ("clips", &clips)]);
    open(&mut rt, learning::open);
    (rt, e)
}

#[test]
fn learning_shows_only_what_the_engine_has_and_retrains_on_request() {
    // no feedback: empty state, Retrain off (a press does nothing)
    let (mut rt, e) = learning_lab(r#"{"results":[]}"#, 0);
    assert!(has(&rt, "learning/results/empty") && has(&rt, "learning/more") && has(&rt, "learning/waiting/c1"));
    click(&mut rt, "learning/train");
    assert!(calls(&e, "train").is_empty());

    // feedback: rows and Retrain
    let rows = r#"{"results":[{"clipId":"c1","title":"Best","viralScore":0.42,"views":12345,"postedAt":"2026-11-01T10:00:00Z"},{"clipId":"c2","views":9}]}"#;
    let (mut rt, e) = learning_lab(rows, 5);
    assert!(has(&rt, "learning/result/c1") && has(&rt, "learning/result/c2") && !has(&rt, "learning/waiting/c1"));
    click(&mut rt, "learning/train");
    assert_eq!(calls(&e, "train"), ["train"]);
    assert!(has(&rt, "learning/trained"));

    // train error
    e.fail_once("train", EngineError::Api { status: 400, message: "not enough results".into() });
    click(&mut rt, "learning/train");
    assert!(has(&rt, "learning/error") && !has(&rt, "learning/trained"));
}

#[test]
fn learning_that_cannot_load_offers_try_again() {
    let (mut rt, e) = learning_lab(r#"{"results":[]}"#, 0);
    e.fail_once("feedback", EngineError::Network("down".into()));
    open(&mut rt, learning::open);
    assert!(has(&rt, "learning/failed"));
    click(&mut rt, "learning/retry");
    assert!(has(&rt, "learning/teach"));
}

/// 2026-11-15 00:00 UTC: "now" in the sheet tests.
const NOW: i64 = 1_794_700_800;

#[test]
fn the_results_sheet_needs_a_real_past_post_time_and_sends_the_numbers() {
    let (mut rt, e) = learning_lab(r#"{"results":[]}"#, 0);
    click(&mut rt, "learning/log/c1");
    // each row: the five time boxes, the views typed, and `Some(call)` when it reaches the engine
    type Row = ([&'static str; 5], &'static str, Option<&'static str>);
    let rows: [Row; 5] = [
        (["", "", "", "", ""], "", None),
        (["31", "2", "2026", "19", "0"], "", None),
        (["1", "12", "2026", "19", "0"], "", None),
        (["14", "11", "2026", "19", "0"], "12x", None),
        (["14", "11", "2026", "19", "0"], "120", Some("submit_feedback(c1, 120 views, posted 2026-11-14T19:00:00Z)")),
    ];
    for (boxes, views, call) in rows {
        open(&mut rt, |l| feedback::open(l, "c1", "Best"));
        rt.update(|l, _| l.panels.feedback.posted.now = NOW);
        if !boxes[0].is_empty() {
            type_date(&mut rt, "feedback/posted", boxes);
        }
        if !views.is_empty() {
            type_into(&mut rt, "feedback/views", views);
        }
        click(&mut rt, "feedback/submit");
        match call {
            None => assert!(has(&rt, "feedback/error") && calls(&e, "submit_feedback").is_empty(), "{boxes:?}"),
            Some(c) => assert_eq!(calls(&e, "submit_feedback"), [c]),
        }
    }
    assert!(has(&rt, "feedback/saved"));
    click(&mut rt, "feedback/close");
    assert!(!has(&rt, "feedback/sheet"));
}

#[test]
fn a_refused_result_stays_on_the_sheet_and_now_fills_the_boxes() {
    let (mut rt, e) = learning_lab(r#"{"results":[]}"#, 0);
    click(&mut rt, "learning/log/c1");
    rt.update(|l, _| l.panels.feedback.posted.now = NOW);
    click(&mut rt, "feedback/posted/now");
    assert_eq!(rt.state.panels.feedback.posted.parse().map(|s| s.iso()), Ok("2026-11-15T00:00:00Z".to_string()));
    rt.update(|l, _| l.panels.feedback.posted.now = NOW + 60);
    e.fail_once("submit_feedback", EngineError::Api { status: 400, message: "posted in the future".into() });
    click(&mut rt, "feedback/submit");
    assert!(has(&rt, "feedback/error"));
}

fn candidates_json() -> String {
    ok(r#"{"videos":[
        {"id":"d1","title":"Podcast","url":"https://youtu.be/a","duration":754,"channel":"Chan","viewCount":1200,"relevanceScore":0.8,"status":"NEW","why":["strong moments"]},
        {"id":"d2","title":"Queued one","url":"https://youtu.be/b","duration":60,"channel":"Chan","relevanceScore":0.5,"status":"QUEUED"},
        {"id":"d3","title":"Skipped one","url":"https://youtu.be/c","duration":60,"channel":"Chan","relevanceScore":0.5,"status":"SKIPPED"}]}"#)
}

fn discover_lab() -> (Runtime<Lab>, Arc<FakeEngine>) {
    let (mut rt, e) = lab(discover::view, &[("candidates", &candidates_json()), ("discover", &candidates_json())]);
    open(&mut rt, discover::open);
    (rt, e)
}

#[test]
fn every_discover_action_is_one_engine_call() {
    type Step = (&'static str, Option<&'static str>);
    let rows: [(&[Step], &str); 9] = [
        (&[("discover/mode/search", None), ("discover/query", Some("hustle")), ("discover/run", None)], "discover(search, hustle)"),
        (&[("discover/mode/trending", None), ("discover/run", None)], "discover(trending, )"),
        (&[("discover/mode/channel", None), ("discover/channel", Some("https://youtube.com/@x")), ("discover/run", None)], "discover(channel, https://youtube.com/@x)"),
        (&[("discover/goal", Some("funny")), ("discover/run", None)], "discover_auto(funny)"),
        (&[("discover/c/d1/pick", None), ("discover/queue", None)], "queue_candidates(d1)"),
        (&[("discover/drain", None)], "drain_queue"),
        (&[("discover/c/d1/status", None)], "set_candidate_status(d1, SKIPPED)"),
        (&[("discover/c/d3/status", None)], "set_candidate_status(d3, NEW)"),
        (&[("discover/filter/queued", None)], "candidates(QUEUED)"),
    ];
    for (steps, call) in rows {
        let (mut rt, e) = discover_lab();
        let before = e.calls().len();
        for (key, typed) in steps {
            match typed {
                Some(t) => type_into(&mut rt, key, t),
                None => click(&mut rt, key),
            }
        }
        let after = e.calls().split_off(before);
        assert!(after.contains(&call.to_string()), "{steps:?} -> {after:?}");
    }
}

#[test]
fn an_auto_run_is_followed_until_it_is_done_and_importing_a_candidate_goes_through_the_engine() {
    let (mut rt, e) = discover_lab();
    click(&mut rt, "discover/run");
    assert!(rt.state.panels.discover.running() && has(&rt, "discover/run-status"));
    e.serve("auto-done", &ok(r#"{"id":"run1","status":"DONE","count":2,"llmError":"timeout"}"#));
    rt.update(|l, _| discover::poll(l));
    rt.frame(1.0 / 60.0);
    assert!(!rt.state.panels.discover.running() && has(&rt, "discover/llm-error"));
    rt.update(|l, _| discover::poll(l));
    assert_eq!(calls(&e, "auto_status").len(), 1, "a finished run is not asked about again");

    click(&mut rt, "discover/c/d1/import");
    assert_eq!((calls(&e, "queue_candidates"), calls(&e, "drain_queue")), (vec!["queue_candidates(d1)".to_string()], vec!["drain_queue".to_string()]));
    assert!(has(&rt, "discover/c/d1/import") && has(&rt, "discover/c/d3/status") && !has(&rt, "discover/c/d2/import") && !has(&rt, "discover/c/d2/status") && !has(&rt, "discover/c/d2/pick") && !has(&rt, "discover/c/d3/pick"), "actions only where the status allows them");
    assert!(has(&rt, "discover/notice"));
    e.fail_once("queue_candidates", EngineError::Api { status: 400, message: "private video".into() });
    click(&mut rt, "discover/c/d1/import");
    assert!(has(&rt, "discover/error"));
}

#[test]
fn discover_says_what_to_do_when_there_is_nothing_or_something_went_wrong() {
    let (mut rt, e) = lab(discover::view, &[]);
    open(&mut rt, discover::open);
    assert!(has(&rt, "discover/empty"));
    for mode in ["search", "channel"] {
        click(&mut rt, &format!("discover/mode/{mode}"));
        click(&mut rt, "discover/run");
        assert!(has(&rt, "discover/error") && calls(&e, "discover(").is_empty(), "{mode} with nothing typed asks nothing");
    }
    e.serve("auto", r#"{"status":"ok","data":{"id":"r","status":"FAILED","error":"no web search"}}"#);
    click(&mut rt, "discover/mode/auto");
    click(&mut rt, "discover/run");
    assert!(has(&rt, "discover/run-status"));
    e.fail_once("candidates", EngineError::Network("down".into()));
    open(&mut rt, discover::open);
    assert!(has(&rt, "discover/failed"));
    click(&mut rt, "discover/retry");
    assert!(has(&rt, "discover/find"));
}

#[test]
fn a_long_candidate_list_shows_twenty_until_asked_for_all() {
    let many: Vec<String> = (0..25).map(|i| format!(r#"{{"id":"d{i}","title":"V{i}","url":"u{i}","status":"NEW"}}"#)).collect();
    let (mut rt, _) = lab(discover::view, &[("candidates", &ok(&format!(r#"{{"videos":[{}]}}"#, many.join(","))))]);
    open(&mut rt, discover::open);
    assert!(has(&rt, "discover/c/d19/row") && !has(&rt, "discover/c/d20/row"));
    click(&mut rt, "discover/show-all");
    assert!(has(&rt, "discover/c/d24/row"));
    let (mut rt, e) = lab(discover::view, &[("candidates", &candidates_json()), ("drained", &ok(r#"{"started":[{}],"failed":[{"discoveredId":"d2","error":"private"}]}"#))]);
    open(&mut rt, discover::open);
    click(&mut rt, "discover/drain");
    assert!(has(&rt, "discover/notice"));
    e.fail_once("drain_queue", EngineError::Network("down".into()));
    click(&mut rt, "discover/drain");
    assert!(has(&rt, "discover/error"));
}

// ---- US5 parity follow-ups (T-17) -----------------------------------------------------------

fn kenari_settings(base: &str, active: bool) -> String {
    ok(&format!(
        r#"{{"llm":{{"active":{active},"enabled":true,"saved":[],"apiKey":"masked","apiKeySet":{active},"baseUrl":"{base}","model":"kenari/auto","director":false}},
        "jev":{{"active":false,"enabled":true,"saved":[],"apiKey":"","apiKeySet":false,"url":"","model":"","director":false}},
        "tebar":{{"active":false,"enabled":true,"saved":[],"apiKey":"","apiKeySet":false,"baseUrl":""}}}}"#
    ))
}

#[test]
fn kenari_is_picked_tried_and_only_then_saved_and_its_balance_shows_once_connected() {
    let models = ok(r#"{"models":[{"id":"kenari/auto","free":false},{"id":"qwen-free","free":true}]}"#);
    let (mut rt, e) = lab(connections::view, &[("settings", &kenari_settings("", false)), ("kenari-llm-models", &models)]);
    open(&mut rt, connections::open);
    assert!(has(&rt, "conn/llm/mode-kenari") && !has(&rt, "conn/llm/endpoint"), "nothing is chosen yet, so no fields");
    click(&mut rt, "conn/llm/mode-kenari");
    assert_eq!(calls(&e, "kenari_models"), ["kenari_models(llm)"]);
    assert!(has(&rt, "conn/llm/kenari/model/1"), "the catalogue follows kenari/auto");
    click(&mut rt, "conn/llm/kenari/model/1");
    click(&mut rt, "conn/llm/kenari/connect");
    assert!(calls(&e, "update_settings").is_empty(), "nothing is saved before the key was tried");
    type_into(&mut rt, "conn/llm/kenari/key", "kn-123");
    click(&mut rt, "conn/llm/kenari/probe");
    assert_eq!(calls(&e, "probe_llm"), ["probe_llm(qwen-free, kn-123)"]);
    click(&mut rt, "conn/llm/kenari/connect");
    let saved = calls(&e, "update_settings").remove(0);
    assert!(saved.contains(r#""baseUrl":"https://kenari.id/v1""#) && saved.contains(r#""model":"qwen-free""#) && saved.contains(r#""apiKey":"kn-123""#), "{saved}");

    // connected: the balance and quota are shown
    let account = ok(r#"{"account":{"plan":"Pro","windows":{"daily":{"budgetRp":1000,"remainingRp":400,"usedFrac":0.6,"resetsAt":""}},"balanceRp":12500,"usage":{"requests":3,"promptTokens":10,"completionTokens":20}}}"#);
    let (mut rt, e) = lab(connections::view, &[("settings", &kenari_settings("https://kenari.id/v1", true)), ("kenari-llm-models", &models), ("kenari-account", &account)]);
    open(&mut rt, connections::open);
    assert!(has(&rt, "conn/llm/kenari/account") && has(&rt, "conn/llm/kenari/balance"));
    assert_eq!(calls(&e, "kenari_account"), ["kenari_account"]);
}

fn generate_cards_settings(voice_base: &str) -> String {
    ok(&format!(
        r#"{{"llm":{{"active":true,"enabled":true,"saved":[],"apiKey":"","apiKeySet":false,"baseUrl":"https://llm.example/v1","model":"m1","director":false}},
        "jev":{{"active":false,"enabled":true,"saved":[],"apiKey":"","apiKeySet":false,"url":"","model":"","director":false}},
        "tebar":{{"active":false,"enabled":true,"saved":[],"apiKey":"","apiKeySet":false,"baseUrl":""}},
        "voice":{{"active":true,"enabled":true,"saved":[],"engine":"openai","engines":["elevenlabs","fish","openai","local"],"localAvailable":false,"baseUrl":"{voice_base}","model":"tts-1","apiKey":"masked","apiKeySet":true,"voices":{{"id":"alloy"}}}},
        "image":{{"active":false,"enabled":true,"saved":[],"baseUrl":"","model":"","apiKey":"","apiKeySet":false,"size":"1024x1792","style":""}},
        "commands":{{"active":true,"allowed":true,"commands":[{{"name":"brand-check","cmd":"python","args":["check.py"],"timeoutSec":60}}]}}}}"#
    ))
}

fn generate_cards_lab(voice_base: &str) -> (Runtime<Lab>, Arc<FakeEngine>) {
    let files = generate_files();
    let settings = generate_cards_settings(voice_base);
    let kenari_voices = ok(r#"{"models":[{"id":"tts-1","voices":["alloy","nova"]}]}"#);
    let mut refs: Vec<(&str, &str)> = files.iter().filter(|(r, _)| *r != "settings").map(|(r, b)| (*r, b.as_str())).collect();
    refs.push(("settings", &settings));
    refs.push(("kenari-voice-models", &kenari_voices));
    let (mut rt, e) = lab(generate::view, &refs);
    open(&mut rt, generate::open);
    (rt, e)
}

/// Voice, scene images and custom commands each save through the settings route with only what changed.
#[test]
fn the_voice_the_images_and_the_commands_each_save_only_what_changed() {
    type Step = (&'static str, Option<&'static str>);
    let rows: [(&[Step], &str); 6] = [
        (&[("gen/voice/engine/elevenlabs", None)], r#"update_settings(voice, {"engine":"elevenlabs"})"#),
        (&[("gen/voice/voice/id", Some("2")), ("gen/voice/save", None)], r#"update_settings(voice, {"voices":{"id":"alloy2"}})"#),
        (&[("gen/voice/enabled", None)], r#"update_settings(voice, {"enabled":false})"#),
        (&[("gen/image/mode-custom", None), ("gen/image/baseUrl", Some("https://img.example/v1")), ("gen/image/save", None)], r#"update_settings(image, {"baseUrl":"https://img.example/v1"})"#),
        (&[("gen/cmd/0/remove", None), ("gen/cmd/save", None)], r#"update_settings(commands, {"commands":[]})"#),
        (&[("gen/cmd/add", None), ("gen/cmd/1/name", Some("a-b")), ("gen/cmd/1/program", Some("py")), ("gen/cmd/save", None)], r#"update_settings(commands, {"commands":[{"args":["check.py"],"cmd":"python","name":"brand-check","timeoutSec":60},{"args":[],"cmd":"py","name":"a-b","timeoutSec":60}]})"#),
    ];
    for (steps, call) in rows {
        let (mut rt, e) = generate_cards_lab("https://tts.example");
        for (key, typed) in steps {
            match typed {
                Some(t) => type_into(&mut rt, key, t),
                None => click(&mut rt, key),
            }
            rt.frame(0.5);
        }
        assert_eq!(calls(&e, "update_settings"), [call], "{steps:?}");
    }
}

#[test]
fn kenari_voice_models_and_their_voices_are_picked_not_typed_and_a_test_shows_its_result() {
    let (mut rt, e) = generate_cards_lab("https://kenari.id/v1");
    assert_eq!(calls(&e, "kenari_voice_models"), ["kenari_voice_models"], "a voice already on Kenari reads its models on open");
    assert!(has(&rt, "gen/voice/kenari/model/0") && has(&rt, "gen/voice/voice/id/1") && !has(&rt, "gen/voice/base-url"));
    click(&mut rt, "gen/voice/voice/id/1");
    click(&mut rt, "gen/voice/save");
    assert_eq!(calls(&e, "update_settings"), [r#"update_settings(voice, {"voices":{"id":"nova"}})"#]);
    click(&mut rt, "gen/voice/test");
    click(&mut rt, "gen/image/mode-kenari");
    assert_eq!(calls(&e, "kenari_models"), ["kenari_models(image)"]);
    assert!(has(&rt, "gen/voice/result") && has(&rt, "gen/image/kenari/model/0"));
    // commands the install keeps off cannot be added
    let off = generate_cards_settings("x").replace(r#""allowed":true"#, r#""allowed":false"#);
    e.serve("settings", &off);
    open(&mut rt, generate::open);
    assert!(has(&rt, "gen/cmd/off"));
    click(&mut rt, "gen/cmd/add");
    assert_eq!(rt.state.panels.generate.commands.items.len(), 1);
}

#[test]
fn remembered_accounts_come_back_a_post_can_be_refreshed_and_its_link_opened() {
    let posts = r#"{"posts":[{"id":"p1","clipId":"c1","status":"PUBLISHED","targets":"[{\"platform\":\"tiktok\",\"status\":\"PUBLISHED\",\"permalink\":\"https://tiktok.example/v/1\"},{\"platform\":\"youtube\",\"status\":\"PUBLISHED\",\"permalink\":null}]"}]}"#;
    let post = ok(r#"{"post":{"id":"p1","clipId":"c1","status":"PUBLISHED","errorMessage":"stale","targets":"[{\"platform\":\"tiktok\",\"status\":\"PUBLISHED\",\"permalink\":\"https://tiktok.example/v/1\"},{\"platform\":\"youtube\",\"status\":\"PUBLISHED\",\"permalink\":null}]"}}"#);
    let (mut rt, e) = lab(publish::view, &[("social-accounts", &accounts_json()), ("posts", &ok(posts)), ("post", &post)]);
    rt.update(|l, _| l.kept = vec!["yt".into(), "ig".into(), "gone".into()]);
    open(&mut rt, |l| publish::open(l, "c1", "My clip"));
    assert_eq!(rt.state.panels.publish.selected, ["yt"], "only listed accounts of one workspace come back");
    click(&mut rt, "publish/account/tt");
    assert_eq!(rt.state.kept, ["yt", "tt"], "a change is remembered for next time");

    click(&mut rt, "publish/post/p1/refresh");
    assert_eq!(calls(&e, "refresh_post"), ["refresh_post(p1)"]);
    assert!(has(&rt, "publish/post/p1/error"), "the refreshed post replaces the row");
    click(&mut rt, "publish/post/p1/target/0/open");
    assert_eq!(rt.state.opened, ["https://tiktok.example/v/1"]);
    assert!(!has(&rt, "publish/post/p1/target/1/open"), "no link, no Open");
    assert!(has(&rt, "publish/generated/soon"), "publishing a generated video is labelled as coming with Generate");
}

fn enriching_json(scored: bool) -> String {
    let c = if scored { r#""transcriptScore":0.7,"predictedScore":0.9"# } else { r#""transcriptScore":null,"predictedScore":null"# };
    ok(&format!(
        r#"{{"videos":[{{"id":"d1","title":"Podcast","url":"https://youtu.be/a","duration":754,"channel":"Chan","relevanceScore":0.8,{c},"status":"NEW","sourceMode":"auto","pickedBy":"qwen","why":["a","b","c","d","e"]}},
        {{"id":"d2","title":"Rules pick","url":"https://youtu.be/b","relevanceScore":0.5,"transcriptScore":0.2,"predictedScore":null,"status":"NEW","sourceMode":"auto","pickedBy":"algorithm"}}]}}"#
    ))
}

#[test]
fn discover_shows_enriching_until_the_captions_are_scored_and_reads_the_list_again_by_itself() {
    let (mut rt, e) = lab(discover::view, &[("candidates", &enriching_json(false))]);
    open(&mut rt, discover::open);
    assert!(rt.state.panels.discover.enriching() && rt.state.panels.discover.polling());
    assert_eq!(rt.state.panels.discover.candidates[0].predicted_score, None);
    let before = calls(&e, "candidates").len();
    e.serve("candidates", &enriching_json(true));
    rt.update(|l, _| discover::poll(l));
    rt.frame(1.0 / 60.0);
    assert_eq!(calls(&e, "candidates").len(), before + 1);
    assert_eq!(rt.state.panels.discover.candidates[0].predicted_score, Some(0.9));
    assert!(!rt.state.panels.discover.enriching(), "every NEW row has its captions scored");
    rt.update(|l, _| discover::poll(l));
    assert_eq!(calls(&e, "candidates").len(), before + 1, "nothing is read when nothing is pending");
}

#[test]
fn a_candidate_row_shows_who_picked_it_more_reasons_a_youtube_link_and_the_auto_run_log() {
    let run = ok(r#"{"id":"r1","status":"DONE","count":2,"mode":"agent","model":"qwen","notes":"cooking is up","steps":[{"tool":"search_web","args":{"query":"masak"},"result":"12 results"}]}"#);
    let (mut rt, _) = lab(discover::view, &[("candidates", &enriching_json(true)), ("auto", &run)]);
    open(&mut rt, discover::open);
    assert!(has(&rt, "discover/c/d1/picked") && has(&rt, "discover/c/d2/picked"));
    assert!(has(&rt, "discover/c/d1/why/2") && !has(&rt, "discover/c/d1/why/3"));
    click(&mut rt, "discover/c/d1/more");
    assert!(has(&rt, "discover/c/d1/why/4"));
    click(&mut rt, "discover/c/d1/yt");
    assert_eq!(rt.state.opened, ["https://youtu.be/a"]);
    rt.update(|l, _| l.panels.discover.run = serde_json::from_str(&run).ok().and_then(|v: serde_json::Value| serde_json::from_value(v["data"].clone()).ok()));
    rt.frame(1.0 / 60.0);
    assert!(has(&rt, "discover/run-status") && has(&rt, "discover/run-notes") && has(&rt, "discover/step/0"));
}

#[test]
fn learning_lists_each_results_posted_day() {
    let rows = r#"{"results":[{"clipId":"c1","title":"Best","viralScore":0.42,"views":12345,"postedAt":"2026-11-01T10:00:00Z"},{"clipId":"c2","views":9}]}"#;
    let (rt, _) = learning_lab(rows, 5);
    assert!(has(&rt, "learning/result/c1/posted") && has(&rt, "learning/result/c2/posted"));
    assert_eq!(sorot_desktop::screens::learning::day(Some("2026-11-01T10:00:00Z")), "2026-11-01");
    assert_eq!(sorot_desktop::screens::learning::day(None), "-");
}

#[test]
fn switching_between_kenari_and_an_own_endpoint_and_the_other_card_actions_each_reach_the_engine() {
    // (steps, engine call that must be among the calls)
    let rows: [(&[&str], &str); 8] = [
        (&["gen/voice/mode-kenari", "gen/voice/kenari/model/0", "gen/voice/mode-custom", "gen/voice/save"], "kenari_voice_models"),
        (&["gen/voice/engine/none"], r#"update_settings(voice, {"engine":""})"#),
        (&["gen/voice/test"], "test_connection(voice)"),
        (&["gen/image/mode-kenari", "gen/image/kenari/model/0", "gen/image/mode-custom", "gen/image/mode-kenari"], "kenari_models(image)"),
        (&["gen/image/mode-custom", "gen/image/enabled"], r#"update_settings(image, {"enabled":false})"#),
        (&["gen/image/mode-custom", "gen/image/test"], "test_connection(image)"),
        (&["gen/cmd/test"], "test_connection(commands)"),
        (&["gen/image/mode-kenari", "gen/image/kenari/model/0", "gen/image/save"], r#"update_settings(image, {"baseUrl":"https://kenari.id/v1","model":"gpt-image-2"})"#),
    ];
    for (steps, call) in rows {
        let (mut rt, e) = generate_cards_lab("https://tts.example");
        for key in steps {
            click(&mut rt, key);
            rt.frame(0.5);
        }
        let seen = e.calls();
        assert!(seen.iter().any(|c| c.contains(call)), "{steps:?} -> {seen:?}");
    }
}
