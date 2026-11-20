//! Settings, Generate: whether Generate can run here, the narration voice, the scene images,
//! custom commands, how each model fares per level (with Calibrate and a pin), and the Generate
//! token budgets and per-role models. The budgets and roles are fields of the LLM connection,
//! saved through the same settings route.

use rune::tok::type_;
use rune::{El, TextEdit, col, edit_access, row, text};
use serde_json::{Map, Value, json};
use sorot_desktop_core::model::{GenerateStatus, Settings};

use crate::engine::types::{ConnTest, GenModels};
use crate::i18n::{tr, trf};
use crate::screens::panels::{Host, Load, Page, Panels, answer, go};
use crate::screens::settings::commands::{self, CommandsCard};
use crate::screens::settings::image::{self, ImageCard};
use crate::screens::settings::voice::{self, VoiceCard};
use crate::screens::settings::{KENARI_BASE_URL, Run, hint};
use crate::ui::focus;
use crate::ui::form::{Tone, btn, card, choice, field, heading, note, page};
use crate::ui::kit::pal;
use crate::ui::states::{Kind, state_block};

/// The LLM connection's Generate fields: engine name, label key, hint (a text key, or the number itself).
pub const FIELDS: [(&str, &str, &str); 6] = [
    ("genMaxTokens", "gen.field.max-tokens", "32000"),
    ("contextTokens", "gen.field.context", "600000"),
    ("turnTokens", "gen.field.turn", "60000"),
    ("planModel", "gen.field.plan", "gen.same-model"),
    ("sceneModel", "gen.field.scene", "gen.same-model"),
    ("judgeModel", "gen.field.judge", "gen.same-model"),
];

pub const LEVELS: [&str; 3] = ["kit", "compose", "free"];

pub struct GenerateSettings {
    pub load: Load,
    pub settings: Option<Settings>,
    pub status: Option<GenerateStatus>,
    pub models: Option<GenModels>,
    pub fields: [TextEdit; 6],
    pub voice: VoiceCard,
    pub image: ImageCard,
    pub commands: CommandsCard,
    pub busy: bool,
    pub error: Option<String>,
    pub notice: bool,
}

impl Default for GenerateSettings {
    fn default() -> Self {
        GenerateSettings {
            load: Load::Idle, settings: None, status: None, models: None, fields: std::array::from_fn(|_| TextEdit::new("")),
            voice: VoiceCard::default(), image: ImageCard::default(), commands: CommandsCard::default(), busy: false, error: None, notice: false,
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
        self.fill_cards(s);
    }

    /// The saved voice, images and commands cards.
    pub fn fill_cards(&mut self, s: &Settings) {
        voice::apply(&mut self.voice, s);
        image::apply(&mut self.image, s);
        commands::apply(&mut self.commands, s);
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
        let all = e.settings().and_then(|s| {
            // A voice or images service set up through Kenari shows Kenari's model lists.
            let on_kenari = |url: &Option<String>| url.as_deref() == Some(KENARI_BASE_URL);
            let voices = if s.voice.as_ref().is_some_and(|v| v.engine == "openai" && on_kenari(&v.base_url)) { e.kenari_voice_models().unwrap_or_default() } else { vec![] };
            let images = if s.image.as_ref().is_some_and(|v| on_kenari(&v.base_url)) { e.kenari_models("image").unwrap_or_default() } else { vec![] };
            Ok((s, e.generate_status()?, e.generate_models()?, voices, images))
        });
        answer(all, |p, r| {
            let g = &mut p.generate;
            g.load = Load::of(&r);
            if let Ok((s, status, models, voices, images)) = r {
                g.fill(&s);
                g.voice.got_models(voices);
                if !images.is_empty() {
                    g.image.models = images;
                }
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
                    (g.settings, g.error, g.notice) = (Some(s), None, true);
                }
                Err(e) => g.error = Some(e),
            }
        })
    });
}

/// Saves `patch` to one connection and hands the engine's answer to every card.
pub fn save_to<H: Host>(h: &mut H, kind: &'static str, patch: Value, run: fn(&mut GenerateSettings) -> &mut Run) {
    run(&mut h.panels_mut().generate).start();
    go(h, move |e| {
        answer(e.update_settings(kind, &patch), move |p, r| {
            let g = &mut p.generate;
            match r {
                Ok(s) => {
                    g.fill_cards(&s);
                    g.settings = Some(s);
                    (run(g).busy, run(g).notice) = (false, true);
                }
                Err(why) => (run(g).busy, run(g).error) = (false, Some(why)),
            }
        })
    });
}

/// Tries one connection as saved and shows what came back.
pub fn test_kind<H: Host>(h: &mut H, kind: &'static str, run: fn(&mut GenerateSettings) -> &mut Run) {
    run(&mut h.panels_mut().generate).start();
    go(h, move |e| {
        answer(e.test_connection(kind), move |p, r| {
            let slot = run(&mut p.generate);
            slot.busy = false;
            slot.test = Some(r.unwrap_or_else(|why| ConnTest { ok: false, ms: 0, model: None, detail: None, error: Some(why) }));
        })
    });
}

fn status_card<H: Host>(h: &H, g: &GenerateSettings) -> El {
    let (dark, l) = (h.dark(), h.lang());
    let p = pal(dark);
    let mut c = card(dark, "gen/status", &tr(l, "gen.status.title"));
    let Some(s) = &g.status else { return c };
    if s.available {
        c = c.child(note(dark, "gen/available", Tone::Ok, &trf(l, "gen.status.ready", &[("compute", &s.compute)])));
    } else {
        c = c.child(note(dark, "gen/unavailable", Tone::Bad, &tr(l, "gen.status.unavailable")));
        for (i, why) in s.reasons.iter().enumerate() {
            c = c.child(text(why).key(focus::gen_reason(i)).font(type_::BODY).color(p.muted).wrap());
        }
    }
    let state = |on: bool| tr(l, if on { "gen.status.connected" } else { "gen.status.not-connected" });
    let hf = tr(l, if s.hyperframes.ok { "gen.status.hf-ready" } else { "gen.status.hf-missing" });
    c.child(text(trf(l, "gen.status.links", &[("llm", &state(s.llm.configured)), ("jev", &state(s.jev.configured)), ("hf", &hf)])).key("gen/links").font(type_::BODY).color(p.muted).wrap())
}

fn percent(l: crate::i18n::Lang, n: u32, of: u32) -> String {
    (n * 100 + of / 2).checked_div(of).map_or(tr(l, "gen.none"), |p| format!("{p}%"))
}

fn models_card<H: Host>(h: &H, g: &GenerateSettings) -> El {
    let (dark, l) = (h.dark(), h.lang());
    let p = pal(dark);
    let mut c = card(dark, "gen/models", &tr(l, "gen.models.title"));
    let Some(m) = &g.models else { return c };
    c = c.child(text(tr(l, "gen.models.about")).font(type_::BODY).color(p.muted).wrap());
    if m.models.is_empty() {
        c = c.child(text(tr(l, "gen.models.empty")).key("gen/models/empty").font(type_::BODY).color(p.muted).wrap());
    }
    for (n, row_) in m.models.iter().enumerate() {
        let name = row_.model.clone();
        let mut levels = row().gap(8.0).child(choice(dark, &focus::gen_model(n, "auto"), &tr(l, "gen.models.auto"), row_.pin.is_none(), {
            let name = name.clone();
            move |h: &mut H| pin(h, &name, None)
        }));
        for lv in LEVELS {
            let name = name.clone();
            levels = levels.child(choice(dark, &focus::gen_model(n, lv), lv, row_.pin.as_deref() == Some(lv), move |h: &mut H| pin(h, &name, Some(lv))));
        }
        let proven = row_.proven.as_ref().map(|lv| trf(l, "gen.models.proven", &[("level", lv)])).unwrap_or_default();
        let mut block = col().key(focus::gen_model_group(n)).role("group").label(row_.model.as_str()).gap(6.0)
            .child(text(&row_.model).font(type_::TITLE).color(p.text))
            .child(text(trf(l, "gen.models.auto-starts", &[("level", &row_.auto), ("proven", &proven)])).font(type_::BODY).color(p.muted))
            .child(levels);
        for r in &row_.records {
            block = block.child(text(trf(l, "gen.models.record", &[
                ("level", &r.level), ("asked", &r.asked.to_string()), ("first", &percent(l, r.first_pass, r.asked)), ("repaired", &percent(l, r.repaired, r.asked)),
                ("dropped", &r.dropped.to_string()), ("malformed", &r.malformed.to_string()),
            ])).font(type_::LABEL).color(p.muted).wrap());
        }
        c = c.child(block);
    }
    let running = g.calibrating();
    let label = if running { tr(l, "gen.models.calibrating") } else if m.current.is_empty() { tr(l, "gen.models.calibrate") } else { trf(l, "gen.models.calibrate-model", &[("model", &m.current)]) };
    c = c.child(btn(dark, "gen/calibrate", &label, false, !g.busy && !running && !m.current.is_empty(), calibrate::<H>));
    if let Some(cal) = &m.calibration {
        if cal.done {
            let words = match &cal.error {
                Some(why) => (Tone::Bad, trf(l, "gen.models.cal-failed", &[("model", &cal.model), ("why", why)])),
                None => (Tone::Ok, trf(l, "gen.models.cal-done", &[("model", &cal.model)])),
            };
            c = c.child(note(dark, "gen/calibration", words.0, &words.1));
        } else {
            c = c.child(note(dark, "gen/calibration", Tone::Plain, &tr(l, "gen.models.cal-running")));
        }
    }
    c
}

fn budgets_card<H: Host>(h: &H, g: &GenerateSettings) -> El {
    let (dark, l) = (h.dark(), h.lang());
    let mut c = card(dark, "gen/budgets", &tr(l, "gen.budgets.title")).child(hint(dark, tr(l, "gen.budgets.about")));
    let mut grid = col().gap(10.0).w_full();
    for (i, ((name, label, hint_), edit)) in FIELDS.iter().zip(&g.fields).enumerate() {
        let shown = if hint_.starts_with("gen.") { tr(l, hint_) } else { hint_.to_string() };
        grid = grid.child(field(dark, &focus::gen_field(name), &tr(l, label), edit, &shown, false, edit_access(move |h: &mut H| &mut h.panels_mut().generate.fields[i])));
    }
    c = c.child(grid).child(btn(dark, "gen/save", &tr(l, "conn.save"), true, !g.busy && !g.changes().is_empty(), save::<H>));
    if g.notice {
        c = c.child(note(dark, "gen/notice", Tone::Ok, &tr(l, "gen.budgets.saved")));
    }
    c
}

pub fn view<H: Host>(h: &H) -> El {
    let (dark, l) = (h.dark(), h.lang());
    let g = &h.panels().generate;
    let head = heading(dark, "gen/title", &tr(l, "settings.title"), &tr(l, "gen.sub"));
    let body = match (&g.load, &g.status) {
        (Load::Failed(why), _) => state_block::<H>(dark, "gen/failed", Kind::Error, &tr(l, "gen.read-failed"), &trf(l, "state.try-again-after", &[("why", why)]), Some(("gen/retry", &tr(l, "state.retry"), open::<H>))),
        (_, Some(_)) => {
            let mut body = col().gap(16.0).w_full().child(status_card::<H>(h, g));
            if let Some(s) = &g.settings {
                if let Some(v) = &s.voice {
                    body = body.child(voice::view::<H>(h, l, v));
                }
                if let Some(v) = &s.image {
                    body = body.child(image::view::<H>(h, l, v));
                }
                if let Some(v) = &s.commands {
                    body = body.child(commands::view::<H>(h, l, v));
                }
            }
            body = body.child(models_card::<H>(h, g)).child(budgets_card::<H>(h, g));
            if let Some(why) = &g.error {
                body = body.child(note(dark, "gen/error", Tone::Bad, &trf(l, "state.try-again-after", &[("why", why)])));
            }
            body
        }
        _ => state_block::<H>(dark, "gen/loading", Kind::Loading, &tr(l, "gen.reading"), &tr(l, "state.moment"), None),
    };
    page().child(head).child(super::tabs::<H>(dark, l, Page::GenerateSettings)).child(body)
}
