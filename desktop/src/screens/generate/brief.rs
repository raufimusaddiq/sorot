//! The brief: what the video is about and the few choices that go with it (`BriefForm.tsx`).
//! The engine plans from it; nothing here decides how.

use rune::tok::type_;
use rune::{El, TextEdit, col, edit_access, row, text};

use crate::engine::generate as api;
use crate::screens::generate::words::{t, tf};
use crate::screens::generate::{Studio, opened, read};
use crate::screens::panels::{Host, answer, go};
use crate::ui::form::{Tone, area, btn, card, choice, field, note};
use crate::ui::kit::pal;

pub const MAX_BRIEF: usize = 2000;
pub const FORMATS: [&str; 3] = ["9:16", "16:9", "1:1"];
pub const LANGUAGES: [(&str, &str); 2] = [("id", "lang.id"), ("en", "lang.en")];

pub struct Form {
    pub text: TextEdit,
    pub length: TextEdit,
    pub style: TextEdit,
    pub format: usize,
    pub language: usize,
    pub problem: Option<String>,
}

impl Default for Form {
    fn default() -> Self {
        Form { text: TextEdit::new(""), length: TextEdit::new("30"), style: TextEdit::new(""), format: 0, language: 0, problem: None }
    }
}

impl Form {
    /// The seconds asked for, when they are 5 to 90.
    fn seconds(&self) -> Option<u32> {
        self.length.text.trim().parse().ok().filter(|n| (5..=90).contains(n))
    }

    fn ready(&self) -> bool {
        let n = self.text.text.trim().chars().count();
        n > 0 && self.text.text.chars().count() <= MAX_BRIEF && self.seconds().is_some()
    }
}

/// "Plan my video": makes the video, then opens it (the engine starts writing storylines).
pub fn create<H: Host>(h: &mut H) {
    let s = &mut h.panels_mut().studio;
    let f = &mut s.brief;
    let Some(target_sec) = f.seconds().filter(|_| f.ready()) else {
        f.problem = Some(t("brief.problem"));
        return;
    };
    let body = api::Brief {
        brief: f.text.text.trim().to_string(), format: FORMATS[f.format].into(), target_sec, language: LANGUAGES[f.language].0.into(), style_notes: f.style.text.trim().to_string(),
    };
    (f.problem, s.busy, s.error) = (None, true, None);
    go(h, move |e| {
        let r = api::create_project(e, &body).and_then(|p| Ok((api::projects(e)?, read(e, &p.id, None)?)));
        answer(r, |p, r| {
            if r.is_ok() {
                p.studio.brief = Form::default();
            }
            opened(p, r);
        })
    });
}

pub fn view<H: Host>(dark: bool, s: &Studio) -> El {
    let p = pal(dark);
    let f = &s.brief;
    if let Some(d) = &s.detail {
        return col().gap(8.0).w_full()
            .child(text(&d.project.brief).key("generate/brief/readonly").font(type_::BODY).color(p.text).wrap())
            .child(text(t("brief.readonly")).font(type_::LABEL).color(p.muted).wrap());
    }
    let mut formats = row().gap(8.0);
    for (i, name) in FORMATS.iter().enumerate() {
        formats = formats.child(choice(dark, &format!("generate/brief/format/{i}"), name, f.format == i, move |h: &mut H| h.panels_mut().studio.brief.format = i));
    }
    let mut langs = row().gap(8.0);
    for (i, (_, key)) in LANGUAGES.iter().enumerate() {
        langs = langs.child(choice(dark, &format!("generate/brief/language/{i}"), &t(key), f.language == i, move |h: &mut H| h.panels_mut().studio.brief.language = i));
    }
    let left = col().gap(12.0).grow(1.0)
        .child(area(dark, "generate/brief/text", &t("brief.text"), &f.text, edit_access(|h: &mut H| &mut h.panels_mut().studio.brief.text)))
        .child(text(tf("brief.count", &[&f.text.text.chars().count().to_string(), &MAX_BRIEF.to_string()])).font(type_::LABEL).color(p.muted));
    let right = card(dark, "generate/brief/settings", &t("brief.settings"))
        .child(text(t("brief.settings.sub")).font(type_::LABEL).color(p.muted).wrap())
        .child(field(dark, "generate/brief/length", &t("brief.length"), &f.length, "30", false, edit_access(|h: &mut H| &mut h.panels_mut().studio.brief.length)))
        .child(text(t("brief.format")).font(type_::LABEL).color(p.muted))
        .child(formats)
        .child(text(t("brief.language")).font(type_::LABEL).color(p.muted))
        .child(langs)
        .child(field(dark, "generate/brief/style", &t("brief.style"), &f.style, &t("brief.style.hint"), false, edit_access(|h: &mut H| &mut h.panels_mut().studio.brief.style)));
    let mut c = col().gap(16.0).w_full().child(row().gap(20.0).w_full().child(left).child(col().w(340.0).child(right)));
    if let Some(why) = &f.problem {
        c = c.child(note(dark, "generate/brief/problem", Tone::Bad, why));
    }
    let label = t(if s.busy { "brief.starting" } else { "brief.create" });
    c.child(btn(dark, "generate/brief/create", &label, true, !s.busy, create::<H>))
}
