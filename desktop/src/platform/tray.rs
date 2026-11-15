//! OS shim: the tray icon on Windows and Linux (macOS keeps the Dock). Out of coverage; no logic
//! beyond the OS call (coverage-exclude.txt).

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use rune::{TrayEvent, TrayIcon, TrayItem, TraySpec};

/// One-colour tray image: a template image on macOS, tinted on Linux.
pub const TRAY_ICON: &str = include_str!("../../assets/icon/tray-template.svg");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrayCmd {
    Open,
    Quit,
}

pub trait Tray: Send + Sync {
    /// Puts the icon up and reports its clicks. False where the OS has no tray: closing the
    /// window must then not hide the app.
    fn install(&self, on: Arc<dyn Fn(TrayCmd) + Send + Sync>) -> bool;
}

pub struct OsTray {
    pub icon: PathBuf,
    held: Mutex<Option<rune::Tray>>,
}

impl OsTray {
    pub fn new(icon: PathBuf) -> Self {
        OsTray { icon, held: Mutex::new(None) }
    }
}

impl Tray for OsTray {
    fn install(&self, on: Arc<dyn Fn(TrayCmd) + Send + Sync>) -> bool {
        let Ok((w, h, px)) = rune::image::app_icon_rgba(&self.icon, 32) else { return false };
        let menu = vec![TrayItem::action("open", "Open Sorot"), TrayItem::action("quit", "Quit Sorot")];
        let spec = TraySpec::new("io.github.raufimusaddiq.sorot", "Sorot", TrayIcon::rgba(w, h, px)).tooltip("Sorot").menu(menu);
        let tray = rune::Tray::new(spec, move |e| on(if matches!(&e, TrayEvent::Menu(id) if id == "quit") { TrayCmd::Quit } else { TrayCmd::Open }));
        tray.map(|t| *self.held.lock().unwrap() = Some(t)).is_ok()
    }
}
