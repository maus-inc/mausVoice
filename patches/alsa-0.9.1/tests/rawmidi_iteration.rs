//! Run with the isolated rawmidi control fixture preloaded; see PATCH.md.

use alsa::{rawmidi::Iter, Ctl, Direction};

#[test]
#[ignore = "requires the rawmidi control preload fixture"]
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
#[ignore = "requires the rawmidi control preload fixture"]
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
