//! Platform-independent mock FFI tests for the macOS capture callback.
#![allow(non_snake_case, non_camel_case_types, dead_code)]
mod coreaudio {
    pub use super::audio_unit;
    pub use super::sys;
}

pub mod sys {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicI32, Ordering};
    pub type AudioUnit = *mut c_void;
    pub type AudioUnitRenderActionFlags = u32;
    pub type OSStatus = i32;
    pub type UInt32 = u32;
    #[derive(Clone, Copy, Debug)]
    pub struct AudioTimeStamp {
        pub mHostTime: u64,
    }
    pub struct AudioBuffer {
        pub mNumberChannels: u32,
        pub mDataByteSize: u32,
        pub mData: *mut c_void,
    }
    pub struct AudioBufferList {
        pub mNumberBuffers: u32,
        pub mBuffers: [AudioBuffer; 1],
    }
    pub static MODE: AtomicI32 = AtomicI32::new(0);
    pub unsafe fn AudioUnitRender(
        _: AudioUnit,
        _: *mut AudioUnitRenderActionFlags,
        _: *const AudioTimeStamp,
        _: UInt32,
        _: UInt32,
        list: *mut AudioBufferList,
    ) -> OSStatus {
        let list = &mut *list;
        let buffer = &mut list.mBuffers[0];
        assert_eq!(buffer.mData as usize % 8, 0);
        match MODE.load(Ordering::SeqCst) {
            1 => return -42,
            2 => buffer.mDataByteSize += 1,
            3 => buffer.mData = std::ptr::null_mut(),
            4 => buffer.mDataByteSize -= 1,
            _ => std::ptr::write_bytes(
                buffer.mData.cast::<u8>(),
                0x5a,
                buffer.mDataByteSize as usize,
            ),
        }
        0
    }
}

pub mod audio_unit {
    pub mod render_callback {
        use super::super::sys;
        pub mod data {
            pub struct Raw {
                pub data: *mut super::super::super::sys::AudioBufferList,
            }
        }
        pub mod action_flags {
            pub struct Handle;
            impl Handle {
                pub fn from_ptr(
                    _: *mut super::super::super::sys::AudioUnitRenderActionFlags,
                ) -> Self {
                    Self
                }
            }
        }
        pub struct Args<D> {
            pub data: D,
            pub time_stamp: sys::AudioTimeStamp,
            pub flags: action_flags::Handle,
            pub bus_number: u32,
            pub num_frames: usize,
        }
    }
}

#[path = "../../coreaudio-rs-0.11.3/src/audio_unit/checked_close.rs"]
mod checked_close;
#[path = "../../coreaudio-rs-0.11.3/src/audio_unit/checked_initialization.rs"]
mod checked_initialization;
#[path = "../src/host/coreaudio/macos/input_build.rs"]
mod input_build;
#[path = "../src/host/coreaudio/macos/input_callback.rs"]
mod input_callback;
#[path = "../src/host/coreaudio/macos/input_render.rs"]
mod input_render;

static RENDER_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn failed_build_retires_callback_before_checked_close() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    struct Unit(Arc<AtomicUsize>);
    impl Drop for Unit {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
    for close_fails in [false, true] {
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&calls);
        let callback = input_callback::InputCallback::new(move |_, _, _, _, _| {
            observed.fetch_add(1, Ordering::SeqCst);
            0
        })
        .unwrap();
        let token = callback.refcon();
        let drops = Arc::new(AtomicUsize::new(0));
        let result = input_build::cleanup_failed_build(Unit(Arc::clone(&drops)), "setup", |_| {
            callback.retire().unwrap();
            let status = unsafe {
                input_callback::trampoline(
                    token,
                    std::ptr::null_mut(),
                    std::ptr::null(),
                    0,
                    0,
                    std::ptr::null_mut(),
                )
            };
            assert_eq!(status, 0);
            assert_eq!(calls.load(Ordering::SeqCst), 0);
            if close_fails {
                Err("close".into())
            } else {
                Ok(())
            }
        });
        if close_fails {
            assert_eq!(result, Err(("setup", "close".into())));
            assert_eq!(drops.load(Ordering::SeqCst), 0);
        } else {
            assert_eq!(result, Ok("setup"));
            assert_eq!(drops.load(Ordering::SeqCst), 1);
        }
    }
}

#[test]
fn input_render_owns_aligned_resizable_memory_and_checks_ffi_results() {
    use std::sync::atomic::Ordering;
    let _guard = RENDER_TEST_LOCK.lock().unwrap();
    let mut render = input_render::InputRender::new(std::ptr::null_mut(), 2, 4, 4).unwrap();
    let mut flags = 0;
    let time = sys::AudioTimeStamp { mHostTime: 123 };
    for frames in [4, 1, 12, 0, 3] {
        let args = unsafe { render.render(&mut flags, &time, 1, frames) }.unwrap();
        let buffer = unsafe { &(*args.data.data).mBuffers[0] };
        assert_eq!(buffer.mDataByteSize, frames * 8);
        assert_eq!(buffer.mNumberChannels, 2);
        assert_eq!(args.num_frames, frames as usize);
        assert_eq!(args.time_stamp.mHostTime, 123);
        let data = unsafe {
            std::slice::from_raw_parts(buffer.mData.cast::<u8>(), buffer.mDataByteSize as usize)
        };
        assert!(data.iter().all(|byte| *byte == 0x5a));
    }
    for (mode, expected) in [(1, -42), (2, -1500), (3, -1500), (4, -1500)] {
        sys::MODE.store(mode, Ordering::SeqCst);
        assert!(
            matches!(unsafe { render.render(&mut flags, &time, 1, 4) }, Err(code) if code == expected)
        );
    }
    sys::MODE.store(0, Ordering::SeqCst);
    assert!(unsafe { render.render(std::ptr::null_mut(), &time, 1, 4) }.is_err());
    assert!(input_render::InputRender::new(std::ptr::null_mut(), 0, 4, 4).is_none());
}

#[test]
fn checked_close_waits_for_render_and_fails_closed_on_native_errors() {
    use checked_close::CloseState;
    use std::sync::{mpsc, Arc};
    use std::time::Duration;
    for failure in [None, Some("uninitialize"), Some("dispose")] {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let callback = Arc::new(
            input_callback::InputCallback::new(move |_, _, _, _, _| {
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                0
            })
            .unwrap(),
        );
        let token = callback.refcon() as usize;
        let render = std::thread::spawn(move || unsafe {
            input_callback::trampoline(
                token as *mut _,
                std::ptr::null_mut(),
                std::ptr::null(),
                0,
                0,
                std::ptr::null_mut(),
            )
        });
        entered_rx.recv().unwrap();
        let callback_to_retire = Arc::clone(&callback);
        let (closed_tx, closed_rx) = mpsc::channel();
        let closer = std::thread::spawn(move || {
            let mut state = CloseState::Open;
            callback_to_retire.retire().unwrap();
            let result = state.close(
                || {
                    if failure == Some("uninitialize") {
                        Err(())
                    } else {
                        Ok(())
                    }
                },
                || {
                    if failure == Some("dispose") {
                        Err(())
                    } else {
                        Ok(())
                    }
                },
            );
            closed_tx.send((state, result.is_ok())).unwrap();
        });
        assert!(closed_rx.recv_timeout(Duration::from_millis(50)).is_err());
        release_tx.send(()).unwrap();
        assert_eq!(render.join().unwrap(), 0);
        closer.join().unwrap();
        let (state, released) = closed_rx.recv().unwrap();
        assert_eq!(released, failure.is_none());
        assert_eq!(
            state,
            if released {
                CloseState::Closed
            } else {
                CloseState::Uncertain
            }
        );
        assert_eq!(
            unsafe {
                input_callback::trampoline(
                    token as *mut _,
                    std::ptr::null_mut(),
                    std::ptr::null(),
                    0,
                    0,
                    std::ptr::null_mut(),
                )
            },
            0
        );
    }
}

#[test]
fn native_trampoline_renders_and_never_renders_after_retirement() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    let _guard = RENDER_TEST_LOCK.lock().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&calls);
    let mut render = input_render::InputRender::new(std::ptr::null_mut(), 1, 4, 2).unwrap();
    let callback = input_callback::InputCallback::new(move |flags, time, bus, frames, _| {
        match unsafe { render.render(flags, time, bus, frames) } {
            Ok(args) => {
                assert_eq!(args.num_frames, 2);
                observed.fetch_add(1, Ordering::SeqCst);
                0
            }
            Err(status) => status,
        }
    })
    .unwrap();
    let mut flags = 0;
    let time = sys::AudioTimeStamp { mHostTime: 123 };
    let invoke = || unsafe {
        input_callback::trampoline(
            callback.refcon(),
            &mut flags,
            &time,
            1,
            2,
            std::ptr::null_mut(),
        )
    };
    // The fake callback consumes the pointers only while invoke is active.
    let mut invoke = invoke;
    assert_eq!(invoke(), 0);
    sys::MODE.store(1, Ordering::SeqCst);
    assert_eq!(invoke(), -42);
    sys::MODE.store(0, Ordering::SeqCst);
    callback.retire().unwrap();
    assert_eq!(invoke(), 0);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}
