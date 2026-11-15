//! User-facing text in Indonesian (the default) and English (FR-018). Strings live in
//! `i18n/id.json` and `i18n/en.json`; a screen asks for a key with `tr`. A key missing in one
//! language falls back to the other, and a test holds the two files to the same keys.

use std::collections::HashMap;
use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Lang {
    #[default]
    Id,
    En,
}

fn table(json: &'static str) -> HashMap<String, String> {
    serde_json::from_str(json).expect("the i18n file is a flat string map")
}

fn tables() -> &'static [HashMap<String, String>; 2] {
    static T: OnceLock<[HashMap<String, String>; 2]> = OnceLock::new();
    T.get_or_init(|| [table(include_str!("../i18n/id.json")), table(include_str!("../i18n/en.json"))])
}

static CURRENT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// The language screens that hold no `State` read with `t`; the view sets it each frame.
pub fn set_current(lang: Lang) {
    CURRENT.store(lang == Lang::En, std::sync::atomic::Ordering::Relaxed);
}

/// The language set for this frame.
pub fn current() -> Lang {
    if CURRENT.load(std::sync::atomic::Ordering::Relaxed) { Lang::En } else { Lang::Id }
}

/// The text for `key` in the current language.
pub fn t(key: &str) -> String {
    tr(if CURRENT.load(std::sync::atomic::Ordering::Relaxed) { Lang::En } else { Lang::Id }, key)
}

/// `t(key)` with `{0}`, `{1}` ... replaced by `args`.
pub fn tf(key: &str, args: &[&str]) -> String {
    args.iter().enumerate().fold(t(key), |s, (i, a)| s.replace(&format!("{{{i}}}"), a))
}

/// The text for `key` in `lang`; the other language's, then the key itself, when it is missing.
pub fn tr(lang: Lang, key: &str) -> String {
    let [id, en] = tables();
    let (first, second) = if lang == Lang::Id { (id, en) } else { (en, id) };
    first.get(key).or_else(|| second.get(key)).cloned().unwrap_or_else(|| key.to_string())
}

/// `tr` with each `{name}` in the text replaced by its value.
pub fn trf(lang: Lang, key: &str, args: &[(&str, &str)]) -> String {
    args.iter().fold(tr(lang, key), |t, (k, v)| t.replace(&format!("{{{k}}}"), v))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Both files hold the same keys, no value is empty, and none uses an em dash (copy rule).
    #[test]
    fn the_two_languages_hold_the_same_keys_without_empty_values_or_em_dashes() {
        let [id, en] = tables();
        let (mut a, mut b): (Vec<_>, Vec<_>) = (id.keys().collect(), en.keys().collect());
        a.sort();
        b.sort();
        assert_eq!(a, b);
        assert!(id.values().chain(en.values()).all(|v| !v.trim().is_empty() && !v.contains('\u{2014}')));
    }

    #[test]
    fn a_key_reads_in_the_chosen_language_and_falls_back() {
        assert_eq!((tr(Lang::Id, "shell.home"), tr(Lang::En, "shell.home"), tr(Lang::Id, "no.such.key")), ("Beranda".into(), "Home".into(), "no.such.key".into()));
        assert_eq!(Lang::default(), Lang::Id);
    }
}
