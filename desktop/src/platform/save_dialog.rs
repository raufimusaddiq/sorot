//! The native "save as" dialog for the diagnostics report.
use std::path::PathBuf;

use crate::diagnostics::SaveDialog;

pub struct OsSaveDialog;

impl SaveDialog for OsSaveDialog {
    fn save(&self, file_name: &str, text: &str) -> Result<Option<PathBuf>, String> {
        let Some(path) = rfd::FileDialog::new().set_file_name(file_name).save_file() else { return Ok(None) };
        std::fs::write(&path, text).map_err(|e| e.to_string())?;
        Ok(Some(path))
    }
}
