//! OS shim: Finder's "Open With" on macOS arrives as an Apple Event (`aevt`/`odoc`) that winit
//! does not forward. Each file goes to the app as `Msg::OpenFile`. Out of coverage.

use std::path::PathBuf;
use std::sync::OnceLock;

use objc2::runtime::{AnyClass, AnyObject, ClassBuilder, NSObject, Sel};
use objc2::{ClassType, class, msg_send, sel};
use objc2_foundation::NSString;

use crate::app::{Msg, State};

type Sink = Box<dyn Fn(PathBuf) + Send + Sync>;
static SINK: OnceLock<Sink> = OnceLock::new();
const AEVT: u32 = u32::from_be_bytes(*b"aevt");
const ODOC: u32 = u32::from_be_bytes(*b"odoc");
const DIRECT: u32 = u32::from_be_bytes(*b"----");
const FURL: u32 = u32::from_be_bytes(*b"furl");

extern "C" fn open_documents(_: &AnyObject, _: Sel, event: *mut AnyObject, _reply: *mut AnyObject) {
    // SAFETY: AppKit passes the event; every message below is nil-safe.
    unsafe {
        let list: *mut AnyObject = msg_send![event, paramDescriptorForKeyword: DIRECT];
        let n: isize = msg_send![list, numberOfItems];
        for i in 1..=n {
            let item: *mut AnyObject = msg_send![list, descriptorAtIndex: i];
            let url: *mut AnyObject = msg_send![item, coerceToDescriptorType: FURL];
            let text: *mut NSString = msg_send![url, stringValue];
            let nsurl: *mut AnyObject = msg_send![class!(NSURL), URLWithString: text];
            let path: *mut NSString = msg_send![nsurl, path];
            if let (Some(sink), Some(path)) = (SINK.get(), path.as_ref()) {
                sink(PathBuf::from(path.to_string()));
            }
        }
    }
}

/// Takes over the open-documents event once the app is running (its own handler is set at launch).
pub fn install(handle: rune::AppHandle<State>) {
    if SINK.set(Box::new(move |p| handle.update(move |s: &mut State, _: &mut rune::Tx| s.apply(Msg::OpenFile(p))))).is_err() {
        return;
    }
    let name = "SorotOpenDocuments";
    let Some(class) = AnyClass::get(name).or_else(|| {
        let mut b = ClassBuilder::new(name, NSObject::class())?;
        // SAFETY: matches `handleOpenDocuments:withReplyEvent:` (two objects, void).
        unsafe { b.add_method(sel!(handleOpenDocuments:withReplyEvent:), open_documents as extern "C" fn(_, _, _, _)) };
        Some(b.register())
    }) else { return };
    // SAFETY: the handler object lives for the process; the manager is the shared one.
    unsafe {
        let handler: *mut AnyObject = msg_send![class, new];
        let manager: *mut AnyObject = msg_send![class!(NSAppleEventManager), sharedAppleEventManager];
        let _: () = msg_send![manager, setEventHandler: handler, andSelector: sel!(handleOpenDocuments:withReplyEvent:), forEventClass: AEVT, andEventID: ODOC];
    }
}
