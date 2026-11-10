//! Run with the isolated ALSA query fixture preloaded; see PATCH.md.

use alsa::{poll::Descriptors, rawmidi::Iter, Ctl, Direction};

#[test]
#[ignore = "requires the ALSA query preload fixture"]
fn ctl_poll_count_failure_is_not_a_huge_allocation() {
    let ctl = Ctl::new("fixture", false).unwrap();
    assert_eq!(ctl.count(), 0);
    assert_eq!(ctl.try_count().unwrap_err().errno(), libc::EIO);
    assert_eq!(ctl.get().unwrap_err().errno(), libc::EIO);
}

#[test]
#[ignore = "requires the ALSA query preload fixture"]
fn pcm_poll_count_failure_is_not_a_huge_allocation() {
    let pcm = alsa::PCM::new("fixture", Direction::Capture, false).unwrap();
    assert_eq!(pcm.count(), 0);
    assert_eq!(pcm.try_count().unwrap_err().errno(), libc::EIO);
    assert_eq!(pcm.get().unwrap_err().errno(), libc::EIO);
}

#[test]
#[ignore = "requires the ALSA query preload fixture"]
fn lists_one_direction_devices_and_does_not_reuse_stale_counts_after_an_error() {
    std::env::remove_var("MIDI_EMPTY_RUN");
    let ctl = Ctl::new("fixture", false).unwrap();
    let mut iter = Iter::new(&ctl);
    for (device, direction, subdevice) in [
        (0, Direction::Playback, 0),
        (0, Direction::Playback, 1),
        (1, Direction::Capture, 0),
    ] {
        let info = iter.next().unwrap().unwrap();
        assert_eq!(
            (info.get_device(), info.get_stream(), info.get_subdevice()),
            (device, direction, subdevice)
        );
    }
    assert_eq!(iter.next().unwrap().err().unwrap().errno(), libc::EIO);
    let info = iter.next().unwrap().unwrap();
    assert_eq!(
        (info.get_device(), info.get_stream(), info.get_subdevice()),
        (3, Direction::Playback, 0)
    );
    assert!(iter.next().is_none());
}

#[test]
#[ignore = "requires the ALSA query preload fixture"]
fn enumeration_error_is_returned_once_then_iteration_ends() {
    std::env::set_var("MIDI_NEXT_ERROR", "1");
    let ctl = Ctl::new("fixture", false).unwrap();
    let mut iter = Iter::new(&ctl);
    assert_eq!(iter.next().unwrap().err().unwrap().errno(), libc::EIO);
    assert!(iter.next().is_none());
    assert!(iter.next().is_none());
    std::env::remove_var("MIDI_NEXT_ERROR");
}

#[test]
#[ignore = "requires the ALSA query preload fixture"]
fn skips_many_empty_devices_without_recursing() {
    std::env::set_var("MIDI_EMPTY_RUN", "1");
    let ctl = Ctl::new("fixture", false).unwrap();
    let mut iter = Iter::new(&ctl);
    let info = iter.next().unwrap().unwrap();
    assert_eq!(
        (info.get_device(), info.get_stream()),
        (100000, Direction::Playback)
    );
    assert!(iter.next().is_none());
    std::env::remove_var("MIDI_EMPTY_RUN");
}

#[test]
#[ignore = "requires the ALSA query preload fixture"]
fn finite_wait_timeouts_do_not_wrap_for_pcm_mixer_or_hctl() {
    let pcm = alsa::PCM::new("fixture", Direction::Capture, false).unwrap();
    let mixer = alsa::mixer::Mixer::open(false).unwrap();
    let hctl = alsa::hctl::HCtl::new("fixture", false).unwrap();
    let symbol = unsafe { libc::dlsym(libc::RTLD_DEFAULT, b"maus_test_last_wait_timeout\0".as_ptr().cast()) };
    assert!(!symbol.is_null(), "wait fixture required");
    let last_timeout: unsafe extern "C" fn() -> libc::c_int = unsafe { std::mem::transmute(symbol) };
    for (timeout, expected) in [(None, -1), (Some(0), 0), (Some(i32::MAX as u32), i32::MAX)] {
        pcm.wait(timeout).unwrap();
        assert_eq!(unsafe { last_timeout() }, expected);
        mixer.wait(timeout).unwrap();
        assert_eq!(unsafe { last_timeout() }, expected);
        hctl.wait(timeout).unwrap();
        assert_eq!(unsafe { last_timeout() }, expected);
    }
    for timeout in [i32::MAX as u32 + 1, u32::MAX] {
        let errors = [
            pcm.wait(Some(timeout)).map(|_| ()).map_err(|error| error.errno()),
            mixer.wait(Some(timeout)).map_err(|error| error.errno()),
            hctl.wait(Some(timeout)).map(|_| ()).map_err(|error| error.errno()),
        ];
        assert_eq!(errors, [Err(libc::EINVAL); 3]);
        assert_eq!(unsafe { last_timeout() }, i32::MAX, "rejected waits must not call ALSA");
    }
}
