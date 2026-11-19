/// The first `max_chars` characters of `s`, or all of `s` when it is shorter.
///
/// Byte slicing (`&s[..8]`) panics whenever the index lands inside a multi-byte
/// character, so it is only safe on a string already known to be ASCII. The
/// strings this is used on are not: they are accessibility-tree titles, window
/// descriptions and dictation ids, any of which can carry an accent or CJK text
/// from the application being inspected or dictated. A panic in a logging or
/// dump path takes down the caller, which is the worst possible place for one.
///
/// Counting characters rather than bytes also means the cap means what it says.
/// A byte cap would cut earlier on non-ASCII text, so the same limit would
/// produce shorter output depending on the script.
pub fn truncate_chars(s: &str, max_chars: usize) -> &str {
    // `char_indices().nth(max_chars)` is the byte index one past the last
    // character to keep, so slicing there is on a boundary by construction.
    match s.char_indices().nth(max_chars) {
        Some((end, _)) => &s[..end],
        // `None` means `s` has `max_chars` characters or fewer.
        None => s,
    }
}

/// [`truncate_chars`] to `max_chars` characters, appending `suffix` only when
/// characters were actually dropped.
///
/// Whether to add the suffix is decided by comparing the truncated result against
/// the input, never by testing `input.len() > max_chars`. Those two disagree as
/// soon as the text is not ASCII, and the disagreement is silent in both
/// directions: `len()` counts bytes, so 300 CJK characters is ~834 bytes and a
/// byte guard at 800 announces a truncation that never happened, while a byte cap
/// small enough to stay ASCII-shaped lets non-ASCII text run to several times the
/// width the limit is there to bound. Every call site here caps characters, so the
/// guard has to count characters too — and reading the outcome off the result is
/// the only way to keep the two from drifting apart again.
pub fn truncate_display(s: &str, max_chars: usize, suffix: &str) -> String {
    let cut = truncate_chars(s, max_chars);
    // Truncation only ever removes whole characters, so a shorter result means
    // characters were dropped.
    if cut.len() < s.len() {
        format!("{cut}{suffix}")
    } else {
        s.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::{truncate_chars, truncate_display};

    #[test]
    fn returns_short_input_unchanged() {
        assert_eq!(truncate_chars("abc", 8), "abc");
        assert_eq!(truncate_chars("abc", 3), "abc");
        assert_eq!(truncate_chars("", 8), "");
    }

    #[test]
    fn zero_caps_yields_the_empty_string() {
        assert_eq!(truncate_chars("abc", 0), "");
        assert_eq!(truncate_chars("café", 0), "");
    }

    #[test]
    fn does_not_panic_on_multi_byte_characters() {
        // The defect this replaces: a byte index that lands mid-character.
        // "café" is 5 bytes and 4 characters, so `&s[..4]` splits the é.
        assert_eq!(truncate_chars("café", 4), "café");
        assert_eq!(truncate_chars("café", 3), "caf");
        // Every prefix length of a multi-byte string must be a valid `str`.
        let text = "naïve café 日本語テキスト";
        for chars in 0..=text.chars().count() + 2 {
            let cut = truncate_chars(text, chars);
            // The character count is the check that carries weight: it fails on
            // any byte-oriented implementation for every non-ASCII length.
            //
            // There is deliberately no `cut.is_char_boundary(cut.len())` assertion
            // here. `cut` is a `&str`, so its length is on a boundary by
            // construction and the call is `true` for every input — it read like
            // the panic guard it was meant to be while testing nothing. The
            // boundary property is structural (the slice comes from
            // `char_indices`), not something this test can observe.
            assert_eq!(cut.chars().count(), chars.min(text.chars().count()));
        }
    }

    #[test]
    fn display_suffix_is_omitted_when_nothing_is_dropped() {
        // The mismatch this replaces: `s.len() > max_chars` tested bytes against
        // a character cap. 300 CJK characters is 900 bytes, so a byte guard at
        // 800 took the truncation branch, `truncate_chars` returned all 300
        // characters untouched, and the output claimed a truncation that never
        // happened.
        let cjk: String = "日".repeat(300);
        assert_eq!(cjk.chars().count(), 300);
        assert!(cjk.len() > 800, "the byte guard would have misfired here");
        assert_eq!(truncate_display(&cjk, 800, "..."), cjk);

        // Short ASCII, and exactly at the cap, likewise get no suffix.
        assert_eq!(truncate_display("abc", 8, "..."), "abc");
        assert_eq!(truncate_display("abc", 3, "..."), "abc");
        assert_eq!(truncate_display("", 8, "..."), "");
    }

    #[test]
    fn display_appends_the_suffix_only_when_characters_are_dropped() {
        let text = "café 日本語 テキスト";
        let out = truncate_display(text, 4, "...");
        assert_eq!(out, "café...");
        assert_eq!(out.chars().count(), 7);

        // The width bound still holds in characters, which is the point of the
        // character cap: 100 characters of CJK is 300 bytes, and that is allowed.
        let cjk: String = "日".repeat(150);
        let out = truncate_display(&cjk, 100, "...");
        assert_eq!(out.chars().count(), 103);
        assert!(out.starts_with(&"日".repeat(100)));
    }

    #[test]
    fn counts_characters_not_bytes() {
        // 2 characters, 6 bytes. A byte cap of 6 would return everything and a
        // cap of 4 would panic; the character cap returns exactly two chars.
        let text = "日本";
        assert_eq!(text.len(), 6);
        assert_eq!(truncate_chars(text, 2), text);
        assert_eq!(truncate_chars(text, 1), "日");
    }

    #[test]
    fn handles_astral_plane_characters() {
        // Four bytes per character, so a byte-oriented cap of 8 would panic.
        let text = "🙂🙃";
        assert_eq!(text.len(), 8);
        assert_eq!(truncate_chars(text, 2), text);
        assert_eq!(truncate_chars(text, 1), "🙂");
    }
}
