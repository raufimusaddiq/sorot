//! The engine's process tree on POSIX: its own process group, ended as one.

use std::os::unix::process::CommandExt;
use std::process::{Child, Command};
use std::time::{Duration, Instant};

/// The group id (the child's pid, since it leads its own group).
pub struct Guard(i32);

pub fn prepare(cmd: &mut Command) {
    cmd.process_group(0);
}

pub fn adopt(child: &Child) -> Guard {
    Guard(child.id() as i32)
}

/// SIGTERM to the group, then SIGKILL after 5 s if anything is left.
pub fn terminate(guard: &Guard, child: &mut Child) {
    // SAFETY: signalling a process group is memory-safe; a gone group answers ESRCH.
    unsafe { libc::killpg(guard.0, libc::SIGTERM) };
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    // SAFETY: as above.
    unsafe { libc::killpg(guard.0, libc::SIGKILL) };
    let _ = child.wait();
}
