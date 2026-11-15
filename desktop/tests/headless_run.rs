//! The binary starts and renders one frame headless (also what covers `main`).

use std::process::Command;

#[test]
fn the_binary_renders_a_snapshot_headless() {
    let png = std::env::temp_dir().join(format!("sorot-desktop-{}.png", std::process::id()));
    let out = Command::new(env!("CARGO_BIN_EXE_sorot-desktop")).arg("--snap").arg(&png).output().unwrap();
    let ok = out.status.success() && png.metadata().map(|m| m.len() > 0).unwrap_or(false);
    let _ = std::fs::remove_file(&png);
    assert!(ok, "{}", String::from_utf8_lossy(&out.stderr));
}
