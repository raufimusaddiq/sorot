//! L3: journeys on the real binary, headless. Each row is a scene, an optional script under
//! `scripts/headless/`, and what the final tree must show. Stories add their journeys as rows.

mod support;

use support::headless::*;

/// `(scene, script, texts, named)`: `(key, text)` pairs the tree must show, and keys that must have a
/// role and a name.
type Flow = (&'static str, Option<&'static str>, &'static [(&'static str, &'static str)], &'static [&'static str]);

const FLOWS: &[Flow] = &[
    ("home-empty", None, &[("home/empty/cause", "No videos yet")], &["home/empty"]),
    ("readiness-missing", None, &[("readiness/title", "Sorot needs a few things first"), ("readiness/whisperModel/progress", "Downloading 40%")], &["readiness/title", "readiness/ffmpeg/fix"]),
    ("engine-failed", None, &[("engine/failed/cause", "The engine stopped before it was ready.")], &["engine/failed", "engine/restart"]),
    ("engine-failed", Some("restart-engine"), &[("engine/starting/cause", "Starting the engine")], &["engine/starting"]),
];

#[test]
fn every_flow_ends_where_it_should_without_overlap_or_clipping() {
    for (scene, script, texts, named) in FLOWS {
        let tree = run(scene, *script, &[]);
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
    assert_eq!(output(&["--list-scenes"]).lines().collect::<Vec<_>>(), ["home-empty", "readiness-missing", "engine-failed"]);
    for theme in ["dark", "light"] {
        let png = snap("readiness-missing", theme, "900x600");
        let _ = std::fs::remove_file(png);
    }
}
