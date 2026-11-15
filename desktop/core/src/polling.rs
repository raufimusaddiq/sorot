//! How often the app asks the engine for state.

use std::time::Duration;

/// 1 s while a job runs, else 5 s.
pub fn next_poll(any_running: bool) -> Duration {
    Duration::from_secs(if any_running { 1 } else { 5 })
}

/// A readiness fix reports progress on `GET /api/readiness`, read once a second.
pub const READINESS_FIX_POLL: Duration = Duration::from_secs(1);

#[cfg(kani)]
mod proofs {
    use super::*;

    #[kani::proof]
    fn poll_is_one_or_five_seconds_and_one_iff_running() {
        let running: bool = kani::any();
        let d = next_poll(running);
        assert!(d == Duration::from_secs(1) || d == Duration::from_secs(5));
        assert_eq!(d == Duration::from_secs(1), running);
    }
}
