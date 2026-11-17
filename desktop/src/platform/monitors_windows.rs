//! OS shim: the monitors Windows has now, primary first. Out of coverage (coverage-exclude.txt).

use sorot_desktop_core::window::Rect;
use windows_sys::Win32::Foundation::{LPARAM, RECT};
use windows_sys::Win32::Graphics::Gdi::{EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO};

unsafe extern "system" fn each(m: HMONITOR, _: HDC, _: *mut RECT, out: LPARAM) -> i32 {
    // SAFETY: `out` is the list `monitors` passed; `info` is sized as the call needs.
    let (list, mut info) = unsafe { (&mut *(out as *mut Vec<(bool, Rect)>), std::mem::zeroed::<MONITORINFO>()) };
    info.cbSize = size_of::<MONITORINFO>() as u32;
    if unsafe { GetMonitorInfoW(m, &mut info) } != 0 {
        let r = info.rcMonitor;
        list.push((info.dwFlags & 1 == 0, Rect { x: r.left, y: r.top, w: (r.right - r.left) as u32, h: (r.bottom - r.top) as u32 }));
    }
    1
}

pub fn monitors() -> Vec<Rect> {
    let mut list: Vec<(bool, Rect)> = vec![];
    // SAFETY: the callback runs before this returns and only touches `list`.
    unsafe { EnumDisplayMonitors(std::ptr::null_mut(), std::ptr::null(), Some(each), &mut list as *mut _ as LPARAM) };
    list.sort_by_key(|(secondary, _)| *secondary);
    list.into_iter().map(|(_, r)| r).collect()
}
