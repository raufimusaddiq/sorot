//! Settings, Connections: the LLM (Kenari or any OpenAI-compatible endpoint), Jev and Tebar.
//! Optional for clipping (constitution IV); a key is shown as the engine masks it and typing
//! replaces it (`core::masked`). A save goes to the engine, which reads settings on every call, so
//! the next action uses it with no restart.

use rune::{El, TextEdit, col, edit_access, row, text};
use rune::tok::type_;
use serde_json::{Map, Value, json};
use sorot_desktop_core::masked::KeyField;
use sorot_desktop_core::model::{Connection, Settings};

use crate::engine::Engine;
use crate::engine::types::{ConnTest, KenariAccount, KenariModel};
use crate::i18n::{Lang, tr, trf};
use crate::screens::panels::{Host, Load, Page, answer, go};
use crate::screens::settings::{KENARI_BASE_URL, KENARI_DEFAULT_MODEL, Mode, hint, mode_of, test_words, wrapped};
use crate::ui::form::{Tone, btn, card, choice, field, heading, note, page, toggle};
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
    pub notice: Option<bool>,
    /// The LLM card only: Kenari, an address of one's own, or not chosen yet.
    pub mode: Option<Mode>,
    pub kenari_models: Vec<KenariModel>,
    pub kenari_model: String,
    /// The Kenari key was tried and works: only then can it be saved.
    pub probe: Option<ConnTest>,
    pub account: Option<KenariAccount>,
}

impl Default for Card {
    fn default() -> Self {
        Card {
            endpoint: TextEdit::new(""), model: TextEdit::new(""), key: TextEdit::new("").secure(), key_field: KeyField::default(),
            busy: false, error: None, test: None, notice: None, mode: None, kenari_models: vec![], kenari_model: KENARI_DEFAULT_MODEL.into(), probe: None, account: None,
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
        if kind == "llm" {
            self.probe = None;
            if let Some(m) = mode_of(c.base_url.as_deref()) {
                self.mode = Some(m);
            }
            if self.mode == Some(Mode::Kenari) {
                self.kenari_model = c.model.clone().filter(|m| !m.is_empty() && c.base_url.as_deref() == Some(KENARI_BASE_URL)).unwrap_or_else(|| KENARI_DEFAULT_MODEL.into());
            }
        }
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

/// Everything one read of the connections brings.
type Fresh = (Settings, Vec<KenariModel>, Option<KenariAccount>);

/// The Kenari lists an LLM set up through Kenari shows: its models, and the balance when it works.
fn extras(e: &dyn Engine, s: &Settings) -> (Vec<KenariModel>, Option<KenariAccount>) {
    if mode_of(s.llm.base_url.as_deref()) != Some(Mode::Kenari) {
        return (vec![], None);
    }
    (e.kenari_models("llm").unwrap_or_default(), if s.llm.active { e.kenari_account().ok().flatten() } else { None })
}

impl Connections {
    fn loaded(&mut self, r: Result<Fresh, String>) {
        self.load = Load::of(&r);
        if let Ok((s, models, account)) = r {
            for (kind, card) in KINDS.iter().zip(&mut self.cards) {
                card.fill(kind, view_of(&s, kind));
            }
            let llm = &mut self.cards[0];
            if !models.is_empty() {
                llm.kenari_models = models;
            }
            llm.account = account;
            self.settings = Some(s);
        }
    }

    fn saved(&mut self, i: usize, r: Result<Fresh, String>) {
        self.cards[i].busy = false;
        match r {
            Ok(fresh) => {
                self.loaded(Ok(fresh));
                let card = &mut self.cards[i];
                (card.error, card.test, card.notice) = (None, None, Some(true));
            }
            Err(e) => self.cards[i].error = Some(e),
        }
    }
}

/// Reads the settings from the engine.
pub fn open<H: Host>(h: &mut H) {
    h.panels_mut().connections.load = Load::Loading;
    go(h, |e| {
        let fresh = e.settings().map(|s| {
            let (m, a) = extras(e, &s);
            (s, m, a)
        });
        answer(fresh, |p, r| p.connections.loaded(r))
    });
}

fn send<H: Host>(h: &mut H, i: usize, patch: Value) {
    let card = &mut h.panels_mut().connections.cards[i];
    (card.busy, card.error, card.notice) = (true, None, None);
    go(h, move |e| {
        let fresh = e.update_settings(KINDS[i], &patch).map(|s| {
            let (m, a) = extras(e, &s);
            (s, m, a)
        });
        answer(fresh, move |p, r| p.connections.saved(i, r))
    });
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

/// Chooses how the LLM is set up. Kenari reads its model list the first time.
pub fn set_mode<H: Host>(h: &mut H, mode: Mode) {
    let card = &mut h.panels_mut().connections.cards[0];
    card.mode = Some(mode);
    (card.probe, card.error, card.test, card.notice) = (None, None, None, None);
    card.key.replace_text("");
    card.key_field.type_text("");
    if mode == Mode::Kenari && card.kenari_models.is_empty() {
        go(h, |e| answer(e.kenari_models("llm"), |p, r| p.connections.cards[0].kenari_models = r.unwrap_or_default()));
    }
}

pub fn pick_kenari_model<H: Host>(h: &mut H, id: &str) {
    let card = &mut h.panels_mut().connections.cards[0];
    card.kenari_model = id.to_string();
    card.probe = None;
}

/// Tries the typed Kenari key with the chosen model before anything is saved.
pub fn probe_kenari<H: Host>(h: &mut H) {
    let card = &mut h.panels_mut().connections.cards[0];
    let (model, key) = (card.kenari_model.clone(), card.key.text.trim().to_string());
    (card.busy, card.probe, card.error) = (true, None, None);
    go(h, move |e| {
        answer(e.probe_llm(&model, &key), |p, r| {
            let card = &mut p.connections.cards[0];
            card.busy = false;
            card.probe = Some(r.unwrap_or_else(|why| ConnTest { ok: false, ms: 0, model: None, detail: None, error: Some(why) }));
        })
    });
}

/// Saves Kenari's address, the chosen model and the key that was just tried.
pub fn connect_kenari<H: Host>(h: &mut H) {
    let card = &h.panels().connections.cards[0];
    if !card.probe.as_ref().is_some_and(|t| t.ok) {
        return;
    }
    let patch = json!({ "baseUrl": KENARI_BASE_URL, "model": card.kenari_model, "apiKey": card.key.text.trim() });
    send(h, 0, patch);
}

fn title(l: Lang, kind: &str) -> String {
    tr(l, &format!("conn.{kind}.title"))
}

/// True when the card holds a change the engine does not have.
fn dirty<H: Host>(h: &H, i: usize) -> bool {
    let c = &h.panels().connections;
    let Some(s) = &c.settings else { return false };
    let (card, view) = (&c.cards[i], view_of(s, KINDS[i]));
    card.endpoint.text != endpoint_of(KINDS[i], view) || (KINDS[i] != "tebar" && card.model.text != view.model.clone().unwrap_or_default()) || !card.key.text.is_empty()
}

fn rp(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push('.');
        }
        out.push(ch);
    }
    format!("Rp {out}")
}

/// Kenari's balance, plan quota and usage totals.
fn account_block(dark: bool, l: Lang, a: &KenariAccount) -> El {
    let p = pal(dark);
    let mut b = col().key("conn/llm/kenari/account").role("group").label(tr(l, "conn.kenari.account")).gap(4.0)
        .child(text(trf(l, "conn.kenari.balance", &[("rp", &rp(a.balance_rp))])).key("conn/llm/kenari/balance").font(type_::TITLE).color(p.text));
    if let Some(plan) = &a.plan {
        b = b.child(hint(dark, trf(l, "conn.kenari.plan", &[("plan", plan)])));
    }
    for (name, w) in &a.windows {
        b = b.child(hint(dark, trf(l, "conn.kenari.window", &[("name", name), ("pct", &format!("{:.0}", w.used_frac * 100.0)), ("left", &rp(w.remaining_rp))])));
    }
    b.child(hint(dark, trf(l, "conn.kenari.usage", &[("n", &a.usage.requests.to_string()), ("in", &a.usage.prompt_tokens.to_string()), ("out", &a.usage.completion_tokens.to_string())])))
}

/// The LLM card set up through Kenari: a model, one key, a try, then save.
fn kenari_body<H: Host>(h: &H, l: Lang, c: &Connection) -> El {
    let (dark, st) = (h.dark(), &h.panels().connections.cards[0]);
    let mut models = vec![choice(dark, "conn/llm/kenari/model/0", &tr(l, "conn.kenari.auto"), st.kenari_model == KENARI_DEFAULT_MODEL, |h: &mut H| pick_kenari_model(h, KENARI_DEFAULT_MODEL))];
    for (n, m) in st.kenari_models.iter().filter(|m| m.id != KENARI_DEFAULT_MODEL).enumerate() {
        let id = m.id.clone();
        let label = if m.free { trf(l, "conn.kenari.free", &[("id", &m.id)]) } else { m.id.clone() };
        models.push(choice(dark, &format!("conn/llm/kenari/model/{}", n + 1), &label, st.kenari_model == m.id, move |h: &mut H| pick_kenari_model(h, &id)));
    }
    let saved_here = c.api_key_set && c.base_url.as_deref() == Some(KENARI_BASE_URL);
    let key_hint = if saved_here { trf(l, "conn.key-replace", &[("masked", &c.api_key)]) } else { "kn-…".to_string() };
    let ready = st.probe.as_ref().is_some_and(|t| t.ok);
    let mut b = col().gap(12.0).w_full()
        .child(text(tr(l, "conn.kenari.model")).font(type_::LABEL).color(pal(dark).muted))
        .child(wrapped(models))
        .child(field(dark, "conn/llm/kenari/key", &tr(l, "conn.kenari.key"), &st.key, &key_hint, true, edit_access(|h: &mut H| &mut h.panels_mut().connections.cards[0].key)))
        .child(row().gap(10.0)
            .child(btn(dark, "conn/llm/kenari/probe", &tr(l, "conn.kenari.probe"), false, !st.busy && !st.key.text.trim().is_empty(), probe_kenari::<H>))
            .child(btn(dark, "conn/llm/kenari/connect", &tr(l, "conn.save"), true, !st.busy && ready, connect_kenari::<H>)));
    if let Some(t) = &st.probe {
        b = b.child(note(dark, "conn/llm/kenari/result", if t.ok { Tone::Ok } else { Tone::Bad }, &test_words(l, t)));
    }
    match &st.account {
        Some(a) => b = b.child(account_block(dark, l, a)),
        None if c.active => b = b.child(hint(dark, tr(l, "conn.kenari.no-account")).key("conn/llm/kenari/no-account")),
        None => {}
    }
    b
}

fn one<H: Host>(h: &H, i: usize, c: &Connection) -> El {
    let (dark, l, kind) = (h.dark(), h.lang(), KINDS[i]);
    let p = pal(dark);
    let st = &h.panels().connections.cards[i];
    let key = |n: &str| format!("conn/{kind}/{n}");
    let (status, tone) = if c.active { (tr(l, "conn.ready"), p.pass) } else { (tr(l, "conn.off"), p.muted) };
    let name = title(l, kind);
    let mut body = card(dark, &key("card"), &name)
        .child(text(status).key(key("status")).font(type_::LABEL).color(tone))
        .child(text(tr(l, &format!("conn.{kind}.about"))).font(type_::BODY).color(p.muted).wrap())
        .child(toggle(dark, l, &key("enabled"), &trf(l, "conn.use", &[("name", &name)]), c.enabled, move |h: &mut H| flip(h, i, "enabled")));
    if kind != "tebar" {
        body = body.child(toggle(dark, l, &key("director"), &tr(l, "conn.director"), c.director.unwrap_or(false), move |h: &mut H| flip(h, i, "director")));
    }
    if kind == "llm" {
        match st.mode {
            None => {
                body = body.child(row().gap(8.0)
                    .child(btn(dark, key("mode-kenari"), &tr(l, "conn.kenari.connect"), true, true, |h: &mut H| set_mode(h, Mode::Kenari)))
                    .child(btn(dark, key("mode-custom"), &tr(l, "conn.kenari.other"), false, true, |h: &mut H| set_mode(h, Mode::Custom))));
            }
            Some(m) => {
                let (other, label) = if m == Mode::Kenari { (Mode::Custom, "conn.kenari.use-other") } else { (Mode::Kenari, "conn.kenari.use-kenari") };
                body = body.child(row().child(btn(dark, key("mode-switch"), &tr(l, label), false, true, move |h: &mut H| set_mode(h, other))));
            }
        }
    }
    let kenari = kind == "llm" && st.mode == Some(Mode::Kenari);
    let open_fields = kind != "llm" || st.mode == Some(Mode::Custom);
    if kenari {
        body = body.child(kenari_body::<H>(h, l, c));
    }
    if open_fields {
        let endpoint_label = tr(l, match kind {
            "tebar" => "conn.endpoint.api",
            "jev" => "conn.endpoint.jev",
            _ => "conn.endpoint.base",
        });
        let mut fields = row().gap(12.0).w_full().child(field(dark, &key("endpoint"), &endpoint_label, &st.endpoint, &tr(l, "conn.not-set"), false, edit_access(move |h: &mut H| &mut h.panels_mut().connections.cards[i].endpoint)).grow(1.0));
        if kind != "tebar" {
            fields = fields.child(field(dark, &key("model"), &tr(l, "conn.model"), &st.model, &tr(l, "conn.not-set"), false, edit_access(move |h: &mut H| &mut h.panels_mut().connections.cards[i].model)).w(240.0));
        }
        let masked = st.key_field.displayed();
        let key_hint = if masked.is_empty() { tr(l, "conn.not-set") } else { trf(l, "conn.key-replace", &[("masked", masked)]) };
        body = body.child(fields).child(field(dark, &key("key"), &tr(l, "conn.key"), &st.key, &key_hint, true, edit_access(move |h: &mut H| &mut h.panels_mut().connections.cards[i].key)))
            .child(hint(dark, tr(l, "conn.key-about")));
    }
    if let Some(profiles) = &c.profiles {
        let names = profiles.iter().map(|p| p.name.as_str()).collect::<Vec<_>>().join(", ");
        body = body.child(text(trf(l, "conn.workspaces", &[("names", &names)])).key(key("profiles")).font(type_::BODY).color(p.muted).wrap());
    }
    let mut actions = row().gap(10.0);
    if open_fields {
        actions = actions.child(btn(dark, key("save"), &tr(l, "conn.save"), true, !st.busy && dirty(h, i), move |h: &mut H| save(h, i)));
    }
    actions = actions.child(btn(dark, key("test"), &tr(l, "conn.test"), false, !st.busy, move |h: &mut H| test(h, i)));
    if !c.saved.is_empty() {
        actions = actions.child(btn(dark, key("env"), &tr(l, "conn.env"), false, !st.busy, move |h: &mut H| clear(h, i)));
    }
    body = body.child(actions);
    if let Some(why) = &st.error {
        body = body.child(note(dark, &key("error"), Tone::Bad, &trf(l, "conn.not-saved", &[("why", why)])));
    }
    if st.notice == Some(true) {
        body = body.child(note(dark, &key("notice"), Tone::Ok, &tr(l, "conn.saved")));
    }
    if let Some(t) = &st.test {
        body = body.child(note(dark, &key("result"), if t.ok { Tone::Ok } else { Tone::Bad }, &test_words(l, t)));
    }
    body
}

pub fn view<H: Host>(h: &H) -> El {
    let (dark, l) = (h.dark(), h.lang());
    let c = &h.panels().connections;
    let head = heading(dark, "conn/title", &tr(l, "settings.title"), &tr(l, "conn.sub"));
    let body = match (&c.load, &c.settings) {
        (Load::Failed(why), _) => state_block::<H>(dark, "conn/failed", Kind::Error, &tr(l, "conn.read-failed"), &trf(l, "state.try-again-after", &[("why", why)]), Some(("conn/retry", &tr(l, "state.retry"), open::<H>))),
        (_, Some(s)) => {
            let mut cards = col().gap(16.0).w_full();
            for (i, kind) in KINDS.iter().enumerate() {
                cards = cards.child(one(h, i, view_of(s, kind)));
            }
            cards
        }
        _ => state_block::<H>(dark, "conn/loading", Kind::Loading, &tr(l, "conn.reading"), &tr(l, "state.moment"), None),
    };
    page().child(head).child(super::tabs::<H>(dark, l, Page::Connections)).child(body)
}
