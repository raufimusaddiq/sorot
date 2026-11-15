//! OS shim: show a file in the system file manager. No logic beyond the OS call.

use std::path::Path;
use std::process::{Command, Stdio};

pub trait Reveal: Send + Sync {
    fn reveal(&self, path: &Path) -> Result<(), String>;
    /// Opens the file itself in the system's video player.
    fn open(&self, path: &Path) -> Result<(), String>;
}

pub struct OsReveal;

fn run(cmd: &mut Command) -> Result<(), String> {
    match cmd.stdout(Stdio::null()).stderr(Stdio::null()).status() {
        Ok(s) if s.success() || cfg!(windows) => Ok(()),
        Ok(s) => Err(format!("the file manager stopped with {s}")),
        Err(e) => Err(e.to_string()),
    }
}

impl Reveal for OsReveal {
    #[cfg(windows)]
    fn reveal(&self, path: &Path) -> Result<(), String> {
        // explorer wants backslashes and exits 1 even when it worked.
        run(Command::new("explorer").arg(format!("/select,{}", path.to_string_lossy().replace('/', "\\"))))
    }

    #[cfg(target_os = "macos")]
    fn reveal(&self, path: &Path) -> Result<(), String> {
        run(Command::new("open").arg("-R").arg(path))
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    fn reveal(&self, path: &Path) -> Result<(), String> {
        let uri = format!("file://{}", path.display());
        let shown = run(Command::new("dbus-send").args([
            "--session", "--print-reply", "--dest=org.freedesktop.FileManager1", "/org/freedesktop/FileManager1",
            "org.freedesktop.FileManager1.ShowItems", &format!("array:string:{uri}"), "string:",
        ]));
        shown.or_else(|_| run(Command::new("xdg-open").arg(path.parent().unwrap_or(path))))
    }

    #[cfg(windows)]
    fn open(&self, path: &Path) -> Result<(), String> {
        run(Command::new("cmd").args(["/C", "start", ""]).arg(path))
    }

    #[cfg(target_os = "macos")]
    fn open(&self, path: &Path) -> Result<(), String> {
        run(Command::new("open").arg(path))
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    fn open(&self, path: &Path) -> Result<(), String> {
        run(Command::new("xdg-open").arg(path))
    }
}
