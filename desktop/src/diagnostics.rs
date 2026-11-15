//! The diagnostics report: what a person attaches to a bug report. Every line goes through
//! `core::redact` with the launch token and the masked keys, so neither can leave the machine.

use std::path::PathBuf;

use sorot_desktop_core::engine_conn::State;
use sorot_desktop_core::readiness::Item;
use sorot_desktop_core::redact::redact;

pub const STDERR_LINES: usize = 50;
/// The Rune revision in `Cargo.toml`, short form; a test keeps the two in step.
pub const RUNE_PIN: &str = "73b7dec";

pub struct Inputs<'a> {
    pub app_version: &'a str,
    pub os: &'a str,
    pub readiness: &'a [Item],
    pub connection: &'a State,
    pub stderr: &'a [String],
    /// The token of this launch and every API key the settings show, masked or not.
    pub secrets: &'a [&'a str],
}

pub fn report(i: &Inputs) -> String {
    let mut out = format!("Sorot {}\nOS: {}\nRune: {RUNE_PIN}\nConnection: {:?}\n\nReadiness:\n", i.app_version, i.os, i.connection);
    for item in i.readiness {
        out.push_str(&format!("  {:?} required={} {:?}\n", item.id, item.required, item.state));
    }
    out.push_str("\nEngine log (last lines):\n");
    let skip = i.stderr.len().saturating_sub(STDERR_LINES);
    for line in &i.stderr[skip..] {
        out.push_str(line);
        out.push('\n');
    }
    redact(&out, i.secrets)
}

/// The native "save as" dialog. `None` is a cancel.
pub trait SaveDialog: Send + Sync {
    fn save(&self, file_name: &str, text: &str) -> Result<Option<PathBuf>, String>;
}

pub fn save(dialog: &dyn SaveDialog, i: &Inputs) -> Result<Option<PathBuf>, String> {
    dialog.save("sorot-diagnostics.txt", &report(i))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sorot_desktop_core::readiness::{ItemId, ItemState};
    use std::sync::Mutex;

    struct Fake(Mutex<Vec<(String, String)>>, Option<PathBuf>);

    impl SaveDialog for Fake {
        fn save(&self, name: &str, text: &str) -> Result<Option<PathBuf>, String> {
            self.0.lock().unwrap().push((name.into(), text.into()));
            Ok(self.1.clone())
        }
    }

    #[test]
    fn the_report_has_the_facts_and_neither_the_token_nor_a_key() {
        let stderr: Vec<String> = (0..60).map(|n| format!("line {n} Bearer tok-123 key sk-live-9")).collect();
        let readiness = [Item { id: ItemId::Ffmpeg, required: true, state: ItemState::Missing { fixable: true } }];
        let conn = State::Ready { port: 1234, version: "1.4.0".into() };
        let i = Inputs { app_version: "0.0.1", os: "windows", readiness: &readiness, connection: &conn, stderr: &stderr, secrets: &["tok-123", "sk-live-9"] };
        let text = report(&i);
        for secret in ["tok-123", "sk-live-9"] {
            assert!(!text.contains(secret), "{secret}");
        }
        for fact in ["Sorot 0.0.1", "OS: windows", "Rune: 73b7dec", "port: 1234", "Ffmpeg required=true Missing", "line 59 Bearer •••", "line 10 "] {
            assert!(text.contains(fact), "{fact}");
        }
        assert!(!text.contains("line 9 "), "only the last {STDERR_LINES} lines");

        let (saved, cancelled) = (Fake(Default::default(), Some("a.txt".into())), Fake(Default::default(), None));
        assert_eq!(save(&saved, &i), Ok(Some("a.txt".into())));
        assert_eq!(save(&cancelled, &i), Ok(None));
        assert_eq!(saved.0.lock().unwrap()[0], ("sorot-diagnostics.txt".to_string(), text));
    }

    #[test]
    fn the_pin_matches_cargo_toml() {
        assert!(include_str!("../Cargo.toml").contains(&format!("rev = \"{RUNE_PIN}")));
    }
}
