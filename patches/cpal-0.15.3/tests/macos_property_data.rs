// Portable tests for the bounds checks used by the macOS CoreAudio backend.
#[path = "../src/host/coreaudio/macos/property_data.rs"]
mod property_data;

#[test]
fn enumeration_never_constructs_a_temporary_capture_unit() {
    let source = include_str!("../src/host/coreaudio/macos/mod.rs");
    let enumeration = source
        .split_once("fn supported_configs(")
        .unwrap()
        .1
        .split_once("impl fmt::Debug for Device")
        .unwrap()
        .0;
    assert!(enumeration.contains("get_device_buffer_frame_size_range(self.audio_device_id)"));
    assert!(!enumeration.contains("input_unit_for_build("));
    assert!(!enumeration.contains("AudioUnit::new("));
}

#[test]
fn sample_rate_setter_uses_a_single_f64_not_an_entire_range_array() {
    let source = include_str!("../src/host/coreaudio/macos/mod.rs");
    let setter = source
        .split_once("fn set_sample_rate(")
        .unwrap()
        .1
        .split_once("fn get_device_buffer_frame_size_range(")
        .unwrap()
        .0;
    assert!(setter.contains("mem::size_of::<f64>() as u32"));
    assert!(setter.contains("(&requested_rate as *const f64).cast()"));
    assert!(setter.contains("property_data::supports_rate("));
}
