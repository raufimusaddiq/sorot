//! What the app carries from one launch to the next and what the OS hands it: the view it was
//! on, videos sent by "Open with Sorot", and the progress the taskbar shows.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sorot_desktop_core::job::JobView;

use crate::app::{Msg, Route, State};
use crate::screens::home::is_video;
use crate::screens::panels::{Host, Page};

/// The reverse-DNS name of the app: the single-instance claim and the prefs folder.
pub const APP_ID: &str = "io.github.raufimusaddiq.sorot";

/// Where the window was closed: `lastView` and `lastJobId` of the window state.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewMemory {
    pub last_view: String,
    #[serde(default)]
    pub last_job_id: Option<String>,
}

impl State {
    /// The view to come back to. A clip, editor or publish screen comes back as Home: what they
    /// hold is not saved.
    pub fn view_memory(&self) -> ViewMemory {
        let (view, job) = match &self.route {
            Route::Job(id) => ("job", Some(id.clone())),
            Route::General => ("general", None),
            Route::Connections => ("connections", None),
            Route::GenerateSettings => ("generate-settings", None),
            Route::Learning => ("learning", None),
            Route::Discover => ("discover", None),
            Route::Generate => ("generate", None),
            Route::Home | Route::Clips(_) | Route::Editor(_) | Route::Publish(_) => ("home", None),
        };
        ViewMemory { last_view: view.into(), last_job_id: job }
    }

    pub fn with_view(mut self, memory: ViewMemory) -> Self {
        self.pending_view = Some(memory);
        self
    }

    /// Back to the saved view, once: a job that is gone, or a view that is not known, stays on Home.
    /// Runs when the engine first answers, so the job can be looked for; a person who already
    /// moved on is left where they are.
    pub(crate) fn restore_view(&mut self) {
        let Some(memory) = self.pending_view.take() else { return };
        if self.route != Route::Home {
            return;
        }
        match memory.last_view.as_str() {
            "job" => {
                if let Some(id) = memory.last_job_id.filter(|id| self.jobs.iter().any(|j| j.id == *id)) {
                    self.open_job(&id);
                }
            }
            "general" => self.show(Page::General),
            "connections" => self.show(Page::Connections),
            "generate-settings" => self.show(Page::GenerateSettings),
            "learning" => self.show(Page::Learning),
            "discover" => self.show(Page::Discover),
            "generate" => self.show(Page::Generate),
            _ => {}
        }
    }

    /// A video the OS opened with Sorot: Home shows it as the file to import, with the options
    /// beside it. Anything that is not a video says so instead.
    pub fn open_file(&mut self, path: PathBuf) {
        self.route = Route::Home;
        if is_video(&path) {
            self.home.error = None;
            self.home.opened = Some(path);
        } else {
            self.home.opened = None;
            self.home.error = Some(crate::screens::home::HomeError::File(path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()));
        }
        if let Some(h) = &self.handle {
            h.show();
            h.focus();
        }
    }

    /// Reads what other launches left for this window, at most once a second.
    pub(crate) fn take_opened(&mut self, t: f64) -> bool {
        let Some(dir) = self.config_dir.clone().filter(|_| t - self.opened_polled >= 1.0) else { return false };
        self.opened_polled = t;
        let files = take_open(&dir);
        let any = !files.is_empty();
        files.into_iter().for_each(|f| self.apply(Msg::OpenFile(f)));
        any
    }

    /// What the taskbar shows now: the open job's share of stages done, else a bar with no end
    /// while something runs, else nothing.
    pub fn progress(&self) -> Progress {
        match self.job.detail.as_ref().filter(|d| d.job.is_running()) {
            Some(d) => Progress::Percent(JobView::from_detail(d).percent),
            None if self.running_jobs() > 0 => Progress::Busy,
            None => Progress::None,
        }
    }

    /// Hands the taskbar what changed, and only that.
    pub(crate) fn sync_taskbar(&mut self) {
        let now = self.progress();
        if let Some(bar) = self.taskbar.clone().filter(|_| now != self.taskbar_shown) {
            bar.set(now);
            self.taskbar_shown = now;
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Progress {
    #[default]
    None,
    /// Running, with no share known.
    Busy,
    Percent(u8),
}

/// The progress on the app's taskbar button (Windows) or Dock icon (macOS).
pub trait Taskbar: Send + Sync {
    fn set(&self, progress: Progress);
}

/// Linux has no taskbar progress; the app shows it inside.
pub struct NoTaskbar;

impl Taskbar for NoTaskbar {
    fn set(&self, _: Progress) {}
}

const QUEUE: &str = "open-with.txt";

/// A launch with video paths leaves them for the window that runs: one path a line.
pub fn leave_open(dir: &Path, paths: &[PathBuf]) {
    use std::io::Write;
    let _ = std::fs::create_dir_all(dir);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join(QUEUE)) {
        for p in paths {
            let _ = writeln!(f, "{}", p.display());
        }
    }
}

/// What launches left, taken (renamed first, so a launch writing now is not lost).
pub fn take_open(dir: &Path) -> Vec<PathBuf> {
    let taking = dir.join(format!("{QUEUE}.taking"));
    if std::fs::rename(dir.join(QUEUE), &taking).is_err() {
        return vec![];
    }
    let text = std::fs::read_to_string(&taking).unwrap_or_default();
    let _ = std::fs::remove_file(&taking);
    text.lines().filter(|l| !l.is_empty()).map(PathBuf::from).collect()
}

/// The paths among a launch's arguments. Rune's own tooling flags start with `--`; a launch
/// with one is a headless run and neither forwards nor claims the app.
pub fn launch_paths(args: &[String]) -> Option<Vec<PathBuf>> {
    if args.iter().any(|a| a.starts_with("--")) {
        return None;
    }
    Some(args.iter().map(PathBuf::from).collect())
}

/// The videos among any arguments, flags and their values left out: what a headless run was
/// "opened with".
pub fn argv_videos(args: &[String]) -> Vec<PathBuf> {
    args.iter().map(PathBuf::from).filter(|p| is_video(p)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_launches_leave_is_taken_once_in_order() {
        let dir = std::env::temp_dir().join(format!("sorot-open-{}", std::process::id()));
        assert!(take_open(&dir).is_empty());
        leave_open(&dir, &["a.mp4".into()]);
        leave_open(&dir, &["b c.mkv".into(), "d.mov".into()]);
        assert_eq!(take_open(&dir), [PathBuf::from("a.mp4"), "b c.mkv".into(), "d.mov".into()]);
        assert!(take_open(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_launch_with_tooling_flags_is_headless() {
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(launch_paths(&args(&["--snap", "x.png"])), None);
        assert_eq!(launch_paths(&args(&["talk.mp4"])), Some(vec!["talk.mp4".into()]));
        assert_eq!(launch_paths(&[]), Some(vec![]));
        assert_eq!(argv_videos(&args(&["--scene", "home-empty", "C:/v/talk.MKV", "x.png"])), [PathBuf::from("C:/v/talk.MKV")]);
    }
}
