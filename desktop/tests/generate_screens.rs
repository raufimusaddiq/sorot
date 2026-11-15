//! L2: the Generate screens (T096 to T101) on Rune's headless `Runtime`, against `FakeEngine`. Each
//! table row is a control, the engine call it ends in, and what shows after. Copy is asserted by
//! key (`t(key)`), never by English words; the rules these screens show are the engine's.

use std::sync::Arc;

use rune::{Env, Key, KeyEvent, Mods, Runtime};
use serde_json::{Value, json};
use sorot_desktop::app::{Screen, State, view};
use sorot_desktop::engine::fake::{FakeEngine, RecordReveal, scenes_dir};
use sorot_desktop::engine::EngineError;
use sorot_desktop::screens::generate::{t, tf};
use sorot_desktop::screens::generate;
use sorot_desktop::screens::panels::{Host, Page};

type Rt = Runtime<State>;

/// The app on scene `name` with Generate open, one frame in; and the file manager's log.
fn lab_with(name: &str) -> (Rt, Arc<FakeEngine>, Arc<RecordReveal>) {
    let engine = Arc::new(FakeEngine::scene(name));
    let reveal = Arc::new(RecordReveal::default());
    let mut state = State::with_engine(engine.clone());
    state.reveal = Some(reveal.clone());
    let mut rt = Runtime::new(state, view, (1100.0, 4000.0), Env { system_dark: true, scale: 1.0 });
    rt.frame(0.0);
    rt.update(|s, _| s.show(Page::Generate));
    rt.frame(1.0 / 60.0);
    (rt, engine, reveal)
}

fn lab(name: &str) -> (Rt, Arc<FakeEngine>) {
    let (rt, e, _) = lab_with(name);
    (rt, e)
}

fn click(rt: &mut Rt, key: &str) {
    // the app shell animates layout moves: let them finish so the press lands where the element is
    for _ in 0..30 {
        rt.frame(1.0 / 60.0);
    }
    let (x, y) = rt.find(key).unwrap_or_else(|| panic!("no element {key}"));
    rt.pointer_move(x, y);
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(1.0 / 60.0);
}

fn type_into(rt: &mut Rt, key: &str, s: &str) {
    click(rt, key);
    rt.key(KeyEvent { key: Key::Text(s.into()), mods: Mods::default() });
    rt.frame(1.0 / 60.0);
}

fn has(rt: &Rt, key: &str) -> bool {
    rt.find(key).is_some()
}

/// The accessible name of the element with `key`.
fn name_of(rt: &Rt, key: &str) -> String {
    fn find(v: &Value, key: &str) -> Option<String> {
        if v["key"] == key {
            return v["name"].as_str().map(String::from);
        }
        v["children"].as_array()?.iter().find_map(|c| find(c, key))
    }
    let tree = rt.accessibility_json();
    find(&tree, key).unwrap_or_else(|| panic!("no {key}"))
}

fn calls(e: &FakeEngine, prefix: &str) -> Vec<String> {
    e.calls().into_iter().filter(|c| c.starts_with(prefix)).collect()
}

/// What the scene answers for `route`, for a test to change and serve again.
fn scene(name: &str, route: &str) -> Value {
    let all: Value = serde_json::from_str(&std::fs::read_to_string(scenes_dir().join(name).join("generate.json")).unwrap()).unwrap();
    all[route].clone()
}

fn serve(e: &FakeEngine, route: &str, data: Value) {
    e.serve(route, &json!({ "status": "ok", "data": data }).to_string());
}

const P1: &str = "GET /api/generate/projects/p1";

/// p1's detail as the `generate` scene has it, changed by `f`, served from now on.
fn p1(e: &FakeEngine, f: impl FnOnce(&mut Value)) {
    let mut d = scene("generate", P1);
    f(&mut d);
    serve(e, P1, d);
}

/// Reads p1 again, as picking it from the list does (back at the steps list).
fn reread(rt: &mut Rt) {
    rt.update(|s, _| generate::select(s, Some("p1".into())));
    rt.frame(1.0 / 60.0);
}

/// Opens a step: from the steps list, or from the tab row of another step.
fn goto(rt: &mut Rt, step: &str) {
    let tab = format!("generate/steptab/{step}");
    click(rt, &if has(rt, &tab) { tab } else { format!("generate/step/{step}") });
}

/// The last engine call that changed something and mentions `needle`.
fn last(e: &FakeEngine, needle: &str) -> Option<String> {
    e.calls().into_iter().rev().find(|c| !c.starts_with("GET") && c.contains(needle))
}

fn ver(id: &str, number: u32, status: &str, extra: Value) -> Value {
    let mut v = json!({ "id": id, "projectId": "p1", "planId": "pl1", "number": number, "parentVersionId": null, "status": status });
    v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    v
}

#[test]
fn without_an_ai_connection_generate_says_so_and_links_to_connections() {
    let (mut rt, e) = lab("generate-no-ai");
    assert_eq!(name_of(&rt, "generate/unavailable"), format!("{} {}", t("unavailable.cause"), tf("unavailable.next", &["No LLM or Jev is connected."]).trim()));
    assert!(!has(&rt, "generate/steps") && calls(&e, "GET /api/generate/projects").is_empty(), "nothing of Generate is read while it is unavailable");
    click(&mut rt, "generate/open-settings");
    assert_eq!(rt.state.screen(), Screen::Connections);
}

#[test]
fn a_brief_makes_a_video_and_ideas_run() {
    let (mut rt, e) = lab("generate");
    assert!(has(&rt, "generate/video/p1") && has(&rt, "generate/step/plan"), "the project list beside its steps");
    click(&mut rt, "generate/new");
    // too short a length is refused before anything is sent
    type_into(&mut rt, "generate/brief/text", "Jelaskan bunga majemuk");
    type_into(&mut rt, "generate/brief/length", "9");
    click(&mut rt, "generate/brief/create");
    assert_eq!(name_of(&rt, "generate/brief/problem"), t("brief.problem"));
    assert!(calls(&e, "POST /api/generate/projects").is_empty());
    rt.update(|l, _| l.panels.studio.brief.length = rune::TextEdit::new("30"));
    rt.frame(1.0 / 60.0);
    click(&mut rt, "generate/brief/language/1");
    click(&mut rt, "generate/brief/create");
    assert_eq!(calls(&e, "POST /api/generate/projects"), [r#"POST /api/generate/projects {"brief":"Jelaskan bunga majemuk","format":"9:16","language":"en","narration":false,"recipeId":"explainer","targetSec":30}"#]);
    assert!(has(&rt, "generate/step/plan"), "the new video opens at its steps");

    // ideas: (control, typed, the call)
    goto(&mut rt, "ideas");
    assert!(has(&rt, "generate/idea/i1/card"));
    type_into(&mut rt, "generate/ideas/slug", "bunga");
    type_into(&mut rt, "generate/ideas/brief", "Bunga majemuk");
    for (key, call) in [
        ("generate/ideas/add", r#"POST /api/generate/ideas {"brief":"Bunga majemuk","slug":"bunga"}"#),
        ("generate/ideas/run-next", r#"POST /api/generate/run {"recipeId":"explainer"}"#),
        ("generate/idea/i1/run", r#"POST /api/generate/run {"ideaId":"i1","recipeId":"explainer"}"#),
        ("generate/idea/i1/delete", "DELETE /api/generate/ideas/i1"),
    ] {
        goto(&mut rt, "ideas");
        click(&mut rt, key);
        assert_eq!(last(&e, "/api/generate").as_deref(), Some(call), "{key}");
    }
}

#[test]
fn facts_and_storylines_each_action_is_one_route() {
    let (mut rt, e) = lab("generate");
    p1(&e, |d| d["project"]["recipe"]["steps"].as_array_mut().unwrap().push(json!({ "use": "facts" })));
    reread(&mut rt);
    goto(&mut rt, "facts");
    assert_eq!(name_of(&rt, "generate/fact/f2/status"), t("fact.unverified"));
    type_into(&mut rt, "generate/facts/claim", "Fakta baru");
    type_into(&mut rt, "generate/facts/url", "https://x");
    for (key, call) in [
        ("generate/facts/add", r#"POST /api/generate/projects/p1/facts {"claim":"Fakta baru","sourceUrl":"https://x"}"#),
        ("generate/facts/verify", "POST /api/generate/projects/p1/facts/verify"),
        ("generate/fact/f1/delete", "DELETE /api/generate/facts/f1"),
    ] {
        click(&mut rt, key);
        assert_eq!(last(&e, "/facts").as_deref(), Some(call), "{key}");
    }
    // a fact opens to its three boxes and saves as one change
    click(&mut rt, "generate/fact/f1/edit");
    type_into(&mut rt, "generate/fact/f1/value-edit", "9%");
    click(&mut rt, "generate/fact/f1/save");
    let patch = last(&e, "PATCH /api/generate/facts/f1").unwrap();
    assert!(patch.contains("9%"), "{patch}");
    assert!(!has(&rt, "generate/fact/f1/form"));

    // storylines wait for a pick while the video has no plan
    p1(&e, |d| (d["plans"], d["project"]["currentPlanId"]) = (json!([]), Value::Null));
    reread(&mut rt);
    assert_eq!(name_of(&rt, "generate/step/stories/state"), t("state.pick"));
    goto(&mut rt, "stories");
    type_into(&mut rt, "generate/story/note", "lebih tenang");
    for (key, call) in [
        ("generate/story/1/pick", r#"POST /api/generate/projects/p1/storylines/1/pick {"note":"lebih tenang"}"#),
        ("generate/story/more", r#"POST /api/generate/projects/p1/storylines {"note":"lebih tenang"}"#),
    ] {
        goto(&mut rt, "stories");
        click(&mut rt, key);
        assert_eq!(last(&e, "/storylines").as_deref(), Some(call), "{key}");
    }
}

#[test]
fn building_waits_for_the_plan_to_be_approved_and_an_edit_must_be_saved_first() {
    let (mut rt, e) = lab("generate");
    // not approved: Build does nothing, and its step says why
    goto(&mut rt, "build");
    assert!(has(&rt, "generate/build/gate"));
    click(&mut rt, "generate/build/start");
    assert!(calls(&e, "POST /api/generate/projects/p1/versions").is_empty());

    // an unsaved edit blocks Approve; saving makes a new revision
    goto(&mut rt, "plan");
    type_into(&mut rt, "generate/plan/shot/0/seconds", "5");
    click(&mut rt, "generate/plan/approve");
    assert!(calls(&e, "POST /api/generate/projects/p1/plan/approve").is_empty());
    p1(&e, |d| d["plans"][0]["revision"] = json!(2));
    click(&mut rt, "generate/plan/save");
    assert_eq!(calls(&e, "PUT /api/generate/projects/p1/plan").len(), 1);
    assert_eq!(name_of(&rt, "generate/plan/status"), tf("plan.status", &[&t("plan.pending"), "24", "24"]));

    // approve, and the build opens
    p1(&e, |d| d["plans"][0]["approvedAt"] = json!("2026-11-14T10:00:00Z"));
    click(&mut rt, "generate/plan/approve");
    assert_eq!(calls(&e, "POST /api/generate/projects/p1/plan/approve"), [r#"POST /api/generate/projects/p1/plan/approve {"planId":"pl1"}"#]);
    assert!(has(&rt, "generate/build/start") && !has(&rt, "generate/build/gate"), "approving opens the build");
    goto(&mut rt, "plan");
    assert!(has(&rt, "generate/plan/locked") && !has(&rt, "generate/plan/approve"));
    goto(&mut rt, "build");
    click(&mut rt, "generate/build/start");
    assert_eq!(calls(&e, "POST /api/generate/projects/p1/versions"), ["POST /api/generate/projects/p1/versions"]);
}

#[test]
fn a_build_shows_its_progress_cancels_and_continues_from_the_failed_step() {
    let (mut rt, e) = lab("generate");
    let approved = |d: &mut Value| d["plans"][0]["approvedAt"] = json!("2026-11-14T10:00:00Z");
    // running: progress, then Cancel
    p1(&e, |d| {
        approved(d);
        d["versions"] = json!([ver("ver1", 1, "BUILDING", json!({ "step": "render", "progress": 40.0 }))]);
    });
    reread(&mut rt);
    goto(&mut rt, "build");
    assert_eq!(name_of(&rt, "generate/build/progress"), tf("build.progress", &[&t("build.render"), "40"]));
    click(&mut rt, "generate/build/cancel");
    assert_eq!(calls(&e, "POST /api/generate/versions/ver1/cancel").len(), 1);
    assert!(has(&rt, "generate/log/e1"), "the director log shows beside it");

    // failed: Continue from the failed step; the engine refusing (409) says the plan changed
    p1(&e, |d| {
        approved(d);
        d["versions"] = json!([ver("ver1", 1, "FAILED", json!({ "errorMessage": "Render adegan 4 melewati batas waktu" }))]);
    });
    reread(&mut rt);
    assert_eq!(name_of(&rt, "generate/step/build/state"), t("state.failed"));
    goto(&mut rt, "build");
    click(&mut rt, "generate/build/continue");
    assert_eq!(calls(&e, "POST /api/generate/versions/ver1/retry").len(), 1);
    assert!(!has(&rt, "generate/error"));
    e.fail_once("POST /api/generate/versions/ver1/retry", EngineError::Api { status: 409, message: "plan moved".into() });
    click(&mut rt, "generate/build/continue");
    assert_eq!(name_of(&rt, "generate/error"), t("build.plan_changed"));
}

#[test]
fn both_verdicts_show_and_accept_export_and_restore_are_one_route_each() {
    let (mut rt, e, shown) = lab_with("generate");
    let finding = json!({ "id": "f1", "severity": "must-fix", "shotId": "s3", "fromSec": 4.2, "toSec": 5, "code": "text_over_object", "description": "Teks menimpa gambar", "state": "open", "source": "probe" });
    let verdicts = |technical: &str| {
        json!({ "version": ver("ver2", 2, "BUILT", json!({ "draftPath": "/drafts/ver2.mp4" })), "verdicts": [
            { "id": "a", "versionId": "ver2", "kind": "TECHNICAL", "status": technical, "findings": [], "judgedBy": "code" },
            { "id": "b", "versionId": "ver2", "kind": "CREATIVE", "status": "REVIEW", "findings": [finding], "judgedBy": "hakim" } ] })
    };
    let built = |d: &mut Value, status: &str, exports: Value| {
        d["plans"][0]["approvedAt"] = json!("2026-11-14T10:00:00Z");
        d["project"]["status"] = json!(status);
        d["versions"] = json!([ver("ver2", 2, "BUILT", json!({ "draftPath": "/drafts/ver2.mp4" })), ver("ver1", 1, "BUILT", json!({ "planId": "pl0" }))]);
        d["exports"] = exports;
    };
    // a failed TECHNICAL verdict blocks accepting
    serve(&e, "GET /api/generate/versions/ver2", verdicts("FAIL"));
    p1(&e, |d| built(d, "BUILT", json!([])));
    reread(&mut rt);
    goto(&mut rt, "verdict");
    assert_eq!((name_of(&rt, "generate/verdict/technical"), name_of(&rt, "generate/verdict/creative")), (format!("{}: FAIL", t("verdict.technical")), format!("{}: REVIEW", t("verdict.creative"))));
    assert!(has(&rt, "generate/finding/f1/text") && has(&rt, "generate/build/blocked"));
    click(&mut rt, "generate/build/accept");
    assert!(calls(&e, "POST /api/generate/versions/ver2/accept").is_empty());

    // passing: Fix this, Accept, then Export and reveal
    serve(&e, "GET /api/generate/versions/ver2", verdicts("PASS"));
    reread(&mut rt);
    goto(&mut rt, "verdict");
    for (key, call) in [
        ("generate/finding/f1/fix", r#"POST /api/generate/versions/ver2/fix {"findingIds":["f1"]}"#),
        ("generate/build/fix-must", "POST /api/generate/versions/ver2/fix {}"),
        ("generate/build/accept", "POST /api/generate/versions/ver2/accept"),
    ] {
        click(&mut rt, key);
        assert_eq!(calls(&e, "POST /api/generate/versions/ver2/").last().map(String::as_str), Some(call), "{key}");
    }
    // a note can name one shot
    type_into(&mut rt, "generate/build/note", "lebih besar");
    click(&mut rt, "generate/build/shot/s2");
    click(&mut rt, "generate/build/fix-note");
    assert_eq!(calls(&e, "POST /api/generate/versions/ver2/fix").last().map(String::as_str), Some(r#"POST /api/generate/versions/ver2/fix {"note":"lebih besar","shotId":"s2"}"#));
    p1(&e, |d| built(d, "ACCEPTED", json!([])));
    reread(&mut rt);
    goto(&mut rt, "verdict");
    click(&mut rt, "generate/build/export");
    assert_eq!(calls(&e, "POST /api/generate/versions/ver2/export"), ["POST /api/generate/versions/ver2/export {}"]);
    p1(&e, |d| built(d, "EXPORTED", json!([{ "id": "x1", "versionId": "ver2", "path": "/exports/g.mp4" }])));
    reread(&mut rt);
    goto(&mut rt, "verdict");
    click(&mut rt, "generate/build/reveal");
    click(&mut rt, "generate/build/reveal-draft");
    assert_eq!(shown.shown.lock().unwrap().iter().map(|p| p.display().to_string()).collect::<Vec<_>>(), ["/exports/g.mp4", "/drafts/ver2.mp4"]);


    // Publish opens the panel for the export, on the Generate routes
    click(&mut rt, "generate/build/publish");
    assert_eq!(rt.state.screen(), Screen::Publish);
    assert_eq!(calls(&e, "GET /api/generate/exports/x1/posts").len(), 1);
    click(&mut rt, "publish/account/tt");
    click(&mut rt, "publish/write");
    assert_eq!(calls(&e, "POST /api/generate/exports/x1/publish/draft"), [r#"POST /api/generate/exports/x1/publish/draft {"accountIds":["tt"]}"#]);
    rt.update(|s, _| s.show(Page::Generate));
    rt.frame(1.0 / 60.0);
    reread(&mut rt);
    goto(&mut rt, "verdict");

    // the history: restore an older plan, view the other version
    click(&mut rt, "generate/versions/open");
    assert_eq!(name_of(&rt, "generate/version/ver2/restore"), t("versions.current"));
    click(&mut rt, "generate/version/ver1/restore");
    assert_eq!(calls(&e, "POST /api/generate/versions/ver1/restore").len(), 1);
}

#[test]
fn recipes_shipped_are_read_only_and_a_checked_recipe_shows_its_errors_inline() {
    let (mut rt, e) = lab("generate");
    click(&mut rt, "generate/nav/recipes");
    assert!(has(&rt, "generate/recipes/readonly") && !has(&rt, "generate/recipes/text") && !has(&rt, "generate/recipes/save"), "a shipped recipe has no edit control");
    // a copy asks for its id first (the engine checks it), then makes it
    click(&mut rt, "generate/recipes/copy");
    assert!(calls(&e, "POST /api/generate/recipes ").is_empty());
    type_into(&mut rt, "generate/recipes/copy-id", "-2");
    click(&mut rt, "generate/recipes/copy-do");
    assert!(calls(&e, "POST /api/generate/recipes ").iter().any(|c| c.contains(r#""id":"explainer-copy-2""#)), "{:?}", e.calls());

    click(&mut rt, "generate/recipe/mine");
    assert!(has(&rt, "generate/recipes/step/0") && !has(&rt, "generate/recipes/text"), "your own recipe opens as steps");
    click(&mut rt, "generate/recipes/tab/json");
    assert!(has(&rt, "generate/recipes/text") && !has(&rt, "generate/recipes/readonly"));
    assert_eq!(name_of(&rt, "generate/recipes/error/0"), "steps: harus ada langkah author");
    assert_eq!(name_of(&rt, "generate/recipes/warning/0"), tf("recipes.warning", &["tidak ada langkah voice"]));

    for (key, call) in [
        ("generate/recipes/save", "PUT /api/generate/recipes/mine"),
        ("generate/recipes/delete", "DELETE /api/generate/recipes/mine"),
        ("generate/recipes/export", "GET /api/generate/recipes/mine/export"),
    ] {
        click(&mut rt, "generate/recipe/mine");
        click(&mut rt, key);
        assert!(calls(&e, call).len() == 1, "{key}: {:?}", e.calls());
    }
    // import: text that is not JSON is refused before anything is sent
    type_into(&mut rt, "generate/recipes/import-text", "not json");
    click(&mut rt, "generate/recipes/import");
    assert!(has(&rt, "generate/recipes/failed") && calls(&e, "POST /api/generate/recipes/import").is_empty());
    rt.update(|l, _| l.panels.studio.recipes.import = rune::TextEdit::new(r#"{"id":"x","name":"X"}"#));
    rt.frame(1.0 / 60.0);
    click(&mut rt, "generate/recipes/import");
    assert_eq!(calls(&e, "POST /api/generate/recipes/import"), [r#"POST /api/generate/recipes/import {"recipe":{"id":"x","name":"X"}}"#]);
}

#[test]
fn the_kit_lists_parts_and_only_your_own_can_be_removed() {
    let (mut rt, e) = lab("generate");
    let dir = std::env::temp_dir().join(format!("sorot-kit-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let to = dir.clone();
    rt.update(move |l, _| l.panels.studio.kit.save_dir = Some(to));
    click(&mut rt, "generate/nav/kit");
    assert!(has(&rt, "generate/kit/iso/card") && !has(&rt, "generate/kit/iso/remove") && has(&rt, "generate/kit/timeline/remove"));
    click(&mut rt, "generate/kit/iso/export");
    assert_eq!(calls(&e, "download("), ["download(/api/generate/kit/iso/export)"]);
    assert!(dir.join("iso.zip").is_file() && has(&rt, "generate/kit/notice"));
    // your own part comes from a .zip; the engine checks it and may refuse
    click(&mut rt, "generate/kit/add");
    rt.resolve_file_dialog(Some("D:/a/part.zip".into())).unwrap();
    rt.frame(1.0 / 60.0);
    assert_eq!(calls(&e, "POST /api/generate/kit "), ["POST /api/generate/kit upload(part.zip|)"]);
    assert_eq!(name_of(&rt, "generate/kit/notice"), tf("kit.added", &["mine-part", "1.0.0"]));
    e.fail_once("POST /api/generate/kit", EngineError::Api { status: 422, message: "renders differently twice".into() });
    click(&mut rt, "generate/kit/add");
    rt.resolve_file_dialog(Some("D:/a/part.zip".into())).unwrap();
    rt.frame(1.0 / 60.0);
    assert_eq!(name_of(&rt, "generate/kit/error"), "renders differently twice");
    click(&mut rt, "generate/kit/timeline/remove");
    assert_eq!(calls(&e, "DELETE /api/generate/kit/timeline").len(), 1);
    e.fail_once("DELETE /api/generate/kit/timeline", EngineError::Api { status: 400, message: "no".into() });
    click(&mut rt, "generate/kit/timeline/remove");
    assert!(has(&rt, "generate/kit/error"));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn plan_edits_revisions_and_a_working_video_that_is_followed() {
    let (mut rt, e) = lab("generate");
    goto(&mut rt, "plan");
    // a shot opens to its words, picture and motion; the edits are saved as they are typed
    click(&mut rt, "generate/plan/shot/0/toggle");
    assert_eq!(name_of(&rt, "generate/plan/shot/0/look"), tf("plan.look", &["hangat · warna krem · parts: iso"]));
    click(&mut rt, "generate/plan/shot/0/level/free");
    for (key, typed) in [("generate/plan/shot/0/text/0", "X"), ("generate/plan/shot/0/visual", "Y"), ("generate/plan/shot/0/motion", "Z")] {
        type_into(&mut rt, key, typed);
    }
    click(&mut rt, "generate/plan/save");
    let put = last(&e, "/plan").unwrap();
    assert!(put.contains("PembukaX") && put.contains("Gambar PembukaY") && put.contains("perlahanZ") && put.contains(r#""level":"free""#), "{put}");
    click(&mut rt, "generate/plan/shot/0/toggle");
    assert!(!has(&rt, "generate/plan/shot/0/visual"), "a second press closes it");

    // asking the director for a change, and the revisions listed so far
    p1(&e, |d| (d["plans"][0]["changeRequest"], d["plans"][0]["changeSummary"], d["plans"][0]["revision"]) = (json!("lebih singkat"), json!("shot 2 dipendekkan"), json!(2)));
    reread(&mut rt);
    goto(&mut rt, "plan");
    type_into(&mut rt, "generate/plan/request", "buat shot 2 lebih singkat");
    click(&mut rt, "generate/plan/revise");
    assert_eq!(last(&e, "/plan/revise").as_deref(), Some(r#"POST /api/generate/projects/p1/plan/revise {"request":"buat shot 2 lebih singkat"}"#));

    // off target: the shots no longer add up to the length asked for
    type_into(&mut rt, "generate/plan/shot/0/seconds", "9");
    assert!(has(&rt, "generate/plan/off-target"));

    // approved: the shots are read-only
    p1(&e, |d| d["plans"][0]["approvedAt"] = json!("2026-11-14T10:00:00Z"));
    reread(&mut rt);
    goto(&mut rt, "plan");
    click(&mut rt, "generate/plan/shot/0/toggle");
    assert!(!has(&rt, "generate/plan/shot/0/text/0") && !has(&rt, "generate/plan/save"));

    // a building video is looked at again as time passes
    p1(&e, |d| {
        d["plans"][0]["approvedAt"] = json!("2026-11-14T10:00:00Z");
        d["versions"] = json!([ver("ver1", 1, "BUILDING", json!({ "step": "check", "progress": 10.0 }))]);
    });
    reread(&mut rt);
    let before = calls(&e, "GET /api/generate/projects/p1").len();
    rt.update(|s, _| {
        s.tick(10.0);
    });
    assert!(calls(&e, "GET /api/generate/projects/p1").len() > before);
    goto(&mut rt, "build");
    assert_eq!(name_of(&rt, "generate/build/progress"), tf("build.progress", &[&t("build.check"), "10"]));
}

#[test]
fn a_failed_video_retries_a_running_one_waits_and_a_video_can_be_deleted() {
    let (mut rt, e) = lab("generate");
    p1(&e, |d| (d["project"]["status"], d["project"]["errorMessage"], d["plans"], d["project"]["currentPlanId"]) = (json!("FAILED"), json!("LLM tidak menjawab"), json!([]), Value::Null));
    reread(&mut rt);
    goto(&mut rt, "stories");
    assert!(has(&rt, "generate/failed"));
    click(&mut rt, "generate/retry");
    assert_eq!(calls(&e, "POST /api/generate/projects/p1/retry").len(), 1);
    // the director is at work: its words say which part
    let plans = scene("generate", P1)["plans"].clone();
    let stories = scene("generate", P1)["project"]["storylines"].clone();
    for (storylines, plan_rows, key) in [(Value::Null, json!([]), "project.stories"), (stories, json!([]), "project.plan_from"), (Value::Null, plans, "project.working")] {
        p1(&e, |d| (d["project"]["status"], d["project"]["storylines"], d["plans"]) = (json!("RUNNING"), storylines, plan_rows));
        reread(&mut rt);
        goto(&mut rt, "plan");
        assert_eq!(name_of(&rt, "generate/working"), t(key));
    }
    // delete
    p1(&e, |_| ());
    reread(&mut rt);
    goto(&mut rt, "build");
    click(&mut rt, "generate/delete");
    assert_eq!(calls(&e, "DELETE /api/generate/projects/p1").len(), 1);
    assert!(has(&rt, "generate/new") && !has(&rt, "generate/step/plan"));
    e.fail_once("GET /api/generate/projects/p2", EngineError::Api { status: 500, message: "boom".into() });
    click(&mut rt, "generate/video/p2");
    assert_eq!(name_of(&rt, "generate/error"), "boom");
}

#[test]
fn generate_that_cannot_open_says_so_and_findings_are_ranked_and_placed() {
    let engine = Arc::new(FakeEngine::scene("generate"));
    engine.fail_once("settings", EngineError::Network("down".into()));
    let mut rt = Runtime::new(State::with_engine(engine.clone()), view, (1100.0, 4000.0), Env { system_dark: true, scale: 1.0 });
    rt.frame(0.0);
    rt.update(|s, _| s.show(Page::Generate));
    rt.frame(1.0 / 60.0);
    assert!(has(&rt, "generate/load-failed"));
    click(&mut rt, "generate/retry-open");
    assert!(has(&rt, "generate/ready"), "Try again opens it");

    // findings: worst first; a time without a shot, a shot alone, repeats, a fix hint, and the kept ones
    let (mut rt, e) = lab("generate");
    let f = |id: &str, severity: &str, extra: Value| {
        let mut v = json!({ "id": id, "severity": severity, "code": "c", "description": id, "state": "open", "source": "probe" });
        v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        v
    };
    serve(
        &e,
        "GET /api/generate/versions/ver2",
        json!({ "version": ver("ver2", 2, "BUILT", json!({})), "verdicts": [
            { "id": "b", "versionId": "ver2", "kind": "CREATIVE", "status": "REVIEW", "judgedBy": "hakim", "findings": [
                f("polish1", "polish", json!({ "fromSec": null, "toSec": null, "shotId": null })),
                f("should1", "should-fix", json!({ "fromSec": 2.5, "toSec": null, "shotId": null, "count": 3, "suggestedFix": "perlambat" })),
                f("must1", "must-fix", json!({ "shotId": "s2", "fromSec": null, "toSec": null })),
                f("kept1", "must-fix", json!({ "state": "kept", "keptReason": "disengaja", "shotId": "s1" })),
                f("kept2", "polish", json!({ "state": "kept", "shotId": null })) ] } ] }),
    );
    p1(&e, |d| {
        d["plans"][0]["approvedAt"] = json!("2026-11-14T10:00:00Z");
        d["versions"] = json!([ver("ver2", 2, "BUILT", json!({})), ver("ver1", 1, "BUILT", json!({ "planId": "pl0" }))]);
        d["verdictStatuses"] = json!({ "ver2": { "TECHNICAL": "PASS", "CREATIVE": "REVIEW" }, "ver1": {} });
    });
    reread(&mut rt);
    goto(&mut rt, "verdict");
    assert_eq!(name_of(&rt, "generate/verdict/technical"), format!("{}: {}", t("verdict.technical"), t("verdict.not_judged")));
    assert_eq!(name_of(&rt, "generate/finding/should1/text"), "should-fix · 2.5 s should1 ×3");
    assert_eq!(name_of(&rt, "generate/finding/must1/text"), "must-fix · s2 must1");
    assert_eq!(name_of(&rt, "generate/finding/polish1/text"), "polish polish1");

    // the history's View button shows the other version's verdicts
    serve(&e, "GET /api/generate/versions/ver1", json!({ "version": ver("ver1", 1, "BUILT", json!({})), "verdicts": [] }));
    click(&mut rt, "generate/versions/open");
    click(&mut rt, "generate/version/ver1/view");
    assert_eq!(name_of(&rt, "generate/verdict/version"), tf("verdict.version", &["1"]));
}

#[test]
fn ideas_open_resume_and_empty_and_recipes_say_what_failed() {
    let (mut rt, e) = lab("generate");
    goto(&mut rt, "ideas");
    click(&mut rt, "generate/idea/i2/run");
    assert_eq!(last(&e, "/run").as_deref(), Some(r#"POST /api/generate/run {"ideaId":"i2","recipeId":"explainer"}"#));
    goto(&mut rt, "ideas");
    click(&mut rt, "generate/idea/i2/open");
    assert!(has(&rt, "generate/step/plan"), "Open goes to the video");
    serve(&e, "GET /api/generate/ideas", json!({ "ideas": [] }));
    goto(&mut rt, "ideas");
    assert!(has(&rt, "generate/ideas/empty"));
    reread(&mut rt);

    // recipes: a list that cannot be read, JSON that is not, and the engine refusing
    e.fail_once("GET /api/generate/recipes", EngineError::Api { status: 500, message: "no list".into() });
    click(&mut rt, "generate/nav/recipes");
    assert_eq!(name_of(&rt, "generate/recipes/failed"), "no list");
    let mut with_reasons = scene("generate", "GET /api/generate/recipes");
    with_reasons["recipes"][0]["available"] = json!(false);
    with_reasons["recipes"][0]["reasons"] = json!(["needs an image connection"]);
    serve(&e, "GET /api/generate/recipes", with_reasons);
    click(&mut rt, "generate/nav/projects");
    click(&mut rt, "generate/nav/recipes");
    assert_eq!(name_of(&rt, "generate/recipe/explainer"), tf("recipes.unavailable", &[&tf("recipes.builtin", &["Penjelasan produk"])]));
    click(&mut rt, "generate/recipe/mine");
    rt.update(|s, _| s.panels.studio.recipes.text = rune::TextEdit::new("{"));
    rt.frame(1.0 / 60.0);
    for key in ["generate/recipes/validate", "generate/recipes/save"] {
        click(&mut rt, key);
        assert!(name_of(&rt, "generate/recipes/failed").starts_with("The recipe is not valid JSON") || name_of(&rt, "generate/recipes/failed").starts_with("Resep bukan JSON"), "{key}");
    }
    e.fail_once("POST /api/generate/recipes/validate", EngineError::Api { status: 400, message: "no check".into() });
    rt.update(|s, _| s.panels.studio.recipes.text = rune::TextEdit::new("{}"));
    rt.frame(1.0 / 60.0);
    click(&mut rt, "generate/recipes/validate");
    assert_eq!(name_of(&rt, "generate/recipes/failed"), "no check");
    e.fail_once("GET /api/generate/recipes/mine/export", EngineError::Api { status: 404, message: "no export".into() });
    click(&mut rt, "generate/recipes/export");
    assert_eq!(name_of(&rt, "generate/recipes/failed"), "no export");
    serve(&e, "GET /api/generate/recipes", json!({ "recipes": [] }));
    click(&mut rt, "generate/nav/projects");
    click(&mut rt, "generate/nav/recipes");
    assert!(has(&rt, "generate/recipes/empty"));
}

#[test]
fn a_brief_sends_its_logo_and_files_with_the_new_video_and_refuses_other_types() {
    let (mut rt, e) = lab("generate");
    click(&mut rt, "generate/new");
    // a logo must be a picture; other files by what they are
    for (key, file) in [("generate/brief/logo", "D:/a/logo.png"), ("generate/brief/add", "D:/a/song.mp3"), ("generate/brief/add", "D:/a/tool.exe")] {
        click(&mut rt, key);
        assert!(rt.file_dialog().is_some(), "{key} asks for a file");
        rt.resolve_file_dialog(Some(file.into())).unwrap();
        rt.frame(1.0 / 60.0);
    }
    assert_eq!(name_of(&rt, "generate/brief/problem"), t("brief.file_type"));
    assert_eq!((name_of(&rt, "generate/brief/file/0"), name_of(&rt, "generate/brief/file/1")), (format!("logo.png · {}", t("brief.kind.logo")), format!("song.mp3 · {}", t("brief.kind.music"))));
    click(&mut rt, "generate/brief/add");
    rt.resolve_file_dialog(None).unwrap();
    rt.frame(1.0 / 60.0);
    // a file can be taken back out before the video is made
    click(&mut rt, "generate/brief/file/1/remove");
    assert!(!has(&rt, "generate/brief/file/1"));
    type_into(&mut rt, "generate/brief/text", "Jelaskan bunga majemuk");
    click(&mut rt, "generate/brief/create");
    assert_eq!(calls(&e, "POST /api/generate/projects/").iter().filter(|c| c.contains("/assets")).cloned().collect::<Vec<_>>(), ["POST /api/generate/projects/p1/assets upload(logo.png|kind=logo)"]);
}

#[test]
fn a_built_drafts_plays_in_the_app_and_a_file_that_cannot_come_is_said() {
    let (mut rt, e) = lab("generate");
    p1(&e, |d| {
        d["plans"][0]["approvedAt"] = json!("2026-11-14T10:00:00Z");
        d["versions"] = json!([ver("ver1", 1, "BUILT", json!({ "draftPath": "/drafts/ver1.mp4" }))]);
    });
    serve(&e, "GET /api/generate/versions/ver1", json!({ "version": ver("ver1", 1, "BUILT", json!({ "draftPath": "/drafts/ver1.mp4" })), "verdicts": [] }));
    reread(&mut rt);
    goto(&mut rt, "verdict");
    assert!(!has(&rt, "generate/draft"));
    e.fail_once("download", EngineError::Api { status: 404, message: "no draft".into() });
    click(&mut rt, "generate/build/watch");
    assert_eq!(name_of(&rt, "generate/error"), "no draft");
    click(&mut rt, "generate/build/watch");
    assert_eq!(calls(&e, "download(/api/generate/versions/ver1/draft)").len(), 2);
    assert!(has(&rt, "generate/draft") && has(&rt, "clips/play"), "the player shows under the page");
}

#[test]
fn a_recipe_is_built_as_steps_and_saved_as_the_json_it_makes() {
    let (mut rt, e) = lab("generate");
    click(&mut rt, "generate/nav/recipes");
    click(&mut rt, "generate/recipe/mine");
    // add (export stays last), reorder, remove
    for key in ["generate/recipes/add/storylines", "generate/recipes/add", "generate/recipes/add/export", "generate/recipes/add", "generate/recipes/add/plan", "generate/recipes/add"] {
        click(&mut rt, key);
    }
    assert_eq!(name_of(&rt, "generate/recipes/step/2/title"), "3. plan");
    click(&mut rt, "generate/recipes/step/2/remove");
    click(&mut rt, "generate/recipes/step/1/up");
    // the first step (storylines): its gate and its numbers and switches
    click(&mut rt, "generate/recipes/step/0/open");
    for key in ["generate/recipes/step/0/gate/owner", "generate/recipes/step/0/with/count/inc", "generate/recipes/step/0/with/requireBold"] {
        click(&mut rt, key);
    }
    assert_eq!(name_of(&rt, "generate/recipes/step/0/title"), format!("1. storylines · {}", tf("recipes.gate", &["owner"])));
    // the second (plan): a choice, a condition, text and a list; an object setting says where it is edited
    click(&mut rt, "generate/recipes/step/1/open");
    assert!(!has(&rt, "generate/recipes/step/0/gate/owner"), "one step is open at a time: {:?}", rt.state.panels.studio.recipes.open_step);
    assert!(has(&rt, "generate/recipes/step/1/with/extra.depth/inc"), "{:?}", rt.state.panels.studio.recipes.open_step);
    for key in ["generate/recipes/step/1/with/mode/long", "generate/recipes/step/1/when/connection:vision"] {
        click(&mut rt, key);
    }
    for (name, words) in [("note", "pendek"), ("tags", "a, b")] {
        click(&mut rt, &format!("generate/recipes/step/1/with/{name}/edit"));
        type_into(&mut rt, &format!("generate/recipes/step/1/with/{name}/input"), words);
        click(&mut rt, &format!("generate/recipes/step/1/with/{name}/set"));
    }
    // objects, a flag with fields and a list are drawn from the schema; the step has an id and its own prompt
    for key in ["generate/recipes/step/1/with/extra.depth/inc", "generate/recipes/step/1/with/effects", "generate/recipes/step/1/with/effects.maxSteps/inc", "generate/recipes/step/1/with/crit/add", "generate/recipes/step/1/prompt/append"] {
        click(&mut rt, key);
    }
    for (key, words) in [("generate/recipes/step/1/with/crit.0.question", "apa?"), ("generate/recipes/step/1/id", "rencana"), ("generate/recipes/step/1/prompt/text", "pelan")] {
        click(&mut rt, &format!("{key}/edit"));
        type_into(&mut rt, &format!("{key}/input"), words);
        click(&mut rt, &format!("{key}/set"));
    }
    assert_eq!(name_of(&rt, "generate/recipes/step/1/title"), "2. rencana");
    click(&mut rt, "generate/recipes/step/1/with/crit/add");
    click(&mut rt, "generate/recipes/step/1/with/crit/1/remove");
    click(&mut rt, "generate/recipes/save");
    let put = last(&e, "PUT /api/generate/recipes/mine").unwrap();
    let body: Value = serde_json::from_str(put.splitn(3, ' ').nth(2).unwrap()).unwrap();
    assert_eq!(
        body["recipe"]["steps"],
        json!([
            { "use": "storylines", "gate": "owner", "with": { "count": 4, "requireBold": true } },
            { "use": "plan", "id": "rencana", "prompt": { "mode": "append", "text": "pelan" }, "when": "connection:vision", "with": { "mode": "long", "note": "pendek", "tags": ["a", "b"], "extra": { "depth": 2 }, "effects": { "maxSteps": 2 }, "crit": [{ "question": "apa?" }] } },
            { "use": "export" },
        ])
    );
    // JSON that is not a recipe leaves the form saying so; the name is set from its field
    rt.update(|s, _| s.panels.studio.recipes.text = rune::TextEdit::new("{"));
    rt.frame(1.0 / 60.0);
    assert!(has(&rt, "generate/recipes/steps/broken"));
    rt.update(|s, _| s.panels.studio.recipes.text = rune::TextEdit::new(r#"{"name":"A","steps":[]}"#));
    rt.frame(1.0 / 60.0);
    type_into(&mut rt, "generate/recipes/name", "Baru");
    click(&mut rt, "generate/recipes/name/set");
    assert!(rt.state.panels.studio.recipes.text.text.contains("\"name\": \"Resep sayaBaru\""));
}

#[test]
fn a_brief_carries_its_format_pipeline_narration_facts_and_number_rule() {
    let (mut rt, e) = lab("generate");
    click(&mut rt, "generate/new");
    type_into(&mut rt, "generate/brief/text", "Jelaskan bunga majemuk");
    // a fact line that is not claim | value | https://address is refused before anything is sent
    type_into(&mut rt, "generate/brief/facts/text", "Bunga 5 persen | 5%");
    click(&mut rt, "generate/brief/create");
    assert_eq!(name_of(&rt, "generate/brief/problem"), tf("brief.fact_line", &["Bunga 5 persen | 5%"]));
    assert!(calls(&e, "POST /api/generate/projects").is_empty());
    rt.update(|s, _| s.panels.studio.brief.facts = rune::TextEdit::new("Bunga 5 persen | 5% | https://bi.go.id"));
    rt.frame(1.0 / 60.0);
    for key in ["generate/brief/preset/0", "generate/brief/pipeline/1", "generate/brief/narration", "generate/brief/no-numbers", "generate/brief/create"] {
        click(&mut rt, key);
    }
    assert_eq!(
        calls(&e, "POST /api/generate/projects"),
        [r#"POST /api/generate/projects {"brief":"Jelaskan bunga majemuk","facts":[{"claim":"Bunga 5 persen","sourceUrl":"https://bi.go.id","value":"5%"}],"forbiddenNumbers":true,"format":"9:16","language":"id","narration":true,"preset":"explainer-30","recipeId":"mine","targetSec":30}"#]
    );
}

#[test]
fn narration_needs_a_voice_engine_and_a_videos_own_files_can_be_removed() {
    let (mut rt, e) = lab("generate");
    // the open video lists what it was given, and one can be taken off
    goto(&mut rt, "brief");
    assert!(name_of(&rt, "generate/asset/a1").starts_with("logo.png"));
    click(&mut rt, "generate/asset/a1/remove");
    assert_eq!(calls(&e, "DELETE /api/generate/assets/a1").len(), 1);
    // without a voice engine the box is off and says what it needs
    rt.update(|s, _| {
        if let Some(generate::Avail::Yes { voices, .. }) = &mut s.panels.studio.avail {
            voices.clear();
        }
        generate::select(s, None);
    });
    rt.frame(1.0 / 60.0);
    assert!(has(&rt, "generate/brief/narration/needs"));
    click(&mut rt, "generate/brief/narration");
    assert_eq!(rt.state.panels.studio.brief.narration, None);
}
