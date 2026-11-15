//! The clip preview: the engine's rendered file in a local cache, played by Rune's `Player`
//! (Windows, macOS) or by two ffmpeg processes (Linux, `ffmpeg_player`).

use std::path::{Path, PathBuf};

use rune::El;
use sorot_desktop_core::cache::{Cache, CAP_BYTES, Entry, Inserted};
use sorot_desktop_core::model::Clip;

use crate::engine::{Engine, EngineError};

pub mod ffmpeg_player;
#[cfg(any(windows, target_os = "macos"))]
pub mod rune_player;

/// The player this OS uses.
#[cfg(any(windows, target_os = "macos"))]
pub use rune_player::new as os_player;
#[cfg(target_os = "linux")]
pub use crate::platform::ffmpeg_proc::preview as os_player;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PreviewState {
    Idle,
    Loading,
    Ready,
    Playing,
    Ended,
    /// The player could not play the file; the words go on the stage.
    Error(String),
}

pub trait Preview: Send {
    fn load(&mut self, path: &Path, duration_hint: Option<f64>);
    fn play(&mut self);
    fn pause(&mut self);
    fn seek(&mut self, seconds: f64);
    fn set_muted(&mut self, muted: bool);
    fn time(&self) -> f64;
    fn duration(&self) -> Option<f64>;
    fn state(&self) -> PreviewState;
    /// Work that must follow the clock (Linux decoding); the app calls it every frame.
    fn pump(&mut self) {}
    /// `stage` with the picture on it.
    fn paint(&self, stage: El) -> El;

    /// A clip opens with its sound on.
    fn open(&mut self, path: &Path, duration_hint: Option<f64>) {
        self.load(path, duration_hint);
        self.set_muted(false);
    }
}

/// A preview that shows nothing: scenes and tests, where no media runs.
#[derive(Default)]
pub struct NullPreview {
    pub log: Vec<String>,
    time: f64,
    playing: bool,
}

impl Preview for NullPreview {
    fn load(&mut self, path: &Path, _: Option<f64>) {
        self.log.push(format!("load({})", path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()));
        (self.time, self.playing) = (0.0, false);
    }
    fn play(&mut self) {
        (self.playing, _) = (true, self.log.push("play".into()));
    }
    fn pause(&mut self) {
        (self.playing, _) = (false, self.log.push("pause".into()));
    }
    fn seek(&mut self, seconds: f64) {
        (self.time, _) = (seconds, self.log.push(format!("seek({seconds})")));
    }
    fn set_muted(&mut self, muted: bool) {
        self.log.push(format!("muted({muted})"));
    }
    fn time(&self) -> f64 {
        self.time
    }
    fn duration(&self) -> Option<f64> {
        None
    }
    fn state(&self) -> PreviewState {
        if self.playing { PreviewState::Playing } else { PreviewState::Ready }
    }
    fn paint(&self, stage: El) -> El {
        stage
    }
}

/// `{clipId}-{updatedAt}.mp4` files under one folder, held to `core::cache`'s rules.
pub struct PreviewCache {
    dir: PathBuf,
    cache: Cache,
    clock: u64,
}

/// A file-name part: the engine's ids and times, without anything a file system refuses.
fn safe(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' }).collect()
}

impl PreviewCache {
    /// Starts empty: files left by an earlier run cannot be told from their names (ids and times
    /// both hold dashes), so they are cleared.
    pub fn new(dir: PathBuf) -> Self {
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
        PreviewCache { dir, cache: Cache::new(CAP_BYTES), clock: 0 }
    }

    /// The local file of `clip`'s current render: kept, or downloaded now. A render that changed
    /// (`updatedAt`) is fetched again and the older file goes.
    pub fn fetch(&mut self, engine: &dyn Engine, clip: &Clip) -> Result<PathBuf, EngineError> {
        let version = clip.updated_at.clone().unwrap_or_else(|| clip.created_at.clone());
        let entry = Entry { clip_id: safe(&clip.id), updated_at: safe(&version), size: 0, played: self.clock };
        self.clock += 1;
        let path = self.dir.join(entry.file_name());
        if self.cache.is_valid(&entry.clip_id, &entry.updated_at) && path.is_file() {
            self.cache.touch(&entry.clip_id, &entry.updated_at, entry.played);
            return Ok(path);
        }
        let size = engine.download_preview(&clip.id, &path)?;
        match self.cache.insert(Entry { size, ..entry }) {
            Inserted::Stored { removed } => {
                for gone in removed.iter().filter(|e| e.file_name() != path.file_name().unwrap().to_string_lossy()) {
                    let _ = std::fs::remove_file(self.dir.join(gone.file_name()));
                }
                Ok(path)
            }
            Inserted::TooLarge => {
                let _ = std::fs::remove_file(&path);
                Err(EngineError::Api { status: 413, message: "This clip is too large to preview here.".into() })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::fake::FakeEngine;

    fn dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("sorot-preview-test-{}-{name}", std::process::id()))
    }

    /// A clip downloads once, is reused while its `updatedAt` matches, and a new render replaces the old file.
    #[test]
    fn the_cache_downloads_once_and_replaces_an_older_render() {
        let engine = FakeEngine::scene("home-empty");
        let mut clip = engine.clips("vnew").unwrap().remove(0);
        let root = dir("cache");
        let mut cache = PreviewCache::new(root.clone());
        let first = cache.fetch(&engine, &clip).unwrap();
        assert_eq!(std::fs::read_to_string(&first).unwrap(), "fake-mp4");
        assert_eq!(cache.fetch(&engine, &clip).unwrap(), first);
        clip.updated_at = Some("2026-11-15T10:00:00.000Z".into());
        let second = cache.fetch(&engine, &clip).unwrap();
        let downloads = engine.calls().iter().filter(|c| c.starts_with("download_preview")).count();
        assert_eq!((downloads, first.exists(), second.exists(), first != second), (2, false, true, true));
        assert!(second.file_name().unwrap().to_string_lossy().ends_with("2026-11-15T10_00_00.000Z.mp4"), "{second:?}");
        engine.fail_once("download_preview", EngineError::Network("down".into()));
        clip.updated_at = Some("3".into());
        assert_eq!(cache.fetch(&engine, &clip), Err(EngineError::Network("down".into())));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_clip_opens_with_its_sound_on() {
        let mut p = NullPreview::default();
        p.open(Path::new("/x/clip.mp4"), None);
        p.play();
        p.seek(3.0);
        p.pause();
        assert_eq!(p.log, ["load(clip.mp4)", "muted(false)", "play", "seek(3)", "pause"]);
        assert_eq!((p.time(), p.duration(), p.state()), (3.0, None, PreviewState::Ready));
        let _ = p.paint(rune::col());
    }
}
