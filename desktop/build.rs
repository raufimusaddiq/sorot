//! Generates `theme/sorot.json` from the design tokens. The theme is never edited by hand.
use std::{fs, path::Path};

fn main() {
    println!("cargo:rerun-if-changed=design/tokens.json");
    println!("cargo:rerun-if-changed=build.rs");
    let tokens = fs::read_to_string("design/tokens.json").expect("design/tokens.json");
    let theme = sorot_desktop_core::theme_gen::tokens_to_theme(&tokens).unwrap_or_else(|e| panic!("{e}"));
    let out = Path::new("theme/sorot.json");
    if fs::read_to_string(out).ok().as_deref() != Some(theme.as_str()) {
        fs::create_dir_all("theme").unwrap();
        fs::write(out, theme).unwrap();
    }
}
