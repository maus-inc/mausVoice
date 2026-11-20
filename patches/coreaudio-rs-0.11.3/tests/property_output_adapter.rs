//! Portable tests for the generic AudioUnit property output boundary.
#![allow(dead_code)]
#[derive(Debug, PartialEq)]
pub enum Error {
    Unspecified,
    Unknown(i32),
}
impl Error {
    pub fn from_os_status(status: i32) -> Result<(), Self> {
        if status == 0 {
            Ok(())
        } else {
            Err(Self::Unknown(status))
        }
    }
}
#[path = "../src/audio_unit/property_output.rs"]
mod property_output;

#[cfg(test)]
mod tests {
    #[test]
    fn generic_getters_are_unsafe_and_validate_output_length() {
        let source = include_str!("../src/audio_unit/mod.rs");
        assert_eq!(source.matches("pub unsafe fn get_property<T>").count(), 2);
        assert!(source.contains("pub unsafe fn audio_session_get_property<T>"));
        assert_eq!(source.matches("property_output::read").count(), 2);
        assert!(source.contains("self.checked_close != checked_close::CloseState::Open"));
    }
    #[test]
    fn reads_exactly_sized_initialized_values() {
        let result = unsafe {
            super::property_output::read::<u32>(|out, size| {
                assert_eq!(*size, 4);
                out.cast::<u32>().write(12345);
                0
            })
        };
        assert_eq!(result, Ok(12345));
    }
    #[test]
    fn rejects_short_and_oversized_responses_before_exposing_a_value() {
        for returned in [0, 1, 3, 5, u32::MAX] {
            let result = unsafe {
                super::property_output::read::<u32>(|out, size| {
                    out.cast::<u32>().write(12345);
                    *size = returned;
                    0
                })
            };
            assert_eq!(result, Err(super::Error::Unspecified));
        }
    }
    #[test]
    fn preserves_native_error_without_reading_output() {
        let result = unsafe { super::property_output::read::<u32>(|_, _| -7) };
        assert_eq!(result, Err(super::Error::Unknown(-7)));
    }
    #[test]
    fn rejects_zero_sized_types_without_calling_the_getter() {
        let result =
            unsafe { super::property_output::read::<()>(|_, _| panic!("unexpected native call")) };
        assert_eq!(result, Err(super::Error::Unspecified));
    }
}
