//! Existing libraries, through the engine's startup commands (`--find-libraries`,
//! `--copy-library`, `--import-keys`). The app reads none of those files itself.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use sorot_desktop_core::workspace::Candidate;

use crate::engine::sidecar::{Clock, LaunchConfig, Spawn, run_library_command_with};

pub trait Library: Send + Sync {
    fn find(&self) -> Result<Vec<Candidate>, String>;
    /// Copies `from` into `to`; the files it could not read come back.
    fn copy(&self, from: &str, to: &str, progress: &mut dyn FnMut(u8)) -> Result<Vec<String>, String>;
    /// Brings the API keys of `from` into the data folder `into`; how many.
    fn import_keys(&self, from: &str, into: &str) -> Result<usize, String>;
}

/// The real engine binary, run once per command.
pub struct ProcLibrary {
    pub spawn: Arc<dyn Spawn>,
    pub clock: Arc<dyn Clock>,
    pub cfg: LaunchConfig,
}

impl ProcLibrary {
    fn run(&self, args: &[&str], into: Option<&str>, progress: &mut dyn FnMut(u8)) -> Result<serde_json::Value, String> {
        let env = crate::engine::sidecar::launch_env(&self.cfg, "")
            .into_iter()
            .filter(|(k, _)| k != "SOROT_TOKEN")
            .map(|(k, v)| if k == "DATA_DIR" { (k, into.map(String::from).unwrap_or(v)) } else { (k, v) })
            .collect();
        run_library_command_with(self.spawn.as_ref(), self.clock.as_ref(), &self.cfg, args, env, progress).into_result()
    }
}

fn field<T: serde::de::DeserializeOwned>(data: &serde_json::Value, name: &str) -> Result<T, String> {
    serde_json::from_value(data[name].clone()).map_err(|e| format!("The engine's answer has no {name}: {e}"))
}

impl Library for ProcLibrary {
    fn find(&self) -> Result<Vec<Candidate>, String> {
        field(&self.run(&["--find-libraries"], None, &mut |_| {})?, "candidates")
    }

    fn copy(&self, from: &str, to: &str, progress: &mut dyn FnMut(u8)) -> Result<Vec<String>, String> {
        field(&self.run(&["--copy-library", from, to], Some(to), progress)?, "skipped")
    }

    fn import_keys(&self, from: &str, into: &str) -> Result<usize, String> {
        Ok(field::<Vec<serde_json::Value>>(&self.run(&["--import-keys", from], Some(into), &mut |_| {})?, "imported")?.len())
    }
}

/// A scene's `libraries.json` (`{"candidates":[..],"skipped":[..]}`) played back, for headless runs.
pub struct SceneLibrary {
    pub dir: PathBuf,
    calls: Mutex<Vec<String>>,
}

impl SceneLibrary {
    pub fn new(dir: PathBuf) -> Self {
        SceneLibrary { dir, calls: Mutex::new(vec![]) }
    }

    pub fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }

    fn data(&self) -> Result<serde_json::Value, String> {
        let text = std::fs::read_to_string(self.dir.join("libraries.json")).map_err(|e| e.to_string())?;
        serde_json::from_str(&text).map_err(|e| e.to_string())
    }
}

impl Library for SceneLibrary {
    fn find(&self) -> Result<Vec<Candidate>, String> {
        self.calls.lock().unwrap().push("find".into());
        field(&self.data()?, "candidates")
    }

    fn copy(&self, from: &str, to: &str, progress: &mut dyn FnMut(u8)) -> Result<Vec<String>, String> {
        self.calls.lock().unwrap().push(format!("copy({from},{to})"));
        progress(100);
        field(&self.data()?, "skipped")
    }

    fn import_keys(&self, from: &str, into: &str) -> Result<usize, String> {
        self.calls.lock().unwrap().push(format!("import_keys({from},{into})"));
        Ok(0)
    }
}
