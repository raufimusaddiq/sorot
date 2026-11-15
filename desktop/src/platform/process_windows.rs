//! The engine's process tree on Windows: one Job Object that kills everything when it closes.

use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::process::{Child, Command};

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Owns the job. Closing it (drop, or the app dying) ends every process in it.
pub struct Guard(HANDLE);

// SAFETY: a job handle may be used from any thread.
unsafe impl Send for Guard {}

pub fn prepare(cmd: &mut Command) {
    cmd.creation_flags(CREATE_NO_WINDOW);
}

pub fn adopt(child: &Child) -> Guard {
    // SAFETY: plain Win32 calls on handles this function creates or the live child owns.
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(job, JobObjectExtendedLimitInformation, (&raw const info).cast(), size_of_val(&info) as u32);
        AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE);
        Guard(job)
    }
}

pub fn terminate(guard: &Guard, _child: &mut Child) {
    // SAFETY: the handle is the job `adopt` made.
    unsafe { TerminateJobObject(guard.0, 1) };
}

impl Drop for Guard {
    fn drop(&mut self) {
        // SAFETY: closing the handle is what kills the tree.
        unsafe { CloseHandle(self.0) };
    }
}
