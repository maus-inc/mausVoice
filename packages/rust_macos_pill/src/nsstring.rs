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
/// may return some other object, but it may keep this string past the call
/// only by retaining one of its own first.
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

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::panic::{catch_unwind, AssertUnwindSafe};

    use super::*;

    /// Long enough that Foundation cannot pack it into a tagged pointer, so
    /// the string under test is a real object with a real reference count.
    const TEXT: &str = "a string far too long for a tagged pointer to hold";

    /// One reference left means the helper released the one it created.
    unsafe fn count_and_release(ns: id) -> usize {
        let count: usize = msg_send![ns, retainCount];
        let _: () = msg_send![ns, release];
        count
    }

    #[test]
    fn releases_the_string_after_the_body_returns() {
        unsafe {
            // The closure takes a reference of its own, so the string outlives
            // the helper and its count can still be read here.
            let ns = with_ns_string(TEXT, |ns| {
                let _: () = msg_send![ns, retain];
                ns
            });

            assert_eq!(count_and_release(ns), 1);
        }
    }

    #[test]
    fn releases_the_string_when_the_body_panics() {
        let kept: Cell<id> = Cell::new(nil);

        let outcome: std::thread::Result<()> = catch_unwind(AssertUnwindSafe(|| unsafe {
            with_ns_string(TEXT, |ns| {
                let _: () = msg_send![ns, retain];
                kept.set(ns);
                panic!("the body gave up");
            })
        }));

        assert!(outcome.is_err());
        unsafe {
            assert_eq!(count_and_release(kept.get()), 1);
        }
    }
}
