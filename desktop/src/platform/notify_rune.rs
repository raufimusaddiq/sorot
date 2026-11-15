//! OS shim (Windows, macOS): `rune-notify` toasts. A click comes back as the job id.

use crate::app::{ClickFn, Notifier};

pub fn notifier() -> std::sync::Arc<dyn Notifier> {
    std::sync::Arc::new(RuneNotifier)
}

pub struct RuneNotifier;

impl Notifier for RuneNotifier {
    fn notify(&self, job_id: &str, title: &str, body: &str) {
        rune_notify::post(&rune_notify::Notification::new(job_id, title).body(body).info("job", job_id));
    }

    fn on_click(&self, f: ClickFn) {
        rune_notify::on_click(move |click| {
            if let Some(job) = click.get("job") {
                f(job.to_string());
            }
        });
    }
}
