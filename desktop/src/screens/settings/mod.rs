//! The Settings pages for connections and Generate.

pub mod connections;
pub mod generate;

use rune::{El, row};

use crate::screens::panels::{Host, Page};
use crate::ui::form::choice;

/// The two Settings pages as tabs; `on` is the one open.
pub fn tabs<H: Host>(dark: bool, on: Page) -> El {
    let tab = |key: &str, label: &str, page: Page| choice(dark, key, label, on == page, move |h: &mut H| h.show(page));
    row().gap(8.0).child(tab("settings/tab/connections", "Connections", Page::Connections)).child(tab("settings/tab/generate", "Generate", Page::GenerateSettings))
}
