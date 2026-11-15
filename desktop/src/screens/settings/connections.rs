//! Settings, Connections: the LLM, Jev and Tebar. Optional for clipping (constitution IV); a key is
//! shown as the engine masks it and typing replaces it (`core::masked`). A save goes to the engine,
//! which reads settings on every call, so the next action uses it with no restart.

use rune::tok::type_;
use rune::{El, TextEdit, col, edit_access, row, text};
use serde_json::{Map, Value, json};
use sorot_desktop_core::masked::KeyField;
use sorot_desktop_core::model::{Connection, Settings};

use crate::engine::types::ConnTest;
use crate::screens::panels::{Host, Load, Page, answer, go};
use crate::ui::form::{Tone, btn, card, field, heading, note, toggle};
use crate::ui::kit::pal;
use crate::ui::states::{Kind, state_block};

pub const KINDS: [&str; 3] = ["llm", "jev", "tebar"];

pub struct Card {
    pub endpoint: TextEdit,
    pub model: TextEdit,
    /// What was typed into the key field; the masked value the engine sent is `key_field`'s.
    pub key: TextEdit,
    pub key_field: KeyField,
    pub busy: bool,
    pub error: Option<String>,
    pub test: Option<ConnTest>,
    pub notice: Option<String>,
}

impl Default for Card {
    fn default() -> Self {
        Card {
            endpoint: TextEdit::new(""), model: TextEdit::new(""), key: TextEdit::new("").secure(), key_field: KeyField::default(),
            busy: false, error: None, test: None, notice: None,
        }
    }
}

#[derive(Default)]
pub struct Connections {
    pub load: Load,
    pub settings: Option<Settings>,
    pub cards: [Card; 3],
}

fn view_of<'a>(s: &'a Settings, kind: &str) -> &'a Connection {
    match kind {
        "llm" => &s.llm,
        "jev" => &s.jev,
        _ => &s.tebar,
    }
}

/// The engine names Jev's address `url`, the others `baseUrl`.
fn endpoint_name(kind: &str) -> &'static str {
    if kind == "jev" { "url" } else { "baseUrl" }
}

fn endpoint_of(kind: &str, c: &Connection) -> String {
    (if kind == "jev" { &c.url } else { &c.base_url }).clone().unwrap_or_default()
}

impl Card {
    fn fill(&mut self, kind: &str, c: &Connection) {
        self.endpoint.replace_text(endpoint_of(kind, c));
        self.model.replace_text(c.model.clone().unwrap_or_default());
        self.key.replace_text("");
        self.key_field.receive(if c.api_key_set { &c.api_key } else { "" });
    }

    /// The fields the person changed, in the engine's names. The key goes only when typed.
    fn patch(&mut self, kind: &str, c: &Connection) -> Map<String, Value> {
        self.key_field.type_text(&self.key.text);
        let mut p = Map::new();
        if self.endpoint.text != endpoint_of(kind, c) {
            p.insert(endpoint_name(kind).into(), json!(self.endpoint.text));
        }
        if kind != "tebar" && self.model.text != c.model.clone().unwrap_or_default() {
            p.insert("model".into(), json!(self.model.text));
        }
        if let Some(key) = self.key_field.outgoing() {
            p.insert("apiKey".into(), json!(key));
        }
        p
    }
}

impl Connections {
    fn loaded(&mut self, r: Result<Settings, String>) {
        self.load = Load::of(&r);
        if let Ok(s) = r {
            for (kind, card) in KINDS.iter().zip(&mut self.cards) {
                card.fill(kind, view_of(&s, kind));
            }
            self.settings = Some(s);
        }
    }

    fn saved(&mut self, i: usize, r: Result<Settings, String>) {
        let card = &mut self.cards[i];
        card.busy = false;
        match r {
            Ok(s) => {
                card.fill(KINDS[i], view_of(&s, KINDS[i]));
                (card.error, card.test, card.notice) = (None, None, Some("Saved. The next action uses it; no restart needed.".into()));
                self.settings = Some(s);
            }
            Err(e) => card.error = Some(e),
        }
    }
}

/// Reads the settings from the engine.
pub fn open<H: Host>(h: &mut H) {
    h.panels_mut().connections.load = Load::Loading;
    go(h, |e| answer(e.settings(), |p, r| p.connections.loaded(r)));
}

fn send<H: Host>(h: &mut H, i: usize, patch: Value) {
    h.panels_mut().connections.cards[i].busy = true;
    go(h, move |e| answer(e.update_settings(KINDS[i], &patch), move |p, r| p.connections.saved(i, r)));
}

pub fn save<H: Host>(h: &mut H, i: usize) {
    let c = &mut h.panels_mut().connections;
    let Some(s) = c.settings.clone() else { return };
    let patch = c.cards[i].patch(KINDS[i], view_of(&s, KINDS[i]));
    if !patch.is_empty() {
        send(h, i, Value::Object(patch));
    }
}

pub fn test<H: Host>(h: &mut H, i: usize) {
    let card = &mut h.panels_mut().connections.cards[i];
    (card.busy, card.test, card.error, card.notice) = (true, None, None, None);
    go(h, move |e| {
        answer(e.test_connection(KINDS[i]), move |p, r| {
            let card = &mut p.connections.cards[i];
            card.busy = false;
            card.test = Some(r.unwrap_or_else(|why| ConnTest { ok: false, ms: 0, model: None, detail: None, error: Some(why) }));
        })
    });
}

/// "Use .env": every field saved here goes back to the engine's own value.
pub fn clear<H: Host>(h: &mut H, i: usize) {
    let Some(s) = h.panels().connections.settings.clone() else { return };
    let patch: Map<String, Value> = view_of(&s, KINDS[i]).saved.iter().map(|name| (name.clone(), Value::Null)).collect();
    if !patch.is_empty() {
        send(h, i, Value::Object(patch));
    }
}

/// The two switches on a card: `enabled`, and for the LLM and Jev `director`.
pub fn flip<H: Host>(h: &mut H, i: usize, name: &'static str) {
    let Some(s) = h.panels().connections.settings.clone() else { return };
    let c = view_of(&s, KINDS[i]);
    let now = if name == "director" { c.director.unwrap_or(false) } else { c.enabled };
    send(h, i, json!({ name: !now }));
}

fn title(kind: &str) -> &'static str {
    match kind {
        "llm" => "LLM (OpenAI-compatible endpoint)",
        "jev" => "Jev quality gate",
        _ => "Tebar (publishing)",
    }
}

fn about(kind: &str) -> &'static str {
    match kind {
        "llm" => "Writes post copy, reviews clips and can direct the picks. Off: the rules do it.",
        "jev" => "Answers fixed questions about each clip and checks copy. Off: text rules answer them.",
        _ => "Posts to the accounts you connected at tebar.app. Off: download clips and post them yourself.",
    }
}

/// True when the card holds a change the engine does not have.
fn dirty<H: Host>(h: &H, i: usize) -> bool {
    let c = &h.panels().connections;
    let Some(s) = &c.settings else { return false };
    let (card, view) = (&c.cards[i], view_of(s, KINDS[i]));
    card.endpoint.text != endpoint_of(KINDS[i], view) || (KINDS[i] != "tebar" && card.model.text != view.model.clone().unwrap_or_default()) || !card.key.text.is_empty()
}

fn one<H: Host>(h: &H, i: usize, c: &Connection) -> El {
    let (dark, kind) = (h.dark(), KINDS[i]);
    let p = pal(dark);
    let card_state = &h.panels().connections.cards[i];
    let key = |n: &str| format!("conn/{kind}/{n}");
    let (status, tone) = if c.active { ("Ready", p.pass) } else { ("Off", p.muted) };
    let mut body = card(dark, &key("card"), title(kind))
        .child(text(status).key(key("status")).font(type_::LABEL).color(tone))
        .child(text(about(kind)).font(type_::BODY).color(p.muted).wrap())
        .child(toggle(dark, &key("enabled"), &format!("Use {}", title(kind)), c.enabled, move |h: &mut H| flip(h, i, "enabled")));
    if kind != "tebar" {
        body = body.child(toggle(dark, &key("director"), "Let it direct the picks", c.director.unwrap_or(false), move |h: &mut H| flip(h, i, "director")));
    }
    let endpoint_label = match kind {
        "tebar" => "API base URL",
        "jev" => "Endpoint",
        _ => "Base URL",
    };
    let mut fields = row().gap(12.0).w_full().child(field(dark, &key("endpoint"), endpoint_label, &card_state.endpoint, "Not set", false, edit_access(move |h: &mut H| &mut h.panels_mut().connections.cards[i].endpoint)).grow(1.0));
    if kind != "tebar" {
        fields = fields.child(field(dark, &key("model"), "Model", &card_state.model, "Not set", false, edit_access(move |h: &mut H| &mut h.panels_mut().connections.cards[i].model)).w(240.0));
    }
    let masked = card_state.key_field.displayed();
    let hint = if masked.is_empty() { "Not set".to_string() } else { format!("{masked} (type to replace)") };
    body = body.child(fields).child(field(dark, &key("key"), "API key", &card_state.key, &hint, true, edit_access(move |h: &mut H| &mut h.panels_mut().connections.cards[i].key)))
        .child(text("The key is shown as the engine masks it. Typing replaces it; leaving it empty keeps it.").font(type_::LABEL).color(p.muted).wrap());
    if let Some(profiles) = &c.profiles {
        let names = profiles.iter().map(|p| p.name.as_str()).collect::<Vec<_>>().join(", ");
        body = body.child(text(format!("Workspaces: {names}")).key(key("profiles")).font(type_::BODY).color(p.muted).wrap());
    }
    let mut actions = row().gap(10.0)
        .child(btn(dark, key("save"), "Save", true, !card_state.busy && dirty(h, i), move |h: &mut H| save(h, i)))
        .child(btn(dark, key("test"), "Test connection", false, !card_state.busy, move |h: &mut H| test(h, i)));
    if !c.saved.is_empty() {
        actions = actions.child(btn(dark, key("env"), "Use .env", false, !card_state.busy, move |h: &mut H| clear(h, i)));
    }
    body = body.child(actions);
    if let Some(why) = &card_state.error {
        body = body.child(note(dark, &key("error"), Tone::Bad, &format!("Not saved: {why}. Check the value and save again.")));
    }
    if let Some(done) = &card_state.notice {
        body = body.child(note(dark, &key("notice"), Tone::Ok, done));
    }
    if let Some(t) = &card_state.test {
        let words = if t.ok {
            let model = t.model.as_ref().map(|m| format!(", {m}")).unwrap_or_default();
            let detail = t.detail.as_ref().map(|d| format!(", {d}")).unwrap_or_default();
            format!("Works: answered in {} ms{model}{detail}", t.ms)
        } else {
            format!("Failed: {}. Check the address and key, then test again.", t.error.clone().unwrap_or_else(|| "no reason given".into()))
        };
        body = body.child(note(dark, &key("result"), if t.ok { Tone::Ok } else { Tone::Bad }, &words));
    }
    body
}

pub fn view<H: Host>(h: &H) -> El {
    let dark = h.dark();
    let c = &h.panels().connections;
    let head = heading(dark, "conn/title", "Connections", "Everything here is optional for clipping. Generate needs an AI connection.");
    let body = match (&c.load, &c.settings) {
        (Load::Failed(why), _) => state_block::<H>(dark, "conn/failed", Kind::Error, "Could not read the settings.", &format!("{why}. Try again."), Some(("conn/retry", "Try again", open::<H>))),
        (_, Some(s)) => {
            let mut cards = col().gap(16.0).w_full();
            for (i, kind) in KINDS.iter().enumerate() {
                cards = cards.child(one(h, i, view_of(s, kind)));
            }
            cards
        }
        _ => state_block::<H>(dark, "conn/loading", Kind::Loading, "Reading the settings.", "This takes a moment.", None),
    };
    col().gap(20.0).padding(40.0).w_full().max_w(960.0).child(head).child(super::tabs::<H>(dark, Page::Connections)).child(body)
}
