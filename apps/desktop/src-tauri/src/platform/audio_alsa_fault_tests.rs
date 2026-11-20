// ALSA fault-injection tests also run under scripts/ci/run-alsa-fault-tests.sh.
// This file is included by audio::cpal_impl::tests to keep the fixture names stable.
#[test]
#[ignore = "requires an isolated ALSA null capture device"]
fn cpal_worker_captures_and_hands_off_on_an_alsa_null_device() {
    use super::RecordingManager;
    use crate::platform::Recorder;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    let manager = Arc::new(RecordingManager::new());
    for iteration in 0..2 {
        let (captured_tx, captured_rx) = mpsc::sync_channel(1);
        let chunks = Arc::new(Mutex::new(Vec::<(Vec<f32>, u64)>::new()));
        let observed = Arc::clone(&chunks);
        let start_manager = Arc::clone(&manager);
        thread::spawn(move || {
            start_manager
                .start(
                    Some(Arc::new(move |_| {
                        let _ = captured_tx.try_send(());
                        thread::sleep(Duration::from_millis(1));
                    })),
                    Some(Arc::new(move |samples, offset| {
                        observed.lock().unwrap().push((samples, offset));
                    })),
                )
                .map_err(|error| error.to_string())
        })
        .join()
        .unwrap()
        .unwrap();
        captured_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(manager.is_recording());
        let original_rate = manager.current_sample_rate().unwrap();
        let duplicate_start = manager.start(None, None).unwrap_err();
        assert!(matches!(
            duplicate_start.downcast_ref::<crate::errors::RecordingError>(),
            Some(crate::errors::RecordingError::AlreadyRecording)
        ));
        assert!(manager.is_recording());
        assert_eq!(manager.current_sample_rate(), Some(original_rate));
        let pause_manager = Arc::clone(&manager);
        thread::spawn(move || pause_manager.pause().map_err(|error| error.to_string()))
            .join()
            .unwrap()
            .unwrap();
        let resume_manager = Arc::clone(&manager);
        thread::spawn(move || resume_manager.resume().map_err(|error| error.to_string()))
            .join()
            .unwrap()
            .unwrap();
        let stop_manager = Arc::clone(&manager);
        let result = thread::spawn(move || {
            if iteration == 0 {
                stop_manager.stop()
            } else {
                stop_manager.stop_for_handoff()
            }
            .map_err(|error| error.to_string())
        })
        .join()
        .unwrap()
        .unwrap();
        assert!(!manager.is_recording());
        let duplicate_stop = manager.stop().unwrap_err();
        assert!(matches!(
            duplicate_stop.downcast_ref::<crate::errors::RecordingError>(),
            Some(crate::errors::RecordingError::NotRecording)
        ));
        assert!(!result.capture_failed);
        assert!(result.audio.sample_rate > 0);
        assert!(!result.audio.samples.is_empty());
        let chunks = chunks.lock().unwrap();
        let mut combined = Vec::new();
        for (samples, offset) in chunks.iter() {
            assert_eq!(*offset, combined.len() as u64);
            combined.extend_from_slice(samples);
        }
        assert_eq!(combined, result.audio.samples);
    }
}

#[test]
#[ignore = "requires an isolated ALSA null capture device"]
fn cpal_alsa_pause_suppresses_samples_until_resume() {
    use super::LocalRecordingManager;
    use std::time::Duration;
    let manager = LocalRecordingManager::new();
    manager.start_recording(None, None).unwrap();
    let buffer = Arc::clone(
        manager
            .guard()
            .unwrap()
            .as_ref()
            .unwrap()
            .buffer
            .as_ref()
            .unwrap(),
    );
    std::thread::sleep(Duration::from_millis(10));
    manager.pause_recording().unwrap();
    let paused_len = buffer.lock().unwrap().len();
    assert!(paused_len > 0);
    std::thread::sleep(Duration::from_millis(20));
    assert_eq!(buffer.lock().unwrap().len(), paused_len);
    manager.resume_recording().unwrap();
    std::thread::sleep(Duration::from_millis(10));
    assert!(buffer.lock().unwrap().len() > paused_len);
    let result = manager.stop();
    assert!(!manager.is_recording());
    assert!(!result.unwrap().capture_failed);
}

#[test]
#[ignore = "requires ALSA null and the delayed-callback preload"]
fn cpal_alsa_pause_drains_a_read_before_its_callback() {
    use super::RecordingManager;
    use crate::platform::Recorder;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    let symbol = |name: &std::ffi::CStr| {
        let pointer = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) };
        assert!(!pointer.is_null(), "delayed callback preload required");
        pointer
    };
    let arm: unsafe extern "C" fn() =
        unsafe { std::mem::transmute(symbol(c"maus_test_arm_delayed_callback")) };
    let entered: unsafe extern "C" fn() -> libc::c_int =
        unsafe { std::mem::transmute(symbol(c"maus_test_delayed_callback_entered")) };
    let release: unsafe extern "C" fn() =
        unsafe { std::mem::transmute(symbol(c"maus_test_release_delayed_callback")) };
    let manager = Arc::new(RecordingManager::new());
    manager.start(None, None).unwrap();
    unsafe { arm() };
    let deadline = Instant::now() + Duration::from_secs(2);
    while unsafe { entered() } == 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(1));
    }
    if unsafe { entered() } == 0 {
        unsafe { release() };
        panic!("capture did not reach the delayed callback");
    }

    let (done_tx, done_rx) = mpsc::channel();
    let (started_tx, started_rx) = mpsc::channel();
    let worker = {
        let manager = Arc::clone(&manager);
        std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            let result = manager.pause().map_err(|error| error.to_string());
            done_tx.send(result).unwrap();
        })
    };
    if started_rx.recv_timeout(Duration::from_secs(2)).is_err() {
        unsafe { release() };
        panic!("pause worker did not start");
    }
    let early = done_rx.recv_timeout(Duration::from_millis(100));
    unsafe { release() };
    let result = match early {
        Ok(result) => Some(result),
        Err(mpsc::RecvTimeoutError::Timeout) => None,
        Err(error) => panic!("pause worker exited: {error}"),
    };
    assert!(result.is_none(), "pause completed before delivery drained");
    done_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap()
        .unwrap();
    worker.join().unwrap();
    manager.resume().unwrap();
    let result = manager.stop().unwrap();
    assert!(!result.capture_failed);
    assert!(!result.audio.samples.is_empty());
}

#[test]
#[ignore = "requires ALSA null and the stale-poll preload"]
fn cpal_alsa_stale_poll_xrun_does_not_restart_after_resume() {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    let symbol = |name: &std::ffi::CStr| {
        let pointer = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) };
        assert!(!pointer.is_null(), "stale poll preload required");
        pointer
    };
    let arm: unsafe extern "C" fn() =
        unsafe { std::mem::transmute(symbol(c"maus_test_arm_stale_poll")) };
    let entered: unsafe extern "C" fn() -> libc::c_int =
        unsafe { std::mem::transmute(symbol(c"maus_test_stale_poll_entered")) };
    let release: unsafe extern "C" fn() =
        unsafe { std::mem::transmute(symbol(c"maus_test_release_stale_poll")) };
    let preparations: unsafe extern "C" fn() -> libc::c_int =
        unsafe { std::mem::transmute(symbol(c"maus_test_stale_poll_preparations")) };
    let starts: unsafe extern "C" fn() -> libc::c_int =
        unsafe { std::mem::transmute(symbol(c"maus_test_stale_poll_starts")) };
    let device = cpal::default_host().default_input_device().unwrap();
    let supported = device.default_input_config().unwrap();
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let (error_tx, error_rx) = mpsc::channel();
    let (data_tx, data_rx) = mpsc::sync_channel(1);
    let reported = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut stream = device
        .build_input_stream_raw(
            &config,
            format,
            {
                let reported = Arc::clone(&reported);
                move |_, _| {
                    if reported.load(Ordering::Acquire) {
                        let _ = data_tx.try_send(());
                    }
                }
            },
            move |error| {
                reported.store(true, Ordering::Release);
                let _ = error_tx.send(error.to_string());
            },
            None,
        )
        .unwrap();
    stream.play().unwrap();
    unsafe { arm() };
    let deadline = Instant::now() + Duration::from_secs(2);
    while unsafe { entered() } == 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(1));
    }
    if unsafe { entered() } == 0 {
        unsafe { release() };
        panic!("capture did not reach the delayed poll");
    }
    // A blocking poll is not an admitted cycle. Pause must not wait for
    // it, and its old result must not recover the resumed stream.
    #[allow(unreachable_patterns)]
    let pause = match stream.as_inner() {
        cpal::platform::StreamInner::Alsa(stream) => stream.pause_input_and_drain(),
        _ => panic!("ALSA stream required"),
    };
    let resume = stream.play();
    unsafe { release() };
    pause.unwrap();
    resume.unwrap();
    let error = error_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(error.contains("overrun lost audio samples"));
    // Wait for a subsequent read. Recovery, if mistakenly attempted,
    // runs after reporting the error and before that next callback.
    data_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(unsafe { preparations() }, 0);
    assert_eq!(unsafe { starts() }, 0);
    #[allow(unreachable_patterns)]
    match stream.as_inner_mut() {
        cpal::platform::StreamInner::Alsa(stream) => stream.stop_input_for_release().unwrap(),
        _ => panic!("ALSA stream required"),
    }
}

fn exercise_alsa_pause_fault(mode: libc::c_int) {
    use super::LocalRecordingManager;
    use std::time::Duration;
    let arm = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"maus_test_arm_alsa_pause".as_ptr()) };
    let calls = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"maus_test_alsa_pause_calls".as_ptr()) };
    assert!(
        !arm.is_null() && !calls.is_null(),
        "pause-failure preload required"
    );
    let arm: unsafe extern "C" fn(libc::c_int) = unsafe { std::mem::transmute(arm) };
    let calls: unsafe extern "C" fn() -> libc::c_int = unsafe { std::mem::transmute(calls) };
    unsafe { arm(mode) };
    let manager = LocalRecordingManager::new();
    manager.start_recording(None, None).unwrap();
    let buffer = Arc::clone(
        manager
            .guard()
            .unwrap()
            .as_ref()
            .unwrap()
            .buffer
            .as_ref()
            .unwrap(),
    );
    std::thread::sleep(Duration::from_millis(10));
    if mode == 3 {
        manager.pause_recording().unwrap();
        assert!(manager.resume_recording().is_err());
    } else {
        assert!(manager.pause_recording().is_err());
    }
    let count = buffer.lock().unwrap().len();
    std::thread::sleep(Duration::from_millis(10));
    let after = buffer.lock().unwrap().len();
    if mode == 1 {
        assert_eq!(unsafe { calls() }, 0);
        assert!(
            after > count,
            "unsupported pause must leave capture running"
        );
    } else {
        assert_eq!(
            after, count,
            "failed transition must retire capture callbacks"
        );
        assert!(manager.resume_recording().is_err());
    }
    let result = manager.stop();
    assert!(!manager.is_recording());
    assert_eq!(result.unwrap().capture_failed, mode != 1);
}

#[test]
#[ignore = "requires ALSA null and the test-only pause-failure preload"]
fn cpal_alsa_unsupported_pause_keeps_recording() {
    exercise_alsa_pause_fault(1);
}

#[test]
#[ignore = "requires ALSA null and the test-only pause-failure preload"]
fn cpal_alsa_failed_pause_marks_partial_capture() {
    exercise_alsa_pause_fault(2);
}

#[test]
#[ignore = "requires ALSA null and the test-only pause-failure preload"]
fn cpal_alsa_failed_resume_marks_partial_capture() {
    exercise_alsa_pause_fault(3);
}

fn exercise_alsa_playback_pause_failure(mode: libc::c_int) {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use std::sync::mpsc;
    use std::time::Duration;

    let arm: unsafe extern "C" fn(libc::c_int) =
        unsafe { std::mem::transmute(alsa_probe_symbol(c"maus_test_arm_alsa_pause")) };
    let calls: unsafe extern "C" fn() -> libc::c_int =
        unsafe { std::mem::transmute(alsa_probe_symbol(c"maus_test_alsa_pause_calls")) };
    let device = cpal::default_host().default_output_device().unwrap();
    let supported = device.default_output_config().unwrap();
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let (tx, rx) = mpsc::sync_channel(1);
    let stream = device
        .build_output_stream_raw(
            &config,
            format,
            move |data, _| {
                data.bytes_mut().fill(0);
                let _ = tx.try_send(());
            },
            |_| {},
            None,
        )
        .unwrap();
    stream.play().unwrap();
    rx.recv_timeout(Duration::from_secs(2)).unwrap();
    unsafe { arm(mode) };
    let error = stream
        .pause()
        .expect_err("ALSA pause failure must be reported");
    assert!(error.to_string().contains("snd_pcm_pause"));
    assert_eq!(unsafe { calls() }, 1);
    // Propagate a simulated successful native return too. The null
    // PCM can race from running to XRUN before a real retry reaches it.
    unsafe { arm(6) };
    stream.pause().unwrap();
    assert_eq!(unsafe { calls() }, 1);
    drop(stream);
}

#[test]
#[ignore = "requires ALSA null and the test-only pause-failure preload"]
fn cpal_alsa_playback_reports_unsupported_pause() {
    exercise_alsa_playback_pause_failure(4);
}

#[test]
#[ignore = "requires ALSA null and the test-only pause-failure preload"]
fn cpal_alsa_playback_reports_pause_io_error() {
    exercise_alsa_playback_pause_failure(5);
}

#[test]
#[ignore = "requires an isolated ALSA null capture device"]
fn cpal_alsa_input_waits_for_play_and_can_be_dropped_unstarted() {
    use cpal::traits::{DeviceTrait, HostTrait};
    use std::sync::mpsc;
    use std::time::Duration;

    let device = cpal::default_host().default_input_device().unwrap();
    let supported = device.default_input_config().unwrap();
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let (tx, rx) = mpsc::channel();
    let errors = tx.clone();
    let stream = device
        .build_input_stream_raw(
            &config,
            format,
            move |_, _| {
                let _ = tx.send(());
            },
            move |_| {
                let _ = errors.send(());
            },
            None,
        )
        .unwrap();
    assert!(matches!(
        rx.recv_timeout(Duration::from_millis(100)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    drop(stream);
    assert!(rx.try_recv().is_err());
}

#[test]
#[ignore = "requires ALSA null and the test-only start-failure preload"]
fn cpal_alsa_failed_start_retains_an_uncertain_active_device() {
    use super::RecordingManager;
    use crate::platform::Recorder;

    let arm = unsafe {
        libc::dlsym(
            libc::RTLD_DEFAULT,
            c"maus_test_arm_alsa_start_failure".as_ptr(),
        )
    };
    let starts =
        unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"maus_test_alsa_failed_starts".as_ptr()) };
    let stops = unsafe {
        libc::dlsym(
            libc::RTLD_DEFAULT,
            c"maus_test_alsa_failed_start_stops".as_ptr(),
        )
    };
    assert!(
        !arm.is_null() && !starts.is_null() && !stops.is_null(),
        "start-failure preload required"
    );
    let arm: unsafe extern "C" fn() = unsafe { std::mem::transmute(arm) };
    let starts: unsafe extern "C" fn() -> libc::c_int = unsafe { std::mem::transmute(starts) };
    let stops: unsafe extern "C" fn() -> libc::c_int = unsafe { std::mem::transmute(stops) };
    let manager = RecordingManager::new();
    unsafe { arm() };
    assert!(manager.start(None, None).is_err());
    assert_eq!(unsafe { starts() }, 1);
    assert_eq!(unsafe { stops() }, 2);
    assert!(manager.is_recording());
    assert!(manager.start(None, None).is_err());
    manager.stop().unwrap();
    assert!(!manager.is_recording());
    manager.start(None, None).unwrap();
    manager.stop().unwrap();
}

unsafe fn alsa_probe_symbol(name: &std::ffi::CStr) -> *mut libc::c_void {
    let pointer = libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr());
    assert!(!pointer.is_null(), "ALSA fault-injection preload required");
    pointer
}

fn exercise_alsa_probe_close_failure(active: bool) {
    use super::RecordingManager;
    use crate::platform::Recorder;
    use cpal::traits::{DeviceTrait, HostTrait};

    let arm: unsafe extern "C" fn() = unsafe {
        std::mem::transmute(alsa_probe_symbol(c"maus_test_arm_alsa_probe_close_failure"))
    };
    let closes: unsafe extern "C" fn() -> libc::c_int =
        unsafe { std::mem::transmute(alsa_probe_symbol(c"maus_test_alsa_probe_closes")) };
    let opens: unsafe extern "C" fn() -> libc::c_int = unsafe {
        std::mem::transmute(alsa_probe_symbol(
            c"maus_test_alsa_opens_after_probe_failure",
        ))
    };
    let capture_opens: unsafe extern "C" fn() -> libc::c_int =
        unsafe { std::mem::transmute(alsa_probe_symbol(c"maus_test_alsa_capture_opens")) };
    // Read the configuration before starting, because a live recording
    // now refuses capability probes.
    let device = cpal::default_host().default_input_device().unwrap();
    let supported = device.default_input_config().unwrap();
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let manager = RecordingManager::new();
    if active {
        manager.start(None, None).unwrap();
    }
    unsafe { arm() };
    if active {
        // Discovery while a stream owns the device must refuse to probe
        // rather than open a second handle, so a failing probe close
        // cannot poison admission during a recording.
        assert!(device.default_input_config().is_err());
        assert_eq!(unsafe { closes() }, 0);
        assert_eq!(unsafe { capture_opens() }, 0);
        assert!(!cpal::alsa_capture_cleanup_uncertain());
        let listing = super::list_input_devices();
        assert!(!listing.is_empty());
        std::thread::sleep(std::time::Duration::from_millis(20));
        let recording = manager.stop_for_handoff().unwrap();
        assert!(!recording.capture_failed);
        // With the stream released, the armed probe runs and latches the
        // uncertainty that keeps later capture from being admitted.
        assert!(device.default_input_config().is_err());
    } else {
        assert!(device.default_input_config().is_err());
    }
    assert_eq!(unsafe { closes() }, 1);
    assert!(cpal::alsa_capture_cleanup_uncertain());
    assert!(manager.is_recording());
    if !active {
        assert!(manager.stop().is_err());
    }
    assert!(manager.is_recording());
    assert!(manager.start(None, None).is_err());
    let other = RecordingManager::new();
    assert!(other.is_recording());
    assert!(other.start(None, None).is_err());
    assert!(matches!(
        device.build_input_stream_raw(&config, format, |_, _| {}, |_| {}, None),
        Err(cpal::BuildStreamError::CleanupUncertain { .. })
    ));
    assert_eq!(unsafe { opens() }, 0);
    assert_eq!(unsafe { closes() }, 1);
}

#[test]
#[ignore = "requires isolated ALSA null and the test-only probe-close preload"]
fn cpal_alsa_capture_build_waits_for_probe_close() {
    use cpal::traits::{DeviceTrait, HostTrait};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    let hold: unsafe extern "C" fn() =
        unsafe { std::mem::transmute(alsa_probe_symbol(c"maus_test_hold_alsa_probe_close")) };
    let release: unsafe extern "C" fn() =
        unsafe { std::mem::transmute(alsa_probe_symbol(c"maus_test_release_alsa_probe_close")) };
    let closing: unsafe extern "C" fn() -> libc::c_int =
        unsafe { std::mem::transmute(alsa_probe_symbol(c"maus_test_alsa_probe_closing")) };
    let opens: unsafe extern "C" fn() -> libc::c_int =
        unsafe { std::mem::transmute(alsa_probe_symbol(c"maus_test_alsa_capture_opens")) };
    struct Release(unsafe extern "C" fn());
    impl Drop for Release {
        fn drop(&mut self) {
            unsafe { (self.0)() }
        }
    }

    let device = cpal::default_host().default_input_device().unwrap();
    let supported = device.default_input_config().unwrap();
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    unsafe { hold() };
    let release_on_drop = Release(release);
    let probe = device.clone();
    let probe_thread = std::thread::spawn(move || probe.default_input_config());
    let deadline = Instant::now() + Duration::from_secs(2);
    while unsafe { closing() } == 0 {
        assert!(Instant::now() < deadline, "probe did not reach close");
        std::thread::sleep(Duration::from_millis(1));
    }
    let (attempt_tx, attempt_rx) = mpsc::channel();
    let (done_tx, done_rx) = mpsc::channel();
    let build_thread = std::thread::spawn(move || {
        attempt_tx.send(()).unwrap();
        let result = device.build_input_stream_raw(&config, format, |_, _| {}, |_| {}, None);
        let success = result
            .map(|mut stream| {
                #[allow(unreachable_patterns)]
                match stream.as_inner_mut() {
                    cpal::platform::StreamInner::Alsa(inner) => {
                        inner.stop_input_for_release().unwrap()
                    }
                    _ => panic!("expected ALSA stream"),
                }
            })
            .is_ok();
        done_tx.send(success).unwrap();
    });
    attempt_rx.recv().unwrap();
    assert!(done_rx.recv_timeout(Duration::from_millis(100)).is_err());
    assert_eq!(unsafe { opens() }, 1);
    drop(release_on_drop);
    assert!(probe_thread.join().unwrap().is_ok());
    assert!(done_rx.recv_timeout(Duration::from_secs(2)).unwrap());
    build_thread.join().unwrap();
    assert_eq!(unsafe { opens() }, 2);
    assert!(!cpal::alsa_capture_cleanup_uncertain());
}

#[test]
#[ignore = "requires isolated ALSA null and the test-only probe-close preload"]
fn cpal_alsa_uncertain_probe_blocks_successor_capture() {
    exercise_alsa_probe_close_failure(false);
}

#[test]
#[ignore = "requires isolated ALSA null and the test-only probe-close preload"]
fn cpal_alsa_discovery_during_recording_leaves_capture_running() {
    exercise_alsa_probe_close_failure(true);
}

fn exercise_alsa_capability_cache(failure: Option<(i32, bool)>) {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    let fail_open: unsafe extern "C" fn(libc::c_int) =
        unsafe { std::mem::transmute(alsa_probe_symbol(c"maus_test_alsa_cache_fail_open")) };
    let fail_setup: unsafe extern "C" fn() =
        unsafe { std::mem::transmute(alsa_probe_symbol(c"maus_test_alsa_cache_fail_setup")) };
    let opens: unsafe extern "C" fn() -> libc::c_int =
        unsafe { std::mem::transmute(alsa_probe_symbol(c"maus_test_alsa_cache_capture_opens")) };
    let injected: unsafe extern "C" fn() -> libc::c_int =
        unsafe { std::mem::transmute(alsa_probe_symbol(c"maus_test_alsa_cache_injected")) };
    let host = cpal::default_host();
    let target = host
        .devices()
        .unwrap()
        .find(|device| device.name().unwrap() == "maus_capture_only")
        .expect("capture-only device must initially be discovered by probing");
    let supported = target.default_input_config().unwrap();
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let default = host.default_input_device().unwrap();
    let supported = default.default_input_config().unwrap();
    let default_format = supported.sample_format();
    let default_config: cpal::StreamConfig = supported.into();

    if let Some((error, true)) = failure {
        unsafe { fail_open(error) };
        assert!(target.default_input_config().is_err());
        assert_eq!(unsafe { injected() }, 1);
    }
    let callbacks = Arc::new(AtomicUsize::new(0));
    let callback_counter = Arc::clone(&callbacks);
    let mut stream = default
        .build_input_stream_raw(
            &default_config,
            default_format,
            move |_, _| {
                callback_counter.fetch_add(1, Ordering::Relaxed);
            },
            |_| {},
            None,
        )
        .unwrap();
    stream.play().unwrap();
    let wait_for_progress = |previous| {
        let deadline = Instant::now() + Duration::from_secs(2);
        while callbacks.load(Ordering::Relaxed) <= previous {
            assert!(
                Instant::now() < deadline,
                "live stream stopped producing callbacks"
            );
            std::thread::sleep(Duration::from_millis(1));
        }
    };
    wait_for_progress(0);
    if !matches!(failure, Some((_, true))) {
        unsafe {
            if let Some((error, false)) = failure {
                fail_open(error)
            } else {
                fail_setup()
            }
        }
        assert!(target
            .build_input_stream_raw(&config, format, |_, _| {}, |_| {}, None)
            .is_err());
        assert_eq!(unsafe { injected() }, 1);
    }
    assert!(!cpal::alsa_capture_cleanup_uncertain());
    let before = unsafe { opens() };
    let found = host
        .devices()
        .unwrap()
        .any(|device| device.name().unwrap() == "maus_capture_only");
    assert_eq!(
        unsafe { opens() },
        before,
        "discovery must not open capture while a stream is live"
    );
    assert_eq!(
        found,
        !matches!(failure, Some((libc::ENODEV | libc::ENOENT, _))),
        "unexpected capture-only discovery after {failure:?}"
    );
    let previous = callbacks.load(Ordering::Relaxed);
    wait_for_progress(previous);
    #[allow(unreachable_patterns)]
    match stream.as_inner_mut() {
        cpal::platform::StreamInner::Alsa(inner) => inner.stop_input_for_release().unwrap(),
        _ => panic!("expected ALSA stream"),
    }
    drop(stream);
    assert!(!cpal::alsa_capture_cleanup_uncertain());
    let before = unsafe { opens() };
    assert!(host
        .devices()
        .unwrap()
        .any(|device| device.name().unwrap() == "maus_capture_only"));
    assert!(
        unsafe { opens() } > before,
        "discovery must probe again after release"
    );
}

#[test]
#[ignore = "requires isolated ALSA null and the test-only capability cache preload"]
fn cpal_alsa_cache_survives_setup_failure() {
    exercise_alsa_capability_cache(None);
}

#[test]
#[ignore = "requires isolated ALSA null and the test-only capability cache preload"]
fn cpal_alsa_cache_survives_busy_build() {
    exercise_alsa_capability_cache(Some((libc::EBUSY, false)));
}

#[test]
#[ignore = "requires isolated ALSA null and the test-only capability cache preload"]
fn cpal_alsa_cache_survives_busy_probe() {
    exercise_alsa_capability_cache(Some((libc::EBUSY, true)));
}

#[test]
#[ignore = "requires isolated ALSA null and the test-only capability cache preload"]
fn cpal_alsa_cache_forgets_missing_build() {
    exercise_alsa_capability_cache(Some((libc::ENODEV, false)));
}

#[test]
#[ignore = "requires isolated ALSA null and the test-only capability cache preload"]
fn cpal_alsa_cache_forgets_missing_probe() {
    exercise_alsa_capability_cache(Some((libc::ENODEV, true)));
}

#[test]
#[ignore = "requires isolated ALSA null and the test-only capability cache preload"]
fn cpal_alsa_cache_survives_permission_build() {
    exercise_alsa_capability_cache(Some((libc::EACCES, false)));
}

#[test]
#[ignore = "requires isolated ALSA null and the test-only capability cache preload"]
fn cpal_alsa_cache_survives_permission_probe() {
    exercise_alsa_capability_cache(Some((libc::EACCES, true)));
}

#[test]
#[ignore = "requires isolated ALSA null and the test-only capability cache preload"]
fn cpal_alsa_cache_forgets_absent_build() {
    exercise_alsa_capability_cache(Some((libc::ENOENT, false)));
}

#[test]
#[ignore = "requires isolated ALSA null and the test-only capability cache preload"]
fn cpal_alsa_cache_forgets_absent_probe() {
    exercise_alsa_capability_cache(Some((libc::ENOENT, true)));
}

fn exercise_alsa_uncertain_open(probe: bool) {
    use super::RecordingManager;
    use crate::platform::Recorder;
    use cpal::traits::{DeviceTrait, HostTrait};

    let arm: unsafe extern "C" fn() =
        unsafe { std::mem::transmute(alsa_probe_symbol(c"maus_test_arm_alsa_open_failure")) };
    let opens: unsafe extern "C" fn() -> libc::c_int = unsafe {
        std::mem::transmute(alsa_probe_symbol(
            c"maus_test_alsa_opens_after_open_failure",
        ))
    };
    let closes: unsafe extern "C" fn() -> libc::c_int =
        unsafe { std::mem::transmute(alsa_probe_symbol(c"maus_test_alsa_uncertain_open_closes")) };
    let device = cpal::default_host().default_input_device().unwrap();
    let supported = device.default_input_config().unwrap();
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    unsafe { arm() };
    if probe {
        assert!(device.default_input_config().is_err());
    } else {
        assert!(matches!(
            device.build_input_stream_raw(&config, format, |_, _| {}, |_| {}, None),
            Err(cpal::BuildStreamError::CleanupUncertain { .. })
        ));
    }
    assert!(cpal::alsa_capture_cleanup_uncertain());
    let manager = RecordingManager::new();
    assert!(manager.is_recording());
    assert!(manager.start(None, None).is_err());
    assert_eq!(unsafe { opens() }, 0);
    assert_eq!(unsafe { closes() }, 0);
}

#[test]
#[ignore = "requires isolated ALSA null and the test-only open-failure preload"]
fn cpal_alsa_uncertain_probe_open_blocks_capture() {
    exercise_alsa_uncertain_open(true);
}

#[test]
#[ignore = "requires isolated ALSA null and the test-only open-failure preload"]
fn cpal_alsa_uncertain_stream_open_blocks_capture() {
    exercise_alsa_uncertain_open(false);
}

#[test]
#[ignore = "requires ALSA null and the test-only build-failure preload"]
fn cpal_alsa_build_failure_distinguishes_confirmed_close() {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    let arm = unsafe {
        libc::dlsym(
            libc::RTLD_DEFAULT,
            c"maus_test_arm_alsa_build_failure".as_ptr(),
        )
    };
    let closes = unsafe {
        libc::dlsym(
            libc::RTLD_DEFAULT,
            c"maus_test_alsa_build_close_calls".as_ptr(),
        )
    };
    assert!(
        !arm.is_null() && !closes.is_null(),
        "build-failure preload required"
    );
    let arm: unsafe extern "C" fn(libc::c_int) = unsafe { std::mem::transmute(arm) };
    let closes: unsafe extern "C" fn() -> libc::c_int = unsafe { std::mem::transmute(closes) };
    let device = cpal::default_host().default_input_device().unwrap();
    let supported = device.default_input_config().unwrap();
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    unsafe { arm(0) };
    let result = device.build_input_stream_raw(&config, format, |_, _| {}, |_| {}, None);
    assert!(matches!(
        result,
        Err(cpal::BuildStreamError::BackendSpecific { .. })
    ));
    assert_eq!(unsafe { closes() }, 1);
    let stream = device
        .build_input_stream_raw(&config, format, |_, _| {}, |_| {}, None)
        .unwrap();
    stream.play().unwrap();
    drop(stream);
}

#[test]
#[ignore = "requires ALSA null and the test-only build-failure preload"]
fn cpal_alsa_poll_count_error_closes_capture_and_reports_cause() {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    let arm = unsafe {
        libc::dlsym(
            libc::RTLD_DEFAULT,
            c"maus_test_arm_alsa_poll_count_failure".as_ptr(),
        )
    };
    let closes = unsafe {
        libc::dlsym(
            libc::RTLD_DEFAULT,
            c"maus_test_alsa_build_close_calls".as_ptr(),
        )
    };
    assert!(
        !arm.is_null() && !closes.is_null(),
        "build-failure preload required"
    );
    let arm: unsafe extern "C" fn() = unsafe { std::mem::transmute(arm) };
    let closes: unsafe extern "C" fn() -> libc::c_int = unsafe { std::mem::transmute(closes) };
    let device = cpal::default_host().default_input_device().unwrap();
    let supported = device.default_input_config().unwrap();
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    unsafe { arm() };
    let error = device
        .build_input_stream_raw(&config, format, |_, _| {}, |_| {}, None)
        .err()
        .expect("poll descriptor failure must reject the stream");
    assert!(error.to_string().contains("snd_pcm_poll_descriptors_count"));
    assert_eq!(unsafe { closes() }, 1);
    let stream = device
        .build_input_stream_raw(&config, format, |_, _| {}, |_| {}, None)
        .unwrap();
    stream.play().unwrap();
    drop(stream);
}

fn exercise_alsa_uncertain_build_close(cached: bool) {
    use super::RecordingManager;
    use crate::platform::Recorder;

    let arm = unsafe {
        libc::dlsym(
            libc::RTLD_DEFAULT,
            c"maus_test_arm_alsa_build_failure".as_ptr(),
        )
    };
    let setups =
        unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"maus_test_alsa_failed_setups".as_ptr()) };
    let closes = unsafe {
        libc::dlsym(
            libc::RTLD_DEFAULT,
            c"maus_test_alsa_build_close_calls".as_ptr(),
        )
    };
    assert!(
        !arm.is_null() && !setups.is_null() && !closes.is_null(),
        "build-failure preload required"
    );
    let arm: unsafe extern "C" fn(libc::c_int) = unsafe { std::mem::transmute(arm) };
    let setups: unsafe extern "C" fn() -> libc::c_int = unsafe { std::mem::transmute(setups) };
    let closes: unsafe extern "C" fn() -> libc::c_int = unsafe { std::mem::transmute(closes) };
    {
        let manager = RecordingManager::new();
        if cached {
            manager.start(None, None).unwrap();
            manager.stop().unwrap();
        }
        unsafe { arm(1) };
        let error = manager.start(None, None).unwrap_err();
        assert!(matches!(
            error.downcast_ref::<crate::errors::RecordingError>(),
            Some(crate::errors::RecordingError::ReleaseUncertain(_))
        ));
        assert_eq!(unsafe { setups() }, 1);
        assert_eq!(unsafe { closes() }, 1);
        assert!(manager.is_recording());
        assert!(manager.start(None, None).is_err());
        assert!(manager.stop().is_err());
        assert!(manager.is_recording());
        assert_eq!(unsafe { closes() }, 1);
    }
}

#[test]
#[ignore = "requires isolated ALSA null and the test-only build-failure preload"]
fn cpal_alsa_uncertain_build_close_blocks_successor_capture() {
    exercise_alsa_uncertain_build_close(false);
}

#[test]
#[ignore = "requires isolated ALSA null and the test-only build-failure preload"]
fn cpal_alsa_uncertain_cached_build_close_blocks_successor_capture() {
    exercise_alsa_uncertain_build_close(true);
}

#[test]
#[ignore = "requires ALSA null and the test-only close-failure preload"]
fn cpal_alsa_failed_close_never_reuses_the_uncertain_handle() {
    use super::RecordingManager;
    use crate::platform::Recorder;
    use std::sync::mpsc;
    use std::time::Duration;

    let arm = unsafe {
        libc::dlsym(
            libc::RTLD_DEFAULT,
            c"maus_test_arm_alsa_close_failure".as_ptr(),
        )
    };
    let calls = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"maus_test_alsa_close_calls".as_ptr()) };
    assert!(
        !arm.is_null() && !calls.is_null(),
        "close-failure preload required"
    );
    let arm: unsafe extern "C" fn() = unsafe { std::mem::transmute(arm) };
    let calls: unsafe extern "C" fn() -> libc::c_int = unsafe { std::mem::transmute(calls) };
    let manager = RecordingManager::new();
    let (captured_tx, captured_rx) = mpsc::sync_channel(1);
    manager
        .start(
            Some(Arc::new(move |_| {
                let _ = captured_tx.try_send(());
            })),
            None,
        )
        .unwrap();
    captured_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    unsafe { arm() };
    assert!(manager.stop_for_handoff().unwrap().capture_failed);
    assert_eq!(unsafe { calls() }, 1);
    assert!(manager.is_recording());
    assert!(manager.start(None, None).is_err());
    assert!(manager.stop().is_err());
    assert_eq!(unsafe { calls() }, 1);
    assert!(manager.is_recording());
    // Model process teardown: dropping the retained recording must not
    // close the already-consumed, potentially invalid native handle.
    manager
        .worker
        .call(|recorder| drop(recorder.unresolved_stream.borrow_mut().take()))
        .unwrap();
    assert_eq!(unsafe { calls() }, 1);
}

#[test]
#[ignore = "requires ALSA null and the test-only stop-failure preload"]
fn cpal_alsa_failed_stop_retains_ownership_until_retry_succeeds() {
    use super::RecordingManager;
    use crate::platform::Recorder;
    use std::sync::mpsc;
    use std::time::Duration;

    let arm = unsafe {
        libc::dlsym(
            libc::RTLD_DEFAULT,
            c"maus_test_fail_next_alsa_stops".as_ptr(),
        )
    };
    let failures =
        unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"maus_test_alsa_stop_failures".as_ptr()) };
    assert!(
        !arm.is_null() && !failures.is_null(),
        "stop-failure preload required"
    );
    let arm: unsafe extern "C" fn() = unsafe { std::mem::transmute(arm) };
    let failures: unsafe extern "C" fn() -> libc::c_int = unsafe { std::mem::transmute(failures) };
    let manager = RecordingManager::new();
    let (captured_tx, captured_rx) = mpsc::sync_channel(1);
    manager
        .start(
            Some(Arc::new(move |_| {
                let _ = captured_tx.try_send(());
            })),
            None,
        )
        .unwrap();
    captured_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    unsafe { arm() };
    let result = manager.stop_for_handoff().unwrap();
    assert!(result.capture_failed);
    assert_eq!(unsafe { failures() }, 2);
    assert!(manager.is_recording());
    assert!(manager.start(None, None).is_err());
    manager.stop().unwrap();
    assert!(!manager.is_recording());
    manager.start(None, None).unwrap();
    manager.stop().unwrap();
}

#[test]
#[ignore = "requires an isolated ALSA null playback device"]
fn cpal_alsa_playback_uses_aligned_sample_buffers() {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use std::sync::mpsc;
    use std::time::Duration;

    let device = cpal::default_host().default_output_device().unwrap();
    let supported = device.default_output_config().unwrap();
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let (data_tx, data_rx) = mpsc::sync_channel(1);
    let stream = device
        .build_output_stream_raw(
            &config,
            format,
            move |data, _| {
                let bytes = data.bytes_mut();
                let _ = data_tx.try_send((bytes.len(), bytes.as_ptr() as usize));
                bytes.fill(0);
            },
            |_| {},
            None,
        )
        .unwrap();
    stream.play().unwrap();
    let (len, address) = data_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    drop(stream);
    assert!(len > 0);
    assert_eq!(address % std::mem::align_of::<u64>(), 0);
}

fn check_alsa_partial_playback(no_progress: bool, expect_error: bool) {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    unsafe fn symbol(name: &std::ffi::CStr) -> *mut libc::c_void {
        let result = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) };
        assert!(!result.is_null(), "short-write preload required");
        result
    }
    let calls: unsafe extern "C" fn() -> libc::c_ulong =
        unsafe { std::mem::transmute(symbol(c"maus_test_write_calls")) };
    let completed: unsafe extern "C" fn() -> libc::c_ulong =
        unsafe { std::mem::transmute(symbol(c"maus_test_write_completed")) };
    let mismatch: unsafe extern "C" fn() -> libc::c_int =
        unsafe { std::mem::transmute(symbol(c"maus_test_write_mismatch")) };
    let device = cpal::default_host().default_output_device().unwrap();
    let config = cpal::StreamConfig {
        channels: 1,
        sample_rate: cpal::SampleRate(48_000),
        buffer_size: cpal::BufferSize::Default,
    };
    let callbacks = Arc::new(AtomicUsize::new(0));
    let duplicate = Arc::new(AtomicBool::new(false));
    let errors = Arc::new(AtomicUsize::new(0));
    let stream = device
        .build_output_stream(
            &config,
            {
                let callbacks = Arc::clone(&callbacks);
                let duplicate = Arc::clone(&duplicate);
                move |data: &mut [f32], _| {
                    if callbacks.fetch_add(1, Ordering::SeqCst) != 0 && unsafe { completed() } == 0
                    {
                        duplicate.store(true, Ordering::SeqCst);
                    }
                    for (index, sample) in data.iter_mut().enumerate() {
                        *sample = index as f32;
                    }
                }
            },
            {
                let errors = Arc::clone(&errors);
                move |_| {
                    errors.fetch_add(1, Ordering::SeqCst);
                }
            },
            None,
        )
        .unwrap();
    stream.play().unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        let done = if no_progress {
            unsafe { calls() >= 10 }
        } else {
            unsafe { completed() != 0 || mismatch() != 0 }
        };
        if done {
            break;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    assert!(unsafe { calls() >= if no_progress { 10 } else { 4 } });
    if !no_progress {
        assert_eq!(unsafe { completed() }, 1);
    }
    assert_eq!(unsafe { mismatch() }, 0);
    assert!(!duplicate.load(Ordering::SeqCst));
    assert_eq!(errors.load(Ordering::SeqCst), usize::from(expect_error));
    let drop_started = Instant::now();
    drop(stream);
    assert!(drop_started.elapsed() < Duration::from_millis(500));
}

#[test]
#[ignore = "requires ALSA null and the test-only short-write preload"]
fn cpal_alsa_partial_playback_preserves_unwritten_frames() {
    check_alsa_partial_playback(false, false);
}

#[test]
#[ignore = "requires ALSA null and the test-only partial-write XRUN preload"]
fn cpal_alsa_playback_recovers_xrun_after_partial_write() {
    check_alsa_partial_playback(false, false);
}

#[test]
#[ignore = "requires ALSA null and the test-only permanent-EAGAIN preload"]
fn cpal_alsa_playback_drop_interrupts_retry() {
    check_alsa_partial_playback(true, false);
}

#[test]
#[ignore = "requires ALSA null and the test-only fatal-write preload"]
fn cpal_alsa_playback_coalesces_persistent_errors() {
    check_alsa_partial_playback(true, true);
}

fn check_alsa_stalled_read() {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use std::sync::atomic::AtomicUsize;
    use std::time::{Duration, Instant};
    let calls = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"maus_test_read_calls".as_ptr()) };
    assert!(!calls.is_null(), "short-read preload required");
    let calls: unsafe extern "C" fn() -> libc::c_ulong = unsafe { std::mem::transmute(calls) };
    let device = cpal::default_host().default_input_device().unwrap();
    let supported = device.default_input_config().unwrap();
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let callbacks = Arc::new(AtomicUsize::new(0));
    let errors = Arc::new(AtomicUsize::new(0));
    let mut stream = device
        .build_input_stream_raw(
            &config,
            format,
            {
                let callbacks = Arc::clone(&callbacks);
                move |_, _| {
                    callbacks.fetch_add(1, Ordering::SeqCst);
                }
            },
            {
                let errors = Arc::clone(&errors);
                move |_| {
                    errors.fetch_add(1, Ordering::SeqCst);
                }
            },
            None,
        )
        .unwrap();
    stream.play().unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    while unsafe { calls() } < 10 {
        assert!(Instant::now() < deadline, "read retry did not run");
        std::thread::sleep(Duration::from_millis(2));
    }
    let before = unsafe { calls() };
    std::thread::sleep(Duration::from_millis(50));
    assert!(
        unsafe { calls() } - before <= 15,
        "read retry spun despite no progress"
    );
    assert_eq!(callbacks.load(Ordering::SeqCst), 0);
    assert_eq!(errors.load(Ordering::SeqCst), 0);
    let started = Instant::now();
    #[allow(unreachable_patterns)]
    match stream.as_inner_mut() {
        cpal::platform::StreamInner::Alsa(inner) => inner.stop_input_for_release().unwrap(),
        _ => panic!("expected ALSA stream"),
    }
    assert!(started.elapsed() < Duration::from_millis(500));
}

#[test]
#[ignore = "requires ALSA null and the test-only permanent-EAGAIN read preload"]
fn cpal_alsa_stalled_read_is_interruptible() {
    check_alsa_stalled_read();
}

#[test]
#[ignore = "requires ALSA null and the test-only zero-read preload"]
fn cpal_alsa_zero_read_is_interruptible() {
    check_alsa_stalled_read();
}

#[test]
#[ignore = "requires ALSA null and the test-only short-read preload"]
fn cpal_alsa_delivers_only_frames_returned_by_a_short_read() {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use std::sync::mpsc;
    use std::time::Duration;

    let requested = unsafe {
        libc::dlsym(
            libc::RTLD_DEFAULT,
            c"maus_test_last_read_requested".as_ptr(),
        )
    };
    let returned =
        unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"maus_test_last_read_returned".as_ptr()) };
    assert!(
        !requested.is_null() && !returned.is_null(),
        "short-read preload required"
    );
    let requested: unsafe extern "C" fn() -> libc::c_ulong =
        unsafe { std::mem::transmute(requested) };
    let returned: unsafe extern "C" fn() -> libc::c_long = unsafe { std::mem::transmute(returned) };
    let device = cpal::default_host().default_input_device().unwrap();
    let supported = device.default_input_config().unwrap();
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let channels = config.channels as usize;
    let (data_tx, data_rx) = mpsc::sync_channel(1);
    let (error_tx, error_rx) = mpsc::sync_channel(1);
    let stream = device
        .build_input_stream_raw(
            &config,
            format,
            move |data, _| {
                let _ = data_tx.try_send((
                    data.len(),
                    data.bytes().as_ptr() as usize % std::mem::align_of::<u64>(),
                    unsafe { requested() },
                    unsafe { returned() },
                ));
            },
            move |error| {
                let _ = error_tx.try_send(error.to_string());
            },
            None,
        )
        .unwrap();
    stream.play().unwrap();
    let (samples, alignment, requested, returned) =
        data_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    stream.pause().unwrap();
    drop(stream);
    assert!(returned > 0 && (returned as libc::c_ulong) < requested);
    assert_eq!(samples, returned as usize * channels);
    assert_eq!(alignment, 0);
    assert!(
        error_rx.try_recv().is_err(),
        "EAGAIN must not report capture failure"
    );
}

#[test]
#[ignore = "requires ALSA null and the test-only POLLERR overrun preload"]
fn cpal_alsa_pollerr_overrun_is_reported_and_prepared() {
    use super::RecordingManager;
    use crate::platform::Recorder;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    let arm = unsafe {
        libc::dlsym(
            libc::RTLD_DEFAULT,
            c"maus_test_inject_alsa_poll_xrun".as_ptr(),
        )
    };
    let preparations = unsafe {
        libc::dlsym(
            libc::RTLD_DEFAULT,
            c"maus_test_alsa_xrun_preparations".as_ptr(),
        )
    };
    assert!(
        !arm.is_null() && !preparations.is_null(),
        "POLLERR overrun preload required"
    );
    let arm: unsafe extern "C" fn() = unsafe { std::mem::transmute(arm) };
    let preparations: unsafe extern "C" fn() -> libc::c_int =
        unsafe { std::mem::transmute(preparations) };
    let manager = RecordingManager::new();
    let (captured_tx, captured_rx) = mpsc::sync_channel(1);
    manager
        .start(
            Some(Arc::new(move |_| {
                let _ = captured_tx.try_send(());
            })),
            None,
        )
        .unwrap();
    captured_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    unsafe { arm() };
    let deadline = Instant::now() + Duration::from_secs(2);
    while unsafe { preparations() } == 0 {
        assert!(
            Instant::now() < deadline,
            "POLLERR overrun was not prepared"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    let recording = manager.stop_for_handoff().unwrap();
    assert!(recording.capture_failed);
    assert!(!recording.audio.samples.is_empty());
    assert!(!manager.is_recording());
}

fn assert_alsa_disconnect(
    stream: &cpal::Stream,
    first_pcm: std::sync::mpsc::Receiver<()>,
    errors: &std::sync::mpsc::Receiver<cpal::StreamError>,
    arm: unsafe extern "C" fn(),
    observations: unsafe extern "C" fn() -> libc::c_uint,
) {
    use cpal::traits::StreamTrait;
    use std::time::Duration;
    stream.play().unwrap();
    first_pcm.recv_timeout(Duration::from_secs(2)).unwrap();
    unsafe { arm() };
    let error = errors.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(
        matches!(error, cpal::StreamError::DeviceNotAvailable),
        "expected a device disconnect, got {error:?}"
    );
    std::thread::sleep(Duration::from_millis(30));
    assert!(errors.try_recv().is_err());
    assert_eq!(unsafe { observations() }, 1);
}

fn check_alsa_capture_disconnect(disconnected_state: bool) {
    use cpal::traits::{DeviceTrait, HostTrait};
    use std::sync::mpsc;
    let arm = unsafe {
        libc::dlsym(
            libc::RTLD_DEFAULT,
            c"maus_test_inject_alsa_disconnect".as_ptr(),
        )
    };
    let observations = unsafe {
        libc::dlsym(
            libc::RTLD_DEFAULT,
            c"maus_test_alsa_disconnect_observations".as_ptr(),
        )
    };
    let clear = unsafe {
        libc::dlsym(
            libc::RTLD_DEFAULT,
            c"maus_test_clear_alsa_disconnect".as_ptr(),
        )
    };
    assert!(
        !arm.is_null() && !observations.is_null() && !clear.is_null(),
        "disconnect preload required"
    );
    let clear: unsafe extern "C" fn() = unsafe { std::mem::transmute(clear) };
    let arm: unsafe extern "C" fn() = unsafe { std::mem::transmute(arm) };
    let observations: unsafe extern "C" fn() -> libc::c_uint =
        unsafe { std::mem::transmute(observations) };
    let device = cpal::default_host().default_input_device().unwrap();
    let supported = device.default_input_config().unwrap();
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let (data_tx, data_rx) = mpsc::sync_channel(1);
    let (error_tx, error_rx) = mpsc::channel();
    let mut stream = device
        .build_input_stream_raw(
            &config,
            format,
            move |_, _| {
                let _ = data_tx.try_send(());
            },
            move |error| {
                let _ = error_tx.send(error);
            },
            None,
        )
        .unwrap();
    assert_alsa_disconnect(&stream, data_rx, &error_rx, arm, observations);
    #[allow(unreachable_patterns)]
    match stream.as_inner_mut() {
        cpal::platform::StreamInner::Alsa(inner) => {
            let result = inner.stop_input_for_release();
            if disconnected_state {
                assert!(
                    result.is_err(),
                    "unconfirmed native stop must remain retryable"
                );
                unsafe { clear() };
                inner.stop_input_for_release().unwrap();
            } else {
                result.unwrap();
            }
        }
        _ => panic!("expected ALSA stream"),
    }
}

#[test]
#[ignore = "requires ALSA null and the test-only POLLHUP preload"]
fn cpal_alsa_capture_disconnect_stops_worker() {
    check_alsa_capture_disconnect(false);
}

#[test]
#[ignore = "requires ALSA null and the test-only disconnected-state preload"]
fn cpal_alsa_capture_disconnected_state_stops_worker() {
    check_alsa_capture_disconnect(true);
}

#[test]
#[ignore = "requires ALSA null and the test-only disconnect-stage preload"]
fn cpal_alsa_disconnect_during_descriptor_fill_stops_worker() {
    check_alsa_capture_disconnect(false);
}

#[test]
#[ignore = "requires ALSA null and the test-only disconnect-stage preload"]
fn cpal_alsa_disconnect_during_revents_stops_worker() {
    check_alsa_capture_disconnect(false);
}

#[test]
#[ignore = "requires ALSA null and the test-only disconnect-stage preload"]
fn cpal_alsa_disconnect_during_status_stops_worker() {
    check_alsa_capture_disconnect(false);
}

#[test]
#[ignore = "requires ALSA null and the test-only disconnect-stage preload"]
fn cpal_alsa_disconnect_during_avail_stops_worker() {
    check_alsa_capture_disconnect(false);
}

#[test]
#[ignore = "requires ALSA null and the test-only disconnect-stage preload"]
fn cpal_alsa_disconnect_during_read_stops_worker() {
    check_alsa_capture_disconnect(false);
}

fn check_alsa_playback_disconnect() {
    use cpal::traits::{DeviceTrait, HostTrait};
    use std::sync::mpsc;

    let arm = unsafe {
        libc::dlsym(
            libc::RTLD_DEFAULT,
            c"maus_test_inject_alsa_disconnect".as_ptr(),
        )
    };
    let observations = unsafe {
        libc::dlsym(
            libc::RTLD_DEFAULT,
            c"maus_test_alsa_disconnect_observations".as_ptr(),
        )
    };
    assert!(
        !arm.is_null() && !observations.is_null(),
        "disconnect preload required"
    );
    let arm: unsafe extern "C" fn() = unsafe { std::mem::transmute(arm) };
    let observations: unsafe extern "C" fn() -> libc::c_uint =
        unsafe { std::mem::transmute(observations) };
    let device = cpal::default_host().default_output_device().unwrap();
    let supported = device.default_output_config().unwrap();
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let (data_tx, data_rx) = mpsc::sync_channel(1);
    let (error_tx, error_rx) = mpsc::channel();
    let stream = device
        .build_output_stream_raw(
            &config,
            format,
            move |_, _| {
                let _ = data_tx.try_send(());
            },
            move |error| {
                let _ = error_tx.send(error);
            },
            None,
        )
        .unwrap();
    assert_alsa_disconnect(&stream, data_rx, &error_rx, arm, observations);
    drop(stream);
}

#[test]
#[ignore = "requires ALSA null and the test-only disconnect-stage preload"]
fn cpal_alsa_playback_disconnect_during_write_stops_worker() {
    check_alsa_playback_disconnect();
}

#[test]
#[ignore = "requires ALSA null and the test-only disconnect-stage preload"]
fn cpal_alsa_playback_disconnect_during_recovery_stops_worker() {
    check_alsa_playback_disconnect();
}

#[test]
#[ignore = "requires ALSA null and the test-only POLLHUP preload"]
fn cpal_alsa_disconnect_preserves_incomplete_recording() {
    use super::RecordingManager;
    use crate::platform::Recorder;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    let arm = unsafe {
        libc::dlsym(
            libc::RTLD_DEFAULT,
            c"maus_test_inject_alsa_disconnect".as_ptr(),
        )
    };
    assert!(!arm.is_null(), "disconnect preload required");
    let arm: unsafe extern "C" fn() = unsafe { std::mem::transmute(arm) };
    let manager = RecordingManager::new();
    let (captured_tx, captured_rx) = mpsc::sync_channel(1);
    manager
        .start(
            Some(Arc::new(move |_| {
                let _ = captured_tx.try_send(());
            })),
            None,
        )
        .unwrap();
    captured_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    unsafe { arm() };
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let failed = manager
            .worker
            .call(|recorder| {
                recorder
                    .inner
                    .lock()
                    .unwrap()
                    .as_ref()
                    .unwrap()
                    .sink
                    .as_ref()
                    .unwrap()
                    .fault_token()
                    .is_some()
            })
            .unwrap();
        if failed {
            break;
        }
        assert!(Instant::now() < deadline, "disconnect was not reported");
        std::thread::sleep(Duration::from_millis(5));
    }
    let recording = manager.stop_for_handoff().unwrap();
    assert!(recording.capture_failed);
    assert!(!recording.audio.samples.is_empty());
    assert!(!manager.is_recording());
}

#[test]
#[ignore = "requires ALSA null and the test-only read XRUN preload"]
fn cpal_alsa_read_overrun_restarts_and_reports_loss() {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use std::sync::atomic::AtomicUsize;
    use std::time::{Duration, Instant};

    let symbol = |name: &std::ffi::CStr| unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) };
    let arm = symbol(c"maus_test_inject_read_xrun");
    let prepares = symbol(c"maus_test_read_xrun_preparations");
    let starts = symbol(c"maus_test_read_xrun_starts");
    assert!(!arm.is_null() && !prepares.is_null() && !starts.is_null());
    let arm: unsafe extern "C" fn() = unsafe { std::mem::transmute(arm) };
    let prepares: unsafe extern "C" fn() -> libc::c_int = unsafe { std::mem::transmute(prepares) };
    let starts: unsafe extern "C" fn() -> libc::c_int = unsafe { std::mem::transmute(starts) };
    let device = cpal::default_host().default_input_device().unwrap();
    let supported = device.default_input_config().unwrap();
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let captured = Arc::new(AtomicUsize::new(0));
    let errors = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&captured);
    let observed_errors = Arc::clone(&errors);
    let stream = device
        .build_input_stream_raw(
            &config,
            format,
            move |_, _| {
                observed.fetch_add(1, Ordering::SeqCst);
            },
            move |_| {
                observed_errors.fetch_add(1, Ordering::SeqCst);
            },
            None,
        )
        .unwrap();
    stream.play().unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    while captured.load(Ordering::SeqCst) == 0 {
        assert!(Instant::now() < deadline);
        std::thread::yield_now();
    }
    unsafe { arm() };
    while unsafe { starts() } == 0 {
        assert!(Instant::now() < deadline, "read overrun was not restarted");
        std::thread::yield_now();
    }
    assert_eq!(unsafe { prepares() }, 1);
    assert_eq!(unsafe { starts() }, 1);
    assert!(errors.load(Ordering::SeqCst) > 0);
    let after_restart = captured.load(Ordering::SeqCst);
    while captured.load(Ordering::SeqCst) == after_restart {
        assert!(Instant::now() < deadline, "capture did not resume");
        std::thread::yield_now();
    }
    drop(stream);
}

#[test]
#[ignore = "requires ALSA null and the test-only overrun preload"]
fn cpal_alsa_overrun_marks_the_captured_prefix_incomplete() {
    use super::RecordingManager;
    use crate::platform::Recorder;
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};

    let symbol = unsafe {
        libc::dlsym(
            libc::RTLD_DEFAULT,
            c"maus_test_inject_alsa_overrun".as_ptr(),
        )
    };
    assert!(!symbol.is_null(), "test-only ALSA preload is required");
    let inject: unsafe extern "C" fn() = unsafe { std::mem::transmute(symbol) };
    let manager = RecordingManager::new();
    let (captured_tx, captured_rx) = mpsc::sync_channel(1);
    manager
        .start(
            Some(Arc::new(move |_| {
                let _ = captured_tx.try_send(());
            })),
            None,
        )
        .unwrap();
    captured_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    unsafe { inject() };
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let failed = manager
            .worker
            .call(|recorder| {
                recorder
                    .inner
                    .lock()
                    .unwrap()
                    .as_ref()
                    .unwrap()
                    .sink
                    .as_ref()
                    .unwrap()
                    .fault_token()
                    .is_some()
            })
            .unwrap();
        if failed {
            break;
        }
        assert!(Instant::now() < deadline, "overrun was not reported");
        thread::sleep(Duration::from_millis(10));
    }
    let recording = manager.stop_for_handoff().unwrap();
    assert!(recording.capture_failed);
    assert!(!recording.audio.samples.is_empty());
    assert!(!manager.is_recording());
}
