//! The accounts picked in Publish last time, kept in the config folder so the next post starts
//! from them. A missing or unreadable file means none; nothing here can stop a post.

use std::path::Path;

const FILE: &str = "publish-accounts.json";

pub fn load(dir: &Path) -> Vec<String> {
    std::fs::read_to_string(dir.join(FILE)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

/// Best effort: a read-only folder only means the next post starts empty.
pub fn store(dir: &Path, ids: &[String]) {
    let _ = std::fs::create_dir_all(dir);
    let _ = std::fs::write(dir.join(FILE), serde_json::to_string(ids).unwrap_or_default());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_was_stored_comes_back_and_nothing_stored_or_garbage_is_none() {
        let dir = std::env::temp_dir().join(format!("sorot-remembered-{}", std::process::id()));
        assert!(load(&dir).is_empty());
        store(&dir, &["tt".into(), "yt".into()]);
        assert_eq!(load(&dir), ["tt", "yt"]);
        std::fs::write(dir.join(FILE), "not json").unwrap();
        assert!(load(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
