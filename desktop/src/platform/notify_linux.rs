//! OS shim (Linux): desktop notifications through `notify-rust`. A click comes back as the job id.

use std::sync::Mutex;

use crate::app::{ClickFn, Notifier};

pub fn notifier() -> std::sync::Arc<dyn Notifier> {
    std::sync::Arc::new(LinuxNotifier::default())
}

#[derive(Default)]
pub struct LinuxNotifier {
    on_click: Mutex<Option<ClickFn>>,
}

impl Notifier for LinuxNotifier {
    fn notify(&self, job_id: &str, title: &str, body: &str) {
        let (title, body, job) = (title.to_string(), body.to_string(), job_id.to_string());
        let click = self.on_click.lock().unwrap().clone();
        std::thread::spawn(move || {
            let shown = notify_rust::Notification::new().summary(&title).body(&body).action("default", "Open").show();
            if let (Ok(handle), Some(click)) = (shown, click) {
                handle.wait_for_action(|action| if action == "default" { click(job.clone()) });
            }
        });
    }

    fn on_click(&self, f: ClickFn) {
        *self.on_click.lock().unwrap() = Some(f);
    }
}
