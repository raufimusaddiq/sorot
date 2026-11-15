//! The Settings pages: connections, and Generate (models, voice, images, commands).

pub mod commands;
pub mod connections;
pub mod generate;
pub mod image;
pub mod voice;

use rune::{El, row, text};
use rune::tok::type_;

use crate::engine::types::ConnTest;
use crate::i18n::{Lang, tr, trf};
use crate::screens::panels::{Host, Page};
use crate::ui::form::{Tone, choice, note};
use crate::ui::kit::pal;

/// Kenari (kenari.id) is the default AI provider: one key, no address to type.
pub const KENARI_BASE_URL: &str = "https://kenari.id/v1";
pub const KENARI_DEFAULT_MODEL: &str = "kenari/auto";
pub const KENARI_DEFAULT_IMAGE_MODEL: &str = "gpt-image-2";

/// How a connection is set up: through Kenari, or with an address of the person's own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Kenari,
    Custom,
}

/// `None` while no address is saved.
pub fn mode_of(base_url: Option<&str>) -> Option<Mode> {
    match base_url {
        None | Some("") => None,
        Some(KENARI_BASE_URL) => Some(Mode::Kenari),
        Some(_) => Some(Mode::Custom),
    }
}

/// What every card of the Generate page keeps while it works: a busy flag, the engine's refusal and a test result.
#[derive(Default)]
pub struct Run {
    pub busy: bool,
    pub error: Option<String>,
    pub test: Option<ConnTest>,
    pub notice: bool,
}

impl Run {
    pub fn start(&mut self) {
        (self.busy, self.error, self.test, self.notice) = (true, None, None, false);
    }

    /// The error, the test result and the saved notice of a card whose controls are keyed `{prefix}/...`.
    pub fn notes(&self, dark: bool, lang: Lang, prefix: &str) -> Vec<El> {
        let mut out = vec![];
        if let Some(why) = &self.error {
            out.push(note(dark, &format!("{prefix}/error"), Tone::Bad, &trf(lang, "conn.not-saved", &[("why", why)])));
        }
        if self.notice {
            out.push(note(dark, &format!("{prefix}/notice"), Tone::Ok, &tr(lang, "conn.saved")));
        }
        if let Some(t) = &self.test {
            out.push(note(dark, &format!("{prefix}/result"), if t.ok { Tone::Ok } else { Tone::Bad }, &test_words(lang, t)));
        }
        out
    }
}

pub fn test_words(lang: Lang, t: &ConnTest) -> String {
    if t.ok {
        let model = t.model.as_ref().map(|m| format!(", {m}")).unwrap_or_default();
        let detail = t.detail.as_ref().map(|d| format!(", {d}")).unwrap_or_default();
        trf(lang, "conn.works", &[("ms", &t.ms.to_string()), ("model", &model), ("detail", &detail)])
    } else {
        trf(lang, "conn.failed", &[("why", &t.error.clone().unwrap_or_else(|| tr(lang, "conn.no-reason")))])
    }
}

/// The Settings pages as tabs; `on` is the one open.
pub fn tabs<H: Host>(dark: bool, lang: Lang, on: Page) -> El {
    let tab = |key: &str, label: &str, page: Page| choice(dark, key, label, on == page, move |h: &mut H| h.show(page));
    row().gap(8.0)
        .child(tab("settings/tab/connections", &tr(lang, "settings.tab.connections"), Page::Connections))
        .child(tab("settings/tab/generate", &tr(lang, "settings.tab.generate"), Page::GenerateSettings))
}

/// A line of small muted words.
pub fn hint(dark: bool, words: impl Into<String>) -> El {
    text(words.into()).font(type_::LABEL).color(pal(dark).muted).wrap()
}

/// Choices that wrap onto more lines when there are many (a model list).
pub fn wrapped(items: Vec<El>) -> El {
    let mut r = row().gap(8.0).flex_wrap().w_full();
    for i in items {
        r = r.child(i);
    }
    r
}

