//! Settings, General: language, theme, what closing the window does, notifications, and the
//! keyboard map. A change is applied and saved at once through `Host::prefs_changed`; a chord
//! another action already has is refused under the recorder (`core::prefs::Shortcuts::set`).

use std::str::FromStr;

use rune::{Shortcut, ShortcutError, col, row, text};
use rune::tok::type_;
use rune::El;
use rune_kit::{Kit, ShortcutRecorder, ShortcutRecorderState};
use sorot_desktop_core::prefs::{ACTIONS, Action, Chord, CloseBehaviour, Language, Preferences, Shortcuts, Theme};

use crate::i18n::{Lang, tr, trf};
use crate::screens::panels::{Host, Page};
use crate::ui::form::{card, choice, heading, page, toggle};
use crate::ui::kit::pal;

/// The preferences as the screen edits them, and one recorder per action.
pub struct General {
    pub prefs: Preferences,
    pub recorders: [ShortcutRecorderState; ACTIONS],
}

impl Default for General {
    fn default() -> Self {
        let mut g = General { prefs: Preferences::default(), recorders: Default::default() };
        g.load(Preferences::default());
        g
    }
}

impl General {
    pub fn load(&mut self, prefs: Preferences) {
        self.recorders = Action::ALL.map(|a| ShortcutRecorderState::new(shortcut_of(prefs.shortcuts.get(a))));
        self.prefs = prefs;
    }
}

/// `System` follows the OS: English when it is set to English, Indonesian otherwise (FR-018).
/// `os` is the OS's language tag (`en-US`, `en_GB.UTF-8`, `id-ID`), if it says one.
pub fn lang_of(l: Language, os: Option<&str>) -> Lang {
    match l {
        Language::En => Lang::En,
        Language::Id => Lang::Id,
        Language::System if os.is_some_and(|t| t.get(..2).is_some_and(|p| p.eq_ignore_ascii_case("en"))) => Lang::En,
        Language::System => Lang::Id,
    }
}

const ACTION_KEYS: [&str; ACTIONS] = ["palette", "import", "paste", "play", "next", "previous", "export", "reveal", "settings", "cancel"];

/// The chord as Rune records it (`primary` is Ctrl, or Cmd on macOS).
pub fn shortcut_of(c: Chord) -> Option<Shortcut> {
    let key = if c.key == ' ' { "space".to_string() } else { c.key.to_string() };
    let words = format!("{}{}{key}", if c.primary { "primary+" } else { "" }, if c.shift { "shift+" } else { "" });
    Shortcut::from_str(&words).ok()
}

/// The chord a recorded shortcut stands for; `None` for one the keyboard map cannot hold
/// (Alt, the other platform's modifier, a key that is not a letter, a digit or a sign).
pub fn chord_of(s: &Shortcut) -> Option<Chord> {
    let m = s.modifiers();
    if m.alt || (if cfg!(target_os = "macos") { m.ctrl } else { m.logo }) {
        return None;
    }
    let caps = s.keycaps();
    let key = match caps.last()?.as_str() {
        "Space" => ' ',
        one if one.chars().count() == 1 => one.chars().next()?.to_ascii_lowercase(),
        _ => return None,
    };
    Some(Chord::new(m.cmd, m.shift, key))
}

fn rebind<H: Host>(h: &mut H, action: Action, next: Option<&Shortcut>) -> Result<(), ShortcutError> {
    let Some(chord) = next.and_then(chord_of) else { return Err(ShortcutError::InvalidAccelerator(String::new())) };
    let g = &mut h.panels_mut().general;
    let mut shortcuts = g.prefs.shortcuts;
    shortcuts.set(action, chord).map_err(|_| ShortcutError::Conflict)?;
    g.prefs.shortcuts = shortcuts;
    h.prefs_changed();
    Ok(())
}

/// What the recorder says when it refuses: the action that has the chord, or why the chord can't be one.
fn refusal(l: Lang, shortcuts: &Shortcuts, error: &ShortcutError, chord: Option<&Shortcut>) -> String {
    let owner = chord.and_then(chord_of).and_then(|c| shortcuts.bound_to(c).map(|a| (c, a)));
    match (error, owner) {
        (ShortcutError::Conflict, Some((c, a))) => {
            trf(l, "general.shortcut.taken", &[("chord", &c.label(os())), ("action", &tr(l, &format!("general.action.{}", ACTION_KEYS[a as usize])))])
        }
        (_, _) if chord.is_none() => tr(l, "general.shortcut.keep"),
        _ => tr(l, "general.shortcut.invalid"),
    }
}

pub fn os() -> sorot_desktop_core::prefs::Os {
    if cfg!(target_os = "macos") { sorot_desktop_core::prefs::Os::Mac } else { sorot_desktop_core::prefs::Os::Windows }
}

fn edit<H: Host>(h: &mut H, f: fn(&mut Preferences)) {
    f(&mut h.panels_mut().general.prefs);
    h.prefs_changed();
}

/// A choice of the page: its key, its words, whether it is the one in force, and what picking it sets.
type Pick = (&'static str, String, bool, fn(&mut Preferences));

pub fn view<H: Host>(h: &H) -> El {
    let (dark, l) = (h.dark(), h.lang());
    let g = &h.panels().general;
    let p = pal(dark);
    let head = heading(dark, "general/title", &tr(l, "settings.title"), &tr(l, "general.sub"));

    let picks = |key: &str, name: &str, items: Vec<Pick>| {
        let mut r = row().gap(8.0).flex_wrap();
        for (slug, label, on, set) in items {
            r = r.child(choice(dark, &format!("general/{key}/{slug}"), &label, on, move |h: &mut H| edit(h, set)));
        }
        col().gap(6.0).child(text(name).font(type_::LABEL).color(p.muted)).child(r)
    };
    let (pf, t) = (&g.prefs, |k: &str| tr(l, k));
    let look = card(dark, "general/look", &t("general.look"))
        .child(picks("language", &t("general.language"), vec![
            ("system", t("general.system"), pf.language == Language::System, |p| p.language = Language::System),
            ("id", t("lang.id"), pf.language == Language::Id, |p| p.language = Language::Id),
            ("en", t("lang.en"), pf.language == Language::En, |p| p.language = Language::En),
        ]))
        .child(picks("theme", &t("general.theme"), vec![
            ("system", t("general.system"), pf.theme == Theme::System, |p| p.theme = Theme::System),
            ("dark", t("general.dark"), pf.theme == Theme::Dark, |p| p.theme = Theme::Dark),
            ("light", t("general.light"), pf.theme == Theme::Light, |p| p.theme = Theme::Light),
        ]));
    let window = card(dark, "general/window", &t("general.window"))
        .child(picks("close", &t("general.close"), vec![
            ("ask", t("general.close.ask"), pf.close_behaviour == CloseBehaviour::Ask, |p| p.close_behaviour = CloseBehaviour::Ask),
            ("background", t("general.close.background"), pf.close_behaviour == CloseBehaviour::Background, |p| p.close_behaviour = CloseBehaviour::Background),
            ("quit", t("general.close.quit"), pf.close_behaviour == CloseBehaviour::Quit, |p| p.close_behaviour = CloseBehaviour::Quit),
        ]))
        .child(toggle(dark, l, "general/notifications", &t("general.notifications"), pf.notifications, |h: &mut H| edit(h, |p| p.notifications = !p.notifications)));

    let kit = Kit::neutral(dark);
    let mut keys = card(dark, "general/shortcuts", &t("general.shortcuts"));
    for action in Action::ALL {
        let i = action as usize;
        let name = t(&format!("general.action.{}", ACTION_KEYS[i]));
        let shortcuts = pf.shortcuts;
        let recorder = ShortcutRecorder::new(format!("general/shortcut/{}", ACTION_KEYS[i]), &g.recorders[i], move |h: &mut H| &mut h.panels_mut().general.recorders[i])
            .label(name.clone())
            .allow_unmodified()
            .on_change(move |h: &mut H, next, _| rebind(h, action, next))
            .error_message(move |e, c| refusal(l, &shortcuts, e, c))
            .build(&kit);
        keys = keys.child(row().gap(16.0).items_center().child(text(name).font(type_::BODY).color(p.text).w(220.0)).child(recorder));
    }
    page().child(head).child(super::tabs::<H>(dark, l, Page::General)).child(look).child(window).child(keys)
}
