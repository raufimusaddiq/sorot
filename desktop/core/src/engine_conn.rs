//! The connection to the engine as a state machine. The app feeds it what it sees (a ready line,
//! an exit, a health check, a 401) and acts on the state it lands in.
//!
//! `Starting -> Ready -> (Lost -> Restarting -> Ready) | Stopping -> Stopped`, and `Failed` when
//! the engine exits before `SOROT_READY` or within 10 s, after 2 automatic restarts, or on a
//! second 401.

pub const MAX_AUTO_RESTARTS: u8 = 2;
/// An engine that exits sooner than this after it was ready is a crash on start, not a loss.
pub const EARLY_EXIT_SECS: u32 = 10;
/// Health checks in a row that fail before the engine counts as lost.
pub const LOST_AFTER_FAILS: u8 = 3;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FailReason {
    ExitedBeforeReady,
    ExitedEarly,
    StartTimeout,
    EngineTooNew,
    TooManyRestarts,
    Unauthorized,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum State {
    Starting,
    Ready { port: u16, version: String },
    Lost,
    Restarting,
    Stopping,
    Stopped,
    Failed(FailReason),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    /// The `SOROT_READY` line was read.
    Ready { port: u16, version: String },
    /// The engine process ended, `uptime_secs` after it was ready (0 when it never was).
    Exited { uptime_secs: u32 },
    /// 30 s passed without a ready line.
    StartTimeout,
    /// The ready line names a newer `api` than the app speaks.
    TooNew,
    HealthOk,
    HealthFailed,
    /// An API call answered 401.
    Unauthorized,
    /// The app reacts to `Lost`: restart if it may.
    Recover,
    /// The user pressed "Restart engine" on a failed connection.
    UserRestart,
    /// The user quit the app.
    Quit,
    /// The engine process is gone after a quit.
    Gone,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EngineConn {
    pub state: State,
    pub restarts: u8,
    fails: u8,
    auth_restarted: bool,
}

impl Default for EngineConn {
    fn default() -> Self {
        EngineConn { state: State::Starting, restarts: 0, fails: 0, auth_restarted: false }
    }
}

impl EngineConn {
    pub fn apply(&mut self, event: Event) {
        use Event as E;
        use State as S;
        match (&self.state, event) {
            (S::Stopped, _) => {}
            (_, E::Quit) => self.state = S::Stopping,
            (S::Stopping, E::Gone) => self.state = S::Stopped,
            (S::Stopping, _) => {}
            (S::Failed(_), E::UserRestart) => *self = EngineConn { state: S::Restarting, ..EngineConn::default() },
            (S::Failed(_), _) => {}
            (S::Starting | S::Restarting, E::Ready { port, version }) => {
                self.fails = 0;
                self.state = S::Ready { port, version };
            }
            (S::Starting | S::Restarting, E::Exited { .. }) => self.state = S::Failed(FailReason::ExitedBeforeReady),
            (S::Starting | S::Restarting, E::TooNew) => self.state = S::Failed(FailReason::EngineTooNew),
            (S::Starting | S::Restarting, E::StartTimeout) => self.state = S::Failed(FailReason::StartTimeout),
            (S::Ready { .. }, E::HealthOk) => self.fails = 0,
            (S::Ready { .. }, E::HealthFailed) => {
                self.fails += 1;
                if self.fails >= LOST_AFTER_FAILS {
                    self.fails = 0;
                    self.state = S::Lost;
                }
            }
            (S::Ready { .. }, E::Exited { uptime_secs }) => {
                self.state = if uptime_secs < EARLY_EXIT_SECS { S::Failed(FailReason::ExitedEarly) } else { S::Lost };
            }
            (S::Ready { .. }, E::Unauthorized) => {
                if self.auth_restarted {
                    self.state = S::Failed(FailReason::Unauthorized);
                } else {
                    self.auth_restarted = true;
                    self.restart();
                }
            }
            (S::Lost, E::Recover) => self.restart(),
            _ => {}
        }
    }

    fn restart(&mut self) {
        if self.restarts < MAX_AUTO_RESTARTS {
            self.restarts += 1;
            self.state = State::Restarting;
        } else {
            self.state = State::Failed(FailReason::TooManyRestarts);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use Event as E;

    fn ready() -> Event {
        E::Ready { port: 9, version: "1".into() }
    }

    fn run(events: Vec<Event>) -> EngineConn {
        let mut c = EngineConn::default();
        for e in events {
            c.apply(e);
        }
        c
    }

    #[test]
    fn event_sequences_end_in_the_expected_state() {
        let lost = || vec![ready(), E::HealthFailed, E::HealthFailed, E::HealthFailed, E::Recover];
        let cases: Vec<(&str, Vec<Event>, State, u8)> = vec![
            ("ready", vec![ready()], State::Ready { port: 9, version: "1".into() }, 0),
            ("exit before ready", vec![E::Exited { uptime_secs: 0 }], State::Failed(FailReason::ExitedBeforeReady), 0),
            ("no line in 30 s", vec![E::StartTimeout], State::Failed(FailReason::StartTimeout), 0),
            ("a newer engine", vec![E::TooNew], State::Failed(FailReason::EngineTooNew), 0),
            ("crash within 10 s", vec![ready(), E::Exited { uptime_secs: 3 }], State::Failed(FailReason::ExitedEarly), 0),
            ("a late exit is a loss", vec![ready(), E::Exited { uptime_secs: 60 }], State::Lost, 0),
            ("two failed checks recover", vec![ready(), E::HealthFailed, E::HealthFailed, E::HealthOk, E::HealthFailed], State::Ready { port: 9, version: "1".into() }, 0),
            ("three failed checks restart", lost(), State::Restarting, 1),
            ("restarted and ready again", [lost(), vec![ready()]].concat(), State::Ready { port: 9, version: "1".into() }, 1),
            ("a third loss fails", [lost(), vec![ready()], lost(), vec![ready()], lost()].concat(), State::Failed(FailReason::TooManyRestarts), 2),
            ("a 401 restarts once", vec![ready(), E::Unauthorized], State::Restarting, 1),
            ("a second 401 fails", vec![ready(), E::Unauthorized, ready(), E::Unauthorized], State::Failed(FailReason::Unauthorized), 1),
            ("the user restarts a failure", vec![E::StartTimeout, E::UserRestart], State::Restarting, 0),
            ("quit then gone", vec![ready(), E::Quit, ready(), E::Gone, ready(), E::Quit], State::Stopped, 0),
        ];
        for (name, events, state, restarts) in cases {
            let c = run(events);
            assert_eq!((c.state, c.restarts), (state, restarts), "{name}");
        }
    }
}

#[cfg(kani)]
mod proofs {
    use super::*;

    fn any_event() -> Event {
        match kani::any::<u8>() % 11 {
            0 => Event::Ready { port: kani::any(), version: String::new() },
            1 => Event::Exited { uptime_secs: kani::any() },
            2 => Event::StartTimeout,
            3 => Event::HealthOk,
            4 => Event::HealthFailed,
            5 => Event::Unauthorized,
            6 => Event::Recover,
            7 => Event::UserRestart,
            8 => Event::Quit,
            9 => Event::TooNew,
            _ => Event::Gone,
        }
    }

    #[kani::proof]
    #[kani::unwind(10)]
    fn restarts_stay_in_budget_and_stopping_never_comes_back() {
        let mut c = EngineConn::default();
        let mut leaving = false;
        let mut stopped = false;
        for _ in 0..8 {
            c.apply(any_event());
            assert!(c.restarts <= MAX_AUTO_RESTARTS);
            leaving |= matches!(c.state, State::Stopping | State::Stopped);
            if leaving {
                assert!(matches!(c.state, State::Stopping | State::Stopped));
            }
            if stopped {
                assert_eq!(c.state, State::Stopped);
            }
            stopped |= c.state == State::Stopped;
        }
    }
}
