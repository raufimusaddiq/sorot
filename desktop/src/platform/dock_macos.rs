//! OS shim: the Dock icon's badge as text, "42%" while a job runs. Rune's badge is a count and
//! the Dock has no bar. Main thread only (the app's state runs there). Out of coverage.

use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use objc2_foundation::NSString;

use crate::session::{Progress, Taskbar};

pub struct OsDock;

impl Taskbar for OsDock {
    fn set(&self, progress: Progress) {
        let label = match progress {
            Progress::None => None,
            Progress::Busy => Some(NSString::from_str("...")),
            Progress::Percent(p) => Some(NSString::from_str(&format!("{p}%"))),
        };
        // SAFETY: AppKit's Dock tile on the main thread; a nil label clears the badge.
        unsafe {
            let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            let tile: *mut AnyObject = msg_send![app, dockTile];
            let label: *const AnyObject = label.as_deref().map_or(std::ptr::null(), |l| (l as *const NSString).cast());
            if !tile.is_null() {
                let _: () = msg_send![tile, setBadgeLabel: label];
            }
        }
    }
}
