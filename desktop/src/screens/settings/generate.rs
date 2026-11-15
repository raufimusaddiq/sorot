//! Settings, Generate: whether Generate can run here, how each model fares per level (with
//! Calibrate and a pin), and the Generate token budgets and per-role models. The budgets and roles
//! are fields of the LLM connection, saved through the same settings route.

use rune::tok::type_;
use rune::{El, TextEdit, col, edit_access, row, text};
use serde_json::{Map, Value, json};
use sorot_desktop_core::model::{GenerateStatus, Settings};

use crate::engine::types::GenModels;
use crate::screens::panels::{Host, Load, Page, Panels, answer, go};
use crate::ui::form::{Tone, btn, card, choice, field, heading, note};
use crate::ui::kit::pal;
use crate::ui::states::{Kind, state_block};

/// The LLM connection's Generate fields: engine name, label, hint.
pub const FIELDS: [(&str, &str, &str); 6] = [
    ("genMaxTokens", "Token budget", "32000"),
    ("contextTokens", "Context budget", "600000"),
    ("turnTokens", "Turn budget", "60000"),
    ("planModel", "Plan model", "Same as the LLM model"),
    ("sceneModel", "Scene model", "Same as the LLM model"),
    ("judgeModel", "Judge model", "Same as the LLM model"),
];

pub const LEVELS: [&str; 3] = ["kit", "compose", "free"];

pub struct GenerateSettings {
    pub load: Load,
    pub settings: Option<Settings>,
    pub status: Option<GenerateStatus>,
    pub models: Option<GenModels>,
    pub fields: [TextEdit; 6],
    pub busy: bool,
    pub error: Option<String>,
    pub notice: Option<String>,
}

impl Default for GenerateSettings {
    fn default() -> Self {
        GenerateSettings {
            load: Load::Idle, settings: None, status: None, models: None, fields: std::array::from_fn(|_| TextEdit::new("")),
            busy: false, error: None, notice: None,
        }
    }
}

/// The saved text of one Generate field, as the LLM connection holds it.
fn saved_text(s: &Settings, name: &str) -> String {
    let l = &s.llm;
    let number = |n: Option<u64>| n.map(|n| n.to_string()).unwrap_or_default();
    match name {
        "genMaxTokens" => number(l.gen_max_tokens),
        "contextTokens" => number(l.context_tokens),
        "turnTokens" => number(l.turn_tokens),
        "planModel" => l.plan_model.clone().unwrap_or_default(),
        "sceneModel" => l.scene_model.clone().unwrap_or_default(),
        _ => l.judge_model.clone().unwrap_or_default(),
    }
}

impl GenerateSettings {
    fn fill(&mut self, s: &Settings) {
        for ((name, _, _), edit) in FIELDS.iter().zip(&mut self.fields) {
            edit.replace_text(saved_text(s, name));
        }
    }

    /// A calibration is running: the screen looks at the models again until it is done.
    pub fn calibrating(&self) -> bool {
        self.models.as_ref().and_then(|m| m.calibration.as_ref()).is_some_and(|c| !c.done)
    }

    fn changes(&self) -> Map<String, Value> {
        let Some(s) = &self.settings else { return Map::new() };
        FIELDS.iter().zip(&self.fields).filter(|((name, _, _), e)| e.text != saved_text(s, name)).map(|((name, _, _), e)| (name.to_string(), json!(e.text))).collect()
    }
}

/// Reads settings, status and models together; the screen opens once all three answered.
pub fn open<H: Host>(h: &mut H) {
    h.panels_mut().generate.load = Load::Loading;
    go(h, |e| {
        let all = e.settings().and_then(|s| Ok((s, e.generate_status()?, e.generate_models()?)));
        answer(all, |p, r| {
            let g = &mut p.generate;
            g.load = Load::of(&r);
            if let Ok((s, status, models)) = r {
                g.fill(&s);
                (g.settings, g.status, g.models) = (Some(s), Some(status), Some(models));
            }
        })
    });
}

fn reload_models<H: Host>(h: &mut H) {
    go(h, |e| answer(e.generate_models(), apply_models));
}

fn apply_models(p: &mut Panels, r: Result<GenModels, String>) {
    p.generate.busy = false;
    match r {
        Ok(m) => (p.generate.models, p.generate.error) = (Some(m), None),
        Err(e) => p.generate.error = Some(e),
    }
}

/// While a calibration runs, the app calls this on its poll to look at the models again.
pub fn poll<H: Host>(h: &mut H) {
    if h.panels().generate.calibrating() {
        reload_models(h);
    }
}

pub fn calibrate<H: Host>(h: &mut H) {
    h.panels_mut().generate.busy = true;
    go(h, |e| match e.calibrate().and_then(|()| e.generate_models()) {
        Ok(m) => answer(Ok(m), apply_models),
        Err(err) => answer::<GenModels>(Err(err), apply_models),
    });
}

/// `level` is `None` for auto.
pub fn pin<H: Host>(h: &mut H, model: &str, level: Option<&'static str>) {
    let model = model.to_string();
    h.panels_mut().generate.busy = true;
    go(h, move |e| match e.pin_model(&model, level).and_then(|()| e.generate_models()) {
        Ok(m) => answer(Ok(m), apply_models),
        Err(err) => answer::<GenModels>(Err(err), apply_models),
    });
}

pub fn save<H: Host>(h: &mut H) {
    let patch = h.panels().generate.changes();
    if patch.is_empty() {
        return;
    }
    h.panels_mut().generate.busy = true;
    go(h, move |e| {
        answer(e.update_settings("llm", &Value::Object(patch)), |p, r| {
            let g = &mut p.generate;
            g.busy = false;
            match r {
                Ok(s) => {
                    g.fill(&s);
                    (g.settings, g.error, g.notice) = (Some(s), None, Some("Saved. The next Generate build uses it.".into()));
                }
                Err(e) => g.error = Some(e),
            }
        })
    });
}

fn status_card(dark: bool, g: &GenerateSettings) -> El {
    let p = pal(dark);
    let mut c = card(dark, "gen/status", "Generate on this machine");
    let Some(s) = &g.status else { return c };
    if s.available {
        c = c.child(note(dark, "gen/available", Tone::Ok, &format!("Ready. Rendering on the {}.", s.compute)));
    } else {
        c = c.child(note(dark, "gen/unavailable", Tone::Bad, "Generate cannot run yet. Fix these, then open this page again."));
        for (i, why) in s.reasons.iter().enumerate() {
            c = c.child(text(why).key(format!("gen/reason/{i}")).font(type_::BODY).color(p.muted).wrap());
        }
    }
    let (llm, jev) = (if s.llm.configured { "connected" } else { "not connected" }, if s.jev.configured { "connected" } else { "not connected" });
    c.child(text(format!("LLM {llm}. Jev {jev}. HyperFrames {}.", if s.hyperframes.ok { "ready" } else { "missing" })).key("gen/links").font(type_::BODY).color(p.muted).wrap())
}

fn percent(n: u32, of: u32) -> String {
    (n * 100 + of / 2).checked_div(of).map_or("none".into(), |p| format!("{p}%"))
}

fn models_card<H: Host>(dark: bool, g: &GenerateSettings) -> El {
    let p = pal(dark);
    let mut c = card(dark, "gen/models", "Models");
    let Some(m) = &g.models else { return c };
    c = c.child(text("A shot starts at the highest level. These numbers show how a model fares; pin a weak one lower.").font(type_::BODY).color(p.muted).wrap());
    if m.models.is_empty() {
        c = c.child(text("No model has run yet. Calibrate the connected model to see how it fares.").key("gen/models/empty").font(type_::BODY).color(p.muted).wrap());
    }
    for (n, row_) in m.models.iter().enumerate() {
        let name = row_.model.clone();
        let mut levels = row().gap(8.0).child(choice(dark, &format!("gen/model/{n}/auto"), "Auto", row_.pin.is_none(), {
            let name = name.clone();
            move |h: &mut H| pin(h, &name, None)
        }));
        for l in LEVELS {
            let name = name.clone();
            levels = levels.child(choice(dark, &format!("gen/model/{n}/{l}"), l, row_.pin.as_deref() == Some(l), move |h: &mut H| pin(h, &name, Some(l))));
        }
        let mut block = col().key(format!("gen/model/{n}")).role("group").label(row_.model.as_str()).gap(6.0)
            .child(text(&row_.model).font(type_::TITLE).color(p.text))
            .child(text(format!("Auto starts at {}{}.", row_.auto, row_.proven.as_ref().map(|l| format!(", proven at {l}")).unwrap_or_default())).font(type_::BODY).color(p.muted))
            .child(levels);
        for r in &row_.records {
            block = block.child(text(format!("{}: asked {}, first time {}, repaired {}, dropped {}, malformed {}", r.level, r.asked, percent(r.first_pass, r.asked), percent(r.repaired, r.asked), r.dropped, r.malformed)).font(type_::LABEL).color(p.muted).wrap());
        }
        c = c.child(block);
    }
    let running = g.calibrating();
    let label = if running { "Calibrating".to_string() } else if m.current.is_empty() { "Calibrate".into() } else { format!("Calibrate {}", m.current) };
    c = c.child(btn(dark, "gen/calibrate", &label, false, !g.busy && !running && !m.current.is_empty(), calibrate::<H>));
    if let Some(cal) = &m.calibration {
        if cal.done {
            let words = match &cal.error {
                Some(why) => (Tone::Bad, format!("Calibration of {} failed: {why}. Calibrate again.", cal.model)),
                None => (Tone::Ok, format!("Calibrated {}. The table above shows the result.", cal.model)),
            };
            c = c.child(note(dark, "gen/calibration", words.0, &words.1));
        } else {
            c = c.child(note(dark, "gen/calibration", Tone::Plain, "Calibrating. This takes a few minutes; the table updates by itself."));
        }
    }
    c
}

fn budgets_card<H: Host>(dark: bool, g: &GenerateSettings) -> El {
    let mut c = card(dark, "gen/budgets", "Budgets and models per role");
    let mut grid = col().gap(10.0).w_full();
    for (i, ((name, label, hint), edit)) in FIELDS.iter().zip(&g.fields).enumerate() {
        grid = grid.child(field(dark, &format!("gen/field/{name}"), label, edit, hint, false, edit_access(move |h: &mut H| &mut h.panels_mut().generate.fields[i])));
    }
    c = c.child(grid).child(btn(dark, "gen/save", "Save", true, !g.busy && !g.changes().is_empty(), save::<H>));
    if let Some(done) = &g.notice {
        c = c.child(note(dark, "gen/notice", Tone::Ok, done));
    }
    c
}

pub fn view<H: Host>(h: &H) -> El {
    let dark = h.dark();
    let g = &h.panels().generate;
    let head = heading(dark, "gen/title", "Generate settings", "How Generate runs on this machine, and what it may spend.");
    let body = match (&g.load, &g.status) {
        (Load::Failed(why), _) => state_block::<H>(dark, "gen/failed", Kind::Error, "Could not read the Generate settings.", &format!("{why}. Try again."), Some(("gen/retry", "Try again", open::<H>))),
        (_, Some(_)) => {
            let mut page = col().gap(16.0).w_full().child(status_card(dark, g)).child(models_card::<H>(dark, g)).child(budgets_card::<H>(dark, g));
            if let Some(why) = &g.error {
                page = page.child(note(dark, "gen/error", Tone::Bad, &format!("{why}. Try again.")));
            }
            page
        }
        _ => state_block::<H>(dark, "gen/loading", Kind::Loading, "Reading the Generate settings.", "This takes a moment.", None),
    };
    col().gap(20.0).padding(40.0).w_full().max_w(960.0).child(head).child(super::tabs::<H>(dark, Page::GenerateSettings)).child(body)
}
