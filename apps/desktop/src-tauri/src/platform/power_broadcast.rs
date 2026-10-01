//! The console-display power setting, as a decision this crate can test anywhere.
//!
//! `PBT_POWERSETTINGCHANGE` arrives as a borrowed `POWERBROADCAST_SETTING`
//! whose `Data` tail is only `DataLength` bytes long. The watcher that receives
//! it is a `cfg(windows)` message pump, and no CI job could run `cargo test`
//! there -- the test binary links WebView2, which a bare runner does not have --
//! so anything decided in that module was decided with no test at all.
//!
//! This module holds that decision and nothing else. It has no `cfg` gate and no
//! Windows dependency, so it compiles and is unit-tested on every platform the
//! crate is built for. Reading the fields out of the raw message stays in the
//! watcher, which is the only place that knows the layout is unaligned and
//! truncated; it hands the values here and acts on the answer.

/// `GUID_CONSOLE_DISPLAY_STATE`, the setting the resume watcher registers.
///
/// Kept as the `u128` the Win32 GUID is written as, so the watcher and this
/// module cannot disagree about which setting is meant: the watcher builds its
/// `GUID` from this constant rather than declaring a second copy of it.
pub const CONSOLE_DISPLAY_STATE_GUID: u128 = 0x6FE69556_704A_47A0_8F24_C28D936FDA47;

/// The bytes `CONSOLE_DISPLAY_STATE_GUID` occupies in memory, which is what a
/// `POWERBROADCAST_SETTING` read out of a message actually holds.
///
/// This is not `to_le_bytes`. A Win32 `GUID` is `{ DWORD; WORD; WORD; BYTE[8] }`
/// laid out little-endian for the three integers and verbatim for the eight
/// bytes, whereas `to_le_bytes` on the `u128` reverses all sixteen. Only the
/// first eight are reversed here; the tail is already the byte order it is
/// stored in.
pub const fn console_display_state_guid_bytes() -> [u8; 16] {
    // 6FE69556-704A-47A0-8F24-C28D936FDA47, as its canonical string bytes.
    let canonical = CONSOLE_DISPLAY_STATE_GUID.to_be_bytes();
    [
        // Data1, little-endian.
        canonical[3],
        canonical[2],
        canonical[1],
        canonical[0],
        // Data2, little-endian.
        canonical[5],
        canonical[4],
        // Data3, little-endian.
        canonical[7],
        canonical[6],
        // Data4, eight raw bytes.
        canonical[8],
        canonical[9],
        canonical[10],
        canonical[11],
        canonical[12],
        canonical[13],
        canonical[14],
        canonical[15],
    ]
}

/// The byte value the setting reports when the display is on. Any other value is
/// a display state change that is not this one.
pub const CONSOLE_DISPLAY_ON: u32 = 1;

/// How many bytes of `Data` the setting carries. A different length is a
/// payload this watcher is not entitled to read, whatever its GUID says.
pub const CONSOLE_DISPLAY_STATE_DATA_LENGTH: u32 = 4;

/// What a `PBT_POWERSETTINGCHANGE` for the console-display state turned out to
/// report.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConsoleDisplayPower {
    /// The registered setting came back on. This is the wake signal.
    On,
    /// The registered setting reported the display going off.
    Off,
    /// The message is for a different registered power setting.
    OtherSetting,
    /// The payload carries no display state to read, either because it declares
    /// a length that is not the one this setting uses or because the byte is
    /// simply absent.
    NoData,
}

/// Whether a `PBT_POWERSETTINGCHANGE` reports the registered console-display
/// setting coming back on, and if not, why.
///
/// `setting` is the message's GUID in memory order and `data` its display-state
/// byte. The GUID is checked first so a message for another registered setting
/// is never answered with this one's answer; the length is checked next because
/// it is what says how much data follows the fixed header. `data` is `None`
/// when the payload does not contain the byte at all.
pub fn console_display_power(
    setting: &[u8; 16],
    data_length: u32,
    data: Option<u8>,
) -> ConsoleDisplayPower {
    if *setting != console_display_state_guid_bytes() {
        return ConsoleDisplayPower::OtherSetting;
    }
    if data_length != CONSOLE_DISPLAY_STATE_DATA_LENGTH || data.is_none() {
        return ConsoleDisplayPower::NoData;
    }
    if data == Some(CONSOLE_DISPLAY_ON as u8) {
        ConsoleDisplayPower::On
    } else {
        ConsoleDisplayPower::Off
    }
}

#[cfg(test)]
mod tests {
    use super::{
        console_display_power, console_display_state_guid_bytes, ConsoleDisplayPower,
        CONSOLE_DISPLAY_ON, CONSOLE_DISPLAY_STATE_DATA_LENGTH, CONSOLE_DISPLAY_STATE_GUID,
    };

    fn console_display_guid() -> [u8; 16] {
        console_display_state_guid_bytes()
    }

    const OTHER_SETTING: [u8; 16] = [0; 16];

    #[test]
    fn the_display_coming_back_on_is_a_wake() {
        assert_eq!(
            console_display_power(
                &console_display_guid(),
                CONSOLE_DISPLAY_STATE_DATA_LENGTH,
                Some(CONSOLE_DISPLAY_ON as u8),
            ),
            ConsoleDisplayPower::On,
        );
    }

    #[test]
    fn the_display_going_off_is_not_a_wake() {
        assert_eq!(
            console_display_power(
                &console_display_guid(),
                CONSOLE_DISPLAY_STATE_DATA_LENGTH,
                Some(0),
            ),
            ConsoleDisplayPower::Off,
        );
    }

    /// The reported length is what says how much data follows the fixed header,
    /// so a length that is not the one this watcher registered for is not a
    /// value it may read.
    #[test]
    fn a_zero_or_unexpected_data_length_carries_no_data() {
        for data_length in [0u32, 1, 2, 3, 5, 8] {
            assert_eq!(
                console_display_power(
                    &console_display_guid(),
                    data_length,
                    Some(CONSOLE_DISPLAY_ON as u8),
                ),
                ConsoleDisplayPower::NoData,
                "DataLength {data_length} is not the registered setting's width",
            );
        }
    }

    /// A payload whose length promises the byte but does not contain one is the
    /// same case: there is no display state to answer with.
    #[test]
    fn a_missing_display_state_byte_carries_no_data() {
        assert_eq!(
            console_display_power(
                &console_display_guid(),
                CONSOLE_DISPLAY_STATE_DATA_LENGTH,
                None,
            ),
            ConsoleDisplayPower::NoData,
        );
    }

    /// A message for a different registered setting carries the same header
    /// shape, and answering it with this setting's answer is how a resume gets
    /// emitted for an event that was never one.
    #[test]
    fn another_registered_setting_is_not_answered() {
        assert_eq!(
            console_display_power(
                &OTHER_SETTING,
                CONSOLE_DISPLAY_STATE_DATA_LENGTH,
                Some(CONSOLE_DISPLAY_ON as u8),
            ),
            ConsoleDisplayPower::OtherSetting,
        );
    }

    /// The GUID is checked before the length, so a message for another setting
    /// is reported as such even when its payload is unreadable.
    #[test]
    fn the_setting_is_identified_before_the_payload_is_trusted() {
        assert_eq!(
            console_display_power(&OTHER_SETTING, 0, None),
            ConsoleDisplayPower::OtherSetting,
        );
    }

    /// The GUID a `POWERBROADCAST_SETTING` carries is read straight out of the
    /// message, so the bytes this module compares against have to be the ones a
    /// Win32 `GUID` actually occupies. `to_le_bytes` on the `u128` is not that:
    /// it reverses the eight raw `Data4` bytes too.
    #[test]
    fn the_guid_constant_is_in_win32_memory_order() {
        assert_eq!(
            console_display_state_guid_bytes(),
            [
                0x56, 0x95, 0xE6, 0x6F, 0x4A, 0x70, 0xA0, 0x47, 0x8F, 0x24, 0xC2, 0x8D, 0x93, 0x6F,
                0xDA, 0x47,
            ],
        );
        // 6FE69556-704A-47A0-8F24-C28D936FDA47, as its canonical string bytes.
        assert_eq!(
            CONSOLE_DISPLAY_STATE_GUID.to_be_bytes(),
            [
                0x6F, 0xE6, 0x95, 0x56, 0x70, 0x4A, 0x47, 0xA0, 0x8F, 0x24, 0xC2, 0x8D, 0x93, 0x6F,
                0xDA, 0x47,
            ],
        );
    }
}
