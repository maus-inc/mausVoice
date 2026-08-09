#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PasteKeystroke {
    CtrlV,
    CtrlShiftV,
    ShiftInsert,
}

pub fn parse_paste_keystroke(keybind: Option<&str>) -> PasteKeystroke {
    match keybind {
        Some("ctrl+v") => PasteKeystroke::CtrlV,
        Some("ctrl+shift+v") => PasteKeystroke::CtrlShiftV,
        _ => PasteKeystroke::ShiftInsert,
    }
}

#[cfg(test)]
mod parse_tests {
    use super::*;

    #[test]
    fn default_is_shift_insert() {
        assert_eq!(parse_paste_keystroke(None), PasteKeystroke::ShiftInsert);
        assert_eq!(
            parse_paste_keystroke(Some("")),
            PasteKeystroke::ShiftInsert
        );
        assert_eq!(
            parse_paste_keystroke(Some("unknown")),
            PasteKeystroke::ShiftInsert
        );
    }

    #[test]
    fn ctrl_v_still_resolves_when_explicit() {
        assert_eq!(
            parse_paste_keystroke(Some("ctrl+v")),
            PasteKeystroke::CtrlV
        );
    }

    #[test]
    fn terminal_binding_resolves() {
        assert_eq!(
            parse_paste_keystroke(Some("ctrl+shift+v")),
            PasteKeystroke::CtrlShiftV
        );
    }

    #[test]
    fn shift_insert_is_explicit_and_default() {
        assert_eq!(
            parse_paste_keystroke(Some("shift+insert")),
            PasteKeystroke::ShiftInsert
        );
    }
}

