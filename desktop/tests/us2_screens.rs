//! L2 for User Story 2: home, job, clips, editor, export and notifications, in process against fakes.


use std::path::PathBuf;
use std::sync::Arc;

use rune::{Key, KeyEvent, Mods, Runtime};
use sorot_desktop::app::*;
use sorot_desktop::engine::{EngineError, fake::stage_script};
use sorot_desktop_core::model::{Job, JobDetail, JobStage};
use crate::support::*;

fn has(rt: &Runtime<State>, key: &str) -> bool {
    rt.find(key).is_some()
}

fn poke(rt: &mut Runtime<State>, f: impl FnOnce(&mut State) + Send + 'static) {
    rt.update(move |s, _| f(s));
    rt.frame(1.0 / 60.0);
}

fn text_of(rt: &Runtime<State>, key: &str) -> String {
    let tree = rt.accessibility_json();
    fn find(v: &serde_json::Value, key: &str) -> Option<String> {
        if v["key"] == key {
            return v["name"].as_str().map(String::from);
        }
        v["children"].as_array()?.iter().find_map(|c| find(c, key))
    }
    find(&tree, key).unwrap_or_else(|| panic!("no {key}: {tree}"))
}

fn home_rt() -> (Runtime<State>, Arc<FakeEngine>) {
    let fake = Arc::new(FakeEngine::scene("home-empty"));
    (runtime_of(State::with_engine(fake.clone())), fake)
}

fn import_calls(fake: &FakeEngine) -> Vec<String> {
    fake.calls().into_iter().filter(|c| c.starts_with("import(")).collect()
}

/// What Home sends the engine, and what it says when it cannot: link, direction limit, the
/// Indonesian direction unchanged, a full disk, a dropped file, a file that is not a video.
#[test]
fn home_import_table() {
    let long = "a".repeat(501);
    let diacritics = "Rangkum bagian paling mengejutkan, ya… élan ü";
    let diacritics_call = format!("import(https://youtu.be/abc|{diacritics})");
    let rows: Vec<(&str, &str, Vec<&str>, &str)> = vec![
        ("https://youtu.be/abc", "", vec!["import(https://youtu.be/abc|)"], ""),
        ("https://youtu.be/abc", "Ringkas bagian yang lucu, pakai gaya santai", vec!["import(https://youtu.be/abc|Ringkas bagian yang lucu, pakai gaya santai)"], ""),
        ("https://youtu.be/abc", diacritics, vec![&diacritics_call], ""),
        ("https://youtu.be/abc", &long, vec![], "The direction is 501 characters; the limit is 500."),
        ("not a link", "", vec![], "Paste a link that starts with http:// or https://."),
    ];
    for (link, direction, calls, error) in rows {
        let (mut rt, fake) = home_rt();
        type_text(&mut rt, "home/link", link);
        if !direction.is_empty() {
            type_text(&mut rt, "home/direction", direction);
            assert_eq!(text_of(&rt, "home/direction-count"), format!("{}/500", direction.chars().count()));
        }
        click(&mut rt, "home/import");
        assert_eq!(import_calls(&fake), calls, "{link} {}", direction.len());
        if error.is_empty() {
            assert_eq!(rt.state.screen(), Screen::Job, "an import opens its job");
        } else {
            assert_eq!(text_of(&rt, "home/error/cause"), error);
        }
    }

    // a full disk: the sentence and the next step; Home stays
    let (mut rt, fake) = home_rt();
    fake.fail_once("import", EngineError::DiskFull { need: 3_000_000_000, free: 1_000_000_000 });
    type_text(&mut rt, "home/link", "https://youtu.be/abc");
    click(&mut rt, "home/import");
    assert_eq!(text_of(&rt, "home/error/cause"), "Not enough disk space: needs 3.0 GB, 1.0 GB free");
    assert!(text_of(&rt, "home/error/next").starts_with("Free some space"));
    assert_eq!(rt.state.screen(), Screen::Home);

    // dropped files: a video starts an import, anything else is not accepted by the field
    for (name, calls) in [("a.mp4", vec!["import(file:a.mp4|)"]), ("notes.txt", vec![])] {
        let (mut rt, fake) = home_rt();
        let at = rt.find("home/drop").unwrap();
        rt.drop_files(vec![PathBuf::from(name)], Some(at));
        rt.frame(1.0 / 60.0);
        assert_eq!(import_calls(&fake), calls, "{name}");
    }
    // the same path through the code the field calls, for a file the field would refuse
    let (mut rt, fake) = home_rt();
    poke(&mut rt, |s| s.dropped(&[PathBuf::from("clip.avi")]));
    assert_eq!((import_calls(&fake).len(), text_of(&rt, "home/error/cause")), (0, "clip.avi is not a video Sorot can read (mp4, mov, mkv or webm).".to_string()));
}

/// The file dialog is the Wayland path: choosing a file imports it.
#[test]
fn choose_file_opens_the_dialog_and_imports_the_pick() {
    let (mut rt, fake) = home_rt();
    click(&mut rt, "home/choose-file");
    assert!(rt.file_dialog().is_some());
    rt.resolve_file_dialog(Some("D:/videos/talk.mkv".into())).unwrap();
    rt.frame(1.0 / 60.0);
    assert_eq!(import_calls(&fake), ["import(file:talk.mkv|)"]);
    let (mut rt, fake) = home_rt();
    click(&mut rt, "home/choose-file");
    rt.resolve_file_dialog(None).unwrap();
    rt.frame(1.0 / 60.0);
    assert!(import_calls(&fake).is_empty());
}

/// The options sheet sends only what it changed.
#[test]
fn the_options_sheet_sends_only_its_changes() {
    let (mut rt, fake) = home_rt();
    click(&mut rt, "home/options-toggle");
    assert!(has(&rt, "home/option/style/plain"));
    click(&mut rt, "home/option/style/plain");
    click(&mut rt, "home/option/bgm/lofi.mp3");
    click(&mut rt, "home/option/silenceTrim");
    click(&mut rt, "home/option/reframe/center");
    click(&mut rt, "home/option/reframe/center");
    type_text(&mut rt, "home/link", "https://youtu.be/abc");
    click(&mut rt, "home/import");
    assert_eq!(import_calls(&fake), [r#"import(https://youtu.be/abc||{"bgm":"lofi.mp3","silenceTrim":true,"style":"plain"})"#]);
}

fn detail(status: &str, err: Option<&str>, stages: &[(&str, &str, Option<&str>)]) -> JobDetail {
    JobDetail {
        job: Job { id: "j1".into(), video_id: "vnew".into(), status: status.into(), current_stage: None, error_message: err.map(Into::into), created_at: String::new(), updated_at: String::new() },
        stages: stages.iter().map(|(stage, status, out)| JobStage {
            id: String::new(), job_id: "j1".into(), stage: (*stage).into(), status: (*status).into(), started_at: None, completed_at: None, output_path: out.map(Into::into),
        }).collect(),
    }
}

/// Job states: the words on screen and the buttons that exist.
#[test]
fn the_job_screen_shows_each_state_with_its_buttons() {
    let running = [("IMPORT", "COMPLETED", None), ("TRANSCRIBE", "IN_PROGRESS", Some("Transcribing 37%"))];
    // (detail, headline, cancel, retry, interrupted note)
    let rows = vec![
        (detail("QUEUED", None, &[("IMPORT", "PENDING", None)]), "Waiting to start", true, false, false),
        (detail("RUNNING", None, &running), "Transcribing 37%", true, false, false),
        (detail("RUNNING", None, &[("IMPORT", "IN_PROGRESS", Some("Jev reading moments 10/40"))]), "Jev reading moments 10/40", true, false, false),
        (detail("FAILED", Some("interrupted"), &[("IMPORT", "FAILED", None)]), "Interrupted", false, true, true),
        (detail("FAILED", Some("boom"), &[("IMPORT", "FAILED", None)]), "Failed", false, true, false),
        (detail("CANCELLED", None, &[("IMPORT", "PENDING", None)]), "Cancelled", false, true, false),
    ];
    for (d, headline, cancel, retry, interrupted) in rows {
        let (mut rt, fake) = home_rt();
        poke(&mut rt, |s| s.open_job("j1"));
        assert_eq!(rt.state.screen(), Screen::Job);
        assert!(has(&rt, "job/loading"), "before the engine answers");
        let status = d.job.status.clone();
        poke(&mut rt, |s| s.apply(Msg::JobDetail(d)));
        assert_eq!(text_of(&rt, "job/progress"), headline, "{status}");
        assert_eq!((has(&rt, "job/cancel"), has(&rt, "job/retry"), has(&rt, "job/interrupted")), (cancel, retry, interrupted), "{status}");
        assert!(has(&rt, "job/beam") && has(&rt, "job/elapsed") && !has(&rt, "job/spinner"));
        if cancel {
            click(&mut rt, "job/cancel");
            assert!(fake.calls().contains(&"cancel_job(j1)".to_string()));
        }
        if retry {
            click(&mut rt, "job/retry");
            assert!(fake.calls().contains(&"retry_job(j1)".to_string()));
        }
    }
    // time passes as elapsed seconds
    let (mut rt, _) = home_rt();
    poke(&mut rt, |s| s.open_job("j1"));
    poke(&mut rt, |s| s.apply(Msg::JobDetail(detail("RUNNING", None, &[("IMPORT", "IN_PROGRESS", None)]))));
    poke(&mut rt, |s| { s.tick(65.0); });
    assert_eq!(text_of(&rt, "job/elapsed"), "Elapsed 1:05");
}

/// A job walking every stage ends on the clips, in `rankPos` order.
#[test]
fn a_finished_job_opens_its_clips() {
    let (mut rt, fake) = home_rt();
    type_text(&mut rt, "home/link", "https://youtu.be/abc");
    click(&mut rt, "home/import");
    let mut t = 0.0;
    let mut seen_percent = vec![];
    while rt.state.screen() == Screen::Job && t < 30.0 {
        t += 0.5;
        poke(&mut rt, move |s| { s.tick(t); });
        if has(&rt, "job/progress") {
            seen_percent.push(text_of(&rt, "job/progress"));
        }
    }
    assert!(seen_percent.contains(&"Working 50%".to_string()), "{seen_percent:?}");
    assert_eq!(rt.state.screen(), Screen::Clips);
    assert!(fake.calls().contains(&"clips(vnew)".to_string()));
    let ids: Vec<_> = rt.state.clips.clips.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(ids, ["c2", "c1", "c3"], "rankPos 1, 2, 3");
}

fn clips_rt() -> (Runtime<State>, Arc<FakeEngine>, Arc<RecordReveal>, Arc<RecordNotifier>) {
    let fake = Arc::new(FakeEngine::scene("home-empty"));
    let (reveal, notifier) = (Arc::new(RecordReveal::default()), Arc::new(RecordNotifier::default()));
    let mut s = State::with_engine(fake.clone());
    s.reveal = Some(reveal.clone());
    s.notifier = Some(notifier.clone());
    let mut rt = runtime_of(s);
    poke(&mut rt, |s| s.show_clips("vnew"));
    (rt, fake, reveal, notifier)
}

fn key(c: &str) -> KeyEvent {
    KeyEvent { key: Key::Text(c.into()), mods: Mods::default() }
}

#[test]
fn clips_are_listed_in_rank_order_and_j_k_move_the_selection() {
    let (mut rt, fake, _, _) = clips_rt();
    for id in ["c2", "c1", "c3"] {
        assert!(has(&rt, &format!("clips/row/{id}")), "{id}");
    }
    // list order = core::clips order
    let order = sorot_desktop_core::clips::ordered(&rt.state.clips.clips);
    assert_eq!(order.iter().map(|c| &c.id).collect::<Vec<_>>(), rt.state.clips.clips.iter().map(|c| &c.id).collect::<Vec<_>>());
    // verdict words always show
    for (id, word) in [("c2", "Pass"), ("c1", "Review"), ("c3", "Skip")] {
        assert_eq!(text_of(&rt, &format!("clips/row/{id}/verdict")), word);
    }
    // J and K, stopping at the ends; a clip's preview is fetched the first time it is chosen, then cached
    let moves = [("j", "c1"), ("j", "c3"), ("j", "c3"), ("k", "c1"), ("k", "c2"), ("k", "c2")];
    let mut chosen = vec![];
    for (k, want) in moves {
        poke(&mut rt, move |s| assert!(s.clips_key(&key(k))));
        assert_eq!(rt.state.selected_clip().unwrap().id, want, "{k}");
        chosen.push(want);
    }
    let previews: Vec<_> = fake.calls().into_iter().filter(|c| c.starts_with("download_preview")).collect();
    assert_eq!(previews, ["download_preview(c2)", "download_preview(c1)", "download_preview(c3)"].map(String::from));
    // a press chooses a row; other keys are not taken; off the clips screen J does nothing
    click(&mut rt, "clips/row/c3");
    assert_eq!(rt.state.selected_clip().unwrap().id, "c3");
    poke(&mut rt, |s| assert!(!s.clips_key(&key("x"))));
    // Space plays and pauses
    poke(&mut rt, |s| assert!(s.clips_key(&key(" "))));
    assert_eq!(text_of(&rt, "clips/play"), "Pause");
    click(&mut rt, "clips/play");
    assert_eq!(text_of(&rt, "clips/play"), "Play");
    poke(&mut rt, |s| s.route = Route::Home);
    poke(&mut rt, |s| assert!(!s.clips_key(&key("j"))));
}

#[test]
fn no_clips_says_so_and_offers_the_next_step() {
    let (mut rt, _, _, _) = clips_rt();
    poke(&mut rt, |s| s.apply(Msg::Clips { video_id: "vnew".into(), clips: vec![] }));
    assert_eq!(text_of(&rt, "clips/empty/cause"), "No clips yet");
    click(&mut rt, "clips/empty/home");
    assert_eq!(rt.state.screen(), Screen::Home);
}

/// Edits → the body `Engine::rerender` gets: only the clip-layer delta, nothing when nothing differs.
#[test]
fn the_editor_sends_only_the_delta() {
    let rows: Vec<(Vec<&str>, Option<&str>)> = vec![
        (vec!["editor/style/plain"], Some(r#"{"style":"plain"}"#)),
        (vec!["editor/style/plain", "editor/style/karaoke"], None),
        (vec!["editor/silence-trim"], Some(r#"{"silenceTrim":true}"#)),
        (vec!["editor/silence-trim", "editor/silence-trim"], None),
        (vec!["editor/hook-first", "editor/reframe/center"], Some(r#"{"hookFirst":true,"reframe":"center"}"#)),
        (vec!["editor/music/none"], None),
    ];
    for (clicks, body) in rows {
        let (mut rt, fake, _, _) = clips_rt();
        poke(&mut rt, |s| s.open_editor("c2"));
        assert_eq!(rt.state.screen(), Screen::Editor);
        assert!(has(&rt, "editor/timeline") && has(&rt, "editor/hook-marker"));
        for c in &clicks {
            click(&mut rt, c);
        }
        click(&mut rt, "editor/rerender");
        let calls: Vec<_> = fake.calls().into_iter().filter(|c| c.starts_with("rerender")).collect();
        assert_eq!(calls, body.map(|b| format!("rerender(c2|{b})")).into_iter().collect::<Vec<_>>(), "{clicks:?}");
        let toast = rt.state.toasts.last().unwrap().toast.text.clone();
        assert_eq!(toast.starts_with("Nothing changed"), body.is_none(), "{toast}");
    }
    // a failed render says why and lets the person try again
    let (mut rt, fake, _, _) = clips_rt();
    poke(&mut rt, |s| s.open_editor("c2"));
    fake.fail_once("rerender", EngineError::Api { status: 500, message: "Re-render failed: ffmpeg".into() });
    click(&mut rt, "editor/style/plain");
    click(&mut rt, "editor/rerender");
    assert!(rt.state.toasts.last().unwrap().toast.text.contains("Re-render failed: ffmpeg") && !rt.state.editor.rendering);
    // the editor of a clip that is not loaded, and the way back
    poke(&mut rt, |s| s.open_editor("gone"));
    assert!(has(&rt, "editor/missing"));
    click(&mut rt, "editor/missing/back");
    assert_eq!(rt.state.screen(), Screen::Clips);
}

/// The previous export stays (its path and note) after a re-render, until Export is used again.
#[test]
fn the_previous_export_stays_until_the_next_export() {
    let (mut rt, fake, _, _) = clips_rt();
    click(&mut rt, "clips/export");
    assert_eq!(rt.state.selected_clip().unwrap().export_path.as_deref(), Some("/exports/c2_final.mp4"));
    poke(&mut rt, |s| s.open_editor("c2"));
    assert!(has(&rt, "editor/export-note") && has(&rt, "editor/reveal"));
    click(&mut rt, "editor/reveal");
    assert_eq!(rt.state.screen(), Screen::Editor);
    click(&mut rt, "editor/style/plain");
    click(&mut rt, "editor/rerender");
    assert!(fake.calls().iter().any(|c| c.starts_with("rerender(c2")));
    assert_eq!(rt.state.clip_by_id("c2").unwrap().export_path.as_deref(), Some("/exports/c2_final.mp4"));
    click(&mut rt, "editor/back");
    assert_eq!(rt.state.screen(), Screen::Clips);
}

/// Export, then "Show in folder" for a local engine and a save-as download for a remote one.
#[test]
fn export_then_reveal_locally_or_download_remotely() {
    for remote in [false, true] {
        let (mut rt, fake, reveal, _) = clips_rt();
        poke(&mut rt, move |s| s.remote = remote);
        assert!(!has(&rt, "clips/reveal"), "nothing to show before an export");
        click(&mut rt, "clips/export");
        assert!(fake.calls().contains(&"export(c2)".to_string()));
        assert_eq!(text_of(&rt, "clips/reveal"), if remote { "Save a copy" } else { "Show in folder" });
        click(&mut rt, "clips/reveal");
        if remote {
            assert!(rt.file_dialog().is_some(), "the save dialog is open");
            let dest = std::env::temp_dir().join(format!("sorot-us2-{}.mp4", std::process::id()));
            rt.resolve_file_dialog(Some(dest.clone())).unwrap();
            rt.frame(1.0 / 60.0);
            assert!(fake.calls().contains(&"download_export(c2)".to_string()));
            assert!(reveal.shown.lock().unwrap().is_empty());
            assert!(rt.state.toasts.last().unwrap().toast.text.starts_with("Saved to"));
            assert_eq!(std::fs::read_to_string(&dest).unwrap(), "fake-mp4");
            let _ = std::fs::remove_file(dest);
        } else {
            assert_eq!(*reveal.shown.lock().unwrap(), [PathBuf::from("/exports/c2_final.mp4")]);
            assert!(!fake.calls().iter().any(|c| c.starts_with("download_export")));
        }
    }
    // a failed export frees the button and says why; Ctrl+E exports the selection
    let (mut rt, fake, _, _) = clips_rt();
    fake.fail_once("export", EngineError::Network("down".into()));
    click(&mut rt, "clips/export");
    assert!(rt.state.clips.exporting.is_none() && rt.state.toasts.last().unwrap().toast.text.starts_with("Could not export"));
    let ctrl_e = KeyEvent { key: Key::Command('e'), mods: Mods { cmd: true, ..Mods::default() } };
    poke(&mut rt, move |s| assert!(s.clips_key(&ctrl_e)));
    assert!(has(&rt, "clips/reveal"));
    // a file manager that fails is reported
    struct Broken;
    impl sorot_desktop::platform::reveal::Reveal for Broken {
        fn reveal(&self, _: &std::path::Path) -> Result<(), String> {
            Err("no file manager".into())
        }
        fn open(&self, _: &std::path::Path) -> Result<(), String> {
            Err("no player".into())
        }
    }
    poke(&mut rt, |s| s.reveal = Some(Arc::new(Broken)));
    click(&mut rt, "clips/reveal");
    assert!(rt.state.toasts.last().unwrap().toast.text.contains("no file manager"));
}

/// Notifications: only when the window is not in front and Preferences allows it.
#[test]
fn notifications_follow_focus_and_the_preference() {
    let job = |status: &str, err: Option<&str>| Job { id: "j1".into(), video_id: "v".into(), status: status.into(), current_stage: None, error_message: err.map(Into::into), created_at: String::new(), updated_at: String::new() };
    let rows = [
        (true, true, "COMPLETED", None, 0),
        (false, false, "COMPLETED", None, 0),
        (false, true, "COMPLETED", None, 1),
        (false, true, "FAILED", Some("boom"), 1),
        (false, true, "FAILED", Some("interrupted"), 1),
        (false, true, "CANCELLED", None, 0),
        (false, true, "RUNNING", None, 0),
    ];
    for (focused, pref, status, err, sent) in rows {
        let (mut rt, _, _, notifier) = clips_rt();
        let (before, after) = (job("RUNNING", None), job(status, err));
        poke(&mut rt, move |s| {
            (s.focused, s.notifications) = (focused, pref);
            s.jobs = vec![before];
            s.apply(Msg::Snapshot(Snapshot { jobs: vec![after], videos: vec![], readiness: vec![] }));
        });
        assert_eq!(notifier.sent.lock().unwrap().len(), sent, "{focused} {pref} {status}");
    }
    // an ended job that was never seen running is not announced, and a state with no notifier is quiet
    let (mut rt, _, _, notifier) = clips_rt();
    let (done, running) = (job("COMPLETED", None), job("RUNNING", None));
    poke(&mut rt, move |s| {
        s.focused = false;
        s.apply(Msg::Snapshot(Snapshot { jobs: vec![done.clone()], videos: vec![], readiness: vec![] }));
        s.notifier = None;
        s.jobs = vec![running];
        s.apply(Msg::Snapshot(Snapshot { jobs: vec![done], videos: vec![], readiness: vec![] }));
    });
    assert!(notifier.sent.lock().unwrap().is_empty());
    // a click on a notification opens its job
    poke(&mut rt, |s| s.apply(Msg::OpenJob("j9".into())));
    assert_eq!((rt.state.screen(), rt.state.job.id.as_str()), (Screen::Job, "j9"));
}

/// The script every stage reports once, in order, ending completed.
#[test]
fn the_stage_script_walks_every_stage_then_completes() {
    let steps = stage_script("j", "v");
    assert_eq!((steps.len(), steps[0].job.status.as_str(), steps.last().unwrap().job.status.as_str()), (24, "QUEUED", "COMPLETED"));
    let active: Vec<_> = steps.iter().filter_map(|d| d.stages.iter().find(|s| s.status == "IN_PROGRESS").map(|s| s.stage.clone())).collect();
    assert_eq!(active.len(), 22);
    assert_eq!(active.first().unwrap(), "IMPORT");
    assert_eq!(active.last().unwrap(), "EXPORT");
}

/// Every button that moves between screens goes where it says; a job that runs, is cancelled and
/// retried; the drop field lights while a drag is over it.
#[test]
fn navigation_buttons_and_a_cancelled_then_retried_job() {
    let (mut rt, fake) = home_rt();
    let mut running = detail("RUNNING", None, &[("IMPORT", "IN_PROGRESS", None)]);
    let mut failed = detail("FAILED", Some("boom"), &[("IMPORT", "FAILED", None)]);
    (running.job.id, failed.job.id) = ("jnew".into(), "jnew".into());
    fake.job_steps(vec![running, failed]);

    let at = rt.find("home/drop").unwrap();
    rt.drag_files(vec![PathBuf::from("a.mp4")], Some(at));
    rt.frame(1.0 / 60.0);
    assert!(rt.state.home.dropping);
    rt.drag_files_leave();
    rt.frame(1.0 / 60.0);
    assert!(!rt.state.home.dropping);

    type_text(&mut rt, "home/link", "https://youtu.be/abc");
    click(&mut rt, "home/import");
    assert!(has(&rt, "job/cancel") && !has(&rt, "job/retry"));
    click(&mut rt, "job/cancel");
    assert!(fake.calls().contains(&"cancel_job(jnew)".to_string()));
    click(&mut rt, "job/retry");
    assert!(fake.calls().contains(&"retry_job(jnew)".to_string()));
    click(&mut rt, "job/home");
    assert_eq!(rt.state.screen(), Screen::Home);
    click(&mut rt, "home/job/jnew");
    assert_eq!(rt.state.screen(), Screen::Job);

    poke(&mut rt, |s| s.show_clips("vnew"));
    click(&mut rt, "clips/edit");
    assert_eq!(rt.state.screen(), Screen::Editor);
    click(&mut rt, "editor/export");
    assert!(fake.calls().contains(&"export(c2)".to_string()));
    click(&mut rt, "editor/back");
    click(&mut rt, "clips/home");
    assert_eq!(rt.state.screen(), Screen::Home);
    // a failed option read and a failed clip read say so
    poke(&mut rt, |s| s.edit_options = None);
    fake.fail_once("options", EngineError::Network("down".into()));
    click(&mut rt, "home/options-toggle");
    fake.fail_once("clips", EngineError::Network("down".into()));
    poke(&mut rt, |s| s.show_clips("vnew"));
    let texts: Vec<_> = rt.state.toasts.iter().map(|t| t.toast.text.clone()).collect();
    assert!(texts.iter().any(|t| t.starts_with("Could not read the options")) && texts.iter().any(|t| t.starts_with("Could not read the clips")), "{texts:?}");
}
