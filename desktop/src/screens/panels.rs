//! What the panel screens (settings, publish, learning, discover) share: their state in one place,
//! and `Host`, the little the app must give them. A screen never reaches into the app itself, so
//! its own tests run it against a stand-in host.

use std::sync::Arc;

use crate::engine::{Engine, EngineError};
use crate::screens::{discover, feedback, learning, publish, settings};

/// What a worker hands back: a change to the panels, applied on the UI thread.
pub type Apply = Box<dyn FnOnce(&mut Panels) + Send>;

/// Engine work: runs off the UI thread and answers with an `Apply`.
pub type Work = Box<dyn FnOnce(&dyn Engine) -> Apply + Send>;

/// The state of every panel screen. The app holds one.
#[derive(Default)]
pub struct Panels {
    pub connections: settings::connections::Connections,
    pub generate: settings::generate::GenerateSettings,
    pub publish: publish::Publish,
    pub learning: learning::Learning,
    pub feedback: feedback::Sheet,
    pub discover: discover::Discover,
    /// App clock of the last look at a running calibration or auto run.
    pub polled: f64,
}

/// The panel pages a tab or the rail can open.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Page {
    Connections,
    GenerateSettings,
    Learning,
    Discover,
}

/// What a panel screen needs from the app.
pub trait Host: 'static {
    fn panels(&self) -> &Panels;
    fn panels_mut(&mut self) -> &mut Panels;
    fn dark(&self) -> bool;
    fn engine(&self) -> Option<Arc<dyn Engine>>;
    /// Runs `work` against the engine off the UI thread (inline in a test) and applies its answer.
    fn run(&mut self, work: Work);
    /// Goes to a page and reads what it shows.
    fn show(&mut self, page: Page);
}

/// Starts `work` through the host.
pub fn go<H: Host>(h: &mut H, work: impl FnOnce(&dyn Engine) -> Apply + Send + 'static) {
    h.run(Box::new(work));
}

/// `result` as an `Apply`: `done` gets the data, or the engine's words.
pub fn answer<T: Send + 'static>(result: Result<T, EngineError>, done: impl FnOnce(&mut Panels, Result<T, String>) + Send + 'static) -> Apply {
    let result = result.map_err(|e| e.to_string());
    Box::new(move |p| done(p, result))
}

/// Where a screen's data is.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum Load {
    #[default]
    Idle,
    Loading,
    Ready,
    Failed(String),
}

impl Load {
    pub fn of<T>(r: &Result<T, String>) -> Load {
        match r {
            Ok(_) => Load::Ready,
            Err(e) => Load::Failed(e.clone()),
        }
    }
}
