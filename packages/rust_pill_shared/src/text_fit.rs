//! Fitting a string to a pixel width, given a way to measure it.
//!
//! The three pill crates each have their own text measurement -- cairo
//! `text_extents` on Linux, `NSString.size` on macOS, `DrawTextW` on Windows --
//! and none of those types can live in this crate, which has no dependencies by
//! design. So the fitting logic takes the measurement as a callback and the
//! crates pass theirs in. One implementation, three callers, no duplicated
//! geometry.

/// The longest prefix of `text` that fits within `max_w`, plus `suffix` when
/// anything was dropped.
///
/// `suffix` is counted against the budget only when it is actually shown, so a
/// string that already fits is returned byte-for-byte. Returns an empty string
/// when even `suffix` is too wide, because a row that overruns its neighbours is
/// the failure this exists to prevent.
///
/// `measure` must be monotonic in the length of its argument -- a real font's
/// advance widths are, so appending a character never narrows the result. That is
/// what lets the search below be a binary search rather than a linear scan.
pub fn elide_to_width<F>(text: &str, max_w: f64, suffix: &str, measure: F) -> String
where
    F: Fn(&str) -> f64,
{
    if max_w <= 0.0 {
        return String::new();
    }
    if measure(text) <= max_w {
        return text.to_string();
    }

    let suffix_w = measure(suffix);
    if suffix_w > max_w {
        // Not even the ellipsis fits. Nothing is drawn rather than something
        // drawn over whatever is next to it.
        return String::new();
    }

    let chars: Vec<char> = text.chars().collect();
    // Largest prefix length whose rendered width, with the suffix, still fits.
    let (mut lo, mut hi) = (0usize, chars.len());
    while lo < hi {
        let mid = lo + (hi - lo).div_ceil(2);
        let mut candidate: String = chars[..mid].iter().collect();
        candidate.push_str(suffix);
        if measure(&candidate) <= max_w {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }

    let mut out: String = chars[..lo].iter().collect();
    out.push_str(suffix);
    out
}

#[cfg(test)]
mod tests {
    use super::elide_to_width;

    /// One unit per character: makes the arithmetic in the assertions exact.
    fn per_char(s: &str) -> f64 {
        s.chars().count() as f64
    }

    /// Stands in for a proportional font: 'i' is narrow, 'W' is wide.
    fn proportional(s: &str) -> f64 {
        s.chars()
            .map(|c| match c {
                'i' | 'l' | '.' => 1.0,
                'W' | 'M' => 9.0,
                _ => 5.0,
            })
            .sum()
    }

    #[test]
    fn a_string_that_fits_is_returned_unchanged() {
        // The suffix is not counted when nothing is dropped, so this fits
        // exactly at the boundary with room to spare for the suffix.
        assert_eq!(elide_to_width("abcd", 4.0, "...", per_char), "abcd");
        assert_eq!(elide_to_width("abcd", 40.0, "...", per_char), "abcd");
        assert_eq!(elide_to_width("", 0.0, "...", per_char), "");
    }

    #[test]
    fn a_string_that_does_not_fit_gains_the_suffix_and_never_exceeds_max_w() {
        // 4 prefix chars + "..." = 7 units against a 6-unit budget, so it drops
        // to 3 + "..." = 6.
        assert_eq!(elide_to_width("abcdefgh", 6.0, "...", per_char), "abc...");
        for width in 0..=12 {
            let out = elide_to_width("abcdefghijklmnop", width as f64, "...", per_char);
            assert!(
                per_char(&out) <= width as f64,
                "{out:?} is {width} units over a {width} budget"
            );
        }
    }

    #[test]
    fn a_budget_too_small_for_the_suffix_yields_nothing() {
        // "..." alone is 3 units, so a 2-unit budget has no honest answer and the
        // row is left empty rather than overrunning its neighbour.
        assert_eq!(elide_to_width("abcdef", 2.0, "...", per_char), "");
        assert_eq!(elide_to_width("abcdef", 0.0, "...", per_char), "");
        assert_eq!(elide_to_width("abcdef", -5.0, "...", per_char), "");
    }

    #[test]
    fn truncation_lands_on_a_character_boundary_for_multi_byte_text() {
        // The defect this exists alongside: slicing at a byte offset inside a
        // multi-byte character. "日本語テキスト" is 21 bytes in 7 characters.
        let text = "日本語テキスト";
        assert_eq!(text.len(), 21);
        assert_eq!(text.chars().count(), 7);
        let out = elide_to_width(text, 4.0, "…", per_char);
        assert_eq!(out, "日本語…");
        assert_eq!(out.chars().count(), 4);
    }

    #[test]
    fn works_with_a_proportional_measure_rather_than_a_char_count() {
        // "WWWWW" is 45 units wide and "iiiii" is 5, so a budget that fits the
        // narrow string must still shorten the wide one. A char-count
        // implementation would treat both as five characters.
        let wide = "WWWWW";
        let narrow = "iiiii";
        assert!(proportional(wide) > 20.0);
        assert!(proportional(narrow) < 10.0);
        assert_eq!(elide_to_width(narrow, 20.0, "…", proportional), narrow);
        let out = elide_to_width(wide, 20.0, "…", proportional);
        assert!(proportional(&out) <= 20.0, "{out:?} overran the budget");
        assert!(out.ends_with('…'));
    }

    /// The review hint and the button row share one line, and three locales
    /// overflowed it.
    ///
    /// Widths are measured from `apps/desktop/src/assets/fonts/satoshi/
    /// Satoshi-Medium.ttf` (unitsPerEm 1000) at the 11px the draw sites use,
    /// summing `hmtx` advance widths through `cmap` — the same arithmetic the
    /// platform text APIs perform, minus kerning, which these strings do not
    /// trigger. `row` is the button row: each caption `(text + 20).max(64)` plus
    /// a 6px gap.
    ///
    /// The regression this pins: the hint used to be drawn before the buttons
    /// were laid out, so it had no idea how much room they left. French overran
    /// the leftmost button by 35.7px, German by 32.6px, and Brazilian Portuguese
    /// by 1.0px — which is the one a two-locale spot check misses.
    #[test]
    fn no_locale_hint_overruns_the_review_button_row() {
        const PANEL: f64 = 572.0;
        const INSET: f64 = 24.0;
        const GAP: f64 = 6.0;
        // (locale, hint px, button row px) -- all ten shipped locales.
        const LOCALES: &[(&str, f64, f64)] = &[
            ("en", 182.1, 274.0),
            ("de", 261.0, 295.7),
            ("es", 215.4, 274.7),
            ("fr", 285.7, 274.0),
            ("it", 227.7, 274.0),
            ("ko", 137.8, 274.0),
            ("pt", 225.1, 274.7),
            ("pt-BR", 244.3, 274.7),
            ("zh-CN", 98.3, 274.0),
            ("zh-TW", 98.3, 274.0),
        ];

        // One definition of the budget, used by both the per-locale check and
        // the named set below. Written twice, a mutation of one copy leaves the
        // other still asserting -- which is how `GAP` went missing from the
        // draw site without this test noticing.
        let budget_for = |row_px: f64| (PANEL - INSET - row_px) - GAP - INSET;

        for &(loc, hint_px, row_px) in LOCALES {
            let budget = budget_for(row_px);
            assert!(
                budget > 0.0,
                "{loc}: the button row leaves no room for a hint at all \
                 (row {row_px}px of a {PANEL}px panel)"
            );
            if hint_px > budget {
                // Overflows today, so the hint must be shortened. Per-character
                // widths are unknown here, so elide against a proportional
                // stand-in: what is pinned is that the draw site consults the
                // budget, not the exact prefix a given font chooses.
                let unit = hint_px / 40.0;
                let scale = |s: &str| s.chars().count() as f64 * unit;
                let out = elide_to_width(&"x".repeat(60), budget, "…", scale);
                assert!(
                    scale(&out) <= budget,
                    "{loc}: {out:?} is still {}px over",
                    scale(&out) - budget
                );
                assert!(out.ends_with('…'), "{loc}: overflow was not marked");
            }
        }

        // And the three that overflow are named, so a new locale that joins them
        // cannot pass unnoticed by only checking French and German.
        let overflowing: Vec<&str> = LOCALES
            .iter()
            .filter(|(_, hint_px, row_px)| *hint_px > budget_for(*row_px))
            .map(|(loc, _, _)| *loc)
            .collect();
        assert_eq!(overflowing, ["de", "fr", "pt-BR"]);
    }

    #[test]
    fn a_single_character_wider_than_the_budget_leaves_only_the_suffix() {
        // "W" is 9 units and the budget is 8, so no prefix of the text fits, but
        // "…" is 5 and does. `lo` starts at 0 and `mid` never evaluates the
        // empty prefix, so this terminates on the first iteration rather than
        // spinning -- which is the property worth pinning.
        assert_eq!(proportional("W"), 9.0);
        assert_eq!(elide_to_width("W", 8.0, "…", proportional), "…");
        // And a budget that cannot fit even the suffix falls back to nothing,
        // which is the neighbouring case rather than a truncation.
        assert_eq!(elide_to_width("W", 2.0, "…", proportional), "");
    }
}
