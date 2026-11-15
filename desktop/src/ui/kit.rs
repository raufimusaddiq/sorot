//! The generated theme (`theme/sorot.json`) as the few colours screens use, and the one button.

use rune::tok::type_;
use rune::{Color, El, Theme, col, text};

use crate::app::State;

pub struct Pal {
    pub bg: Color,
    pub surface: Color,
    pub raised: Color,
    pub divider: Color,
    pub text: Color,
    pub muted: Color,
    pub beam: Color,
    pub beam_text: Color,
    pub pass: Color,
    pub skip: Color,
}

thread_local! {
    static THEMES: [Theme; 2] = [true, false].map(|dark| Theme::from_json(crate::app::THEME_JSON, dark).expect("the generated theme loads"));
}

pub fn pal(dark: bool) -> Pal {
    THEMES.with(|t| {
        let t = &t[usize::from(!dark)];
        Pal {
            bg: t.color("bg"), surface: t.color("surface"), raised: t.color("raised"), divider: t.color("divider"), text: t.color("text"),
            muted: t.color("muted"), beam: t.color("beam"), beam_text: t.color("beamText"), pass: t.color("pass"), skip: t.color("skip"),
        }
    })
}

/// A labelled button. `primary` is the one beam-coloured action on a screen.
pub fn button(dark: bool, key: impl Into<String>, label: &str, primary: bool, on_press: impl Fn(&mut State) + 'static) -> El {
    let p = pal(dark);
    let (fill, ink) = if primary { (p.beam, p.bg) } else { (p.raised, p.text) };
    col().key(key.into()).role("button").label(label).focusable(true).padding(10.0).radius(6.0).fill(fill).border(1.0, p.divider)
        .on_press(on_press).child(text(label).font(type_::LABEL).color(ink))
}
