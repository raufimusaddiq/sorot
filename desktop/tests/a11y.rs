//! Accessibility on every screen: each interactive node has a role and a name, verdict marks speak
//! their word, and focus order follows the reading order.


use serde_json::Value;
use sorot_desktop::app::SCENES;
use crate::support::*;

fn interactive<'a>(node: &'a Value, out: &mut Vec<&'a Value>) {
    if node["actions"].as_array().is_some_and(|a| a.iter().any(|x| x == "click" || x == "focus")) {
        out.push(node);
    }
    node["children"].as_array().into_iter().flatten().for_each(|c| interactive(c, out));
}

/// Every interactive node: a real role and a non-empty name. Every clip row names its verdict word.
#[test]
fn every_screen_names_what_a_person_can_press() {
    for name in SCENES.iter().map(|(n, _)| *n) {
        let rt = scene_rt(name);
        let (tree, mut found) = (rt.accessibility_json(), vec![]);
        interactive(&tree, &mut found);
        for n in found {
            let (role, label) = (n["role"].as_str().unwrap_or_default(), n["name"].as_str().unwrap_or_default());
            assert!(!role.is_empty() && !matches!(role, "group" | "generic") && !label.trim().is_empty(), "{name}: {n}");
        }
    }
    let rt = scene_rt("clips-ranked");
    let tree = rt.accessibility_json();
    let mut rows = vec![];
    interactive(&tree, &mut rows);
    let words: Vec<&str> = rows.iter().filter(|n| n["key"].as_str().is_some_and(|k| k.starts_with("clips/row/"))).map(|n| n["name"].as_str().unwrap()).collect();
    assert_eq!(words.len(), 3);
    assert!(["clips.verdict.PASS", "clips.verdict.REVIEW", "clips.verdict.FAIL"].iter().all(|k| words.iter().any(|n| n.ends_with(&sorot_desktop::i18n::tr(sorot_desktop::i18n::Lang::Id, k)))), "{words:?}");
}

/// Focus order never jumps back up the page unless it moves on to a column to the right.
#[test]
fn focus_order_follows_the_reading_order() {
    for name in SCENES.iter().map(|(n, _)| *n) {
        let rt = scene_rt(name);
        let order: Vec<_> = rt.elements().into_iter().filter(|e| e.focusable && !e.exiting).collect();
        for pair in order.windows(2) {
            let (a, b) = (pair[0].rect, pair[1].rect);
            let jumps_up = b[1] + b[3] < a[1];
            assert!(!jumps_up || b[0] > a[0], "{name}: {:?} then {:?}", pair[0].key, pair[1].key);
        }
    }
}
