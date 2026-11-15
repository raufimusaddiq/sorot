//! Sorot desktop app: Rune front end for the engine. Placeholder shell until the screens land.

use rune::tok;
use rune::{AppSpec, Cx, El, col, text};

/// OS shims, each listed in `coverage-exclude.txt`; `tests/platform_list.rs` guards the list.
pub mod platform {
    #[cfg(windows)]
    #[path = "process_windows.rs"]
    pub mod process_windows;
    #[cfg(unix)]
    #[path = "process_unix.rs"]
    pub mod process_unix;
    #[path = "tray.rs"]
    pub mod tray;
    #[path = "reveal.rs"]
    pub mod reveal;
    #[cfg(target_os = "linux")]
    #[path = "notify_linux.rs"]
    pub mod notify_linux;
    #[cfg(windows)]
    #[path = "taskbar_windows.rs"]
    pub mod taskbar_windows;
    #[path = "window_state.rs"]
    pub mod window_state;
    #[cfg(target_os = "macos")]
    #[path = "open_documents_macos.rs"]
    pub mod open_documents_macos;
    #[path = "gpu_probe.rs"]
    pub mod gpu_probe;
}

#[derive(Default)]
pub struct State;

pub fn view(_: &State, _: &mut Cx<State>) -> El {
    let t = tok::theme(true);
    col().w_full().h_full().center().fill(t.bg).child(text("Sorot").font(tok::type_::TITLE).color(t.text))
}

pub fn run() {
    rune::run(AppSpec::<State>::new("Sorot", (1100.0, 720.0), State::default, view));
}

#[cfg(test)]
mod tests {
    use super::*;
    use rune::{Env, Runtime};

    #[test]
    fn the_placeholder_view_lays_out() {
        let mut rt = Runtime::new(State, view, (320.0, 200.0), Env { system_dark: true, scale: 1.0 });
        rt.frame(0.0);
    }
}
