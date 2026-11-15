//! The director's storylines: different films, the first drawn larger (`StorylineCards.tsx`). Pick
//! one, with an optional note the plan takes into account, or ask for new ones.

use rune::tok::type_;
use rune::{El, TextEdit, col, edit_access, row, text};

use crate::engine::generate as api;
use crate::engine::generate::Detail;
use crate::screens::generate::{t, tf};
use crate::screens::generate::{Step, Studio, View, act};
use crate::screens::panels::Host;
use crate::ui::form::{btn, card, field};
use crate::ui::kit::pal;

pub struct Note {
    pub text: TextEdit,
}

impl Default for Note {
    fn default() -> Self {
        Note { text: TextEdit::new("") }
    }
}

pub fn pick<H: Host>(h: &mut H, index: usize) {
    let note = h.panels().studio.stories.text.text.trim().to_string();
    h.panels_mut().studio.view = View::Step(Step::Plan);
    act(h, move |e, id| api::pick_storyline(e, id, index, &note).map(|()| None));
}

pub fn more<H: Host>(h: &mut H) {
    let note = h.panels().studio.stories.text.text.trim().to_string();
    act(h, move |e, id| api::more_storylines(e, id, &note).map(|()| None));
}

pub fn view<H: Host>(dark: bool, s: &Studio, d: &Detail) -> El {
    let p = pal(dark);
    let Some(list) = &d.project.storylines else { return col() };
    let picked = d.project.picked_storyline;
    let mut cards = row().gap(16.0).w_full();
    for (i, st) in list.iter().enumerate() {
        let tags: Vec<String> = [(st.recommended, "stories.recommended"), (st.bold, "stories.bold"), (picked == Some(i), "stories.picked")].iter().filter(|(on, _)| *on).map(|(_, k)| t(k)).collect();
        let mut c = card(dark, &format!("generate/story/{i}"), &st.title)
            .child(text(st.pitch.as_str()).font(type_::BODY).color(p.text).wrap())
            .child(text(tf("stories.opening", &[&st.opening])).font(type_::LABEL).color(p.muted).wrap())
            .child(text(tf("stories.beats", &[&st.beats.join(" → ")])).font(type_::LABEL).color(p.muted).wrap())
            .child(text(tf("stories.look", &[&st.look, &st.sound])).font(type_::LABEL).color(p.muted).wrap());
        if !tags.is_empty() {
            c = c.child(text(tags.join(" · ")).key(format!("generate/story/{i}/tags")).font(type_::LABEL).color(p.beam_text));
        }
        if !st.reason.is_empty() {
            c = c.child(text(st.reason.as_str()).font(type_::LABEL).color(p.muted).wrap());
        }
        let pick_btn = btn(dark, format!("generate/story/{i}/pick"), &t("stories.pick"), i == 0, !s.busy, move |h: &mut H| pick(h, i));
        cards = cards.child(col().grow(if i == 0 { 2.0 } else { 1.0 }).child(c.child(pick_btn)));
    }
    col().gap(16.0).w_full().child(cards)
        .child(field(dark, "generate/story/note", &t("stories.note"), &s.stories.text, &t("stories.note.hint"), false, edit_access(|h: &mut H| &mut h.panels_mut().studio.stories.text)))
        .child(btn(dark, "generate/story/more", &t("stories.more"), false, !s.busy, more::<H>))
}
