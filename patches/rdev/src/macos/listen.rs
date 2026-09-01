//! NSEvent-based event listening for macOS.
//!
//! This implementation uses NSEvent.addGlobalMonitorForEvents which only requires
//! Accessibility permission, NOT Input Monitoring permission. This is more
//! privacy-friendly and easier for users to configure.
//!
//! Key-related events may only be monitored if accessibility is enabled or if
//! your application is trusted for accessibility access (see AXIsProcessTrusted()).

#![allow(improper_ctypes_definitions)]
use crate::macos::common::*;
use crate::rdev::{Event, ListenError};
use block::ConcreteBlock;
use cocoa::base::{id, nil};
use cocoa::foundation::NSAutoreleasePool;

static mut GLOBAL_CALLBACK: Option<Box<dyn FnMut(Event)>> = None;
static mut GLOBAL_MONITOR: id = nil;

// NSEvent mask constants (as bit flags)
#[allow(non_upper_case_globals)]
const NSEventMaskLeftMouseDown: u64 = 1 << 1;
#[allow(non_upper_case_globals)]
const NSEventMaskLeftMouseUp: u64 = 1 << 2;
#[allow(non_upper_case_globals)]
const NSEventMaskRightMouseDown: u64 = 1 << 3;
#[allow(non_upper_case_globals)]
const NSEventMaskRightMouseUp: u64 = 1 << 4;
#[allow(non_upper_case_globals)]
const NSEventMaskMouseMoved: u64 = 1 << 5;
#[allow(non_upper_case_globals)]
const NSEventMaskLeftMouseDragged: u64 = 1 << 6;
#[allow(non_upper_case_globals)]
const NSEventMaskRightMouseDragged: u64 = 1 << 7;
#[allow(non_upper_case_globals)]
const NSEventMaskKeyDown: u64 = 1 << 10;
#[allow(non_upper_case_globals)]
const NSEventMaskKeyUp: u64 = 1 << 11;
#[allow(non_upper_case_globals)]
const NSEventMaskFlagsChanged: u64 = 1 << 12;
#[allow(non_upper_case_globals)]
const NSEventMaskScrollWheel: u64 = 1 << 22;
#[allow(non_upper_case_globals)]
const NSEventMaskOtherMouseDown: u64 = 1 << 25;
#[allow(non_upper_case_globals)]
const NSEventMaskOtherMouseUp: u64 = 1 << 26;
#[allow(non_upper_case_globals)]
const NSEventMaskOtherMouseDragged: u64 = 1 << 27;

// Combined mask for all events
#[allow(non_upper_case_globals)]
const NSEventMaskAny: u64 = NSEventMaskLeftMouseDown
    | NSEventMaskLeftMouseUp
    | NSEventMaskRightMouseDown
    | NSEventMaskRightMouseUp
    | NSEventMaskMouseMoved
    | NSEventMaskLeftMouseDragged
    | NSEventMaskRightMouseDragged
    | NSEventMaskKeyDown
    | NSEventMaskKeyUp
    | NSEventMaskFlagsChanged
    | NSEventMaskScrollWheel
    | NSEventMaskOtherMouseDown
    | NSEventMaskOtherMouseUp
    | NSEventMaskOtherMouseDragged;

// Keyboard only mask
#[allow(non_upper_case_globals)]
const NSEventMaskKeyboard: u64 = NSEventMaskKeyDown | NSEventMaskKeyUp | NSEventMaskFlagsChanged;

/// Process an NSEvent and convert it to our Event type
unsafe fn process_ns_event(ns_event: id) {
    if ns_event == nil {
        return;
    }

    if let Ok(mut state) = KEYBOARD_STATE.lock() {
        if let Some(keyboard) = state.as_mut() {
            if let Some(event) = convert_ns_event(ns_event, keyboard) {
                if let Some(callback) = &mut GLOBAL_CALLBACK {
                    callback(event);
                }
            }
        }
    }
}

/// Starts listening for global events using NSEvent.addGlobalMonitorForEvents.
///
/// This function only requires Accessibility permission, NOT Input Monitoring permission.
/// Key-related events may only be monitored if accessibility is enabled or if
/// your application is trusted for accessibility access.
///
/// Note: Your handler will NOT be called for events that are sent to your own application.
/// This is a limitation of NSEvent global monitors.
pub fn listen<T>(callback: T) -> Result<(), ListenError>
where
    T: FnMut(Event) + 'static,
{
    unsafe {
        GLOBAL_CALLBACK = Some(Box::new(callback));
        let _pool = NSAutoreleasePool::new(nil);

        // Determine which events to monitor
        let mask = if crate::keyboard_only() {
            NSEventMaskKeyboard
        } else {
            NSEventMaskAny
        };

        // Use block-based API via objc
        let monitor = add_global_monitor_for_events(mask)?;
        GLOBAL_MONITOR = monitor;

        // Run the main run loop
        CFRunLoopRun();
    }
    Ok(())
}

/// Stop listening and remove the monitor
#[allow(dead_code)]
pub fn stop_listen() {
    unsafe {
        if GLOBAL_MONITOR != nil {
            let _: () = msg_send![class!(NSEvent), removeMonitor: GLOBAL_MONITOR];
            GLOBAL_MONITOR = nil;
        }
        CFRunLoopStop(CFRunLoopGetMain());
    }
}

/// Add a global monitor for events using NSEvent.addGlobalMonitorForEvents
unsafe fn add_global_monitor_for_events(mask: u64) -> Result<id, ListenError> {
    // Create a block that will be called for each event
    let block = ConcreteBlock::new(move |event: id| {
        process_ns_event(event);
    });
    let block = block.copy();

    let monitor: id = msg_send![
        class!(NSEvent),
        addGlobalMonitorForEventsMatchingMask: mask
        handler: &*block
    ];

    if monitor == nil {
        return Err(ListenError::EventTapError);
    }

    // Keep the block alive for the duration of the program
    std::mem::forget(block);

    Ok(monitor)
}
