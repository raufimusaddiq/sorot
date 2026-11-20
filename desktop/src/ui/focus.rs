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
pub fn readiness(id: &str, what: &str) -> String { if what.is_empty() { format!("readiness/{id}") } else { format!("readiness/{id}/{what}") } }
pub fn publish_account(id: &str) -> String { format!("publish/account/{id}") }
pub fn publish_tab(i: usize) -> String { format!("publish/tab/{i}") }
pub fn publish_post(id: &str, what: &str) -> String { format!("publish/post/{id}/{what}") }
pub fn publish_target(i: usize, what: &str) -> String { format!("publish/{i}/{what}") }
pub fn kit_part(name: &str, what: &str) -> String { format!("generate/kit/{name}/{what}") }
pub fn gen_log(id: &str) -> String { format!("generate/log/{id}") }
pub fn gen_log_open(id: &str) -> String { format!("generate/log/{id}/open") }
pub fn gen_fact(id: &str, what: &str) -> String { format!("generate/fact/{id}/{what}") }
pub fn gen_idea(id: &str, what: &str) -> String { format!("generate/idea/{id}/{what}") }
pub fn gen_finding(id: &str, what: &str) -> String { format!("generate/finding/{id}/{what}") }
pub fn gen_version(id: &str, what: &str) -> String { format!("generate/version/{id}/{what}") }
pub fn gen_story(i: usize, what: &str) -> String { if what.is_empty() { format!("generate/story/{i}") } else { format!("generate/story/{i}/{what}") } }
pub fn gen_plan_shot(i: usize, what: &str) -> String { if what.is_empty() { format!("generate/plan/shot/{i}") } else { format!("generate/plan/shot/{i}/{what}") } }
pub fn gen_recipe_step(i: usize, what: &str) -> String { if what.is_empty() { format!("generate/recipes/step/{i}") } else { format!("generate/recipes/step/{i}/{what}") } }
pub fn gen_recipe_with(i: usize, path: &str, what: &str) -> String { if what.is_empty() { format!("generate/recipes/step/{i}/with/{path}") } else { format!("generate/recipes/step/{i}/with/{path}/{what}") } }
pub fn gen_recipe(id: &str) -> String { format!("generate/recipe/{id}") }
pub fn gen_recipe_add(kind: &str) -> String { format!("generate/recipes/add/{kind}") }
pub fn gen_asset(id: &str, what: &str) -> String { if what.is_empty() { format!("generate/asset/{id}") } else { format!("generate/asset/{id}/{what}") } }
pub fn gen_brief(i: usize, what: &str) -> String { format!("generate/brief/{what}/{i}") }
pub fn gen_brief_file(i: usize, what: &str) -> String { if what.is_empty() { format!("generate/brief/file/{i}") } else { format!("generate/brief/file/{i}/{what}") } }
pub fn gen_ideas_pipeline(i: usize) -> String { format!("generate/ideas/pipeline/{i}") }
pub fn gen_step_page(key: &str, what: &str) -> String { format!("generate/{key}/{what}") }
pub fn gen_verdict(kind: &str) -> String { format!("generate/verdict/{kind}") }
pub fn gen_recipes_check(i: usize, what: &str) -> String { format!("generate/recipes/{what}/{i}") }
pub fn gen_build_shot(id: &str) -> String { format!("generate/build/shot/{id}") }
pub fn gen_step(key: &str, what: &str) -> String { if what.is_empty() { format!("generate/step/{key}") } else { format!("generate/step/{key}/{what}") } }
pub fn gen_steptab(key: &str) -> String { format!("generate/steptab/{key}") }
pub fn discover_step(i: usize) -> String { format!("discover/step/{i}") }
pub fn discover_mode(key: &str) -> String { format!("discover/mode/{key}") }
pub fn discover_filter(key: &str) -> String { format!("discover/filter/{key}") }
pub fn learning_result(id: &str, what: &str) -> String { if what.is_empty() { format!("learning/result/{id}") } else { format!("learning/result/{id}/{what}") } }
pub fn learning_waiting(id: &str) -> String { format!("learning/waiting/{id}") }
pub fn feedback_field(name: &str) -> String { format!("feedback/{name}") }
pub fn shell_menu(id: &str) -> String { format!("shell/menu/{id}") }
pub fn conn_kenari_model(n: usize) -> String { format!("conn/llm/kenari/model/{n}") }
pub fn conn_field(kind: &str, what: &str) -> String { format!("conn/{kind}/{what}") }
pub fn gen_reason(i: usize) -> String { format!("gen/reason/{i}") }
pub fn gen_model_group(n: usize) -> String { format!("gen/model/{n}") }
pub fn gen_image_model(n: usize) -> String { format!("gen/image/kenari/model/{n}") }
pub fn gen_image_field(name: &str) -> String { format!("gen/image/{name}") }
pub fn gen_voice_engine(e: &str) -> String { format!("gen/voice/engine/{e}") }
pub fn gen_voice_model(n: usize) -> String { format!("gen/voice/kenari/model/{n}") }
pub fn gen_voice_voice(code: &str, what: &str) -> String { if what.is_empty() { format!("gen/voice/voice/{code}") } else { format!("gen/voice/voice/{code}/{what}") } }
pub fn gen_field(name: &str) -> String { format!("gen/field/{name}") }
pub fn general_field(key: &str, slug: &str) -> String { format!("general/{key}/{slug}") }
pub fn general_shortcut(action: &str) -> String { format!("general/shortcut/{action}") }
pub fn with_suffix(base: &str, what: &str) -> String { format!("{base}/{what}") }

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
    "generate/versions/open", "generate/delete", "generate/steptab/brief", "generate/steptab/ideas", "generate/steptab/facts", "generate/steptab/stories", "generate/steptab/plan", "generate/steptab/build", "generate/steptab/verdict",
    "generate/kit/add", "generate/ideas/run-next", "generate/ideas/slug", "generate/ideas/brief", "generate/ideas/add",
    "generate/facts/verify", "generate/facts/claim", "generate/facts/value", "generate/facts/url", "generate/facts/add",
    "generate/story/note", "generate/story/more", "generate/plan/approve", "generate/plan/save", "generate/plan/request", "generate/plan/revise",
    "generate/build/start", "generate/build/cancel", "generate/build/continue", "generate/build/fix-must", "generate/build/note", "generate/build/shot/any", "generate/build/fix-note", "generate/build/watch", "generate/build/reveal-draft", "generate/build/accept", "generate/build/export", "generate/build/reveal", "generate/build/publish",
    "generate/versions/back", "generate/recipes/copy", "generate/recipes/tab/steps", "generate/recipes/tab/json", "generate/recipes/text", "generate/recipes/save", "generate/recipes/validate", "generate/recipes/delete", "generate/recipes/copy-id", "generate/recipes/copy-do", "generate/recipes/copy-cancel", "generate/recipes/export", "generate/recipes/import-text", "generate/recipes/import", "generate/recipes/name", "generate/recipes/name/set", "generate/recipes/add",
    "generate/brief/preset/none", "generate/brief/narration", "generate/brief/no-numbers", "generate/brief/facts/text", "generate/brief/text", "generate/brief/length", "generate/brief/style", "generate/brief/create",
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
    for (_, key) in STEPS { out.insert(gen_step(key, "")); out.insert(gen_step(key, "state")); out.insert(gen_steptab(key)); out.insert(gen_step_page(key, "title")); }
    for kind in ["technical", "creative"] { out.insert(gen_verdict(kind)); }
    for i in 0..s.panels.studio.pipelines.len() { out.insert(gen_ideas_pipeline(i)); }
    if let Some(c) = &s.panels.studio.recipes.checked {
        for i in 0..c.errors.len() { out.insert(gen_recipes_check(i, "error")); }
        for i in 0..c.warnings.len() { out.insert(gen_recipes_check(i, "warning")); }
    }
    for proj in &s.panels.studio.projects { out.insert(gen_video(&proj.id)); }
    // Generate sub-views. Every focusable key they build carries an id or index from State; derive
    // the same keys here so a toast cannot miss a control on Kit, Build, Recipes or a step page.
    let st = &s.panels.studio;
    for part in &st.kit.parts {
        out.insert(kit_part(&part.name, "export"));
        if part.source == "user" { out.insert(kit_part(&part.name, "remove")); }
    }
    if let Some(events) = &st.build.events {
        for ev in events { out.insert(gen_log(&ev.id)); out.insert(gen_log_open(&ev.id)); }
    }
    for fact in &st.facts.list {
        for what in ["claim", "claim-edit", "value-edit", "url-edit", "save", "cancel", "edit", "delete"] { out.insert(gen_fact(&fact.id, what)); }
    }
    for idea in &st.ideas.list {
        for what in ["card", "open", "run", "delete"] { out.insert(gen_idea(&idea.id, what)); }
    }
    for a in st.detail.iter().flat_map(|d| d.assets.iter()) { out.insert(gen_asset(&a.id, "remove")); }
    for i in 0..crate::screens::generate::brief::FORMATS.len() { out.insert(gen_brief(i, "format")); }
    for i in 0..crate::screens::generate::brief::LANGUAGES.len() { out.insert(gen_brief(i, "language")); }
    if let Some(crate::screens::generate::Avail::Yes { presets, .. }) = &st.avail {
        for i in 0..presets.len() { out.insert(gen_brief(i, "preset")); }
    }
    for i in 0..st.pipelines.len() { out.insert(gen_brief(i, "pipeline")); }
    for i in 0..st.brief.files.len() { out.insert(gen_brief_file(i, "remove")); }
    if let Some(d) = &st.detail {
        for (i, _) in d.project.storylines.iter().flatten().enumerate() { out.insert(gen_story(i, "pick")); out.insert(gen_story(i, "tags")); }
        if let Some(row) = d.current_plan() {
            for (i, shot) in row.plan.shots.iter().enumerate() {
                for what in ["seconds", "toggle", "look", "level", "visual", "motion"] { out.insert(gen_plan_shot(i, what)); }
                out.insert(gen_build_shot(&shot.id));
                for lv in LEVELS { out.insert(gen_plan_shot(i, &format!("level/{lv}"))); }
                for k in 0..shot.text.len() { out.insert(gen_plan_shot(i, &format!("text/{k}"))); }
            }
        }
        for v in &d.versions { for what in ["view", "restore"] { out.insert(gen_version(&v.id, what)); } }
    }
    if let Some(built) = &st.built {
        for v in &built.verdicts {
            for f in &v.findings { for what in ["fix", "text"] { out.insert(gen_finding(&f.id, what)); } }
        }
    }
    for item in &st.recipes.items { out.insert(gen_recipe(&item.id)); }
    for spec in &st.recipes.specs { out.insert(gen_recipe_add(&spec.kind)); }
    if let Ok(recipe) = serde_json::from_str::<serde_json::Value>(&st.recipes.text.text) {
        let steps = recipe["steps"].as_array().map(Vec::as_slice).unwrap_or_default();
        for (i, step) in steps.iter().enumerate() {
            for what in ["up", "down", "open", "remove", "gate/none", "gate/owner", "gate/director", "when/always", "id", "prompt/none", "prompt/append", "prompt/replace", "prompt/text"] { out.insert(gen_recipe_step(i, what)); }
            for w in crate::screens::generate::steps::WHEN { out.insert(gen_recipe_step(i, &format!("when/{w}"))); }
            for (name, _) in step["with"].as_object().into_iter().flatten() {
                out.insert(gen_recipe_with(i, name, "edit"));
            }
            for spec in &st.recipes.specs {
                let kind = step["use"].as_str().unwrap_or_default();
                if spec.kind == kind {
                    for name in spec.fields.keys() {
                        for what in ["edit", "input", "set", "add", "dec", "inc"] { out.insert(gen_recipe_with(i, name, what)); }
                    }
                }
            }
        }
    }
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
