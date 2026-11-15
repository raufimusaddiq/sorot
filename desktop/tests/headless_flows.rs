//! L3: journeys on the real binary, headless. Each row is a scene, an optional script under
//! `scripts/headless/`, and what the final tree must show. Stories add their journeys as rows.

mod support;

use support::headless::*;

/// `(scene, script, texts, named)`: `(key, text)` pairs the tree must show, and keys that must have a
/// role and a name, and the `source` that `workspace.json` must end up with (the journey chose a library).
type Flow = (&'static str, Option<&'static str>, &'static [(&'static str, &'static str)], &'static [&'static str], Option<&'static str>);

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
    assert_eq!(output(&["--list-scenes"]).lines().collect::<Vec<_>>(), ["home-empty", "readiness-missing", "engine-failed", "first-run"]);
    for theme in ["dark", "light"] {
        let png = snap("readiness-missing", theme, "900x600");
        let _ = std::fs::remove_file(png);
    }
}
