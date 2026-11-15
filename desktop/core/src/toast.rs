//! A toast: what it says and how long it lives. The timer pauses while the pointer is on it.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToastKind {
    Info,
    Done,
    Failed,
}

/// A button on the toast; `target` is a route the app opens.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToastAction {
    pub label: String,
    pub target: String,
}

pub const LIFETIME_MS: u32 = 6000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Toast {
    pub kind: ToastKind,
    pub text: String,
    pub action: Option<ToastAction>,
    unhovered_ms: u32,
}

impl Toast {
    pub fn new(kind: ToastKind, text: impl Into<String>, action: Option<ToastAction>) -> Self {
        Toast { kind, text: text.into(), action, unhovered_ms: 0 }
    }

    /// `dt_ms` passed; the clock only runs while the toast is not hovered.
    pub fn tick(&mut self, dt_ms: u32, hovered: bool) {
        if !hovered {
            self.unhovered_ms = self.unhovered_ms.saturating_add(dt_ms);
        }
    }

    pub fn expired(&self) -> bool {
        self.unhovered_ms >= LIFETIME_MS
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_clock_runs_only_while_unhovered() {
        let mut t = Toast::new(ToastKind::Done, "Exported", None);
        t.tick(5000, true);
        t.tick(5999, false);
        assert!(!t.expired());
        t.tick(1, false);
        assert!(t.expired());
    }
}

#[cfg(kani)]
mod proofs {
    use super::*;

    #[kani::proof]
    #[kani::unwind(6)]
    fn a_toast_hovered_for_its_whole_life_never_expires() {
        let mut t = Toast::new(ToastKind::Info, "", None);
        for _ in 0..5 {
            t.tick(kani::any(), true);
            assert!(!t.expired());
        }
    }

    #[kani::proof]
    #[kani::unwind(6)]
    fn an_unhovered_toast_expires_by_six_seconds() {
        let mut t = Toast::new(ToastKind::Failed, "", None);
        let mut total: u32 = 0;
        for _ in 0..5 {
            let dt: u16 = kani::any();
            total += dt as u32;
            t.tick(dt as u32, false);
            if total >= LIFETIME_MS {
                assert!(t.expired());
            }
        }
    }
}
