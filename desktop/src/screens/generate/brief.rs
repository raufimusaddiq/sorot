//! The brief: what the video is about and the few choices that go with it (`BriefForm.tsx`).
//! The engine plans from it; nothing here decides how.

use rune::tok::type_;
use std::path::{Path, PathBuf};

use rune::{El, FileDialogOptions, TextEdit, Tx, col, edit_access, row, text};

use crate::engine::generate as api;
use crate::screens::generate::{t, tf};
use crate::screens::generate::{Studio, opened, read};
use crate::screens::panels::{Host, answer, go};
use crate::ui::form::{Tone, area, btn, btn_tx, card, choice, field, note};
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
    /// Files for the video, sent when it is made: the path and what it is for.
    pub files: Vec<(PathBuf, &'static str)>,
}

impl Default for Form {
    fn default() -> Self {
        Form { text: TextEdit::new(""), length: TextEdit::new("30"), style: TextEdit::new(""), format: 0, language: 0, problem: None, files: vec![] }
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

/// What a file is for, from its extension; `None` for a type Generate cannot use.
pub fn kind_of(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_string_lossy().to_lowercase().as_str() {
        "png" | "jpg" | "jpeg" | "webp" | "svg" => Some("image"),
        "ttf" | "otf" | "woff" | "woff2" => Some("font"),
        "mp3" | "m4a" | "wav" | "ogg" => Some("music"),
        _ => None,
    }
}

const EXTENSIONS: [&str; 13] = ["png", "jpg", "jpeg", "webp", "svg", "ttf", "otf", "woff", "woff2", "mp3", "m4a", "wav", "ogg"];

/// A chosen file joins the brief: a logo replaces the last one; anything else must be a type Generate can use.
fn picked<H: Host>(h: &mut H, logo: bool, path: PathBuf) {
    let f = &mut h.panels_mut().studio.brief;
    let kind = if logo { (kind_of(&path) == Some("image")).then_some("logo") } else { kind_of(&path) };
    match kind {
        Some(k) => {
            if k == "logo" {
                f.files.retain(|(_, old)| *old != "logo");
            }
            f.files.push((path, k));
            f.problem = None;
        }
        None => f.problem = Some(t("brief.file_type")),
    }
}

/// The dialog for a logo or for other files.
fn ask<H: Host>(logo: bool) -> impl Fn(&mut H, &mut Tx) + 'static {
    move |_, tx| {
        let all = EXTENSIONS.as_slice();
        let options = FileDialogOptions { title: t(if logo { "brief.logo" } else { "brief.files" }), ..Default::default() }.filter("Generate", if logo { &all[..5] } else { all });
        tx.open_file(options, move |h: &mut H, r, _| match r {
            Ok(Some(path)) => picked(h, logo, path),
            Ok(None) => {}
            Err(e) => h.panels_mut().studio.brief.problem = Some(e.to_string()),
        });
    }
}

fn unpick<H: Host>(h: &mut H, i: usize) {
    let f = &mut h.panels_mut().studio.brief;
    if i < f.files.len() {
        f.files.remove(i);
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
    let files = f.files.clone();
    (f.problem, s.busy, s.error) = (None, true, None);
    go(h, move |e| {
        // the video exists once it is made: a file that does not go up is said, not a reason to lose it
        let r = api::create_project(e, &body).and_then(|p| {
            let failed = files.iter().find_map(|(file, kind)| api::upload_asset(e, &p.id, file, kind).err());
            Ok((api::projects(e)?, read(e, &p.id, None)?, failed.map(|why| tf("brief.upload_failed", &[&why.to_string()]))))
        });
        answer(r, |p, r| {
            if r.is_ok() {
                p.studio.brief = Form::default();
            }
            let failed = r.as_ref().ok().and_then(|(_, _, f)| f.clone());
            opened(p, r.map(|(list, l, _)| (list, l)));
            if failed.is_some() {
                p.studio.error = failed;
            }
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
    let mut files = card(dark, "generate/brief/files", &t("brief.files")).child(text(t("brief.files.sub")).font(type_::LABEL).color(p.muted).wrap());
    for (i, (path, kind)) in f.files.iter().enumerate() {
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        files = files.child(
            row().gap(10.0).items_center().w_full()
                .child(text(format!("{name} · {}", t(&format!("brief.kind.{kind}")))).key(format!("generate/brief/file/{i}")).font(type_::BODY).color(p.text).grow(1.0))
                .child(btn(dark, format!("generate/brief/file/{i}/remove"), &tf("brief.remove", &[&name]), false, true, move |h: &mut H| unpick(h, i))),
        );
    }
    files = files.child(row().gap(10.0).child(btn_tx(dark, "generate/brief/logo", &t("brief.logo"), true, ask::<H>(true))).child(btn_tx(dark, "generate/brief/add", &t("brief.add"), true, ask::<H>(false))));
    let left = col().gap(12.0).grow(1.0)
        .child(area(dark, "generate/brief/text", &t("brief.text"), &f.text, edit_access(|h: &mut H| &mut h.panels_mut().studio.brief.text)))
        .child(text(tf("brief.count", &[&f.text.text.chars().count().to_string(), &MAX_BRIEF.to_string()])).font(type_::LABEL).color(p.muted))
        .child(files);
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
