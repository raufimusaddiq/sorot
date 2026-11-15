//! The few form controls the panel screens share, generic over the host state so a screen's own
//! tests can run without the whole app. Every control is keyed and has a role and a name.

use rune::tok::{TextStyle, type_};
use rune::{Color, El, TextEdit, col, row, text, text_input};

use crate::i18n::{Lang, tr};
use crate::ui::kit::pal;

/// A labelled button. A disabled one keeps its place and name but does nothing.
pub fn btn<H: 'static>(dark: bool, key: impl Into<String>, label: &str, primary: bool, enabled: bool, on_press: impl Fn(&mut H) + 'static) -> El {
    let p = pal(dark);
    let (fill, ink) = match (primary, enabled) {
        (_, false) => (p.surface, p.muted),
        (true, true) => (p.beam, p.bg),
        (false, true) => (p.raised, p.text),
    };
    let b = col().key(key.into()).role("button").label(label).padding(10.0).radius(6.0).fill(fill).border(1.0, p.divider)
        .child(text(label).font(type_::LABEL).color(ink));
    if enabled { b.focusable(true).on_press(on_press) } else { b.disabled(true) }
}

/// A button that asks for a file: `on_press` gets the host and the `Tx` to open the dialog with.
pub fn btn_tx<H: 'static>(dark: bool, key: impl Into<String>, label: &str, enabled: bool, on_press: impl Fn(&mut H, &mut rune::Tx) + 'static) -> El {
    let p = pal(dark);
    let (fill, ink) = if enabled { (p.raised, p.text) } else { (p.surface, p.muted) };
    let b = col().key(key.into()).role("button").label(label).padding(10.0).radius(6.0).fill(fill).border(1.0, p.divider).child(text(label).font(type_::LABEL).color(ink));
    if enabled { b.focusable(true).on_press_tx(on_press) } else { b.disabled(true) }
}

/// A one-line field bound to a `TextEdit` in the host. `secure` hides what is typed.
pub fn field<H: 'static, F>(dark: bool, key: &str, name: &str, edit: &TextEdit, hint: &str, secure: bool, access: F) -> El
where
    F: for<'a> Fn(&'a mut H) -> &'a mut TextEdit + 'static,
{
    let p = pal(dark);
    let mut input = text_input(edit, type_::BODY).single_line().key(key).label(name).placeholder(hint, p.muted).w_full().padding(10.0).radius(6.0)
        .fill(p.raised).border(1.0, p.divider).on_edit(access);
    if secure {
        input = input.secure();
    }
    col().gap(4.0).w_full().child(text(name).font(type_::LABEL).color(p.muted)).child(input)
}

/// A few-lines field for text such as a post caption.
pub fn area<H: 'static, F>(dark: bool, key: &str, name: &str, edit: &TextEdit, access: F) -> El
where
    F: for<'a> Fn(&'a mut H) -> &'a mut TextEdit + 'static,
{
    let p = pal(dark);
    let input = text_input(edit, type_::BODY).key(key).label(name).w_full().min_h(96.0).padding(10.0).radius(6.0).fill(p.raised).border(1.0, p.divider).on_edit(access);
    col().gap(4.0).w_full().child(text(name).font(type_::LABEL).color(p.muted)).child(input)
}

/// An on/off choice (role `checkbox`).
pub fn toggle<H: 'static>(dark: bool, l: Lang, key: &str, label: &str, on: bool, f: impl Fn(&mut H) + 'static) -> El {
    let p = pal(dark);
    let mark = tr(l, if on { "toggle.on" } else { "toggle.off" });
    row().key(key).role("checkbox").label(label).checked(on).focusable(true).gap(10.0).items_center().on_press(f)
        .child(text(mark).font(type_::LABEL).color(if on { p.beam_text } else { p.muted }))
        .child(text(label).font(type_::BODY).color(p.text).wrap())
}

/// One of several choices (role `radio`).
pub fn choice<H: 'static>(dark: bool, key: &str, label: &str, chosen: bool, f: impl Fn(&mut H) + 'static) -> El {
    let p = pal(dark);
    let (fill, ink) = if chosen { (p.beam, p.bg) } else { (p.raised, p.text) };
    col().key(key).role("radio").label(label).checked(chosen).focusable(true).padding(8.0).radius(6.0).fill(fill).border(1.0, p.divider)
        .on_press(f).child(text(label).font(type_::LABEL).color(ink))
}

/// A titled card of rows.
pub fn card(dark: bool, key: &str, title: &str) -> El {
    let p = pal(dark);
    col().key(key).role("group").label(title).gap(12.0).padding(16.0).w_full().fill(p.surface).border(1.0, p.divider).radius(10.0)
        .child(text(title).font(type_::TITLE).color(p.text))
}

/// The 28 pt title every frame opens with.
pub const DISPLAY: TextStyle = TextStyle::new(28.0, 600.0);

/// A screen's column: the frames: 104 pt from the window edge, so 40 pt beside the 64 pt rail.
pub fn page() -> El {
    col().gap(20.0).px(40.0).py(40.0).w_full().max_w(1280.0)
}

pub fn heading(dark: bool, key: &str, title: &str, sub: &str) -> El {
    let p = pal(dark);
    col().gap(4.0).child(text(title).key(key).role("heading").level(1).font(DISPLAY).color(p.text))
        .child(text(sub).font(type_::BODY).color(p.muted).wrap())
}

/// How a line of words reads: the colour carries nothing alone, the words say it too.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    Ok,
    Bad,
    Plain,
}

fn ink(dark: bool, tone: Tone) -> Color {
    let p = pal(dark);
    match tone {
        Tone::Ok => p.pass,
        Tone::Bad => p.skip,
        Tone::Plain => p.muted,
    }
}

/// A line of status words. `Bad` is announced at once (`alert`).
pub fn note(dark: bool, key: &str, tone: Tone, words: &str) -> El {
    let role = if tone == Tone::Bad { "alert" } else { "status" };
    text(words).key(key).role(role).label(words).font(type_::BODY).color(ink(dark, tone)).wrap()
}

/// Whole text of an optional string, for fields that start from what the engine has.
pub fn or_empty(s: &Option<String>) -> String {
    s.clone().unwrap_or_default()
}

pub fn edit_of(s: &str) -> TextEdit {
    TextEdit::new(s)
}
