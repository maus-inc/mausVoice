//! Which Enter presses the pill may treat as a submit.
//!
//! Plain Enter submits. A review edit also needs Shift+Enter for a line break,
//! and each platform states that rule at its own key handler because GTK always
//! gives Shift+Enter to the buffer while AppKit and Win32 only do so during a
//! review. The one rule every platform shares is that a command modifier other
//! than Shift never submits: a desktop or input method may bind Ctrl+Enter,
//! Alt+Enter or Super+Enter to something else, and a review that sent on those
//! would answer the desktop the user never confirmed. Lock modifiers such as
//! Caps Lock and Num Lock leave the shortcut alone.

/// The command modifiers a platform saw on the Enter press.
#[derive(Debug, Clone, Copy, Default, Eq, PartialEq)]
pub struct SubmitModifiers {
    pub control: bool,
    pub alt: bool,
    pub meta: bool,
}

/// Whether no command modifier is down, so the platform's own Shift rule decides.
pub fn enter_submits(modifiers: SubmitModifiers) -> bool {
    !(modifiers.control || modifiers.alt || modifiers.meta)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn modifiers(control: bool, alt: bool, meta: bool) -> SubmitModifiers {
        SubmitModifiers { control, alt, meta }
    }

    #[test]
    fn enter_submits_without_a_command_modifier() {
        assert!(enter_submits(modifiers(false, false, false)));
    }

    #[test]
    fn each_command_modifier_blocks_submit() {
        assert!(!enter_submits(modifiers(true, false, false)));
        assert!(!enter_submits(modifiers(false, true, false)));
        assert!(!enter_submits(modifiers(false, false, true)));
    }
}
