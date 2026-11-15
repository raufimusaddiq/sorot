//! What closing the window does, from the running jobs and the saved preference.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClosePref {
    Ask,
    Background,
    Quit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseAction {
    AskDialog,
    HideKeepRunning,
    Quit,
    QuitCancelJobs,
}

pub fn on_close(running_jobs: usize, pref: ClosePref) -> CloseAction {
    match (pref, running_jobs) {
        (ClosePref::Background, _) => CloseAction::HideKeepRunning,
        (ClosePref::Ask | ClosePref::Quit, 0) => CloseAction::Quit,
        (ClosePref::Ask, _) => CloseAction::AskDialog,
        (ClosePref::Quit, _) => CloseAction::QuitCancelJobs,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn close_table() {
        use CloseAction as A;
        use ClosePref as P;
        for (jobs, pref, want) in [
            (0, P::Ask, A::Quit), (2, P::Ask, A::AskDialog), (0, P::Background, A::HideKeepRunning),
            (2, P::Background, A::HideKeepRunning), (0, P::Quit, A::Quit), (2, P::Quit, A::QuitCancelJobs),
        ] {
            assert_eq!(on_close(jobs, pref), want, "{jobs} {pref:?}");
        }
    }
}

#[cfg(kani)]
mod proofs {
    use super::*;

    #[kani::proof]
    fn never_quits_while_jobs_run_and_pref_is_ask() {
        let jobs: usize = kani::any();
        kani::assume(jobs > 0);
        assert_eq!(on_close(jobs, ClosePref::Ask), CloseAction::AskDialog);
    }

    #[kani::proof]
    fn a_silent_quit_means_no_jobs() {
        let jobs: usize = kani::any();
        let pref = match kani::any::<u8>() % 3 {
            0 => ClosePref::Ask,
            1 => ClosePref::Background,
            _ => ClosePref::Quit,
        };
        if on_close(jobs, pref) == CloseAction::Quit {
            assert_eq!(jobs, 0);
        }
    }
}
