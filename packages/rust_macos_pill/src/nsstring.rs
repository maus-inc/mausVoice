//! Temporary Foundation strings.
//!
//! `NSString::alloc(nil).init_str(...)` is an alloc and init pair, so this
//! process owns the string that comes back and has to release it. Cocoa calls
//! that take a string keep their own copy or retain what they need, so the
//! local reference is finished as soon as the call returns. The pill draws
//! text on every frame, so a string left unreleased here grows for as long as
//! the app runs.

use cocoa::base::{id, nil};
use cocoa::foundation::NSString;
use objc::{msg_send, sel, sel_impl};

/// Run `body` with a temporary `NSString` holding `text`, then release it.
pub(crate) unsafe fn with_ns_string<R>(text: &str, body: impl FnOnce(id) -> R) -> R {
    let ns: id = NSString::alloc(nil).init_str(text);
    let result = body(ns);
    let _: () = msg_send![ns, release];
    result
}
