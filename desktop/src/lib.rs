//! Sorot desktop app: Rune front end for the engine. Rust holds no pipeline logic; it shows what
//! the engine's HTTP API says (constitution I, V).

pub mod app;
pub mod diagnostics;
pub mod engine;
pub mod i18n;
pub mod library;
pub mod preview;
pub mod remembered;
pub mod screens;
pub mod ui;
pub mod update;
pub mod workspace;

use std::path::PathBuf;
use std::sync::Arc;

#[cfg(any(windows, target_os = "macos"))]
use platform::notify_rune::notifier as os_notifier;
#[cfg(target_os = "linux")]
use platform::notify_linux::notifier as os_notifier;
use engine::sidecar::{LaunchConfig, OsSpawn, Sidecar, SystemClock};

/// OS shims, each listed in `coverage-exclude.txt`; `tests/platform_list.rs` guards the list.
pub mod platform {
    #[cfg(windows)]
    #[path = "process_windows.rs"]
    pub mod process_windows;
    #[cfg(unix)]
    #[path = "process_unix.rs"]
    pub mod process_unix;
    #[cfg(windows)]
    pub use process_windows as process;
    #[cfg(unix)]
    pub use process_unix as process;
    #[path = "tray.rs"]
    pub mod tray;
    #[path = "reveal.rs"]
    pub mod reveal;
    #[cfg(target_os = "linux")]
    #[path = "notify_linux.rs"]
    pub mod notify_linux;
    #[cfg(any(windows, target_os = "macos"))]
    #[path = "notify_rune.rs"]
    pub mod notify_rune;
    #[cfg(any(windows, target_os = "macos"))]
    #[path = "rune_player.rs"]
    pub mod rune_player;
    #[cfg(target_os = "linux")]
    #[path = "ffmpeg_proc.rs"]
    pub mod ffmpeg_proc;
    #[cfg(target_os = "linux")]
    #[path = "audio_cpal.rs"]
    pub mod audio_cpal;
    #[cfg(windows)]
    #[path = "taskbar_windows.rs"]
    pub mod taskbar_windows;
    #[path = "locale.rs"]
    pub mod locale;
    #[path = "window_state.rs"]
    pub mod window_state;
    #[cfg(target_os = "macos")]
    #[path = "open_documents_macos.rs"]
    pub mod open_documents_macos;
    #[path = "fx_compositor.rs"]
    pub mod fx_compositor;
    #[path = "gpu_probe.rs"]
    pub mod gpu_probe;
    #[path = "updater_feed.rs"]
    pub mod updater_feed;
    #[path = "save_dialog.rs"]
    pub mod save_dialog;
}

/// Where the engine and its tools are, from the environment (`SOROT_ENGINE`, `SOROT_ENGINE_ARGS`,
/// `SOROT_DATA_DIR`, ...). The packaged layout and the data folder come with the workspace tasks.
pub fn launch_config(env: impl Fn(&str) -> Option<String>) -> LaunchConfig {
    let path = |key: &str, default: &str| PathBuf::from(env(key).unwrap_or_else(|| default.to_string()));
    LaunchConfig {
        program: path("SOROT_ENGINE", "sorot-engine"),
        args: env("SOROT_ENGINE_ARGS").map(|a| a.split_whitespace().map(String::from).collect()).unwrap_or_default(),
        data_dir: path("SOROT_DATA_DIR", "data"),
        pipeline_dir: path("SOROT_PIPELINE_DIR", "ai-pipeline"),
        generator_dir: path("SOROT_GENERATOR_DIR", "generator"),
        python_path: path("SOROT_PYTHON", "python"),
        ffmpeg_path: path("SOROT_FFMPEG", "ffmpeg"),
        gpu: env("WHISPER_DEVICE").is_some_and(|d| d != "cpu"),
    }
}

/// The engine, the library commands and the tray for a real launch. A saved `workspace.json`
/// decides which data folder the engine runs on.
pub fn live() -> app::Live {
    let env = |k: &str| std::env::var(k).ok();
    let config_dir = workspace::config_dir(env);
    let saved = workspace::load(&config_dir);
    let mut cfg = launch_config(env);
    if let Some(ws) = &saved {
        cfg.data_dir = PathBuf::from(&ws.data_dir);
    }
    let data_dir = cfg.data_dir.to_string_lossy().into_owned();
    let (spawn, clock) = (Arc::new(OsSpawn), Arc::new(SystemClock::default()));
    let library = Arc::new(library::ProcLibrary { spawn: spawn.clone(), clock: clock.clone(), cfg: cfg.clone() });
    let icon = env("SOROT_ICON").map(PathBuf::from).unwrap_or_else(|| {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(if cfg!(windows) { "assets/icon/icon.ico" } else { "assets/icon/icon-512.png" })
    });
    app::Live {
        supervisor: app::Supervisor::new(Sidecar::new(spawn, clock, cfg), app::http_engine),
        library,
        config_dir,
        saved,
        data_dir,
        tray: Arc::new(platform::tray::OsTray::new(icon)),
        reveal: Arc::new(platform::reveal::OsReveal),
        notifier: os_notifier(),
        preview: preview::os_player,
        gpu: Arc::new(platform::gpu_probe::OsGpuProbe),
    }
}

pub fn run() {
    app::run(live);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_launch_config_reads_the_environment_or_falls_back() {
        let none = launch_config(|_| None);
        assert_eq!((none.program, none.args, none.gpu), (PathBuf::from("sorot-engine"), vec![], false));
        let set = launch_config(|k| match k {
            "SOROT_ENGINE" => Some("bun".into()),
            "SOROT_ENGINE_ARGS" => Some("run backend/src/index.ts".into()),
            "WHISPER_DEVICE" => Some("cuda".into()),
            _ => None,
        });
        assert_eq!((set.program, set.args, set.gpu), (PathBuf::from("bun"), vec!["run".into(), "backend/src/index.ts".into()], true));
    }
}
