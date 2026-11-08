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
