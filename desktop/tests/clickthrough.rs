//! R-26/R-35: one tap on every interactive control of every scene, on Rune's in-process headless
//! `Runtime`. A control that changes neither the tree nor the engine call log is dead and fails.
//! The element-by-element evidence goes to `desktop/design/clickthrough.md`.

use std::time::Instant;

use rune::{Env, Runtime};
use serde_json::Value;
use sorot_desktop::app::{SCENES, State, view};

use crate::support::click;

/// True no-ops, by `scene/key`, each with the one-line reason it is not dead. Listed explicitly
/// (never by role) so adding a new one is a deliberate change to this file and to the report.
const NO_OP: &[(&str, &str)] = &[
    ("palette-open/palette/input", "the command palette autofocuses this field; tapping an already-focused field moves nothing"),
];

/// A node a person can press, from the accessibility tree the binary's `--tree` dumps.
fn interactive<'a>(node: &'a Value, out: &mut Vec<&'a Value>) {
    if node["actions"].as_array().is_some_and(|a| a.iter().any(|x| x == "click" || x == "focus")) {
        out.push(node);
    }
    node["children"].as_array().into_iter().flatten().for_each(|c| interactive(c, out));
}

/// The tree as text: what a screen reader hears, plus the drawn keys that carry the visual state.
/// Animation-only fields are left out so a tap is not mistaken for a control that merely pulses.
struct Snapshot {
    a11y: Vec<String>,
    keys: Vec<String>,
    calls: Vec<String>,
}

fn flat(node: &Value, out: &mut Vec<String>) {
    let parts: Vec<String> = ["role", "key", "name", "text", "value", "states", "selected", "placeholder"]
        .iter().filter_map(|k| node[k].as_str().map(|s| format!("{k}={s}"))).collect();
    if !parts.is_empty() || !node["actions"].is_null() {
        out.push(parts.join(" "));
    }
    node["children"].as_array().into_iter().flatten().for_each(|c| flat(c, out));
}

fn snapshot(rt: &Runtime<State>) -> Snapshot {
    let mut a11y = vec![];
    flat(&rt.accessibility_json(), &mut a11y);
    let keys = rt.elements().iter().map(|e| format!("{:?}|{:?}|{:?}|{:?}|{}", e.key, e.text, e.selected, e.focus_visible, e.focused)).collect();
    let calls = rt.state.engine.as_ref().map_or_else(Vec::new, |e| e.call_log());
    Snapshot { a11y, keys, calls }
}

fn field<'a>(s: &'a str, name: &str) -> Option<&'a str> {
    s.split_once(&format!("{name}=")).map(|(_, rest)| rest.split(' ').next().unwrap_or("")).filter(|v| !v.is_empty())
}

/// A field's full value: later fields are space-separated too, so cut at the next known name.
fn full_field<'a>(s: &'a str, name: &str) -> Option<&'a str> {
    let v = s.split_once(&format!("{name}="))?.1;
    let end = [" text=", " value=", " states=", " selected=", " placeholder="]
        .iter().filter_map(|n| v.find(n)).min().unwrap_or(v.len());
    Some(&v[..end]).filter(|v| !v.is_empty())
}

fn focused_keys(s: &[String]) -> Vec<&str> {
    s.iter().filter_map(|v| v.contains("focused").then(|| field(v, "key")).flatten()).collect()
}

/// What changed for the report: engine calls, what took focus, and what a person now reads (a
/// toast). Copy is whatever the app renders now; T110's rewrite is pending the owner.
fn effect<'a>(before: &'a Snapshot, after: &'a Snapshot) -> String {
    let mut out = vec![];
    let new_calls: Vec<&str> = after.calls.iter().skip(before.calls.len()).map(String::as_str).collect();
    if !new_calls.is_empty() {
        out.push(format!("Engine::{}", new_calls.join(", Engine::")));
    }
    let (was, now) = (focused_keys(&before.a11y), focused_keys(&after.a11y));
    if let Some(k) = now.iter().find(|k| !was.contains(k)) {
        out.push(format!("focus `{k}`"));
    }
    let toasts: Vec<&str> = after.a11y.iter().filter(|s| !before.a11y.contains(s))
        .filter(|s| field(s, "role") == Some("status"))
        .filter_map(|s| full_field(s, "name")).collect();
    if !toasts.is_empty() {
        out.push(format!("toast \"{}\"", toasts.join(" / ")));
    }
    if out.is_empty() { "(tree changed)".into() } else { out.join(", ") }
}

/// A tall window: settings and discover pages scroll far past a laptop viewport, and a tap on a
/// control outside it lands on nothing. Rune's headless runtime needs no pixels, so height is free.
fn tall(state: State) -> Runtime<State> {
    let mut rt = Runtime::new(state, view, (1100.0, 3200.0), Env { system_dark: true, scale: 1.0 });
    rt.frame(0.0);
    rt
}

/// A tap changes the tree or asks the engine something. Disabled controls say why they cannot.
#[test]
fn every_control_responds_to_one_tap() {
    let started = Instant::now();
    let mut report = String::from("# Click-through (R-26/R-35)\n\nOne tap per interactive control, on Rune's in-process headless runtime against `FakeEngine`.\n\
        `cargo test --test suite clickthrough::` writes this file. Controls come from the same accessibility tree that the binary's `--tree` dumps. A tap counts when it moves focus, changes state, opens something or calls the engine; one that changes nothing fails the test (R-26).\n\
        Copy is recorded as the app renders it now (T110's rewrite is pending the owner). Native-only inputs — argv forwarding, file dialogs, system menu picks and resize — are not nodes in `--tree`; they stay in the L3 journeys in `headless_flows.rs`.\n\n");
    let mut checked = 0usize;
    let mut disabled = 0usize;
    let mut dead = vec![];
    let mut seen_no_op = vec![];

    for (scene, build) in SCENES {
        let mut state = State::default();
        build(&mut state);
        let mut base = tall(state);
        for _ in 0..8 { base.frame(1.0 / 60.0); }
        let tree = base.accessibility_json();
        let mut controls = vec![];
        interactive(&tree, &mut controls);
        report.push_str(&format!("## `{scene}`\n\n"));
        for node in controls {
            let key = node["key"].as_str().unwrap().to_string();
            let off = node["states"].as_array().is_some_and(|s| s.iter().any(|v| v == "disabled"));
            let reason = node["name"].as_str().unwrap_or("");
            let mut state = State::default();
            build(&mut state);
            let mut rt = tall(state);
            for _ in 0..8 { rt.frame(1.0 / 60.0); }
            let before = snapshot(&rt);
            click(&mut rt, &key);
            let after = snapshot(&rt);
            let tree_changed = before.a11y != after.a11y || before.keys != after.keys;
            let calls_changed = before.calls != after.calls;
            let paused = off && !tree_changed && !calls_changed;
            let id = format!("{scene}/{key}");
            let no_op = NO_OP.iter().find(|(k, _)| *k == id);
            let accepted = paused || no_op.is_some();
            if let Some((k, _)) = no_op { seen_no_op.push(*k); }
            if off { disabled += 1; }
            if !accepted && !tree_changed && !calls_changed { dead.push(id); }
            let why = if let Some((_, reason)) = no_op { format!("no-op — {reason}") }
                else if off { format!("disabled ({reason})") }
                else { effect(&before, &after) };
            report.push_str(&format!("- `{key}` → {why}\n"));
            checked += 1;
        }
        report.push('\n');
    }

    report.push_str("## Explicit no-ops\n\n| Control | Reason |\n|---|---|\n");
    for (key, reason) in NO_OP {
        report.push_str(&format!("| `{key}` | {reason} |\n"));
    }
    report.push('\n');
    report.push_str(&format!("{checked} controls, {disabled} disabled, {} dead. Wall time {:.1}s.\n", dead.len(), started.elapsed().as_secs_f64()));
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("design/clickthrough.md");
    std::fs::write(&path, &report).unwrap();
    assert_eq!(seen_no_op, NO_OP.iter().map(|(k, _)| *k).collect::<Vec<_>>(), "a no-op table row is not a control in any scene");
    assert!(dead.is_empty(), "dead controls: {}", dead.join(", "));
    eprintln!("clickthrough: {checked} controls in {:.1}s", started.elapsed().as_secs_f64());
}
