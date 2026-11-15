//! Where `workspace.json` lives and how it is read and written. The file holds no secret.

use std::path::{Path, PathBuf};

use sorot_desktop_core::workspace::Workspace;

const FILE: &str = "workspace.json";

/// The app's own folder: `SOROT_CONFIG_DIR`, else the OS's usual place for per-user settings.
pub fn config_dir(env: impl Fn(&str) -> Option<String>) -> PathBuf {
    if let Some(dir) = env("SOROT_CONFIG_DIR") {
        return dir.into();
    }
    let home = PathBuf::from(env("HOME").or_else(|| env("USERPROFILE")).unwrap_or_default());
    if cfg!(windows) {
        PathBuf::from(env("APPDATA").unwrap_or_default()).join("Sorot")
    } else if cfg!(target_os = "macos") {
        home.join("Library/Application Support/Sorot")
    } else {
        env("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".config")).join("sorot")
    }
}

pub fn load(dir: &Path) -> Option<Workspace> {
    serde_json::from_str(&std::fs::read_to_string(dir.join(FILE)).ok()?).ok()
}

pub fn save(dir: &Path, w: &Workspace) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join(FILE), serde_json::to_string_pretty(w).expect("a workspace is plain data"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sorot_desktop_core::workspace::{EngineKind, Source};

    #[test]
    fn the_config_folder_comes_from_the_override_or_the_os_convention() {
        let env = |pairs: &'static [(&str, &str)]| move |k: &str| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.to_string());
        assert_eq!(config_dir(env(&[("SOROT_CONFIG_DIR", "/c")])), PathBuf::from("/c"));
        let default = config_dir(env(&[("APPDATA", "/a"), ("HOME", "/h"), ("XDG_CONFIG_HOME", "/x")]));
        let want = if cfg!(windows) { "/a/Sorot" } else if cfg!(target_os = "macos") { "/h/Library/Application Support/Sorot" } else { "/x/sorot" };
        assert_eq!(default, PathBuf::from(want));
        if cfg!(all(unix, not(target_os = "macos"))) {
            assert_eq!(config_dir(env(&[("HOME", "/h")])), PathBuf::from("/h/.config/sorot"));
        }
    }

    #[test]
    fn a_saved_workspace_loads_back_and_a_missing_or_broken_file_is_none() {
        let dir = std::env::temp_dir().join(format!("sorot-ws-{}", std::process::id()));
        assert_eq!(load(&dir), None);
        let w = Workspace { data_dir: "/d".into(), source: Source::New, adopted_from: None, engine: EngineKind::Local };
        save(&dir, &w).unwrap();
        assert_eq!(load(&dir), Some(w));
        std::fs::write(dir.join(FILE), "{").unwrap();
        assert_eq!(load(&dir), None);
        assert!(save(&dir.join(FILE), &Workspace { data_dir: String::new(), source: Source::New, adopted_from: None, engine: EngineKind::Local }).is_err());
    }
}
