//! L2: Settings > General on Rune's headless `Runtime`. Preferences are applied and saved at once,
//! loaded at the next start, and a chord another action holds is refused under the recorder.

use rune::prefs::Prefs;
use rune::{Env, Mods, Runtime, PhysicalInput, PhysicalKeyCode as K};
use sorot_desktop::app::State;
use sorot_desktop::i18n::Lang;
use sorot_desktop::screens::panels::{Host, Page};
use sorot_desktop::screens::settings::general::lang_of;
use sorot_desktop_core::prefs::{Action, Chord, CloseBehaviour, Language, Preferences, Theme};

use crate::support::*;

fn stored(path: &std::path::Path) -> Preferences {
    Prefs::at(path).get("preferences").expect("the preferences were saved")
}

fn general(path: &std::path::Path) -> rune::Runtime<State> {
    let mut s = State::scene("home-empty").with_preferences(Prefs::at(path));
    s.show(Page::General);
    // Tall, so the ten recorders are all on screen to press.
    let mut rt = Runtime::new(s, sorot_desktop::app::view, (1100.0, 2400.0), Env { system_dark: true, scale: 1.0 });
    rt.frame(0.0);
    rt
}

fn temp(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("sorot-general-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir.join("preferences.json")
}

#[test]
fn a_choice_updates_the_app_and_is_saved_and_a_restart_reads_it_back() {
    let path = temp("choices");
    let mut rt = general(&path);
    let mut want = Preferences::default();
    type Row = (&'static str, fn(&mut Preferences));
    let rows: [Row; 4] = [
        ("general/theme/light", |p| p.theme = Theme::Light),
        ("general/language/en", |p| p.language = Language::En),
        ("general/close/quit", |p| p.close_behaviour = CloseBehaviour::Quit),
        ("general/notifications", |p| p.notifications = false),
    ];
    for (key, set) in rows {
        click(&mut rt, key);
        set(&mut want);
        assert_eq!(stored(&path), want, "{key}");
    }
    assert_eq!((rt.state.theme, rt.state.lang, rt.state.notifications), (Theme::Light, Lang::En, false));

    let restarted = State::scene("home-empty").with_preferences(Prefs::at(&path));
    assert_eq!((restarted.theme, restarted.lang, restarted.notifications), (Theme::Light, Lang::En, false));
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

#[test]
fn the_system_language_follows_the_os_and_falls_back_to_indonesian() {
    let rows = [
        (Language::System, Some("en-US"), Lang::En),
        (Language::System, Some("en_GB.UTF-8"), Lang::En),
        (Language::System, Some("id-ID"), Lang::Id),
        (Language::System, Some("de-DE"), Lang::Id),
        (Language::System, None, Lang::Id),
        (Language::Id, Some("en-US"), Lang::Id),
        (Language::En, Some("id-ID"), Lang::En),
    ];
    for (chosen, os, want) in rows {
        let s = State::scene("home-empty").with_os_locale(os.map(String::from)).with_preferences(Prefs::memory());
        assert_eq!(lang_of(chosen, os), want, "{chosen:?} on {os:?}");
        let mut s = s;
        s.panels.general.prefs.language = chosen;
        s.prefs_changed();
        assert_eq!(s.lang, want, "the app takes it: {chosen:?} on {os:?}");
    }
}

#[test]
fn a_stored_chord_runs_its_action_and_the_chord_it_replaced_does_nothing() {
    let (ctrl, shift) = (Mods { cmd: true, ..Mods::default() }, Mods { cmd: true, shift: true, ..Mods::default() });
    let mut s = State::scene("home-empty").with_preferences(Prefs::memory());
    s.panels.general.prefs.shortcuts.set(Action::Settings, Chord::new(true, true, 'g')).expect("Ctrl+Shift+G is free");
    s.prefs_changed();
    let mut rt = runtime_of(s);
    let press = |rt: &mut rune::Runtime<State>, key, mods| {
        rt.update(|s: &mut State, tx: &mut rune::Tx| {
            s.keys(&rune::KeyEvent { key, mods }, tx);
        });
    };
    press(&mut rt, rune::Key::Command(','), ctrl);
    assert_eq!(rt.state.screen(), sorot_desktop::app::Screen::Home, "Ctrl+, no longer opens Settings");
    press(&mut rt, rune::Key::Text("G".into()), shift);
    assert_eq!(rt.state.screen(), sorot_desktop::app::Screen::General, "Ctrl+Shift+G does");
}

#[test]
fn a_shortcut_edit_is_saved_or_refused_inline() {
    let ctrl = Mods { ctrl: true, cmd: true, ..Mods::default() };
    let shift = Mods { shift: true, ..ctrl };
    let alt = Mods { alt: true, ..ctrl };
    // (action, key pressed, modifiers, the chord it ends on or None when refused, words of the refusal)
    let rows = [
        ("export", K::KeyU, shift, Some(Chord::new(true, true, 'u')), ""),
        ("export", K::KeyK, ctrl, None, "Ctrl+K sudah dipakai untuk Palet perintah"),
        ("export", K::KeyU, alt, None, "tidak bisa dipakai"),
        ("export", K::Backspace, Mods::default(), None, "tidak bisa dihapus"),
    ];
    for (name, key, mods, saved, words) in rows {
        let path = temp("keys");
        let mut rt = general(&path);
        click(&mut rt, &format!("general/shortcut/{name}"));
        rt.physical_input(PhysicalInput::Key { key, mods, pressed: true, repeat: false });
        rt.frame(1.0 / 60.0);
        let kept = rt.state.panels.general.prefs.shortcuts.get(Action::ExportClip);
        match saved {
            Some(chord) => {
                assert_eq!((kept, stored(&path).shortcuts.get(Action::ExportClip), rt.find("error").is_none()), (chord, chord, true), "{key:?}");
            }
            None => {
                let default = Preferences::default().shortcuts.get(Action::ExportClip);
                assert_eq!(kept, default, "{key:?}");
                assert!(rt.find("error").is_some() && rt.accessibility_json().to_string().contains(words), "{key:?}");
                assert!(!path.exists(), "a refused chord is not saved");
            }
        }
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
