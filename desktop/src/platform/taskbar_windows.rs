//! OS shim: progress on the Windows taskbar button. Rune's taskbar has only a bar with no end;
//! this sets the percent through `ITaskbarList3`, on a thread of its own that owns the COM
//! object. Out of coverage (coverage-exclude.txt).

use std::sync::Mutex;
use std::sync::mpsc::{Sender, channel};

use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx};
use windows::Win32::UI::Shell::{ITaskbarList3, TBPF_INDETERMINATE, TBPF_NOPROGRESS, TBPF_NORMAL, TaskbarList};

use crate::session::{Progress, Taskbar};

pub struct OsTaskbar(Mutex<Sender<(isize, Progress)>>);

impl OsTaskbar {
    pub fn start() -> Self {
        let (to, from) = channel::<(isize, Progress)>();
        let _ = std::thread::Builder::new().name("sorot-taskbar".into()).spawn(move || {
            // SAFETY: this thread's own apartment; the object is used only here.
            let list: Option<ITaskbarList3> = unsafe {
                CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok().then(|| CoCreateInstance(&TaskbarList, None, CLSCTX_INPROC_SERVER).ok()).flatten()
            };
            while let (Ok((hwnd, progress)), Some(list)) = (from.recv(), &list) {
                let hwnd = HWND(hwnd as *mut _);
                // SAFETY: the shell's own calls on a window handle that may have gone; errors are ignored.
                let _ = unsafe {
                    match progress {
                        Progress::None => list.SetProgressState(hwnd, TBPF_NOPROGRESS),
                        Progress::Busy => list.SetProgressState(hwnd, TBPF_INDETERMINATE),
                        Progress::Percent(p) => list.SetProgressState(hwnd, TBPF_NORMAL).and_then(|()| list.SetProgressValue(hwnd, u64::from(p), 100)),
                    }
                };
            }
        });
        OsTaskbar(Mutex::new(to))
    }
}

impl Taskbar for OsTaskbar {
    fn set(&self, progress: Progress) {
        let hwnd = super::window_state::window().and_then(|w| {
            w.with_raw_handle(|h| match h.as_raw() {
                raw_window_handle::RawWindowHandle::Win32(w) => Some(w.hwnd.get()),
                _ => None,
            })
            .ok()
            .flatten()
        });
        if let Some(hwnd) = hwnd {
            let _ = self.0.lock().unwrap_or_else(|e| e.into_inner()).send((hwnd, progress));
        }
    }
}
