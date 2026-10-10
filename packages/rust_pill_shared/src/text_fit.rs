//! Fitting a string to a pixel width, given a way to measure it.
//!
//! The three pill crates each have their own text measurement -- cairo
//! `text_extents` on Linux, `NSString.size` on macOS, `DrawTextW` on Windows --
//! and none of those types can live in this crate, which has no dependencies by
//! design. So the fitting logic takes the measurement as a callback and the
//! crates pass theirs in. One implementation, three callers, no duplicated
//! geometry.

/// The width a locale hint may occupy beside the review-button row.
///
/// Lives here because all three pill crates computed this inline, identically, and a test in
/// this crate could not see any of them: the crates have no path back to `rust_pill_shared`'s
/// internals and `rust_pill_shared` has no dependency that could reach theirs. So a term
/// dropped at a draw site -- and `PERM_BUTTON_GAP` WAS dropped from one of them once -- left
/// every test in the repository green.
///
/// `buttons_left` is the left edge of the button row, `hint_x` where the hint begins, and
/// `button_gap` the spacing the caller reserves between buttons.
///
/// The gap is subtracted here as well as inside `buttons_left`, and that is not a double
/// count: `buttons_left` already carries `(n - 1)` gaps between the buttons, and this is the
/// one more the hint must leave before reaching the row. Dropping it lets the hint run into
/// that gap, which is a few pixels of overlap on a row that is already dense.
///
/// Clamped at zero, so a button row wider than the panel yields an empty budget and an empty
/// hint rather than a negative one passed to `elide_to_width`.
pub fn hint_budget(buttons_left: f64, hint_x: f64, button_gap: f64) -> f64 {
    (buttons_left - button_gap - hint_x).max(0.0)
}

/// The gap is subtracted on the draw sites' behalf. Deleting `- button_gap -` from
/// `hint_budget` is the regression the old comment claimed a test already covered: `PERM_BUTTON_GAP`
/// was once missing from a draw site and nothing failed. This is the test that would have.
#[test]
fn the_button_gap_is_subtracted_from_the_hint_budget() {
    let buttons_left = 400.0;
    let hint_x = 24.0;
    let with_gap = hint_budget(buttons_left, hint_x, 6.0);
    let without_gap = hint_budget(buttons_left, hint_x, 0.0);
    assert!(
        with_gap < without_gap,
        "the gap must come out of the budget: with it {with_gap}, without {without_gap}"
    );
    assert_eq!(with_gap, 370.0, "400 - 6 - 24");
    assert_eq!(without_gap, 376.0);
}

/// A row wider than the panel leaves no budget, and a negative one must never reach
/// `elide_to_width`: it is a pixel width, and the callers used to apply `.max(0.0)` at each
/// of the three call sites, which is three chances to forget.
#[test]
fn an_exhausted_or_negative_budget_clamps_to_zero() {
    assert_eq!(hint_budget(100.0, 94.0, 6.0), 0.0);
    assert_eq!(hint_budget(10.0, 200.0, 6.0), 0.0);
    assert_eq!(
        hint_budget(f64::NAN, 0.0, 6.0),
        0.0,
        "NaN must not pass through as a width"
    );
}

/// The wiring, not the arithmetic: each of the three draw sites has to call this.
///
/// STRUCTURAL, and labelled. The property that broke was never inside this function -- it was
/// that a draw site stopped subtracting the gap -- and no test in the repository could see a
/// draw site. So the call is asserted on the source of all three, which is the only instrument
/// available from a crate with no dependencies. Reading a draw site needs cairo and a display,
/// which is why there is no behavioural version to write instead.
///
/// This also pins that each passes its own `PERM_BUTTON_GAP` rather than a number typed in
/// here: the constant stays owned by each crate, and this is what would notice one of them
/// passing something else.
#[test]
fn all_three_draw_sites_compute_the_budget_through_this_function() {
    let manifest = env!("CARGO_MANIFEST_DIR");
    for crate_dir in ["rust_gtk_pill", "rust_macos_pill", "rust_windows_pill"] {
        let path = format!("../{crate_dir}/src/draw.rs");
        let source = std::fs::read_to_string(format!("{manifest}/{path}"))
            .unwrap_or_else(|err| panic!("read {path}: {err}"));
        let call = source
            .find("text_fit::hint_budget(")
            .unwrap_or_else(|| panic!("{path} does not call text_fit::hint_budget"));
        let window = &source[call..(call + 200).min(source.len())];
        assert!(
            window.contains("PERM_BUTTON_GAP"),
            "{path} must pass its own PERM_BUTTON_GAP, not a literal: found {:?}",
            &window[..window.len().min(90)]
        );
        assert!(
            !window.contains("buttons_left - PERM_BUTTON_GAP"),
            "{path} still computes the budget inline, so there are two definitions again"
        );
    }
}

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
        // the named set below, so a mutation of one copy cannot leave the other
        // asserting something different.
        //
        // This used to finish with "which is how `GAP` went missing from the draw site
        // without this test noticing" -- and, worse, a claim below that "what is pinned is
        // that the draw site consults the budget". Neither was true and neither is now.
        // This crate has no dependencies by design, so it cannot read any of the three draw
        // sites, and `PERM_BUTTON_GAP` appeared in NO test anywhere in the repository before
        // this change. The gap is now subtracted by `hint_budget` above, which is called from
        // all three draw sites and is tested here, so the claim is finally checkable.
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
                // stand-in: what is pinned is the MEASUREMENT TABLE and the elision, not
                // the exact prefix a given font chooses. The draw site's own arithmetic is
                // covered by the `hint_budget` tests below, not by this one.
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
