//! The idea bank: briefs lined up for later (`IdeaBank.tsx`), as cards. A run carries the next new
//! idea to an exported video; a step that waits for the owner stops it there. Publishing is never
//! part of it.

use rune::tok::type_;
use rune::{El, TextEdit, col, edit_access, row, text};

use crate::engine::generate as api;
use crate::engine::generate::Idea;
use crate::screens::generate::{t, tf};
use crate::screens::generate::{Studio, open_one, opened};
use crate::screens::panels::{Host, Load, Panels, answer, go};
use crate::ui::form::{area, btn, card, field};
use crate::ui::kit::pal;
use crate::ui::states::{Kind, state_block};

pub struct Ideas {
    pub load: Load,
    pub list: Vec<Idea>,
    pub slug: TextEdit,
    pub brief: TextEdit,
}

impl Default for Ideas {
    fn default() -> Self {
        Ideas { load: Load::Idle, list: vec![], slug: TextEdit::new(""), brief: TextEdit::new("") }
    }
}

fn listed(p: &mut Panels, r: Result<Vec<Idea>, String>) {
    p.studio.busy = false;
    p.studio.ideas.load = Load::of(&r);
    match r {
        Ok(list) => p.studio.ideas.list = list,
        Err(why) => p.studio.error = Some(why),
    }
}

/// Reads the list when the step opens.
pub fn load<H: Host>(h: &mut H) {
    h.panels_mut().studio.ideas.load = Load::Loading;
    go(h, |e| answer(api::ideas(e), listed));
}

pub fn add<H: Host>(h: &mut H) {
    let s = &mut h.panels_mut().studio;
    let (slug, brief) = (s.ideas.slug.text.trim().to_string(), s.ideas.brief.text.trim().to_string());
    if slug.is_empty() || brief.is_empty() {
        return;
    }
    (s.busy, s.error) = (true, None);
    go(h, move |e| {
        let r = api::add_idea(e, &slug, &brief).and_then(|()| api::ideas(e));
        answer(r, |p, r| {
            if r.is_ok() {
                (p.studio.ideas.slug, p.studio.ideas.brief) = (TextEdit::new(""), TextEdit::new(""));
            }
            listed(p, r);
        })
    });
}

pub fn remove<H: Host>(h: &mut H, id: &str) {
    let id = id.to_string();
    let s = &mut h.panels_mut().studio;
    (s.busy, s.error) = (true, None);
    go(h, move |e| answer(api::delete_idea(e, &id).and_then(|()| api::ideas(e)), listed));
}

/// Runs the next new idea (`None`) or the named one, then opens the video it made or resumed.
pub fn run<H: Host>(h: &mut H, id: Option<String>) {
    let s = &mut h.panels_mut().studio;
    (s.busy, s.error) = (true, None);
    go(h, move |e| answer(api::run_idea(e, id.as_deref()).and_then(|p| open_one(e, &p.id)), opened));
}

fn open_video<H: Host>(h: &mut H, id: &str) {
    let id = id.to_string();
    h.panels_mut().studio.busy = true;
    go(h, move |e| answer(open_one(e, &id), opened));
}

pub fn view<H: Host>(dark: bool, s: &Studio) -> El {
    let p = pal(dark);
    let i = &s.ideas;
    let waiting = i.list.iter().filter(|x| x.status == "new").count();
    let label = if waiting > 0 { tf("ideas.run_next", &[&waiting.to_string()]) } else { t("ideas.none_new") };
    let mut c = col().gap(16.0).w_full()
        .child(text(t("ideas.note")).font(type_::BODY).color(p.muted).wrap())
        .child(btn(dark, "generate/ideas/run-next", &label, true, !s.busy && waiting > 0, |h: &mut H| run(h, None)));
    if i.load == Load::Ready && i.list.is_empty() {
        c = c.child(state_block::<H>(dark, "generate/ideas/empty", Kind::Empty, &t("ideas.empty.cause"), &t("ideas.empty.next"), None));
    }
    let mut cards = row().gap(16.0).w_full();
    for idea in &i.list {
        let k = |n: &str| format!("generate/idea/{}/{n}", idea.id);
        let (rid, did) = (idea.id.clone(), idea.id.clone());
        let mut actions = row().gap(8.0);
        if let Some(pid) = idea.project_id.clone() {
            actions = actions.child(btn(dark, k("open"), &t("ideas.open"), false, !s.busy, move |h: &mut H| open_video(h, &pid)));
        }
        let verb = if idea.status == "new" { t("ideas.run") } else { t("ideas.resume") };
        actions = actions
            .child(btn(dark, k("run"), &verb, idea.status == "new", !s.busy && idea.status != "posted", move |h: &mut H| run(h, Some(rid.clone()))))
            .child(btn(dark, k("delete"), &t("ideas.delete"), false, !s.busy, move |h: &mut H| remove(h, &did)));
        cards = cards.child(
            col().grow(1.0).child(
                card(dark, &k("card"), &idea.slug)
                    .child(text(&idea.brief).font(type_::BODY).color(p.muted).wrap())
                    .child(text(&idea.status).font(type_::LABEL).color(p.muted))
                    .child(actions),
            ),
        );
    }
    c.child(cards)
        .child(field(dark, "generate/ideas/slug", &t("ideas.slug"), &i.slug, "bunga-majemuk", false, edit_access(|h: &mut H| &mut h.panels_mut().studio.ideas.slug)))
        .child(area(dark, "generate/ideas/brief", &t("ideas.brief"), &i.brief, edit_access(|h: &mut H| &mut h.panels_mut().studio.ideas.brief)))
        .child(btn(dark, "generate/ideas/add", &t("ideas.add"), false, !s.busy && !i.slug.text.trim().is_empty() && !i.brief.text.trim().is_empty(), add::<H>))
}
