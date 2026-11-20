//! R-26/R-35: one tap on every interactive control of every scene, on Rune's in-process headless
//! `Runtime`. A control that changes no state, opens nothing and sends no request is dead and fails.
//! The element-by-element evidence goes to `desktop/design/clickthrough.md`.

use std::sync::Arc;

use rune::{Env, Runtime};
use serde_json::Value;
use sorot_desktop::app::{SCENES, State, view};
use sorot_desktop::engine::fake::{FakeEngine, RecordReveal};

use crate::support::click;

/// True no-ops, by `scene/key`, each with the one-line reason it is not dead. Listed explicitly
/// (never by role) so adding a new one is a deliberate change to this file and to the report.
const NO_OP: &[(&str, &str)] = &[
    ("home-empty/shell/rail/home", "already on Home — same scene, no navigation to make"),
    ("home-interrupted/shell/rail/home", "already on Home — same scene, no navigation to make"),
    ("clips-ranked/clips/tab/all", "filter is already 'all' — re-selecting the active tab does nothing"),
    ("clips-ranked/clips/row/c2", "c2 is the first ranked clip and already selected"),
    ("clips-publish/clips/tab/all", "filter is already 'all' — re-selecting the active tab does nothing"),
    ("clips-publish/clips/row/c2", "c2 is the first ranked clip and already selected"),
    ("clips-reranked/clips/tab/all", "filter is already 'all' — re-selecting the active tab does nothing"),
    ("clips-reranked/clips/row/c2", "c2 is the first ranked clip and already selected"),
    ("generate-settings/gen/voice/kenari/model/0", "this Kenari TTS model is already selected"),
    ("generate-settings/gen/voice/voice/id/0", "this Indonesian voice is already selected"),
    ("generate-settings/gen/voice/voice/en/2", "this English voice is already selected"),
    ("generate-settings/gen/image/kenari/model/1", "this Kenari image model is already selected"),
    ("generate/generate/nav/projects", "already on the Projects view"),
    ("generate-flow/generate/nav/projects", "already on the Projects view"),
    ("discover/discover/mode/auto", "discover mode is already Auto"),
    ("publish/publish/tab/0", "the TikTok tab is already selected"),
    ("publish/publish/0/direct", "direct posting is already selected"),
    ("palette-open/palette/input", "the command palette autofocuses this field; tapping an already-focused field moves nothing"),
];

/// A node a person can press, from the accessibility tree the binary's `--tree` dumps.
fn interactive<'a>(node: &'a Value, out: &mut Vec<&'a Value>) {
    if node["actions"].as_array().is_some_and(|a| a.iter().any(|x| x == "click" || x == "focus")) {
        out.push(node);
    }
    node["children"].as_array().into_iter().flatten().for_each(|c| interactive(c, out));
}

/// The observable result of one tap: a11y tree shape and states, engine calls, and the platform
/// requests the headless runtime latches (dialog, pop-up menu, URL, clipboard, shell, reveal).
/// Focus flags and animation-only element fields are deliberately excluded: a tap on any focusable
/// control flips `focused`/`focus_visible`, which would let a dead button pass as "tree changed".
struct Snapshot {
    a11y: Vec<String>,
    calls: Vec<String>,
    dialog: Option<String>,
    menu: bool,
    urls: Vec<String>,
    copy: Option<String>,
    shell: Option<String>,
    reveal: RevealSnapshot,
}

/// What the app asked `Reveal` to do (open a browser or a file/folder), recorded by `RecordReveal`.
#[derive(Default, PartialEq)]
struct RevealSnapshot {
    shown: usize,
    opened: usize,
    urls: Vec<String>,
}

fn flat(node: &Value, out: &mut Vec<String>) {
    let role = node["role"].as_str().unwrap_or_default();
    let parts: Vec<String> = ["role", "key", "name", "states", "selected", "value", "placeholder"]
        .iter().filter_map(|k| {
            let v = &node[k];
            let s = match v {
                Value::String(s) => s.clone(),
                Value::Array(a) => a.iter().filter_map(Value::as_str)
                    .filter(|x| *x != "focused") // focus flags are handled explicitly, not as a tree change
                    .collect::<Vec<_>>().join(","),
                Value::Bool(b) => b.to_string(),
                Value::Number(n) => n.to_string(),
                _ => return None,
            };
            (!s.is_empty()).then(|| format!("{k}={s}"))
        }).collect();
    if !parts.is_empty() || !node["actions"].is_null() {
        out.push(parts.join(" "));
    }
    // Focus counts only when it moves into a text field, as its own explicit effect.
    let input = matches!(role, "text-input" | "multiline-text-input" | "password-input" | "search-input");
    if input && node["states"].as_array().is_some_and(|a| a.iter().any(|x| x == "focused"))
        && let Some(key) = node["key"].as_str() {
        out.push(format!("text-focus={key}"));
    }
    node["children"].as_array().into_iter().flatten().for_each(|c| flat(c, out));
}

/// Requests are drained where Rune exposes only a draining accessor (`take_url_requests`); call
/// once per snapshot before and after the tap, never twice on the same runtime state.
fn snapshot(rt: &mut Runtime<State>, fake: &FakeEngine, reveal: &RecordReveal) -> Snapshot {
    let mut a11y = vec![];
    flat(&rt.accessibility_json(), &mut a11y);
    let calls = fake.call_log();
    let dialog = rt.file_dialog().map(|(kind, _)| format!("{kind:?}"));
    let menu = rt.popup_menu().is_some();
    let urls = rt.take_url_requests();
    let copy = rt.copy_request.as_ref().map(|c| c.content().text().to_string());
    let shell = rt.shell_request.map(|s| format!("{s:?}"));
    let reveal = RevealSnapshot {
        shown: reveal.shown.lock().unwrap().len(),
        opened: reveal.opened.lock().unwrap().len(),
        urls: reveal.urls.lock().unwrap().clone(),
    };
    Snapshot { a11y, calls, dialog, menu, urls, copy, shell, reveal }
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

/// A `role=textbox` node that took focus: the only focus change allowed to prove a tap alive.
fn text_field(s: &[String]) -> Option<&str> {
    s.iter().find_map(|v| v.strip_prefix("text-focus="))
}

fn key_of(s: &str) -> &str {
    field(s, "key").unwrap_or(s)
}

fn label(s: &str) -> &str {
    full_field(s, "name").or_else(|| field(s, "key")).unwrap_or("?")
}

fn a11y_index(list: &[String]) -> std::collections::BTreeMap<&str, &str> {
    list.iter().filter(|s| !s.starts_with("text-focus=")
        && field(s, "role") != Some("status") && field(s, "role") != Some("alert"))
        .map(|s| (key_of(s), s.as_str())).collect()
}

/// One line per changed node: a key that appeared is `opened`, one that vanished is `closed`, and
/// a key present in both whose states/value changed is named as a state flip. Keyed by `key` so a
/// node that merely moves in the tree is not reported as a close plus an open. Empty names fall
/// back to the key — never print a bare `show `/`hide `.
fn state_change(before: &[String], after: &[String]) -> Vec<String> {
    let (b, a) = (a11y_index(before), a11y_index(after));
    let flip = |s: &str| {
        let flags = field(s, "states").unwrap_or_default();
        let selection = field(s, "selected").unwrap_or_default();
        let value = full_field(s, "value").unwrap_or_default();
        let mut parts = vec![];
        if !flags.is_empty() { parts.push(flags.to_string()); }
        if !selection.is_empty() { parts.push(format!("selected={selection}")); }
        if !value.is_empty() { parts.push(format!("value={value}")); }
        if parts.is_empty() { "changed".into() } else { parts.join(" ") }
    };
    let mut out = vec![];
    for (key, node) in &a {
        match b.get(key) {
            None => out.push(format!("opened {} (`{key}`)", label(node))),
            Some(old) if *old != *node => out.push(format!("{} of `{}`: {} → {}", label(node), key, flip(old), flip(node))),
            _ => {}
        }
    }
    for (key, node) in &b {
        if !a.contains_key(key) { out.push(format!("closed {} (`{key}`)", label(node))); }
    }
    out
}

/// What changed for the report: engine calls, opened/closed nodes, state flips, toasts, and
/// platform requests. Copy is whatever the app renders now, after T110's approved copy rewrite.
fn effect(before: &Snapshot, after: &Snapshot) -> String {
    let mut out: Vec<String> = vec![];
    let new_calls: Vec<&str> = after.calls.iter().skip(before.calls.len()).map(String::as_str).collect();
    if !new_calls.is_empty() {
        out.push(format!("Engine::{}", new_calls.join(", Engine::")));
    }
    out.extend(state_change(&before.a11y, &after.a11y));
    let toasts: Vec<&str> = after.a11y.iter().filter(|s| !before.a11y.contains(s))
        .filter(|s| field(s, "role") == Some("status") || field(s, "role") == Some("alert"))
        .filter_map(|s| full_field(s, "name")).collect();
    if !toasts.is_empty() {
        out.push(format!("toast \"{}\"", toasts.join(" / ")));
    }
    if let Some(k) = text_field(&after.a11y).filter(|k| text_field(&before.a11y) != Some(k)) {
        out.push(format!("focus text field `{k}`"));
    }
    if before.dialog != after.dialog {
        out.push(format!("dialog {}", after.dialog.as_deref().unwrap_or("closed")));
    }
    if before.menu != after.menu {
        out.push(if after.menu { "menu opened".into() } else { "menu closed".into() });
    }
    let new_urls: Vec<&str> = after.urls.iter().skip(before.urls.len()).map(String::as_str).collect();
    if !new_urls.is_empty() {
        out.push(format!("open URL {}", new_urls.join(", ")));
    }
    if before.copy != after.copy {
        out.push(format!("clipboard \"{}\"", after.copy.as_deref().unwrap_or("cleared")));
    }
    if before.shell != after.shell {
        out.push(format!("shell {}", after.shell.as_deref().unwrap_or("request cleared")));
    }
    if before.reveal.shown != after.reveal.shown {
        out.push(format!("reveal {} path(s)", after.reveal.shown - before.reveal.shown));
    }
    if before.reveal.opened != after.reveal.opened {
        out.push(format!("open {} file(s)", after.reveal.opened - before.reveal.opened));
    }
    let new_reveal_urls: Vec<&str> = after.reveal.urls.iter().skip(before.reveal.urls.len()).map(String::as_str).collect();
    if !new_reveal_urls.is_empty() {
        out.push(format!("browser {}", new_reveal_urls.join(", ")));
    }
    out.join(", ")
}

/// A tall window: settings and discover pages scroll far past a laptop viewport, and a tap on a
/// control outside it lands on nothing. Rune's headless runtime needs no pixels, so height is free.
fn tall(state: State) -> Runtime<State> {
    let mut rt = Runtime::new(state, view, (1100.0, 3200.0), Env { system_dark: true, scale: 1.0 });
    rt.frame(0.0);
    rt
}

/// A tap changes the tree, a state, or asks the engine or OS for something. Disabled controls say
/// why they cannot.
#[test]
fn every_control_responds_to_one_tap() {
    let mut report = String::from("# Click-through (R-26/R-35)\n\nOne tap per interactive control, on Rune's in-process headless runtime against `FakeEngine`.\n\
        `cargo test --test suite clickthrough::` writes this file. Controls come from the same accessibility tree that the binary's `--tree` dumps. A tap counts when it changes a state, opens something or sends a request to the engine or OS; one that changes nothing fails the test (R-26).\n\
        Focus flags are excluded from the comparison (every focusable control flips them); focus counts only when it moves into a text field. Copy is recorded as the app renders it now (T110's approved rewrite is applied). Native-only inputs — argv forwarding and resize — stay in the L3 journeys in `headless_flows.rs`; the things a control asks the OS for (file dialog, menu, URL, clipboard, shell, reveal) are read from the headless runtime.\n\n");
    let mut checked = 0usize;
    let mut disabled = 0usize;
    let mut dead = vec![];
    let mut seen_no_op = std::collections::BTreeSet::new();

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
            // Hold the concrete doubles: state stores them as trait objects, and the engine call
            // log and reveal log are FakeEngine/RecordReveal-only (no test API on the prod traits).
            let fake = Arc::new(FakeEngine::scene(scene));
            let reveal = Arc::new(RecordReveal::default());
            state.engine = Some(fake.clone());
            state.reveal = Some(reveal.clone());
            let mut rt = tall(state);
            for _ in 0..8 { rt.frame(1.0 / 60.0); }
            let before = snapshot(&mut rt, &fake, &reveal);
            click(&mut rt, &key);
            let after = snapshot(&mut rt, &fake, &reveal);
            let tree_changed = before.a11y != after.a11y;
            let calls_changed = before.calls != after.calls;
            let requested = before.dialog != after.dialog || before.menu != after.menu || before.urls != after.urls
                || before.copy != after.copy || before.shell != after.shell || before.reveal != after.reveal;
            let paused = off && !tree_changed && !calls_changed && !requested;
            let id = format!("{scene}/{key}");
            let no_op = NO_OP.iter().find(|(k, _)| *k == id);
            let accepted = paused || no_op.is_some();
            if let Some((k, _)) = no_op { seen_no_op.insert(*k); }
            if off { disabled += 1; }
            if !accepted && !tree_changed && !calls_changed && !requested { dead.push(id); }
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
    report.push_str(&format!("{checked} controls, {disabled} disabled, {} dead.\n", dead.len()));
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("design/clickthrough.md");
    std::fs::write(&path, &report).unwrap();
    assert_eq!(seen_no_op, NO_OP.iter().map(|(k, _)| *k).collect::<std::collections::BTreeSet<_>>(), "a no-op table row is not a control in any scene");
    assert!(dead.is_empty(), "dead controls: {}", dead.join(", "));
    eprintln!("clickthrough: {checked} controls");
}
