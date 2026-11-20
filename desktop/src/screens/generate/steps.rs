//! A recipe as steps (`RecipeEditor.tsx`): add, remove and reorder them, choose each one's gate and
//! condition, and set what its schema offers. The recipe's JSON stays the one source of truth, so
//! the JSON tab and this form always show the same recipe. Objects, lists and a flag's fields are
//! drawn from the schema the engine sends, as deep as it goes; a step also has its own id and its
//! instructions for the director.

use rune::tok::type_;
use rune::{El, TextEdit, col, edit_access, row, text};
use serde_json::Value;

use crate::engine::generate::StepSpec;
use crate::screens::generate::recipes::Recipes;
use crate::screens::generate::{t, tf};
use crate::screens::panels::Host;
use crate::ui::focus;
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

/// An empty value of this field, for a new list item.
fn blank(f: &Value) -> Value {
    match f["t"].as_str().unwrap_or_default() {
        "obj" => Value::Object(Default::default()),
        "bool" | "flag" => Value::Bool(false),
        "int" | "num" => f["min"].clone(),
        "enum" => f["values"][0].clone(),
        "strs" | "list" => Value::Array(vec![]),
        _ => Value::String(String::new()),
    }
}

/// `cur` with `leaf` put at `path` below a field of schema `f`; an object or list left empty goes
/// away (a flag left with nothing in it is just on). `None` removes what is at the path.
fn set_at(cur: Option<Value>, path: &[String], f: &Value, leaf: Option<Value>) -> Option<Value> {
    let Some((head, rest)) = path.split_first() else { return leaf };
    match f["t"].as_str().unwrap_or_default() {
        kind @ ("obj" | "flag") => {
            let mut o = cur.and_then(|v| v.as_object().cloned()).unwrap_or_default();
            match set_at(o.get(head).cloned(), rest, &f["fields"][head], leaf) {
                Some(v) => o.insert(head.clone(), v),
                None => o.remove(head),
            };
            if !o.is_empty() { Some(Value::Object(o)) } else { (kind == "flag").then_some(Value::Bool(true)) }
        }
        "list" => {
            let mut a = cur.and_then(|v| v.as_array().cloned()).unwrap_or_default();
            let i = head.parse::<usize>().ok().filter(|i| *i < a.len())?;
            match set_at(Some(a[i].clone()), rest, &f["item"], leaf) {
                Some(v) => a[i] = v,
                None => drop(a.remove(i)),
            }
            (!a.is_empty()).then_some(Value::Array(a))
        }
        _ => cur,
    }
}

/// Puts `leaf` at `path` in step `i`'s settings, by the schema of its step type.
fn put_path<H: Host>(h: &mut H, i: usize, path: Vec<String>, leaf: Option<Value>) {
    let fields = {
        let r = &h.panels().studio.recipes;
        let kind = recipe(r).and_then(|v| v["steps"][i]["use"].as_str().map(String::from));
        kind.and_then(|k| r.specs.iter().find(|x| x.kind == k)).map(|x| x.fields.clone()).unwrap_or_default()
    };
    let root = serde_json::json!({ "t": "obj", "fields": fields });
    at(h, i, move |s| {
        let now = set_at(s.get("with").cloned(), &path, &root, leaf);
        put(s, "with", now);
    });
}

fn value_at<'a>(with: &'a serde_json::Map<String, Value>, name: &str) -> Option<&'a Value> {
    with.get(name)
}

/// A number setting moved one step up or down, kept inside its range.
fn nudge<H: Host>(h: &mut H, i: usize, path: Vec<String>, field: &Value, now: f64, up: bool) {
    let (lo, hi) = (field["min"].as_f64().unwrap_or(0.0), field["max"].as_f64().unwrap_or(f64::MAX));
    let whole = field["t"] == "int";
    let by = if whole { 1.0 } else { 0.1 };
    let next = (now + if up { by } else { -by }).clamp(lo, hi);
    let value = if whole { Value::from(next.round() as i64) } else { Value::from((next * 10.0).round() / 10.0) };
    put_path(h, i, path, Some(value));
}

fn type_in<H: Host>(h: &mut H, i: usize, name: &str, now: &str) {
    let r = &mut h.panels_mut().studio.recipes;
    (r.typing, r.typed) = (Some((i, name.to_string())), TextEdit::new(now));
}

/// Writes the typed words: the step's id or prompt, or a setting (text as it is, a list from its
/// commas); empty clears it.
fn set_typed<H: Host>(h: &mut H, list: bool) {
    let r = &mut h.panels_mut().studio.recipes;
    let Some((step, name)) = r.typing.take() else { return };
    let typed = r.typed.text.trim().to_string();
    match name.as_str() {
        "$id" => at(h, step, move |s| put(s, "id", (!typed.is_empty()).then_some(Value::String(typed)))),
        "$prompt" => {
            let words = r.typed.text.clone();
            at(h, step, move |s| {
                let mode = s["prompt"]["mode"].as_str().unwrap_or("append").to_string();
                put(s, "prompt", Some(serde_json::json!({ "mode": mode, "text": words })));
            });
        }
        _ => {
            let value = if typed.is_empty() {
                None
            } else if list {
                Some(Value::from(typed.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect::<Vec<_>>()))
            } else {
                Some(Value::String(typed))
            };
            put_path(h, step, name.split('.').map(String::from).collect(), value);
        }
    }
}

fn shown(v: &Value) -> String {
    match v {
        Value::Array(a) => a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", "),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// One setting of a step, drawn from its schema; objects, flags with fields and lists draw their
/// parts the same way, below it.
fn control<H: Host>(dark: bool, i: usize, path: &[String], label: &str, f: &Value, now: Option<&Value>, r: &Recipes) -> El {
    let p = pal(dark);
    let name = path.join(".");
    let key = focus::gen_recipe_with(i, &name, "");
    let kind = f["t"].as_str().unwrap_or_default();
    let label_text = text(label.to_string()).font(type_::LABEL).color(p.muted);
    match kind {
        "bool" | "flag" => {
            let on = now.is_some_and(|v| v == &Value::Bool(true) || v.is_object());
            let always = f["always"] == true;
            let at_path = path.to_vec();
            let flag = kind == "flag";
            let toggled = toggle(dark, crate::i18n::current(), &key, label, on, move |h: &mut H| {
                let leaf = if flag && on { (!always).then_some(Value::Bool(false)) } else { Some(Value::Bool(!on)) };
                put_path(h, i, at_path.clone(), leaf);
            });
            let mut c = col().gap(6.0).w_full().child(toggled);
            if let (true, true, Some(fields)) = (flag, on, f["fields"].as_object()) {
                c = c.child(children::<H>(dark, i, path, fields, now, r));
            }
            c
        }
        "obj" => col().gap(6.0).w_full().child(label_text).child(children::<H>(dark, i, path, f["fields"].as_object().unwrap_or(&Default::default()), now, r)),
        "list" => {
            let items = now.and_then(Value::as_array).cloned().unwrap_or_default();
            let max = f["max"].as_u64().unwrap_or(u64::MAX) as usize;
            let mut c = col().gap(8.0).w_full().child(label_text);
            for (k, item) in items.iter().enumerate() {
                let mut sub = path.to_vec();
                sub.push(k.to_string());
                let title = format!("{label} {}", k + 1);
                let gone = sub.clone();
                c = c.child(
                    col().key(focus::gen_recipe_with(i, &name, &k.to_string())).role("group").label(title.as_str()).gap(6.0).padding(8.0).w_full().border(1.0, p.divider).radius(8.0)
                        .child(control::<H>(dark, i, &sub, &title, &f["item"], Some(item), r))
                        .child(btn(dark, focus::gen_recipe_with(i, &name, &format!("{k}/remove")), &tf("recipes.remove_item", &[&title]), false, true, move |h: &mut H| put_path(h, i, gone.clone(), None))),
                );
            }
            let (here, room) = (path.to_vec(), items.len() < max);
            let mut all = items;
            all.push(blank(&f["item"]));
            c.child(btn(dark, focus::gen_recipe_with(i, &name, "add"), &tf("recipes.add_item", &[label]), false, room, move |h: &mut H| put_path(h, i, here.clone(), Some(Value::Array(all.clone())))))
        }
        "enum" => {
            let mut c = row().gap(6.0).flex_wrap().w_full().items_center().child(label_text);
            for v in f["values"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                let (at_path, v2) = (path.to_vec(), v.to_string());
                c = c.child(choice(dark, &focus::gen_recipe_with(i, &name, v), v, now.and_then(Value::as_str) == Some(v), move |h: &mut H| put_path(h, i, at_path.clone(), Some(Value::String(v2.clone())))));
            }
            c
        }
        "int" | "num" => {
            let value = now.and_then(Value::as_f64).unwrap_or_else(|| f["min"].as_f64().unwrap_or(0.0));
            let (f1, f2, p1, p2) = (f.clone(), f.clone(), path.to_vec(), path.to_vec());
            row().gap(8.0).items_center()
                .child(label_text)
                .child(mini(dark, focus::gen_recipe_with(i, &name, "dec"), "−", &tf("recipes.less", &[&name]), false, true, move |h: &mut H| nudge(h, i, p1.clone(), &f1, value, false)))
                .child(text(shown(&Value::from(value))).key(focus::gen_recipe_with(i, &name, "")).font(type_::BODY).color(p.text))
                .child(mini(dark, focus::gen_recipe_with(i, &name, "inc"), "+", &tf("recipes.more", &[&name]), false, true, move |h: &mut H| nudge(h, i, p2.clone(), &f2, value, true)))
        }
        "str" | "strs" => typed_line::<H>(dark, i, &name, &key, label, now.map(shown).unwrap_or_default(), kind == "strs", r),
        _ => row().child(text(tf("recipes.in_json", &[&name])).key(key).font(type_::LABEL).color(p.muted).wrap()),
    }
}

/// A text setting: a button showing it, which turns into a box with Set.
#[allow(clippy::too_many_arguments)]
fn typed_line<H: Host>(dark: bool, i: usize, name: &str, key: &str, label: &str, now_text: String, list: bool, r: &Recipes) -> El {
    let n = name.to_string();
    match r.typing.as_ref().filter(|(s, n)| *s == i && n == name) {
        Some(_) => row().gap(8.0).items_center().w_full()
            .child(col().grow(1.0).child(field(dark, &focus::with_suffix(key, "input"), label, &r.typed, "", false, edit_access(|h: &mut H| &mut h.panels_mut().studio.recipes.typed))))
            .child(btn(dark, focus::with_suffix(key, "set"), &t("recipes.set"), true, true, move |h: &mut H| set_typed(h, list))),
        None => row().gap(8.0).items_center()
            .child(btn(dark, focus::with_suffix(key, "edit"), &tf("recipes.edit_setting", &[label, &now_text]), false, true, move |h: &mut H| type_in(h, i, &n, &now_text))),
    }
}

/// The parts of an object (or a flag's fields), one control each.
fn children<H: Host>(dark: bool, i: usize, path: &[String], fields: &serde_json::Map<String, Value>, now: Option<&Value>, r: &Recipes) -> El {
    let mut c = col().gap(8.0).w_full();
    for (k, f) in fields {
        let mut sub = path.to_vec();
        sub.push(k.clone());
        c = c.child(control::<H>(dark, i, &sub, k, f, now.and_then(|v| v.get(k)), r));
    }
    c
}

/// The settings a step's schema offers, one control each.
fn settings<H: Host>(dark: bool, i: usize, spec: &StepSpec, step: &Value, r: &Recipes) -> El {
    let with = step.get("with").and_then(Value::as_object).cloned().unwrap_or_default();
    let mut c = col().gap(8.0).w_full();
    for (name, f) in &spec.fields {
        let now = value_at(&with, name).or_else(|| spec.defaults.get(name));
        c = c.child(control::<H>(dark, i, std::slice::from_ref(name), name, f, now, r));
    }
    c
}

/// The step's own id (to use a step twice) and its instructions for the director.
fn own<H: Host>(dark: bool, i: usize, step: &Value, key: &str, r: &Recipes) -> El {
    let p = pal(dark);
    let id = step["id"].as_str().unwrap_or_default();
    let mode = step["prompt"]["mode"].as_str();
    let mut c = col().gap(8.0).w_full()
        .child(typed_line::<H>(dark, i, "$id", &focus::with_suffix(key, "id"), &t("recipes.id"), id.to_string(), false, r))
        .child(text(t("recipes.prompt")).font(type_::LABEL).color(p.muted).wrap());
    let mut modes = row().gap(6.0).flex_wrap().w_full().items_center();
    for (m, word) in [(None, "recipes.prompt_none"), (Some("append"), "recipes.prompt_append"), (Some("replace"), "recipes.prompt_replace")] {
        modes = modes.child(choice(dark, &focus::gen_recipe_step(i, &format!("prompt/{}", m.unwrap_or("none"))), &t(word), mode == m, move |h: &mut H| {
            at(h, i, move |s| {
                let words = s["prompt"]["text"].as_str().unwrap_or_default().to_string();
                put(s, "prompt", m.map(|m| serde_json::json!({ "mode": m, "text": words })));
            })
        }));
    }
    c = c.child(modes);
    if mode.is_some() {
        c = c.child(typed_line::<H>(dark, i, "$prompt", &focus::gen_recipe_step(i, "prompt/text"), &t("recipes.prompt_text"), step["prompt"]["text"].as_str().unwrap_or_default().to_string(), false, r));
    }
    c
}

/// A small button: `shown` is its few visible characters, `label` what a screen reader says.
fn mini<H: Host>(dark: bool, key: String, shown: &str, label: &str, active: bool, enabled: bool, f: impl Fn(&mut H) + 'static) -> El {
    let p = pal(dark);
    let (fill, ink) = match (active, enabled) {
        (_, false) => (p.surface, p.muted),
        (true, true) => (p.beam, p.on_beam),
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
        let named = s["id"].as_str().filter(|x| !x.is_empty()).unwrap_or(&kind).to_string();
        let gate = s["gate"].as_str().filter(|g| *g != "none").map(|g| format!(" · {}", tf("recipes.gate", &[g]))).unwrap_or_default();
        let title = format!("{}. {named}{gate}", i + 1);
        let key = focus::gen_recipe_step(i, "");
        let is_open = r.open_step == Some(i);
        let head = row().gap(6.0).items_center().w_full()
            .child(text(title.as_str()).key(focus::gen_recipe_step(i, "title")).font(type_::BODY).color(p.text).grow(1.0))
            .child(mini(dark, focus::gen_recipe_step(i, "up"), "↑", &tf("recipes.up", &[&title]), false, i > 0, move |h: &mut H| shift(h, i, false)))
            .child(mini(dark, focus::gen_recipe_step(i, "down"), "↓", &tf("recipes.down", &[&title]), false, i + 1 < steps.len(), move |h: &mut H| shift(h, i, true)))
            .child(mini(dark, focus::gen_recipe_step(i, "open"), &t(if is_open { "recipes.close_short" } else { "recipes.open_short" }), &tf(if is_open { "recipes.close" } else { "recipes.open" }, &[&title]), is_open, true, move |h: &mut H| open(h, i)))
            .child(mini(dark, focus::gen_recipe_step(i, "remove"), "×", &tf("recipes.remove", &[&title]), false, true, move |h: &mut H| remove(h, i)));
        let mut card = col().key(key.clone()).role("group").label(title.as_str()).gap(8.0).padding(8.0).w_full().border(1.0, p.divider).radius(8.0).child(head);
        if let (true, Some(spec)) = (is_open, r.specs.iter().find(|x| x.kind == kind)) {
            let mut gates = row().gap(6.0).flex_wrap().w_full().items_center().child(text(t("recipes.gates")).font(type_::LABEL).color(p.muted));
            for g in ["none", "owner", "director"].into_iter().filter(|g| spec.gates.iter().any(|x| x == g)) {
                let on = s["gate"].as_str().unwrap_or("none") == g;
                gates = gates.child(choice(dark, &focus::gen_recipe_step(i, &format!("gate/{g}")), g, on, move |h: &mut H| at(h, i, move |s| put(s, "gate", (g != "none").then(|| Value::String(g.into()))))));
            }
            let mut when = row().gap(6.0).flex_wrap().w_full().items_center().child(text(t("recipes.when")).font(type_::LABEL).color(p.muted));
            when = when.child(choice(dark, &focus::gen_recipe_step(i, "when/always"), &t("recipes.always"), s["when"].is_null(), move |h: &mut H| at(h, i, |s| put(s, "when", None))));
            for w in WHEN {
                when = when.child(choice(dark, &focus::gen_recipe_step(i, &format!("when/{w}")), w, s["when"].as_str() == Some(w), move |h: &mut H| at(h, i, move |s| put(s, "when", Some(Value::String(w.into()))))));
            }
            card = card.child(own::<H>(dark, i, s, &key, r)).child(gates).child(when).child(settings::<H>(dark, i, spec, s, r));
        }
        c = c.child(card);
    }
    let mut kinds = row().gap(6.0).flex_wrap().w_full().items_center().child(text(t("recipes.add_step")).font(type_::LABEL).color(p.muted));
    for (k, spec) in r.specs.iter().enumerate() {
        kinds = kinds.child(choice(dark, &focus::gen_recipe_add(&spec.kind), &spec.kind, r.adding == k, move |h: &mut H| h.panels_mut().studio.recipes.adding = k));
    }
    c.child(kinds).child(btn(dark, "generate/recipes/add", &t("recipes.add"), false, !r.specs.is_empty(), add::<H>))
}
