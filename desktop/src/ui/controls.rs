//! The controls the clipping screens' frames show and `kit` does not have: the display title, a
//! dropdown, a switch, an outlined verdict pill, a score bar, the waveform and the transport icons.
//! Every control is keyed with a role and a name, like the rest of the kit.

use std::rc::Rc;

use rune::tok::type_;
use rune::{Color, El, Shape, TextStyle, canvas, col, row, text};

use crate::app::State;
use crate::ui::kit::pal;

/// What a dropdown does with the value that was picked.
pub type Pick = Rc<dyn Fn(&mut State, &str)>;

/// The 28 pt title every frame opens with.
pub const DISPLAY: TextStyle = TextStyle::new(28.0, 600.0);
/// The 20 pt line a big empty field carries.
pub const DISPLAY_SMALL: TextStyle = TextStyle::new(20.0, 600.0);
/// The 40 pt percent beside a stage name.
pub const DISPLAY_BIG: TextStyle = TextStyle::new(40.0, 600.0);

/// What a caption style or framing mode is called (`group` is `style` or `reframe`); an unknown value reads as itself.
pub fn option_word(lang: crate::i18n::Lang, group: &str, value: &str) -> String {
    let key = format!("opt.{group}.{value}");
    let words = crate::i18n::tr(lang, &key);
    if words == key { value.to_string() } else { words }
}

/// `(value, words)` for each value of an option group, for a dropdown.
pub fn option_choices(lang: crate::i18n::Lang, group: &str, values: &[String]) -> Vec<(String, String)> {
    values.iter().map(|v| (v.clone(), option_word(lang, group, v))).collect()
}

/// A button's content centred (the frames centre every button's label).
pub fn centered(button: El) -> El {
    button.items_center().justify_center()
}

/// The page title and its one-line subtitle; `key` names the title.
pub fn page_head(dark: bool, key: &str, title: &str, sub: &str) -> El {
    let p = pal(dark);
    col().gap(4.0).w_full()
        .child(text(title).key(key).role("heading").level(1).font(DISPLAY).color(p.text).truncate())
        .child(text(sub).key(format!("{key}-sub")).font(type_::BODY).color(p.muted).wrap())
}

/// An outlined word on a clear ground: the verdict's colour is the outline, the word says it too.
pub fn pill(key: String, word: &str, ink: Color) -> El {
    col().key(key).role("status").label(word).px(8.0).py(3.0).radius(3.0).border(1.0, ink).child(text(word).font(type_::LABEL).color(ink))
}

/// A thin bar filled to `value` (0 to 1) in steel.
pub fn score_bar(dark: bool, value: f64) -> El {
    const W: f32 = 96.0;
    let p = pal(dark);
    let filled = (value.clamp(0.0, 1.0) as f32 * W).max(0.0);
    col().w(W).h(6.0).radius(3.0).fill(p.divider).child(col().w(filled).h(6.0).radius(3.0).fill(p.steel))
}

/// An on/off switch with its label (and a line under it): role `checkbox`, the whole row presses.
pub fn switch(dark: bool, key: &str, label: &str, sub: Option<&str>, on: bool, f: impl Fn(&mut State) + 'static) -> El {
    let p = pal(dark);
    let mut words = col().gap(2.0).grow(1.0).shrink().child(text(label).font(type_::BODY).color(p.text).wrap());
    if let Some(sub) = sub {
        words = words.child(text(sub).font(type_::LABEL).color(p.muted).wrap());
    }
    let (fill, knob_x, knob) = if on { (p.beam, 18.0, p.on_beam) } else { (p.divider, 2.0, p.muted) };
    let track = col().w(36.0).h(20.0).radius(10.0).fill(fill).child(col().w(16.0).h(16.0).radius(8.0).fill(knob).absolute(knob_x, 2.0));
    row().key(key).role("checkbox").label(label).checked(on).focusable(true).gap(12.0).items_center().w_full().on_press(f)
        .child(words).child(track)
}

fn chevron(dark: bool) -> El {
    let p = pal(dark);
    canvas(Shape::new().stroke(vec![[1.0, 1.0], [8.0, 8.0], [15.0, 1.0]], 1.5, p.muted)).w(16.0).h(9.0)
}

/// A labelled dropdown: the trigger shows the chosen word, and the list opens under it. `choices`
/// are `(value, words)`; the trigger is `{key}`, a choice `{key}/{value}`. Only one list is open.
pub fn dropdown(s: &State, key: &str, label: &str, chosen: &str, choices: &[(String, String)], pick: Pick) -> El {
    let p = pal(s.dark());
    let open = s.open_select.as_deref() == Some(key);
    let shown = choices.iter().find(|(v, _)| v == chosen).map_or(chosen, |(_, w)| w.as_str());
    let owned = key.to_string();
    let trigger = row().key(key).role("button").label(format!("{label}: {shown}")).focusable(true).gap(8.0).px(12.0).py(9.0).items_center().w_full().radius(6.0)
        .fill(p.surface).border(1.0, if open { p.beam } else { p.edge }).hover(p.text.alpha(0.06))
        .on_press(move |s: &mut State| s.open_select = if s.open_select.as_deref() == Some(owned.as_str()) { None } else { Some(owned.clone()) })
        .child(text(shown).font(type_::BODY).color(p.text).truncate().grow(1.0)).child(chevron(s.dark()));
    let mut field = col().gap(6.0).w_full().child(text(label).font(type_::LABEL).color(p.muted)).child(trigger);
    if open {
        let mut list = col().key(format!("{key}/list")).role("listbox").label(label).gap(2.0).padding(4.0).w_full().fill(p.raised).border(1.0, p.divider).radius(6.0);
        for (value, words) in choices {
            let (value, f) = (value.clone(), pick.clone());
            let on = value == chosen;
            let v = value.clone();
            list = list.child(
                row().key(format!("{key}/{value}")).role("option").label(words.clone()).checked(on).focusable(true).px(10.0).py(7.0).radius(4.0).w_full()
                    .fill(if on { p.text.alpha(0.08) } else { p.raised }).hover(p.text.alpha(0.08))
                    .on_press(move |s: &mut State| {
                        s.open_select = None;
                        f(s, &v);
                    })
                    .child(text(words).font(type_::BODY).color(if on { p.beam_text } else { p.text })),
            );
        }
        field = field.child(list);
    }
    field
}

/// A looking-alike waveform: bars whose heights come from `seed`, so a clip always draws the same.
/// The engine reports no audio peaks yet; this is the shape of a timeline, not its measurement.
pub fn waveform(dark: bool, key: &str, label: &str, seed: u64, h: f32) -> El {
    const W: f32 = 496.0;
    let w = W;
    let p = pal(dark);
    let n = ((w - 16.0) / 8.0) as usize;
    let mut x = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    let mut shape = Shape::new();
    for i in 0..n {
        x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let noise = ((x >> 40) as f32 / (1u64 << 24) as f32).clamp(0.0, 1.0);
        let swell = ((i as f32 * 0.35 + (seed % 7) as f32).sin() * 0.5 + 0.5) * 0.7 + 0.3;
        let half = (h * 0.5 - 8.0) * (0.12 + 0.88 * swell * (0.4 + 0.6 * noise));
        let cx = 8.0 + i as f32 * 8.0 + 2.0;
        shape = shape.stroke(vec![[cx, h * 0.5 - half], [cx, h * 0.5 + half]], 4.0, p.steel);
    }
    canvas(shape.view_box(W, h)).key(key).role("img").label(label).w_full().h(h)
}

/// The play triangle or the pause bars, drawn.
pub fn transport_icon(dark: bool, playing: bool) -> El {
    let p = pal(dark);
    let shape = if playing {
        Shape::new().stroke(vec![[4.0, 2.0], [4.0, 16.0]], 3.0, p.text).stroke(vec![[12.0, 2.0], [12.0, 16.0]], 3.0, p.text)
    } else {
        Shape::new().stroke_with(vec![[3.0, 1.5], [3.0, 16.5], [16.0, 9.0]], true, 1.6, rune::LineCap::Round, p.text)
    };
    canvas(shape).w(18.0).h(18.0)
}

/// A text-only action (no fill), for the quiet buttons next to a primary one.
pub fn link(dark: bool, key: impl Into<String>, label: &str, accent: bool, on_press: impl Fn(&mut State) + 'static) -> El {
    let p = pal(dark);
    col().key(key.into()).role("button").label(label).focusable(true).px(8.0).py(8.0).radius(6.0).hover(p.text.alpha(0.08)).press(p.text.alpha(0.16))
        .on_press(on_press).child(text(label).font(type_::LABEL).color(if accent { p.beam_text } else { p.text }))
}

/// The same, pressing with a `Tx` (a file dialog).
pub fn link_tx(dark: bool, key: impl Into<String>, label: &str, accent: bool, on_press: impl Fn(&mut State, &mut rune::Tx) + 'static) -> El {
    let p = pal(dark);
    col().key(key.into()).role("button").label(label).focusable(true).px(8.0).py(8.0).radius(6.0).hover(p.text.alpha(0.08)).press(p.text.alpha(0.16))
        .on_press_tx(on_press).child(text(label).font(type_::LABEL).color(if accent { p.beam_text } else { p.text }))
}
