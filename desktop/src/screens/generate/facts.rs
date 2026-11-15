//! The facts of a video: each claim with the page that states it (`FactsPanel.tsx`). Check them
//! against their sources and see what was found: verified, corrected (with the value it had
//! before), or not verifiable. A factual recipe lets the video show only numbers a verified fact states.

use rune::tok::type_;
use rune::{El, TextEdit, col, edit_access, row, text};

use crate::engine::generate as api;
use crate::engine::generate::Fact;
use crate::screens::generate::Studio;
use crate::screens::generate::words::{t, tf};
use crate::screens::panels::{Host, Load, Panels, answer, go};
use crate::ui::form::{Tone, btn, card, field, note};
use crate::ui::kit::pal;

pub struct Facts {
    pub load: Load,
    pub list: Vec<Fact>,
    pub claim: TextEdit,
    pub value: TextEdit,
    pub url: TextEdit,
    pub busy: bool,
    pub error: Option<String>,
}

impl Default for Facts {
    fn default() -> Self {
        Facts { load: Load::Idle, list: vec![], claim: TextEdit::new(""), value: TextEdit::new(""), url: TextEdit::new(""), busy: false, error: None }
    }
}

fn listed(p: &mut Panels, r: Result<Vec<Fact>, String>) {
    let f = &mut p.studio.facts;
    f.busy = false;
    f.load = Load::of(&r);
    match r {
        Ok(list) => (f.list, f.error) = (list, None),
        Err(why) => f.error = Some(why),
    }
}

fn run<H: Host>(h: &mut H, f: impl FnOnce(&dyn crate::engine::Engine, &str) -> crate::engine::Result<Vec<Fact>> + Send + 'static) {
    let Some(id) = h.panels().studio.selected.clone() else { return };
    let facts = &mut h.panels_mut().studio.facts;
    (facts.busy, facts.error) = (true, None);
    go(h, move |e| answer(f(e, &id), listed));
}

pub fn add<H: Host>(h: &mut H) {
    let f = &h.panels().studio.facts;
    let (claim, value, url) = (f.claim.text.trim().to_string(), f.value.text.trim().to_string(), f.url.text.trim().to_string());
    if claim.is_empty() || url.is_empty() {
        return;
    }
    run(h, move |e, id| {
        api::add_fact(e, id, &claim, &value, &url)?;
        api::facts(e, id)
    });
    let f = &mut h.panels_mut().studio.facts;
    (f.claim, f.value, f.url) = (TextEdit::new(""), TextEdit::new(""), TextEdit::new(""));
}

pub fn remove<H: Host>(h: &mut H, fact_id: &str) {
    let fact_id = fact_id.to_string();
    run(h, move |e, id| {
        api::delete_fact(e, &fact_id)?;
        api::facts(e, id)
    });
}

/// Checks every fact against its source.
pub fn verify<H: Host>(h: &mut H) {
    run(h, |e, id| api::verify_facts(e, id));
}

pub fn view<H: Host>(dark: bool, s: &Studio, working: bool) -> El {
    let p = pal(dark);
    let f = &s.facts;
    let off = f.busy || working;
    let unchecked = f.list.iter().filter(|x| x.status == "unverified").count();
    let verify_label = if f.busy { t("facts.working") } else if unchecked > 0 { tf("facts.verify_n", &[&unchecked.to_string()]) } else { t("facts.verify_again") };
    let mut c = card(dark, "generate/facts", &t("step.facts")).child(text(t("facts.note")).font(type_::LABEL).color(p.muted).wrap());
    if f.load == Load::Ready && f.list.is_empty() {
        c = c.child(text(t("facts.empty")).key("generate/facts/empty").font(type_::BODY).color(p.muted));
    }
    for fact in &f.list {
        let k = |n: &str| format!("generate/fact/{}/{n}", fact.id);
        let id = fact.id.clone();
        let value = fact.value.as_ref().map(|v| format!(" ({v})")).unwrap_or_default();
        let mut body = col().gap(2.0).grow(1.0).child(text(format!("{}{value}", fact.claim)).key(k("claim")).font(type_::TITLE).color(p.text).wrap());
        if let Some(was) = &fact.original_value {
            body = body.child(text(tf("facts.was", &[was])).font(type_::LABEL).color(p.muted));
        }
        if let Some(src) = &fact.source_url {
            body = body.child(text(tf("facts.source", &[src])).font(type_::LABEL).color(p.muted).wrap());
        }
        if let Some(why) = &fact.evidence {
            let lead = t(if fact.status == "unverifiable" { "facts.why" } else { "facts.evidence" });
            body = body.child(text(format!("{lead}: \u{201c}{why}\u{201d}")).font(type_::LABEL).color(p.muted).wrap());
        }
        let ink = if fact.status == "verified" { p.pass } else { p.muted };
        c = c.child(
            row().key(k("row")).role("listitem").label(fact.claim.as_str()).gap(12.0).items_center().w_full().child(body)
                .child(text(t(&format!("fact.{}", fact.status))).key(k("status")).font(type_::LABEL).color(ink))
                .child(btn(dark, k("delete"), &t("facts.delete"), false, !off, move |h: &mut H| remove(h, &id))),
        );
    }
    c = c.child(btn(dark, "generate/facts/verify", &verify_label, true, !off && !f.list.is_empty(), verify::<H>))
        .child(field(dark, "generate/facts/claim", &t("facts.claim"), &f.claim, "", false, edit_access(|h: &mut H| &mut h.panels_mut().studio.facts.claim)))
        .child(field(dark, "generate/facts/value", &t("facts.value"), &f.value, "", false, edit_access(|h: &mut H| &mut h.panels_mut().studio.facts.value)))
        .child(field(dark, "generate/facts/url", &t("facts.url"), &f.url, "https://", false, edit_access(|h: &mut H| &mut h.panels_mut().studio.facts.url)))
        .child(btn(dark, "generate/facts/add", &t("facts.add"), false, !off && !f.claim.text.trim().is_empty() && !f.url.text.trim().is_empty(), add::<H>));
    if let Some(why) = &f.error {
        c = c.child(note(dark, "generate/facts/error", Tone::Bad, why));
    }
    c
}
