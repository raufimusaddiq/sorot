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
    let mut rt = Runtime::new(Lab { panels: Panels::default(), engine: engine.clone(), screen }, show, (1100.0, 2600.0), Env { system_dark: true, scale: 1.0 });
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
    let steps: [(&str, bool); 4] = [("", false), ("publish/0/privacy/1", false), ("publish/1/kids-no", false), ("publish/1/title", true)];
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
    assert_eq!(sent, [0, 0, 0, 1], "Post works only after the last choice");
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
    click(&mut rt, "publish/1/kids-no");
    type_into(&mut rt, "publish/1/title", "Judul");
    click(&mut rt, "publish/confirm");
    type_into(&mut rt, "publish/schedule", "tomorrow");
    click(&mut rt, "publish/post");
    assert!(has(&rt, "publish/error") && calls(&e, "publish(").is_empty(), "a bad time names the format and sends nothing");
    rt.update(|l, _| l.panels.publish.schedule.replace_text(""));
    type_into(&mut rt, "publish/schedule", "2026-11-14 19:00");
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

#[test]
fn the_results_sheet_needs_a_post_time_and_sends_the_numbers() {
    let (mut rt, e) = learning_lab(r#"{"results":[]}"#, 0);
    click(&mut rt, "learning/log/c1");
    // each row: (field, typed) steps then the Save press; `Some(call)` = the engine call it makes
    type Typed = &'static [(&'static str, &'static str)];
    let rows: [(Typed, Option<&str>); 4] = [
        (&[], None),
        (&[("feedback/posted-at", "soon")], None),
        (&[("feedback/posted-at", "2026-11-14 19:00"), ("feedback/views", "12x")], None),
        (&[("feedback/posted-at", "2026-11-14 19:00"), ("feedback/views", "120")], Some("submit_feedback(c1, 120 views, posted 2026-11-14T19:00:00Z)")),
    ];
    for (typed, call) in rows {
        open(&mut rt, |l| feedback::open(l, "c1", "Best"));
        for (k, t) in typed {
            type_into(&mut rt, k, t);
        }
        click(&mut rt, "feedback/submit");
        match call {
            None => assert!(has(&rt, "feedback/error") && calls(&e, "submit_feedback").is_empty()),
            Some(c) => assert_eq!(calls(&e, "submit_feedback"), [c]),
        }
    }
    assert!(has(&rt, "feedback/saved"));
    click(&mut rt, "feedback/close");
    assert!(!has(&rt, "feedback/sheet"));
}

#[test]
fn a_refused_result_stays_on_the_sheet_and_the_time_parser_takes_what_it_should() {
    let (mut rt, e) = learning_lab(r#"{"results":[]}"#, 0);
    click(&mut rt, "learning/log/c1");
    assert!(has(&rt, "feedback/for"));
    type_into(&mut rt, "feedback/posted-at", "2026-11-14T19:00:30Z");
    e.fail_once("submit_feedback", EngineError::Api { status: 400, message: "posted in the future".into() });
    click(&mut rt, "feedback/submit");
    assert!(has(&rt, "feedback/error"));
    for (input, want) in [("2026-11-14 19:00", Some("2026-11-14T19:00:00Z")), ("2026-11-14T19:00:30Z", Some("2026-11-14T19:00:30Z")), ("2026-13-14 19:00", None), ("2026-11-14", None), ("14-11-2026 19:00", None), ("2026-11-14 25:00", None)] {
        assert_eq!(feedback::iso_utc(input).as_deref(), want, "{input}");
    }
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
