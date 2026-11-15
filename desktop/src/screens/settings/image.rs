//! Settings, Generate: the scene images service. Any OpenAI-compatible `/images/generations`
//! endpoint; Kenari is offered as a model picker. A shot that asks for a picture gets one, and
//! without this service its fallback visual is drawn.

use rune::tok::type_;
use rune::{El, TextEdit, edit_access, row, text};
use serde_json::{Map, Value, json};
use sorot_desktop_core::model::{ImageView, Settings};

use crate::engine::types::KenariModel;
use crate::i18n::{Lang, tr, trf};
use crate::screens::panels::{Host, answer, go};
use crate::screens::settings::generate::{GenerateSettings, save_to, test_kind};
use crate::screens::settings::{KENARI_BASE_URL, KENARI_DEFAULT_IMAGE_MODEL, Mode, Run, hint, mode_of, wrapped};
use crate::ui::form::{btn, card, choice, field, toggle};
use crate::ui::kit::pal;

/// The four plain fields: engine name, text key.
pub const FIELDS: [(&str, &str); 4] = [("baseUrl", "image.base-url"), ("model", "image.model"), ("size", "image.size"), ("style", "image.style")];

pub struct ImageCard {
    pub run: Run,
    pub view: Option<ImageView>,
    pub mode: Option<Mode>,
    pub models: Vec<KenariModel>,
    pub model: String,
    pub fields: [TextEdit; 4],
    pub key: TextEdit,
}

impl Default for ImageCard {
    fn default() -> Self {
        ImageCard {
            run: Run::default(), view: None, mode: None, models: vec![], model: KENARI_DEFAULT_IMAGE_MODEL.into(),
            fields: std::array::from_fn(|_| TextEdit::new("")), key: TextEdit::new("").secure(),
        }
    }
}

fn saved(v: &ImageView, name: &str) -> String {
    match name {
        "baseUrl" => v.base_url.clone(),
        "model" => v.model.clone(),
        "size" => v.size.clone(),
        _ => v.style.clone(),
    }
    .unwrap_or_default()
}

impl ImageCard {
    pub fn fill(&mut self, v: &ImageView) {
        for ((name, _), edit) in FIELDS.iter().zip(&mut self.fields) {
            edit.replace_text(saved(v, name));
        }
        self.key.replace_text("");
        if let Some(m) = mode_of(v.base_url.as_deref()) {
            self.mode = Some(m);
        }
        if let (Some(m), true) = (v.model.clone().filter(|m| !m.is_empty()), v.base_url.as_deref() == Some(KENARI_BASE_URL)) {
            self.model = m;
        }
        self.view = Some(v.clone());
    }

    fn kenari(&self) -> bool {
        self.mode == Some(Mode::Kenari)
    }

    pub fn patch(&self) -> Map<String, Value> {
        let mut p = Map::new();
        let Some(v) = &self.view else { return p };
        for ((name, _), edit) in FIELDS.iter().zip(&self.fields) {
            let kenari_owned = self.kenari() && matches!(*name, "baseUrl" | "model");
            if !kenari_owned && edit.text != saved(v, name) {
                p.insert((*name).into(), json!(edit.text));
            }
        }
        if self.kenari() {
            if v.base_url.as_deref() != Some(KENARI_BASE_URL) {
                p.insert("baseUrl".into(), json!(KENARI_BASE_URL));
            }
            if v.model.as_deref() != Some(self.model.as_str()) {
                p.insert("model".into(), json!(self.model));
            }
        }
        if !self.key.text.trim().is_empty() {
            p.insert("apiKey".into(), json!(self.key.text.trim()));
        }
        p
    }
}

fn run_of(g: &mut GenerateSettings) -> &mut Run {
    &mut g.image.run
}

pub fn apply(c: &mut ImageCard, s: &Settings) {
    if let Some(v) = &s.image {
        c.fill(v);
    }
}

pub fn flip_enabled<H: Host>(h: &mut H) {
    let on = h.panels().generate.image.view.as_ref().is_some_and(|v| v.enabled);
    save_to(h, "image", json!({ "enabled": !on }), run_of);
}

pub fn set_mode<H: Host>(h: &mut H, mode: Mode) {
    let c = &mut h.panels_mut().generate.image;
    c.mode = Some(mode);
    c.key.replace_text("");
    if let Some(v) = c.view.clone() {
        c.fill(&v);
        c.mode = Some(mode);
    }
    if mode == Mode::Kenari && c.models.is_empty() {
        go(h, |e| answer(e.kenari_models("image"), |p, r| p.generate.image.models = r.unwrap_or_default()));
    }
}

pub fn pick_model<H: Host>(h: &mut H, id: &str) {
    h.panels_mut().generate.image.model = id.to_string();
}

pub fn save<H: Host>(h: &mut H) {
    let patch = h.panels().generate.image.patch();
    if !patch.is_empty() {
        save_to(h, "image", Value::Object(patch), run_of);
    }
}

pub fn test<H: Host>(h: &mut H) {
    test_kind(h, "image", run_of);
}

pub fn view<H: Host>(h: &H, l: Lang, v: &ImageView) -> El {
    let dark = h.dark();
    let c = &h.panels().generate.image;
    let mut b = card(dark, "gen/image", &tr(l, "image.title")).child(hint(dark, tr(l, "image.about")));
    let (kenari, p) = (c.kenari(), pal(dark));
    b = b.child(row().gap(8.0).child(match c.mode {
        None => btn(dark, "gen/image/mode-kenari", &tr(l, "conn.kenari.connect"), true, true, |h: &mut H| set_mode(h, Mode::Kenari)),
        Some(Mode::Kenari) => btn(dark, "gen/image/mode-custom", &tr(l, "image.use-other"), false, true, |h: &mut H| set_mode(h, Mode::Custom)),
        Some(Mode::Custom) => btn(dark, "gen/image/mode-kenari", &tr(l, "conn.kenari.use-kenari"), false, true, |h: &mut H| set_mode(h, Mode::Kenari)),
    }));
    if c.mode.is_none() {
        b = b.child(btn(dark, "gen/image/mode-custom", &tr(l, "image.other"), false, true, |h: &mut H| set_mode(h, Mode::Custom)));
    } else {
        b = b.child(toggle(dark, l, "gen/image/enabled", &tr(l, "image.use"), v.enabled, flip_enabled::<H>));
        if kenari {
            let mut models = vec![choice(dark, "gen/image/kenari/model/0", KENARI_DEFAULT_IMAGE_MODEL, c.model == KENARI_DEFAULT_IMAGE_MODEL, |h: &mut H| pick_model(h, KENARI_DEFAULT_IMAGE_MODEL))];
            for (n, m) in c.models.iter().filter(|m| m.id != KENARI_DEFAULT_IMAGE_MODEL).enumerate() {
                let id = m.id.clone();
                let label = if m.free { trf(l, "conn.kenari.free", &[("id", &m.id)]) } else { m.id.clone() };
                models.push(choice(dark, &format!("gen/image/kenari/model/{}", n + 1), &label, c.model == m.id, move |h: &mut H| pick_model(h, &id)));
            }
            b = b.child(text(tr(l, "image.model")).font(type_::LABEL).color(p.muted)).child(wrapped(models));
        }
        for (i, (name, label)) in FIELDS.iter().enumerate() {
            if kenari && matches!(*name, "baseUrl" | "model") {
                continue;
            }
            b = b.child(field(dark, &format!("gen/image/{name}"), &tr(l, label), &c.fields[i], "", false, edit_access(move |h: &mut H| &mut h.panels_mut().generate.image.fields[i])));
        }
        let key_hint = if v.api_key_set { trf(l, "conn.key-replace", &[("masked", &v.api_key)]) } else { tr(l, "conn.not-set") };
        b = b.child(field(dark, "gen/image/key", &tr(l, "conn.key"), &c.key, &key_hint, true, edit_access(|h: &mut H| &mut h.panels_mut().generate.image.key)))
            .child(row().gap(10.0)
                .child(btn(dark, "gen/image/save", &tr(l, "conn.save"), true, !c.run.busy && !c.patch().is_empty(), save::<H>))
                .child(btn(dark, "gen/image/test", &tr(l, "conn.test"), false, !c.run.busy, test::<H>)));
    }
    for n in c.run.notes(dark, l, "gen/image") {
        b = b.child(n);
    }
    b
}
