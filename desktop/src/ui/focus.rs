//! The keys of interactive elements, in one place. Views build them with the helpers here; the
//! toast and the L2 gate read `keys`, so a control cannot be omitted by a hand-kept list drifting
//! from the view.

use std::collections::HashSet;

use crate::app::State;
use crate::screens::clips::Filter;
use crate::screens::generate::STEPS;
use crate::screens::menu_bar::{Menu, actions, menu_items};
use crate::screens::settings::generate::{FIELDS as GEN_FIELDS, LEVELS};
use crate::screens::settings::image::FIELDS as IMAGE_FIELDS;
use crate::screens::settings::voice::LANGS;

pub fn home_job(id: &str) -> String { format!("home/job/{id}") }
pub fn home_interrupted(id: &str) -> String { format!("home/interrupted/{id}") }
pub fn home_retry(id: &str) -> String { format!("home/retry/{id}") }
pub fn clips_row(id: &str) -> String { format!("clips/row/{id}") }
pub fn clips_tab(f: Filter) -> String { format!("clips/tab/{}", f.id()) }
pub fn discover(id: &str, what: &str) -> String { format!("discover/c/{id}/{what}") }
pub fn polish_result(id: &str) -> String { format!("learning/log/{id}") }
pub fn welcome(i: usize, name: &str) -> String { if i == 0 { format!("welcome/{name}") } else { format!("welcome/{i}/{name}") } }
pub fn palette(k: &str) -> String { format!("palette/item/{k}") }
pub fn menu(m: Menu, k: &str) -> String { format!("shell/menu/{}/{k}", m.id()) }
pub fn gen_cmd(i: usize, name: &str) -> String { format!("gen/cmd/{i}/{name}") }
pub fn gen_model(i: usize, level: &str) -> String { format!("gen/model/{i}/{level}") }
pub fn gen_video(id: &str) -> String { format!("generate/video/{id}") }
pub fn readiness(id: &str, what: &str) -> String { format!("readiness/{id}/{what}") }
pub fn publish_account(id: &str) -> String { format!("publish/account/{id}") }
pub fn publish_tab(i: usize) -> String { format!("publish/tab/{i}") }
pub fn publish_post(id: &str, what: &str) -> String { format!("publish/post/{id}/{what}") }
pub fn publish_target(i: usize, what: &str) -> String { format!("publish/{i}/{what}") }

/// Fixed keys: every focusable element whose key does not carry an id or index from state.
const STATIC: &[&str] = &[
    "clips/edit", "clips/export", "clips/feedback", "clips/play", "clips/publish",
    "conn/jev/director", "conn/jev/enabled", "conn/jev/endpoint", "conn/jev/key", "conn/jev/model", "conn/jev/test",
    "conn/llm/director", "conn/llm/enabled", "conn/llm/endpoint", "conn/llm/env", "conn/llm/key", "conn/llm/mode-switch", "conn/llm/model", "conn/llm/test",
    "conn/tebar/enabled", "conn/tebar/endpoint", "conn/tebar/key", "conn/tebar/test",
    "discover/drain", "discover/goal", "discover/run",
    "editor/back", "editor/hook-first", "editor/music", "editor/reframe", "editor/rerender", "editor/silence-trim", "editor/style",
    "engine/restart", "gen/calibrate", "gen/cmd/add", "gen/cmd/save", "gen/cmd/test",
    "gen/image/enabled", "gen/image/key", "gen/image/mode-custom", "gen/image/mode-kenari", "gen/image/save", "gen/image/test",
    "gen/save", "gen/voice/enabled", "gen/voice/key", "gen/voice/mode-custom", "gen/voice/mode-kenari", "gen/voice/save", "gen/voice/test",
    "generate/nav/kit", "generate/nav/projects", "generate/nav/recipes", "generate/new", "generate/open-settings",
    "home/choose-file", "home/direction", "home/import", "home/link",
    "job/cancel", "job/retry", "palette/input", "publish/post", "publish/schedule/now", "publish/write",
    "readiness/fix-all", "settings/tab/connections", "settings/tab/general", "settings/tab/generate", "shell/export-diagnostic",
    "shell/menu/edit", "shell/menu/file", "shell/menu/help", "shell/menu/view", "shell/menu/window",
    "shell/rail/clips", "shell/rail/discover", "shell/rail/generate", "shell/rail/home", "shell/rail/learning", "shell/rail/settings",
    "welcome/continue",
];

/// Every focusable key the current state can put on screen. Static keys plus the per-id/per-index
/// rows the views build from the same helpers. No fixture ids.
pub fn keys(s: &State) -> Vec<String> {
    let mut out: HashSet<String> = STATIC.iter().map(|k| k.to_string()).collect();
    for j in &s.jobs {
        out.insert(home_job(&j.id));
        out.insert(home_interrupted(&j.id));
        out.insert(home_retry(&j.id));
    }
    for f in Filter::ALL {
        out.insert(clips_tab(f));
    }
    for c in &s.clips.clips {
        out.insert(clips_row(&c.id));
    }
    for i in s.readiness.iter().map(|r| r.id.as_str()) {
        out.insert(readiness(i, "fix"));
        out.insert(readiness(i, "retry"));
    }
    for (id, _, _) in actions(s) {
        out.insert(palette(id));
    }
    for m in Menu::ALL {
        out.insert(format!("shell/menu/{}", m.id()));
        for (id, _, _) in menu_items(s, m) {
            out.insert(menu(m, id));
        }
    }
    if let Some(w) = &s.welcome {
        for (i, c) in w.candidates.iter().enumerate() {
            out.insert(welcome(i, "copy"));
            if c.ok && c.problem.is_none() { out.insert(welcome(i, "use-here")); }
            out.insert(welcome(i, "fresh"));
        }
    }
    let d = &s.panels.discover;
    for (_, key, _) in crate::screens::discover::MODES { out.insert(format!("discover/mode/{key}")); }
    for (_, key, _) in crate::screens::discover::FILTERS { out.insert(format!("discover/filter/{key}")); }
    for c in &d.candidates {
        for what in ["pick", "yt", "import", "status", "more"] { out.insert(discover(&c.id, what)); }
    }
    let p = &s.panels.publish;
    for a in &p.accounts { out.insert(publish_account(&a.id)); }
    if let Some(draft) = &p.draft {
        for i in 0..draft.targets.len() {
            out.insert(publish_tab(i));
            for what in ["direct", "draft", "title", "kids-no", "kids-yes", "text", "privacy/0", "privacy/1"] { out.insert(publish_target(i, what)); }
        }
        for what in ["day", "month", "year", "hour", "minute"] { out.insert(format!("publish/schedule/{what}")); }
    }
    for post in &p.posts {
        for what in ["refresh", "retry", "cancel"] { out.insert(publish_post(&post.id, what)); }
        let targets: Vec<serde_json::Value> = post.targets.as_deref().and_then(|t| serde_json::from_str(t).ok()).unwrap_or_default();
        for i in 0..targets.len() { out.insert(publish_post(&post.id, &format!("target/{i}/open"))); }
    }
    for w in &s.panels.learning.waiting { out.insert(polish_result(&w.clip_id)); }
    for (_, key) in STEPS { out.insert(format!("generate/step/{key}")); out.insert(format!("generate/step/{key}/state")); }
    for proj in &s.panels.studio.projects { out.insert(gen_video(&proj.id)); }
    let g = &s.panels.generate;
    for i in 0..g.commands.items.len() {
        for what in ["name", "program", "args", "timeout", "remove"] { out.insert(gen_cmd(i, what)); }
    }
    if let Some(m) = &g.models {
        for i in 0..m.models.len() {
            out.insert(gen_model(i, "auto"));
            for lv in LEVELS { out.insert(gen_model(i, lv)); }
        }
    }
    for (name, _, _) in GEN_FIELDS { out.insert(format!("gen/field/{name}")); }
    if let Some(v) = &g.voice.view {
        out.insert("gen/voice/engine/none".into());
        for e in &v.engines { out.insert(format!("gen/voice/engine/{e}")); }
    }
    for (n, m) in g.voice.models.iter().enumerate() {
        out.insert(format!("gen/voice/kenari/model/{n}"));
        for (code, _) in LANGS {
            out.insert(format!("gen/voice/voice/{code}/default"));
            for j in 0..m.voices.len() { out.insert(format!("gen/voice/voice/{code}/{j}")); }
        }
    }
    out.insert(format!("gen/voice/kenari/model/{}", g.voice.models.len()));
    for (code, _) in LANGS { out.insert(format!("gen/voice/voice/{code}")); }
    for n in 0..=g.image.models.len() { out.insert(format!("gen/image/kenari/model/{n}")); }
    for (name, _) in IMAGE_FIELDS { out.insert(format!("gen/image/{name}")); }
    out.into_iter().collect()
}
