//! OS shim stub: filled by its own task. Kept under 80 lines and out of coverage (coverage-exclude.txt).

/// One-colour tray image: a template image on macOS, tinted on Linux.
pub const TRAY_ICON: &str = include_str!("../../assets/icon/tray-template.svg");
