//! Portable checks for the CoreAudio callback action-flags lifetime.
#![allow(dead_code, non_snake_case)]
pub mod flags_sys {
    pub type AudioUnitRenderActionFlags = u32;
}
pub mod action_flags {
    #[derive(Clone, Copy, Debug, PartialEq)]
    pub struct ActionFlags(pub u32);
    impl ActionFlags {
        pub fn from_bits_truncate(bits: u32) -> Self {
            Self(bits & 15)
        }
        pub fn bits(self) -> u32 {
            self.0
        }
        pub fn is_empty(self) -> bool {
            self.0 == 0
        }
        pub fn is_all(self) -> bool {
            self.0 == 15
        }
        pub fn intersects(self, other: Self) -> bool {
            self.0 & other.0 != 0
        }
        pub fn contains(self, other: Self) -> bool {
            self.0 & other.0 == other.0
        }
        pub fn insert(&mut self, other: Self) {
            self.0 |= other.0;
        }
        pub fn remove(&mut self, other: Self) {
            self.0 &= !other.0;
        }
        pub fn toggle(&mut self, other: Self) {
            self.0 ^= other.0;
        }
    }
}
#[path = "../src/audio_unit/render_callback/action_flags_handle.rs"]
mod action_flags_handle;

#[cfg(test)]
mod tests {
    #[test]
    fn source_binds_flags_to_each_callback_invocation() {
        let source = include_str!("../src/audio_unit/render_callback.rs");
        assert!(source.contains("pub struct Args<'a, D>"));
        assert!(source.contains("for<'a> FnMut(Args<'a, D>)"));
        assert!(!source.contains("unsafe impl Send for Handle"));
    }
    #[test]
    fn mutates_only_the_live_callback_flags() {
        use super::{action_flags::ActionFlags, action_flags_handle::Handle};
        let mut native = 1_u32;
        {
            let mut handle = unsafe { Handle::from_ptr(&mut native) };
            assert_eq!(handle.bits(), 1);
            assert!(handle.contains(ActionFlags(1)));
            handle.insert(ActionFlags(2));
            assert!(handle.intersects(ActionFlags(2)));
            handle.toggle(ActionFlags(1));
            handle.remove(ActionFlags(2));
            assert!(handle.is_empty());
            handle.insert(ActionFlags(15));
            assert!(handle.is_all());
        }
        assert_eq!(native, 15);
    }
}
