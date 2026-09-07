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
///
/// The release is tied to a guard rather than written after the call, so it
/// still runs if `body` panics on its way out. A release only lowers a
/// reference count, so sending one while a panic unwinds is safe in a way that
/// heavier work in a `Drop` would not be.
///
/// `body` borrows the string for the length of the call and no longer. It may
/// hand the string to Cocoa, which copies or retains whatever it keeps, and it
/// may return some other object, but it must not return this string or store
/// it anywhere that outlives the call.
pub(crate) unsafe fn with_ns_string<R>(text: &str, body: impl FnOnce(id) -> R) -> R {
    struct Owned(id);

    impl Drop for Owned {
        fn drop(&mut self) {
            unsafe {
                let _: () = msg_send![self.0, release];
            }
        }
    }

    let owned = Owned(NSString::alloc(nil).init_str(text));
    body(owned.0)
}
