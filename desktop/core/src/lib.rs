//! Pure logic of the desktop app: no Rune, no OS. Each module is filled by its own task,
//! with table-driven tests and `#[cfg(kani)]` proofs.

pub mod model;
pub mod handshake;
pub mod engine_conn;
pub mod polling;
pub mod redact;
pub mod toast;
pub mod readiness;
pub mod close;
pub mod workspace;
pub mod job;
pub mod clips;
pub mod cache;
pub mod av_clock;
pub mod contrast;
pub mod theme_gen;
pub mod prefs;
pub mod window;
pub mod palette_search;
pub mod publish_gate;
pub mod availability;
pub mod masked;
pub mod update;
pub mod datetime;
