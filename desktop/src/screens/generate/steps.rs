//! A recipe as steps (`RecipeEditor.tsx`): add, remove and reorder them, choose each one's gate and
//! condition, and set what its schema offers. The recipe's JSON stays the one source of truth, so
//! the JSON tab and this form always show the same recipe. Settings that are objects or lists are
//! edited in the JSON tab.

use rune::tok::type_;
use rune::{El, TextEdit, col, edit_access, row, text};
use serde_json::Value;

use crate::engine::generate::StepSpec;
use crate::screens::generate::recipes::Recipes;
use crate::screens::generate::{t, tf};
use crate::screens::panels::Host;
use crate::ui::form::{btn, choice, field, toggle};
use crate::ui::kit::pal;

/// What a step can be conditioned on.
pub const WHEN: [&str; 5] = ["connection:image", "connection:vision", "connection:voice", "connection:llm", "connection:jev"];

/// The recipe in the text, or nothing while the text is not JSON (the JSON tab says why).
fn recipe(r: &Recipes) -> Option<Value> {
    serde_json::from_str(&r.text.text).ok()
}

/// Changes the recipe in the text through `f`, which gets the step list.
fn change<H: Host>(h: &mut H, f: impl FnOnce(&mut Vec<Value>)) {
    let r = &mut h.panels_mut().studio.recipes;
    let Some(mut v) = recipe(r) else { return };
    let Some(steps) = v.get_mut("steps").and_then(Value::as_array_mut) else { return };
    f(steps);
    (r.text, r.checked) = (TextEdit::new(serde_json::to_string_pretty(&v).unwrap_or_default()), None);
}

/// Sets (or, with `None`, removes) one key of a step; an empty `with` goes away.
fn put(step: &mut Value, key: &str, value: Option<Value>) {
    let Some(o) = step.as_object_mut() else { return };
    match value {
        Some(v) => o.insert(key.into(), v),
        None => o.remove(key),
    };
}

fn put_with(step: &mut Value, name: &str, value: Option<Value>) {
    let mut with = step.get("with").and_then(Value::as_object).cloned().unwrap_or_default();
    match value {
        Some(v) => with.insert(name.into(), v),
        None => with.remove(name),
    };
    put(step, "with", (!with.is_empty()).then_some(Value::Object(with)));
}

fn at<H: Host>(h: &mut H, i: usize, f: impl FnOnce(&mut Value)) {
    change(h, |steps| {
        if let Some(s) = steps.get_mut(i) {
            f(s);
        }
    });
}

pub fn shift<H: Host>(h: &mut H, i: usize, down: bool) {
    change(h, |steps| {
        let j = if down { i + 1 } else { i.wrapping_sub(1) };
        if i < steps.len() && j < steps.len() {
            steps.swap(i, j);
        }
    });
    let r = &mut h.panels_mut().studio.recipes;
    if r.open_step == Some(i) {
        r.open_step = Some(if down { i + 1 } else { i.saturating_sub(1) });
    }
}

pub fn remove<H: Host>(h: &mut H, i: usize) {
    change(h, |steps| {
        if i < steps.len() {
            steps.remove(i);
        }
    });
    let r = &mut h.panels_mut().studio.recipes;
    (r.open_step, r.typing) = (None, None);
}

/// Adds the step chosen in the list; the export step stays last.
pub fn add<H: Host>(h: &mut H) {
    let r = &h.panels().studio.recipes;
    let Some(kind) = r.specs.get(r.adding).map(|s| s.kind.clone()) else { return };
    change(h, |steps| {
        let fresh = serde_json::json!({ "use": kind });
        let last_is_export = steps.last().and_then(|s| s["use"].as_str()) == Some("export") && kind != "export";
        let at = if last_is_export { steps.len() - 1 } else { steps.len() };
        steps.insert(at, fresh);
    });
}

fn open<H: Host>(h: &mut H, i: usize) {
    let r = &mut h.panels_mut().studio.recipes;
    (r.open_step, r.typing) = (if r.open_step == Some(i) { None } else { Some(i) }, None);
}

fn name_it<H: Host>(h: &mut H, _: &str) {
    let r = &mut h.panels_mut().studio.recipes;
    let name = r.name.text.trim().to_string();
    if let Some(mut v) = recipe(r) {
        v["name"] = Value::String(name);
        (r.text, r.checked) = (TextEdit::new(serde_json::to_string_pretty(&v).unwrap_or_default()), None);
    }
}

/// A number setting moved one step up or down, kept inside its range.
fn nudge<H: Host>(h: &mut H, i: usize, name: &str, field: &Value, now: f64, up: bool) {
    let (lo, hi) = (field["min"].as_f64().unwrap_or(0.0), field["max"].as_f64().unwrap_or(f64::MAX));
    let whole = field["t"] == "int";
    let by = if whole { 1.0 } else { 0.1 };
    let next = (now + if up { by } else { -by }).clamp(lo, hi);
    let value = if whole { Value::from(next.round() as i64) } else { Value::from((next * 10.0).round() / 10.0) };
    let name = name.to_string();
    at(h, i, move |s| put_with(s, &name, Some(value)));
}

fn type_in<H: Host>(h: &mut H, i: usize, name: &str, now: &str) {
    let r = &mut h.panels_mut().studio.recipes;
    (r.typing, r.typed) = (Some((i, name.to_string())), TextEdit::new(now));
}

/// Writes the typed words to the setting: text as it is, a list from its commas; empty clears it.
fn set_typed<H: Host>(h: &mut H, list: bool) {
    let r = &mut h.panels_mut().studio.recipes;
    let Some((step, name)) = r.typing.take() else { return };
    let typed = r.typed.text.trim().to_string();
    let value = if typed.is_empty() {
        None
    } else if list {
        Some(Value::from(typed.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect::<Vec<_>>()))
    } else {
        Some(Value::String(typed))
    };
    at(h, step, move |s| put_with(s, &name, value));
}

fn shown(v: &Value) -> String {
    match v {
        Value::Array(a) => a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", "),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// The settings a step's schema offers, one control each.
fn settings<H: Host>(dark: bool, i: usize, spec: &StepSpec, step: &Value, r: &Recipes) -> El {
    let p = pal(dark);
    let with = step.get("with").and_then(Value::as_object).cloned().unwrap_or_default();
    let mut c = col().gap(8.0).w_full();
    for (name, f) in &spec.fields {
        let key = format!("generate/recipes/step/{i}/with/{name}");
        let now = with.get(name).or_else(|| spec.defaults.get(name));
        let kind = f["t"].as_str().unwrap_or_default();
        let n = name.clone();
        let line = match kind {
            "bool" | "flag" => {
                let on = now.is_some_and(|v| v == &Value::Bool(true) || v.is_object());
                let (n2, flag) = (n.clone(), kind == "flag");
                toggle(dark, &key, name, on, move |h: &mut H| {
                    let n2 = n2.clone();
                    at(h, i, move |s| put_with(s, &n2, Some(if flag && !on { Value::Bool(true) } else { Value::Bool(!on) })));
                })
            }
            "enum" => {
                let mut r = row().gap(6.0).flex_wrap().w_full().items_center().child(text(name.as_str()).font(type_::LABEL).color(p.muted));
                for v in f["values"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                    let (n3, v2) = (n.clone(), v.to_string());
                    r = r.child(choice(dark, &format!("{key}/{v}"), v, now.and_then(Value::as_str) == Some(v), move |h: &mut H| {
                        let (n3, v2) = (n3.clone(), v2.clone());
                        at(h, i, move |s| put_with(s, &n3, Some(Value::String(v2))));
                    }));
                }
                r
            }
            "int" | "num" => {
                let value = now.and_then(Value::as_f64).unwrap_or_else(|| f["min"].as_f64().unwrap_or(0.0));
                let (f1, f2, n1, n2) = (f.clone(), f.clone(), n.clone(), n.clone());
                row().gap(8.0).items_center()
                    .child(text(name.as_str()).font(type_::LABEL).color(p.muted))
                    .child(mini(dark, format!("{key}/dec"), "−", &tf("recipes.less", &[name]), false, true, move |h: &mut H| nudge(h, i, &n1, &f1, value, false)))
                    .child(text(shown(&Value::from(value))).key(key.clone()).font(type_::BODY).color(p.text))
                    .child(mini(dark, format!("{key}/inc"), "+", &tf("recipes.more", &[name]), false, true, move |h: &mut H| nudge(h, i, &n2, &f2, value, true)))
            }
            "str" | "strs" => {
                let (n4, now_text, list) = (n.clone(), now.map(shown).unwrap_or_default(), kind == "strs");
                match r.typing.as_ref().filter(|(s, n)| *s == i && n == name) {
                    Some(_) => row().gap(8.0).items_center().w_full()
                        .child(col().grow(1.0).child(field(dark, &format!("{key}/input"), name, &r.typed, "", false, edit_access(|h: &mut H| &mut h.panels_mut().studio.recipes.typed))))
                        .child(btn(dark, format!("{key}/set"), &t("recipes.set"), true, true, move |h: &mut H| set_typed(h, list))),
                    None => row().gap(8.0).items_center()
                        .child(btn(dark, format!("{key}/edit"), &tf("recipes.edit_setting", &[name, &now_text]), false, true, move |h: &mut H| type_in(h, i, &n4, &now_text))),
                }
            }
            _ => row().child(text(tf("recipes.in_json", &[name])).key(key).font(type_::LABEL).color(p.muted).wrap()),
        };
        c = c.child(line);
    }
    c
}

/// A small button: `shown` is its few visible characters, `label` what a screen reader says.
fn mini<H: Host>(dark: bool, key: String, shown: &str, label: &str, active: bool, enabled: bool, f: impl Fn(&mut H) + 'static) -> El {
    let p = pal(dark);
    let (fill, ink) = match (active, enabled) {
        (_, false) => (p.surface, p.muted),
        (true, true) => (p.beam, p.bg),
        (false, true) => (p.raised, p.text),
    };
    let b = col().key(key).role("button").label(label).px(10.0).py(8.0).radius(6.0).fill(fill).border(1.0, p.divider).child(text(shown).font(type_::LABEL).color(ink));
    if enabled { b.focusable(true).on_press(f) } else { b.disabled(true) }
}

/// The form: name, steps, and the one step opened to its gate, condition and settings.
pub fn view<H: Host>(dark: bool, r: &Recipes) -> El {
    let p = pal(dark);
    let Some(v) = recipe(r) else {
        return text(t("recipes.fix_json")).key("generate/recipes/steps/broken").font(type_::BODY).color(p.muted).wrap();
    };
    let steps = v["steps"].as_array().cloned().unwrap_or_default();
    let mut c = col().gap(10.0).w_full().child(field(dark, "generate/recipes/name", &t("recipes.name"), &r.name, "", false, edit_access(|h: &mut H| &mut h.panels_mut().studio.recipes.name)))
        .child(btn(dark, "generate/recipes/name/set", &t("recipes.name_set"), false, true, move |h: &mut H| name_it(h, "")));
    for (i, s) in steps.iter().enumerate() {
        let kind = s["use"].as_str().unwrap_or_default().to_string();
        let gate = s["gate"].as_str().filter(|g| *g != "none").map(|g| format!(" · {}", tf("recipes.gate", &[g]))).unwrap_or_default();
        let title = format!("{}. {kind}{gate}", i + 1);
        let key = format!("generate/recipes/step/{i}");
        let is_open = r.open_step == Some(i);
        let head = row().gap(6.0).items_center().w_full()
            .child(text(title.as_str()).key(format!("{key}/title")).font(type_::BODY).color(p.text).grow(1.0))
            .child(mini(dark, format!("{key}/up"), "↑", &tf("recipes.up", &[&title]), false, i > 0, move |h: &mut H| shift(h, i, false)))
            .child(mini(dark, format!("{key}/down"), "↓", &tf("recipes.down", &[&title]), false, i + 1 < steps.len(), move |h: &mut H| shift(h, i, true)))
            .child(mini(dark, format!("{key}/open"), &t(if is_open { "recipes.close_short" } else { "recipes.open_short" }), &tf(if is_open { "recipes.close" } else { "recipes.open" }, &[&title]), is_open, true, move |h: &mut H| open(h, i)))
            .child(mini(dark, format!("{key}/remove"), "×", &tf("recipes.remove", &[&title]), false, true, move |h: &mut H| remove(h, i)));
        let mut card = col().key(key.clone()).role("group").label(title.as_str()).gap(8.0).padding(8.0).w_full().border(1.0, p.divider).radius(8.0).child(head);
        if let (true, Some(spec)) = (is_open, r.specs.iter().find(|x| x.kind == kind)) {
            let mut gates = row().gap(6.0).flex_wrap().w_full().items_center().child(text(t("recipes.gates")).font(type_::LABEL).color(p.muted));
            for g in ["none", "owner", "director"].into_iter().filter(|g| spec.gates.iter().any(|x| x == g)) {
                let on = s["gate"].as_str().unwrap_or("none") == g;
                gates = gates.child(choice(dark, &format!("{key}/gate/{g}"), g, on, move |h: &mut H| at(h, i, move |s| put(s, "gate", (g != "none").then(|| Value::String(g.into()))))));
            }
            let mut when = row().gap(6.0).flex_wrap().w_full().items_center().child(text(t("recipes.when")).font(type_::LABEL).color(p.muted));
            when = when.child(choice(dark, &format!("{key}/when/always"), &t("recipes.always"), s["when"].is_null(), move |h: &mut H| at(h, i, |s| put(s, "when", None))));
            for w in WHEN {
                when = when.child(choice(dark, &format!("{key}/when/{w}"), w, s["when"].as_str() == Some(w), move |h: &mut H| at(h, i, move |s| put(s, "when", Some(Value::String(w.into()))))));
            }
            card = card.child(gates).child(when).child(settings::<H>(dark, i, spec, s, r));
        }
        c = c.child(card);
    }
    let mut kinds = row().gap(6.0).flex_wrap().w_full().items_center().child(text(t("recipes.add_step")).font(type_::LABEL).color(p.muted));
    for (k, spec) in r.specs.iter().enumerate() {
        kinds = kinds.child(choice(dark, &format!("generate/recipes/add/{}", spec.kind), &spec.kind, r.adding == k, move |h: &mut H| h.panels_mut().studio.recipes.adding = k));
    }
    c.child(kinds).child(btn(dark, "generate/recipes/add", &t("recipes.add"), false, !r.specs.is_empty(), add::<H>))
}
