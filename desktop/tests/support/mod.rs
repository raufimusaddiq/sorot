//! What the screen tests share. L1 is `desktop/core`; L2 drives a Rune `Runtime` in process against
//! `FakeEngine` (these helpers); L3 runs the binary headless (`headless`).
#![allow(dead_code)]

use rune::{Env, Key, KeyEvent, Mods, Runtime};
use sorot_desktop::app::State;

#[allow(unused_imports)]
pub use sorot_desktop::engine::fake::{FakeClock, FakeEngine, FakeProc, FakeSpawn};

pub mod headless;

/// The app on scene `name`, one frame in, at a desktop window size.
pub fn runtime(name: &str) -> Runtime<State> {
    runtime_of(State::scene(name))
}

pub fn runtime_of(state: State) -> Runtime<State> {
    let mut rt = Runtime::new(state, sorot_desktop::app::view, (1100.0, 720.0), Env { system_dark: true, scale: 1.0 });
    rt.frame(0.0);
    rt
}

/// Presses the element with `key` as a pointer would, then lets one frame pass.
pub fn click(rt: &mut Runtime<State>, key: &str) {
    let (x, y) = rt.find(key).unwrap_or_else(|| panic!("no element {key}"));
    rt.pointer_move(x, y);
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(1.0 / 60.0);
}

/// Moves the pointer onto (or off) the element with `key`.
pub fn hover(rt: &mut Runtime<State>, key: Option<&str>) {
    rt.pointer_move(1.0, 1.0);
    rt.frame(1.0 / 60.0);
    if let Some(k) = key {
        let (x, y) = rt.find(k).unwrap_or_else(|| panic!("no element {k}"));
        rt.pointer_move(x, y);
        rt.frame(1.0 / 60.0);
    }
}

/// Types `s` into the focused field (focus it first with `click`).
pub fn type_text(rt: &mut Runtime<State>, key: &str, s: &str) {
    click(rt, key);
    rt.key(KeyEvent { key: Key::Text(s.into()), mods: Mods::default() });
    rt.frame(1.0 / 60.0);
}

/// A chord such as `cmd+k` or `Enter`.
pub fn press(rt: &mut Runtime<State>, chord: &str) {
    let parts: Vec<&str> = chord.split('+').collect();
    let (name, mods) = parts.split_last().unwrap();
    let mods = Mods {
        cmd: mods.contains(&"cmd") || mods.contains(&"ctrl"),
        shift: mods.contains(&"shift"),
        alt: mods.contains(&"alt"),
        ..Mods::default()
    };
    let key = match *name {
        "Enter" => Key::Enter,
        "Escape" => Key::Escape,
        "Tab" => Key::Tab,
        n if n.chars().count() == 1 && mods.cmd => Key::Command(n.chars().next().unwrap().to_ascii_lowercase()),
        n => Key::Text(n.into()),
    };
    rt.key(KeyEvent { key, mods });
    rt.frame(1.0 / 60.0);
}

/// Seconds of app time pass in 60 fps frames.
pub fn advance(rt: &mut Runtime<State>, seconds: f64) {
    let mut t = 0.0;
    while t < seconds {
        rt.frame(1.0 / 60.0);
        t += 1.0 / 60.0;
    }
}
