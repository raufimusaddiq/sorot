//! Settings, Generate: the narration voice. One engine at a time and a voice per language.
//! Kenari speaks the `openai` engine's shape, so for that engine it is offered as a model and
//! voice picker; the other engines keep their own fields.

use rune::{El, TextEdit, edit_access, row, text};
use rune::tok::type_;
use serde_json::{Map, Value, json};
use sorot_desktop_core::model::{Settings, VoiceView};

use crate::engine::types::KenariVoiceModel;
use crate::i18n::{Lang, tr};
use crate::screens::panels::{Host, answer, go};
use crate::screens::settings::generate::{save_to, test_kind};
use crate::screens::settings::{KENARI_BASE_URL, Mode, Run, hint, mode_of, wrapped};
use crate::ui::focus;
use crate::ui::form::{btn, card, choice, field, toggle};
use crate::ui::kit::pal;

/// The two languages a voice is set for: engine code, text key.
pub const LANGS: [(&str, &str); 2] = [("id", "lang.id"), ("en", "lang.en")];

pub struct VoiceCard {
    pub run: Run,
    pub view: Option<VoiceView>,
    pub mode: Option<Mode>,
    pub models: Vec<KenariVoiceModel>,
    /// The Kenari model chosen.
    pub model: String,
    pub base_url: TextEdit,
    pub model_edit: TextEdit,
    pub key: TextEdit,
    pub voices: [TextEdit; 2],
}

impl Default for VoiceCard {
    fn default() -> Self {
        VoiceCard {
            run: Run::default(), view: None, mode: None, models: vec![], model: String::new(), base_url: TextEdit::new(""), model_edit: TextEdit::new(""),
            key: TextEdit::new("").secure(), voices: [TextEdit::new(""), TextEdit::new("")],
        }
    }
}

impl VoiceCard {
    pub fn fill(&mut self, v: &VoiceView) {
        self.base_url.replace_text(v.base_url.clone().unwrap_or_default());
        self.model_edit.replace_text(v.model.clone().unwrap_or_default());
        self.key.replace_text("");
        for ((code, _), edit) in LANGS.iter().zip(&mut self.voices) {
            edit.replace_text(v.voices.get(*code).cloned().unwrap_or_default());
        }
        if v.engine != "openai" {
            self.mode = None;
        } else if let Some(m) = mode_of(v.base_url.as_deref()) {
            self.mode = Some(m);
        }
        if let (Some(m), true) = (&v.model, v.base_url.as_deref() == Some(KENARI_BASE_URL)) {
            self.model = m.clone();
        }
        self.view = Some(v.clone());
    }

    fn kenari(&self) -> bool {
        self.view.as_ref().is_some_and(|v| v.engine == "openai") && self.mode == Some(Mode::Kenari)
    }

    /// The engine has taken the Kenari models: the first becomes the choice when none is.
    pub fn got_models(&mut self, models: Vec<KenariVoiceModel>) {
        if models.is_empty() {
            return;
        }
        if self.model.is_empty() || !models.iter().any(|m| m.id == self.model) {
            self.model = models.first().map(|m| m.id.clone()).unwrap_or_default();
        }
        self.models = models;
    }

    /// What differs from the saved card, in the engine's names.
    pub fn patch(&self) -> Map<String, Value> {
        let mut p = Map::new();
        let Some(v) = &self.view else { return p };
        if self.kenari() {
            if v.base_url.as_deref() != Some(KENARI_BASE_URL) {
                p.insert("baseUrl".into(), json!(KENARI_BASE_URL));
            }
            if !self.model.is_empty() && v.model.as_deref() != Some(self.model.as_str()) {
                p.insert("model".into(), json!(self.model));
            }
        } else {
            if self.base_url.text != v.base_url.clone().unwrap_or_default() {
                p.insert("baseUrl".into(), json!(self.base_url.text));
            }
            if self.model_edit.text != v.model.clone().unwrap_or_default() {
                p.insert("model".into(), json!(self.model_edit.text));
            }
        }
        let typed: std::collections::BTreeMap<String, String> = LANGS.iter().zip(&self.voices).filter(|(_, e)| !e.text.is_empty()).map(|((code, _), e)| (code.to_string(), e.text.clone())).collect();
        if typed != v.voices {
            p.insert("voices".into(), json!(typed));
        }
        if !self.key.text.trim().is_empty() {
            p.insert("apiKey".into(), json!(self.key.text.trim()));
        }
        p
    }
}

fn run_of(g: &mut crate::screens::settings::generate::GenerateSettings) -> &mut Run {
    &mut g.voice.run
}

pub fn set_engine<H: Host>(h: &mut H, engine: &str) {
    save_to(h, "voice", json!({ "engine": engine }), run_of);
}

pub fn flip_enabled<H: Host>(h: &mut H) {
    let on = h.panels().generate.voice.view.as_ref().is_some_and(|v| v.enabled);
    save_to(h, "voice", json!({ "enabled": !on }), run_of);
}

/// Chooses Kenari or a different endpoint for the `openai` engine; Kenari reads its voice models once.
pub fn set_mode<H: Host>(h: &mut H, mode: Mode) {
    let c = &mut h.panels_mut().generate.voice;
    c.mode = Some(mode);
    c.key.replace_text("");
    if let Some(v) = c.view.clone() {
        c.fill(&v);
        c.mode = Some(mode);
    }
    if mode == Mode::Kenari && c.models.is_empty() {
        go(h, |e| answer(e.kenari_voice_models(), |p, r| p.generate.voice.got_models(r.unwrap_or_default())));
    }
}

pub fn pick_model<H: Host>(h: &mut H, id: &str) {
    let c = &mut h.panels_mut().generate.voice;
    c.model = id.to_string();
}

pub fn pick_voice<H: Host>(h: &mut H, lang: usize, voice: &str) {
    let c = &mut h.panels_mut().generate.voice;
    c.voices[lang].replace_text(voice);
}

pub fn save<H: Host>(h: &mut H) {
    let patch = h.panels().generate.voice.patch();
    if !patch.is_empty() {
        save_to(h, "voice", Value::Object(patch), run_of);
    }
}

pub fn test<H: Host>(h: &mut H) {
    test_kind(h, "voice", run_of);
}

/// Hands the saved card to the voice card.
pub fn apply(c: &mut VoiceCard, s: &Settings) {
    if let Some(v) = &s.voice {
        c.fill(v);
    }
}

pub fn view<H: Host>(h: &H, l: Lang, v: &VoiceView) -> El {
    let dark = h.dark();
    let p = pal(dark);
    let c = &h.panels().generate.voice;
    let mut b = card(dark, "gen/voice", &tr(l, "voice.title")).child(hint(dark, tr(l, "voice.about")));
    if !v.active {
        b = b.child(hint(dark, tr(l, "voice.none-yet")));
    }
    b = b.child(toggle(dark, l, "gen/voice/enabled", &tr(l, "voice.use"), v.enabled, flip_enabled::<H>));
    let mut engines = vec![choice(dark, "gen/voice/engine/none", &tr(l, "voice.engine.none"), v.engine.is_empty(), |h: &mut H| set_engine(h, ""))];
    for e in &v.engines {
        let name = e.clone();
        let blocked = e == "local" && !v.local_available;
        let label = if blocked { format!("{} ({})", tr(l, &format!("voice.engine.{e}")), tr(l, "voice.needs-gpu")) } else { tr(l, &format!("voice.engine.{e}")) };
        let mut el = choice(dark, &focus::gen_voice_engine(e), &label, v.engine == *e, move |h: &mut H| set_engine(h, &name));
        if blocked {
            el = el.disabled(true);
        }
        engines.push(el);
    }
    b = b.child(text(tr(l, "voice.engine")).font(type_::LABEL).color(p.muted)).child(wrapped(engines));
    let openai = v.engine == "openai";
    if openai {
        b = b.child(row().gap(8.0).child(match c.mode {
            None => btn(dark, "gen/voice/mode-kenari", &tr(l, "conn.kenari.connect"), true, true, |h: &mut H| set_mode(h, Mode::Kenari)),
            Some(Mode::Kenari) => btn(dark, "gen/voice/mode-custom", &tr(l, "conn.kenari.use-other"), false, true, |h: &mut H| set_mode(h, Mode::Custom)),
            Some(Mode::Custom) => btn(dark, "gen/voice/mode-kenari", &tr(l, "conn.kenari.use-kenari"), false, true, |h: &mut H| set_mode(h, Mode::Kenari)),
        }));
        if c.mode.is_none() {
            b = b.child(btn(dark, "gen/voice/mode-custom", &tr(l, "conn.kenari.other"), false, true, |h: &mut H| set_mode(h, Mode::Custom)));
        }
    }
    let ready = !openai || c.mode.is_some();
    let kenari = c.kenari();
    if v.engine != "local" && !kenari && ready {
        b = b.child(field(dark, "gen/voice/base-url", &tr(l, "voice.base-url"), &c.base_url, "", false, edit_access(|h: &mut H| &mut h.panels_mut().generate.voice.base_url)))
            .child(field(dark, "gen/voice/model", &tr(l, "voice.model"), &c.model_edit, "", false, edit_access(|h: &mut H| &mut h.panels_mut().generate.voice.model_edit)));
    }
    if kenari {
        let mut models = vec![];
        for (n, m) in c.models.iter().enumerate() {
            let id = m.id.clone();
            models.push(choice(dark, &focus::gen_voice_model(n), &m.id, c.model == m.id, move |h: &mut H| pick_model(h, &id)));
        }
        if models.is_empty() {
            b = b.child(hint(dark, tr(l, "voice.loading-models")));
        }
        b = b.child(text(tr(l, "voice.model")).font(type_::LABEL).color(p.muted)).child(wrapped(models));
    }
    if v.engine != "local" && ready {
        let key_hint = if v.api_key_set { crate::i18n::trf(l, "conn.key-replace", &[("masked", &v.api_key)]) } else { tr(l, "conn.not-set") };
        b = b.child(field(dark, "gen/voice/key", &tr(l, "conn.key"), &c.key, &key_hint, true, edit_access(|h: &mut H| &mut h.panels_mut().generate.voice.key)));
    }
    if v.engine == "local" {
        b = b.child(hint(dark, tr(l, "voice.local-note")));
    }
    if ready {
        let kenari_voices: &[String] = c.models.iter().find(|m| m.id == c.model).map(|m| m.voices.as_slice()).unwrap_or(&[]);
        for (i, (code, name)) in LANGS.iter().enumerate() {
            let label = crate::i18n::trf(l, "voice.for", &[("lang", &tr(l, name))]);
            if kenari && !kenari_voices.is_empty() {
                let mut options = vec![choice(dark, &focus::gen_voice_voice(code, "default"), &tr(l, "voice.default"), c.voices[i].text.is_empty(), move |h: &mut H| pick_voice(h, i, ""))];
                for (j, voice) in kenari_voices.iter().enumerate() {
                    let id = voice.clone();
                    options.push(choice(dark, &focus::gen_voice_voice(code, &j.to_string()), voice, c.voices[i].text == *voice, move |h: &mut H| pick_voice(h, i, &id)));
                }
                b = b.child(text(label).font(type_::LABEL).color(p.muted)).child(wrapped(options));
            } else {
                b = b.child(field(dark, &focus::gen_voice_voice(code, ""), &label, &c.voices[i], &tr(l, "voice.id-hint"), false, edit_access(move |h: &mut H| &mut h.panels_mut().generate.voice.voices[i])));
            }
        }
        b = b.child(row().gap(10.0)
            .child(btn(dark, "gen/voice/save", &tr(l, "conn.save"), true, !c.run.busy && !c.patch().is_empty(), save::<H>))
            .child(btn(dark, "gen/voice/test", &tr(l, "conn.test"), false, !c.run.busy, test::<H>)));
    }
    for n in c.run.notes(dark, l, "gen/voice") {
        b = b.child(n);
    }
    b
}
