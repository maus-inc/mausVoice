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

#[cfg(test)]
mod tests {
    use super::truncate_chars;

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
            assert!(
                cut.is_char_boundary(cut.len()),
                "cut at {chars} characters is not on a boundary"
            );
            assert_eq!(cut.chars().count(), chars.min(text.chars().count()));
        }
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
