//! L3: journeys on the real binary, headless. Each row is a scene, an optional script under
//! `scripts/headless/`, and what the final tree must show. Stories add their journeys as rows.

use crate::support::headless::*;

/// `(scene, script, texts, named)`: `(key, text)` pairs the tree must show, and keys that must have a
/// role and a name, and the `source` that `workspace.json` must end up with (the journey chose a library).
type Flow = (&'static str, Option<&'static str>, &'static [(&'static str, &'static str)], &'static [&'static str], Option<&'static str>);

/// A journey's marks: `(mark, key shown, key gone)`.
type Marks = &'static [(&'static str, &'static str, &'static str)];

const FLOWS: &[Flow] = &[
    ("home-empty", None, &[("home/empty/cause", "No videos yet")], &["home/empty"], None),
    ("readiness-missing", None, &[("readiness/title", "Sorot needs a few things first"), ("readiness/whisperModel/progress", "Downloading 40%")], &["readiness/title", "readiness/ffmpeg/fix"], None),
    ("engine-failed", None, &[("engine/failed/cause", "The engine stopped before it was ready.")], &["engine/failed", "engine/restart"], None),
    ("engine-failed", Some("restart-engine"), &[("engine/starting/cause", "Starting the engine")], &["engine/starting"], None),
    ("first-run", Some("us1-first-run"), &[("home/empty/cause", "No videos yet")], &["home/empty", "shell/rail/home"], Some("adopted")),
];

#[test]
fn every_flow_ends_where_it_should_without_overlap_or_clipping() {
    for (scene, script, texts, named, source) in FLOWS {
        let config = temp_dir();
        let tree = run_env(scene, *script, &[], &[("SOROT_CONFIG_DIR", &config)]);
        if let Some(source) = source {
            let saved: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(config.join("workspace.json")).unwrap()).unwrap();
            assert_eq!(saved["source"], *source, "{scene}");
        }
        for (key, text) in *texts {
            assert_text(&tree, key, text);
        }
        for key in *named {
            assert_role_label(&tree, key);
        }
        assert_eq!(overlaps(&tree), Vec::<(String, String)>::new(), "{scene}");
        assert_eq!(clipped_text(&tree), Vec::<String>::new(), "{scene}");
    }
}

#[test]
fn the_scenes_are_listed_and_render_in_both_themes() {
    assert_eq!(output(&["--list-scenes"]).lines().collect::<Vec<_>>(), ["home-empty", "readiness-missing", "engine-failed", "first-run", "job-running", "clips-ranked", "clips-reranked", "editor-hook", "connections", "generate-settings", "generate-no-ai", "generate", "generate-flow", "learning", "discover", "publish"]);
    for theme in ["dark", "light"] {
        let png = snap("readiness-missing", theme, "900x600");
        let _ = std::fs::remove_file(png);
    }
}

/// US2 journeys, binary only: the screen reached at each mark, and the one reveal call at the end.
/// Per-control calls are L2.
#[test]
fn the_us2_journeys_reach_their_screens() {
    let at = |script: &str, mark: &str, log: &std::path::Path| run_at("home-empty", Some(script), mark, &[], &[("SOROT_REVEAL_LOG", log)]);
    let has = |t: &Tree, key: &str| t.0["elements"].as_array().unwrap().iter().any(|e| e["key"] == key);

    let log = temp_dir().join("reveal.log");
    for (mark, shown, absent) in [("job", "job/progress", "home/drop"), ("clips", "clips/list", "job/progress"), ("second", "clips/row/c1", "home/drop"), ("end", "clips/reveal", "job/progress")] {
        let tree = at("us2-drop-to-export", mark, &log);
        assert!(has(&tree, shown) && !has(&tree, absent), "{mark}: {shown} shown, {absent} gone");
        assert_eq!((overlaps(&tree), clipped_text(&tree)), (vec![], vec![]), "{mark}");
    }
    assert_text(&at("us2-drop-to-export", "second", &log), "clips/detail/verdict", "Review");
    let single = temp_dir().join("single.log");
    at("us2-drop-to-export", "end", &single);
    assert_eq!(std::fs::read_to_string(&single).unwrap().lines().collect::<Vec<_>>(), ["/exports/c1_final.mp4"]);

    let tree = at("us2-pick-file", "end", &log);
    assert!(has(&tree, "job/progress") && !has(&tree, "home/choose-file"), "a picked file opens its job");
}

/// US5 journeys, binary only: the screen reached at each mark and the end state. The rules and the
/// per-control routes are L1 and L2.
#[test]
fn the_us5_journeys_reach_their_screens() {
    // the publish page (T-15) is taller than the default window, so its journey runs in a tall one
    let at = |scene: &str, script: &str, mark: &str| run_at(scene, Some(script), mark, if matches!(scene, "publish" | "generate-flow") { &["--size", "1100x2400"] } else { &[] }, &[]);
    let has = |t: &Tree, key: &str| t.0["elements"].as_array().unwrap().iter().any(|e| e["key"] == key);

    // (scene, script, [(mark, key shown, key absent)]): no AI connection, then one saved, then Generate is open
    let journeys: [(&str, &str, Marks); 3] = [
        ("generate-no-ai", "us5-connect-then-generate", &[("settings", "conn/llm/key", "generate/unavailable"), ("end", "generate/ready", "generate/unavailable")]),
        (
            "generate-flow",
            "us5-generate-end-to-end",
            &[("stories", "generate/step/stories", "generate/brief/create"), ("plan", "generate/plan/approve", "generate/story/0/pick"), ("approved", "generate/build/start", "generate/build/gate"), ("built", "generate/build/start", "generate/build/cancel"), ("end", "generate/build/accepted", "generate/build/accept")],
        ),
        ("generate-flow", "us5-generate-to-post", &[("exported", "generate/build/publish", "generate/build/export"), ("choices", "publish/post", "publish/post/p9/row"), ("end", "publish/post/p9/row", "publish/post")]),
    ];
    for (scene, script, marks) in journeys {
        for (mark, shown, absent) in marks {
            let tree = at(scene, script, mark);
            assert!(has(&tree, shown) && !has(&tree, absent), "{script} at {mark}: {shown} shown, {absent} gone");
            if shown.starts_with("generate/") {
                assert_eq!((overlaps(&tree), clipped_text(&tree)), (vec![], vec![]), "{script} at {mark}");
            }
        }
    }
}

/// Reflow: each main screen from 1280x800 down to the 960x640 minimum and back up; at every stop no
/// text is clipped and no two controls overlap.
#[test]
fn the_main_screens_reflow_without_clipping_or_overlap() {
    for scene in ["home-empty", "job-running", "clips-ranked", "editor-hook"] {
        for mark in ["wide", "small", "end"] {
            let tree = run_at(scene, Some("us3-resize"), mark, &["--size", "1280x800"], &[]);
            assert_eq!((overlaps(&tree), clipped_text(&tree)), (vec![], vec![]), "{scene} at {mark} ({:?})", tree.0["viewport"]);
        }
    }
}
