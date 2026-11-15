//! The user's preferences and the keyboard map. No chord is ever bound to two actions.

use serde::{Deserialize, Serialize};

use crate::close::ClosePref;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    Id,
    En,
    System,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    System,
    Dark,
    Light,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CloseBehaviour {
    Ask,
    Background,
    Quit,
}

impl From<CloseBehaviour> for ClosePref {
    fn from(b: CloseBehaviour) -> Self {
        match b {
            CloseBehaviour::Ask => ClosePref::Ask,
            CloseBehaviour::Background => ClosePref::Background,
            CloseBehaviour::Quit => ClosePref::Quit,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Os {
    Windows,
    Linux,
    Mac,
}

/// Every action with a shortcut, in the order of the keyboard map in contracts/desktop-screens.md.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    CommandPalette,
    ImportFile,
    PasteLink,
    PlayPause,
    NextClip,
    PreviousClip,
    ExportClip,
    ShowInFolder,
    Settings,
    CancelJob,
}

pub const ACTIONS: usize = 10;

impl Action {
    pub const ALL: [Action; ACTIONS] = [
        Action::CommandPalette, Action::ImportFile, Action::PasteLink, Action::PlayPause, Action::NextClip,
        Action::PreviousClip, Action::ExportClip, Action::ShowInFolder, Action::Settings, Action::CancelJob,
    ];
}

/// `primary` is Ctrl on Windows and Linux, Cmd on macOS.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Chord {
    pub primary: bool,
    pub shift: bool,
    pub key: char,
}

impl Chord {
    pub const fn new(primary: bool, shift: bool, key: char) -> Self {
        Self { primary, shift, key }
    }

    /// As shown to the user: `Ctrl+Shift+V`, `Cmd+K`, `Space`.
    pub fn label(&self, os: Os) -> String {
        let key = if self.key == ' ' { "Space".to_string() } else { self.key.to_uppercase().to_string() };
        let mods = [(self.primary, if os == Os::Mac { "Cmd" } else { "Ctrl" }), (self.shift, "Shift")];
        mods.iter().filter(|m| m.0).map(|m| format!("{}+", m.1)).collect::<String>() + &key
    }
}

fn default_chord(a: Action) -> Chord {
    use Action::*;
    match a {
        CommandPalette => Chord::new(true, false, 'k'),
        ImportFile => Chord::new(true, false, 'o'),
        PasteLink => Chord::new(true, true, 'v'),
        PlayPause => Chord::new(false, false, ' '),
        NextClip => Chord::new(false, false, 'j'),
        PreviousClip => Chord::new(false, false, 'k'),
        ExportClip => Chord::new(true, false, 'e'),
        ShowInFolder => Chord::new(true, true, 'r'),
        Settings => Chord::new(true, false, ','),
        CancelJob => Chord::new(true, false, '.'),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Shortcuts([Chord; ACTIONS]);

impl Default for Shortcuts {
    fn default() -> Self {
        Self(Action::ALL.map(default_chord))
    }
}

impl Shortcuts {
    pub fn get(&self, action: Action) -> Chord {
        self.0[action as usize]
    }

    /// The action that already uses `chord`, if any.
    pub fn bound_to(&self, chord: Chord) -> Option<Action> {
        Action::ALL.into_iter().find(|a| self.get(*a) == chord)
    }

    /// Rebinds `action`; refused with the owner of the chord when another action has it.
    pub fn set(&mut self, action: Action, chord: Chord) -> Result<(), Action> {
        match self.bound_to(chord) {
            Some(owner) if owner != action => Err(owner),
            _ => {
                self.0[action as usize] = chord;
                Ok(())
            }
        }
    }

    pub fn is_unique(&self) -> bool {
        (0..ACTIONS).all(|i| (i + 1..ACTIONS).all(|j| self.0[i] != self.0[j]))
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub language: Language,
    pub theme: Theme,
    pub shortcuts: Shortcuts,
    pub close_behaviour: CloseBehaviour,
    pub notifications: bool,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            language: Language::System,
            theme: Theme::System,
            shortcuts: Shortcuts::default(),
            close_behaviour: CloseBehaviour::Ask,
            notifications: true,
        }
    }
}

impl Preferences {
    /// A file edited by hand may bind a chord twice: the keyboard map goes back to the defaults.
    pub fn checked(mut self) -> Self {
        if !self.shortcuts.is_unique() {
            self.shortcuts = Shortcuts::default();
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_follow_the_keyboard_map_per_os() {
        let p = Preferences::default();
        assert_eq!((p.language, p.theme, p.close_behaviour, p.notifications), (Language::System, Theme::System, CloseBehaviour::Ask, true));
        assert_eq!(ClosePref::from(p.close_behaviour), ClosePref::Ask);
        assert_eq!([CloseBehaviour::Background, CloseBehaviour::Quit].map(ClosePref::from), [ClosePref::Background, ClosePref::Quit]);
        use Action::*;
        for (action, win_linux, mac) in [
            (CommandPalette, "Ctrl+K", "Cmd+K"), (ImportFile, "Ctrl+O", "Cmd+O"), (PasteLink, "Ctrl+Shift+V", "Cmd+Shift+V"),
            (PlayPause, "Space", "Space"), (NextClip, "J", "J"), (PreviousClip, "K", "K"), (ExportClip, "Ctrl+E", "Cmd+E"),
            (ShowInFolder, "Ctrl+Shift+R", "Cmd+Shift+R"), (Settings, "Ctrl+,", "Cmd+,"), (CancelJob, "Ctrl+.", "Cmd+."),
        ] {
            let c = p.shortcuts.get(action);
            assert_eq!([c.label(Os::Windows), c.label(Os::Linux), c.label(Os::Mac)], [win_linux, win_linux, mac], "{action:?}");
        }
        assert!(p.shortcuts.is_unique());
    }

    #[test]
    fn a_taken_chord_is_refused_and_a_free_one_binds() {
        let mut s = Shortcuts::default();
        let j = s.get(Action::NextClip);
        assert_eq!(s.set(Action::PreviousClip, j), Err(Action::NextClip));
        assert_eq!(s.get(Action::PreviousClip), Chord::new(false, false, 'k'));
        assert_eq!(s.set(Action::NextClip, j), Ok(()), "its own chord again");
        assert_eq!(s.set(Action::PreviousClip, Chord::new(false, false, 'h')), Ok(()));
        assert_eq!(s.bound_to(Chord::new(false, false, 'h')), Some(Action::PreviousClip));
        assert_eq!(s.bound_to(Chord::new(false, false, 'k')), None);
    }

    #[test]
    fn a_hand_edited_file_with_a_double_binding_gets_the_default_map() {
        let mut p = Preferences { theme: Theme::Dark, ..Preferences::default() };
        let json = serde_json::to_string(&p).unwrap();
        assert_eq!(serde_json::from_str::<Preferences>(&json).unwrap().checked(), p);
        p.shortcuts.0[1] = p.shortcuts.0[0];
        let fixed = p.clone().checked();
        assert_eq!((fixed.shortcuts, fixed.theme), (Shortcuts::default(), Theme::Dark));
    }
}

#[cfg(kani)]
mod proofs {
    use super::*;

    #[kani::proof]
    #[kani::unwind(12)]
    fn no_two_actions_ever_share_a_chord() {
        let mut s = Shortcuts::default();
        for _ in 0..4 {
            let action = Action::ALL[kani::any::<usize>() % 4];
            let chord = Chord::new(kani::any(), kani::any(), (b'i' + kani::any::<u8>() % 6) as char);
            let _ = s.set(action, chord);
            assert!(s.is_unique());
        }
    }
}
