//! Recipes: the pipelines a video runs through (`RecipeEditor.tsx`). Shipped examples are read-only:
//! copy one to make your own, then edit it as text. The validator's errors and warnings show
//! inline; a recipe can be imported from, and exported as, shareable JSON.

use rune::tok::type_;
use rune::{El, TextEdit, col, edit_access, row, text};
use serde_json::Value;

use crate::engine::generate as api;
use crate::engine::generate::{Checked, RecipeItem, StepSpec};
use crate::screens::generate::{Studio, steps};
use crate::screens::generate::{t, tf};
use crate::screens::panels::{Host, Load, Panels, answer, go};
use crate::ui::form::{Tone, area, btn, card, choice, field, heading, note};
use crate::ui::kit::pal;
use crate::ui::states::{Kind, state_block};

/// The two ways to edit a recipe: as steps, or as its JSON.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Tab {
    #[default]
    Steps,
    Json,
}

pub struct Recipes {
    pub tab: Tab,
    /// The step library the form adds from.
    pub specs: Vec<StepSpec>,
    pub adding: usize,
    pub open_step: Option<usize>,
    /// The setting being typed (step, name) and its words.
    pub typing: Option<(usize, String)>,
    pub typed: TextEdit,
    pub name: TextEdit,
    /// Copying: the id asked for the new recipe.
    pub copying: bool,
    pub copy_id: TextEdit,
    pub load: Load,
    pub items: Vec<RecipeItem>,
    pub selected: Option<String>,
    /// The selected recipe as editable JSON (read-only for a shipped one).
    pub text: TextEdit,
    pub checked: Option<Checked>,
    /// Pasted JSON to import.
    pub import: TextEdit,
    /// A recipe exported as shareable JSON.
    pub shared: Option<String>,
    pub busy: bool,
    pub error: Option<String>,
}

impl Default for Recipes {
    fn default() -> Self {
        Recipes { tab: Tab::Steps, specs: vec![], adding: 0, open_step: None, typing: None, typed: TextEdit::new(""), name: TextEdit::new(""), copying: false, copy_id: TextEdit::new(""), load: Load::Idle, items: vec![], selected: None, text: TextEdit::new(""), checked: None, import: TextEdit::new(""), shared: None, busy: false, error: None }
    }
}

impl Recipes {
    pub fn current(&self) -> Option<&RecipeItem> {
        self.selected.as_ref().and_then(|id| self.items.iter().find(|r| &r.id == id))
    }

    /// Shipped examples are never edited.
    pub fn editable(&self) -> bool {
        self.current().is_some_and(|r| !r.built_in)
    }

    fn pick(&mut self, id: Option<String>) {
        self.selected = id.or_else(|| self.items.first().map(|r| r.id.clone())).filter(|id| self.items.iter().any(|r| &r.id == id));
        let json = self.current().map(|r| serde_json::to_string_pretty(&r.recipe).unwrap_or_default()).unwrap_or_default();
        (self.text, self.checked, self.shared) = (TextEdit::new(json), None, None);
        (self.open_step, self.typing, self.copying) = (None, None, false);
        self.name = TextEdit::new(self.current().map(|r| r.name.clone()).unwrap_or_default());
    }
}

fn listed(keep: Option<String>) -> impl FnOnce(&mut Panels, Result<Vec<RecipeItem>, String>) + Send + 'static {
    move |p, r| {
        let s = &mut p.studio.recipes;
        (s.busy, s.load) = (false, Load::of(&r));
        match r {
            Ok(items) => {
                s.items = items;
                let id = keep.or_else(|| s.selected.clone());
                s.pick(id);
            }
            Err(why) => s.error = Some(why),
        }
    }
}

/// Reads the list when the page opens.
pub fn load<H: Host>(h: &mut H) {
    h.panels_mut().studio.recipes.load = Load::Loading;
    go(h, |e| answer(api::recipes(e), listed(None)));
    go(h, |e| answer(api::steps(e), |p, r| p.studio.recipes.specs = r.unwrap_or_default()));
}

fn choose<H: Host>(h: &mut H, id: &str) {
    h.panels_mut().studio.recipes.pick(Some(id.to_string()));
    validate(h);
}

/// The editor's text as a recipe, or the words for why it is not one.
fn parsed(r: &Recipes) -> Result<Value, String> {
    serde_json::from_str(&r.text.text).map_err(|e| tf("recipes.bad_json", &[&e.to_string()]))
}

pub fn validate<H: Host>(h: &mut H) {
    let r = &mut h.panels_mut().studio.recipes;
    let recipe = match parsed(r) {
        Ok(v) => v,
        Err(why) => return r.error = Some(why),
    };
    r.error = None;
    go(h, move |e| {
        answer(api::validate_recipe(e, &recipe), |p, r| match r {
            Ok(c) => p.studio.recipes.checked = Some(c),
            Err(why) => p.studio.recipes.error = Some(why),
        })
    });
}

pub fn save<H: Host>(h: &mut H) {
    let r = &mut h.panels_mut().studio.recipes;
    let (Some(id), true) = (r.selected.clone(), r.editable()) else { return };
    let recipe = match parsed(r) {
        Ok(v) => v,
        Err(why) => return r.error = Some(why),
    };
    (r.busy, r.error) = (true, None);
    go(h, move |e| answer(api::save_recipe(e, &id, &recipe).and_then(|()| api::recipes(e)), listed(Some(id.clone()))));
}

/// Starts a copy of a shipped (or any) recipe: asks for the new recipe's id.
pub fn ask_copy<H: Host>(h: &mut H) {
    let r = &mut h.panels_mut().studio.recipes;
    let Some(id) = r.current().map(|c| format!("{}-copy", c.id)) else { return };
    (r.copying, r.copy_id) = (true, TextEdit::new(id));
}

/// Copies the recipe into one of your own, under the id asked for.
pub fn copy<H: Host>(h: &mut H) {
    let r = &mut h.panels_mut().studio.recipes;
    let (Some(cur), id) = (r.current(), r.copy_id.text.trim().to_string()) else { return };
    if id.is_empty() {
        return;
    }
    let (from, name) = (cur.id.clone(), format!("{} (copy)", cur.name));
    (r.copying, r.busy, r.error) = (false, true, None);
    go(h, move |e| {
        answer(api::copy_recipe(e, &from, &id, &name).and_then(|new| Ok((new, api::recipes(e)?))), |p, r| match r {
            Ok((new, items)) => listed(Some(new))(p, Ok(items)),
            Err(why) => (p.studio.recipes.busy, p.studio.recipes.error) = (false, Some(why)),
        })
    });
}

pub fn remove<H: Host>(h: &mut H) {
    let r = &mut h.panels_mut().studio.recipes;
    let (Some(id), true) = (r.selected.clone(), r.editable()) else { return };
    (r.busy, r.error) = (true, None);
    go(h, move |e| answer(api::delete_recipe(e, &id).and_then(|()| api::recipes(e)), listed(None)));
}

pub fn import<H: Host>(h: &mut H) {
    let r = &mut h.panels_mut().studio.recipes;
    let recipe: Value = match serde_json::from_str(&r.import.text) {
        Ok(v) => v,
        Err(e) => return r.error = Some(tf("recipes.bad_import", &[&e.to_string()])),
    };
    (r.busy, r.error) = (true, None);
    go(h, move |e| {
        answer(api::import_recipe(e, &recipe).and_then(|new| Ok((new, api::recipes(e)?))), |p, r| match r {
            Ok((new, items)) => {
                p.studio.recipes.import = TextEdit::new("");
                listed(Some(new))(p, Ok(items));
            }
            Err(why) => (p.studio.recipes.busy, p.studio.recipes.error) = (false, Some(why)),
        })
    });
}

/// Shows the recipe as shareable JSON.
pub fn export<H: Host>(h: &mut H) {
    let Some(id) = h.panels().studio.recipes.selected.clone() else { return };
    go(h, move |e| {
        answer(api::export_recipe(e, &id), |p, r| match r {
            Ok(v) => p.studio.recipes.shared = Some(serde_json::to_string_pretty(&v).unwrap_or_default()),
            Err(why) => p.studio.recipes.error = Some(why),
        })
    });
}

fn label(item: &RecipeItem) -> String {
    let name = if item.built_in { tf("recipes.builtin", &[&item.name]) } else { item.name.clone() };
    if item.available { name } else { tf("recipes.unavailable", &[&name]) }
}

pub fn view<H: Host>(dark: bool, s: &Studio) -> El {
    let p = pal(dark);
    let r = &s.recipes;
    let head = heading(dark, "generate/recipes/title", &t("recipes.title"), &t("recipes.sub"));
    if r.load == Load::Ready && r.items.is_empty() {
        return col().gap(16.0).w_full().child(head).child(state_block::<H>(dark, "generate/recipes/empty", Kind::Empty, &t("recipes.empty.cause"), &t("recipes.empty.next"), None));
    }
    let mut list = card(dark, "generate/recipes", &t("recipes.title"));
    for item in &r.items {
        let id = item.id.clone();
        list = list.child(choice(dark, &format!("generate/recipe/{}", item.id), &label(item), r.selected.as_deref() == Some(&item.id), move |h: &mut H| choose(h, &id)));
    }
    let mut detail = card(dark, "generate/recipes/detail", &r.current().map(|c| c.name.clone()).unwrap_or_default());
    if let Some(cur) = r.current() {
        if let Some(d) = &cur.description {
            detail = detail.child(text(d.as_str()).font(type_::BODY).color(p.muted).wrap());
        }
        for why in &cur.reasons {
            detail = detail.child(text(why.as_str()).font(type_::LABEL).color(p.muted).wrap());
        }
        if cur.built_in {
            detail = detail
                .child(text(t("recipes.readonly")).font(type_::LABEL).color(p.muted).wrap())
                .child(text(serde_json::to_string_pretty(&cur.recipe).unwrap_or_default()).key("generate/recipes/readonly").font(type_::LABEL).color(p.text).wrap())
                .child(btn(dark, "generate/recipes/copy", &t("recipes.copy_mine"), true, !r.busy, ask_copy::<H>));
        } else {
            detail = detail
                .child(row().gap(8.0).child(choice(dark, "generate/recipes/tab/steps", &t("recipes.tab_steps"), r.tab == Tab::Steps, |h: &mut H| h.panels_mut().studio.recipes.tab = Tab::Steps)).child(choice(dark, "generate/recipes/tab/json", &t("recipes.tab_json"), r.tab == Tab::Json, |h: &mut H| h.panels_mut().studio.recipes.tab = Tab::Json)));
            detail = if r.tab == Tab::Steps {
                detail.child(steps::view::<H>(dark, r))
            } else {
                detail.child(area(dark, "generate/recipes/text", &t("recipes.text"), &r.text, edit_access(|h: &mut H| &mut h.panels_mut().studio.recipes.text)))
            };
            detail = detail
                .child(
                    row().gap(10.0)
                        .child(btn(dark, "generate/recipes/save", &t("recipes.save"), true, !r.busy, save::<H>))
                        .child(btn(dark, "generate/recipes/validate", &t("recipes.validate"), false, !r.busy, validate::<H>))
                        .child(btn(dark, "generate/recipes/copy", &t("recipes.copy"), false, !r.busy, ask_copy::<H>))
                        .child(btn(dark, "generate/recipes/delete", &t("recipes.delete"), false, !r.busy, remove::<H>)),
                );
        }
        if r.copying {
            detail = detail.child(
                row().gap(8.0).items_center().w_full()
                    .child(col().grow(1.0).child(field(dark, "generate/recipes/copy-id", &t("recipes.copy_id"), &r.copy_id, "", false, edit_access(|h: &mut H| &mut h.panels_mut().studio.recipes.copy_id))))
                    .child(btn(dark, "generate/recipes/copy-do", &t("recipes.copy_make"), true, !r.busy && !r.copy_id.text.trim().is_empty(), copy::<H>))
                    .child(btn(dark, "generate/recipes/copy-cancel", &t("recipes.copy_cancel"), false, true, |h: &mut H| h.panels_mut().studio.recipes.copying = false)),
            );
        }
        detail = detail.child(btn(dark, "generate/recipes/export", &t("recipes.export"), false, true, export::<H>));
    }
    if let Some(checked) = &r.checked {
        for (i, why) in checked.errors.iter().enumerate() {
            detail = detail.child(note(dark, &format!("generate/recipes/error/{i}"), Tone::Bad, why));
        }
        for (i, why) in checked.warnings.iter().enumerate() {
            detail = detail.child(note(dark, &format!("generate/recipes/warning/{i}"), Tone::Plain, &tf("recipes.warning", &[why])));
        }
        if checked.errors.is_empty() {
            detail = detail.child(note(dark, "generate/recipes/valid", Tone::Ok, &t("recipes.valid")));
        }
    }
    if let Some(shared) = &r.shared {
        detail = detail.child(text(shared.as_str()).key("generate/recipes/shared").font(type_::LABEL).color(p.text).wrap());
    }
    detail = detail
        .child(area(dark, "generate/recipes/import-text", &t("recipes.import_text"), &r.import, edit_access(|h: &mut H| &mut h.panels_mut().studio.recipes.import)))
        .child(btn(dark, "generate/recipes/import", &t("recipes.import"), false, !r.busy && !r.import.text.trim().is_empty(), import::<H>));
    if let Some(why) = &r.error {
        detail = detail.child(note(dark, "generate/recipes/failed", Tone::Bad, why));
    }
    col().gap(16.0).w_full().child(head).child(row().gap(20.0).w_full().child(col().w(320.0).child(list)).child(col().grow(1.0).shrink().child(detail)))
}
