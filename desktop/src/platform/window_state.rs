//! OS shim: where the window and the view were, kept in `rune::prefs::Prefs`; the rule for a
//! spot that is gone is `core::window::restore`. Out of coverage (coverage-exclude.txt).

use std::cell::RefCell;

use rune::WindowHandle;
use rune::prefs::Prefs;
use serde::{Deserialize, Serialize};
#[cfg(not(target_os = "macos"))]
use sorot_desktop_core::window::{Rect, restore};

use crate::session::{APP_ID, ViewMemory};

thread_local! {
    static WINDOW: RefCell<Option<WindowHandle>> = const { RefCell::new(None) };
}

#[derive(Serialize, Deserialize)]
struct Frame { x: i32, y: i32, w: u32, h: u32, maximized: bool }

/// The main window, once it exists (UI thread).
pub fn window() -> Option<WindowHandle> {
    WINDOW.with_borrow(Clone::clone)
}

pub fn load_view() -> ViewMemory {
    Prefs::open(APP_ID).get("view").unwrap_or_default()
}

pub fn was_maximized() -> bool {
    Prefs::open(APP_ID).get::<Frame>("window").is_some_and(|f| f.maximized)
}

/// Remembers the view and, where Rune reports one, the window's frame (macOS keeps its own).
pub fn save(view: &ViewMemory) {
    let mut prefs = Prefs::open(APP_ID);
    let _ = prefs.set("view", view);
    let Some(p) = window().and_then(|w| w.placement()) else { return };
    let ((x, y), (w, h)) = p.restore.unwrap_or((p.position, p.content_size));
    let _ = prefs.set("window", &Frame { x, y, w, h, maximized: p.maximized });
}

/// The window exists: puts it where it was when that is still on a monitor, else leaves it
/// centred on the primary one at the default size.
pub fn on_ready(w: &WindowHandle) {
    WINDOW.with_borrow_mut(|c| *c = Some(w.clone()));
    #[cfg(target_os = "macos")]
    rune_mac::remember_frame("sorot-main");
    #[cfg(not(target_os = "macos"))]
    if let (Some(f), Some(here)) = (Prefs::open(APP_ID).get::<Frame>("window"), w.placement()) {
        let mut monitors = monitors();
        if monitors.is_empty() {
            monitors.extend(here.display.map(|((x, y), (w, h))| Rect { x, y, w, h }));
        }
        let at = restore(Rect { x: f.x, y: f.y, w: f.w, h: f.h }, &monitors);
        w.set_position((at.x, at.y));
        w.resize_instant((at.w as f32 / here.scale as f32, at.h as f32 / here.scale as f32));
    }
}

#[cfg(windows)]
use super::monitors_windows::monitors;
#[cfg(all(not(windows), not(target_os = "macos")))]
fn monitors() -> Vec<Rect> {
    vec![]
}
