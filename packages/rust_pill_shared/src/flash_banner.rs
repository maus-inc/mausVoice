//! Geometry for the flash banner the native pill paints above itself.
//!
//! The banner carries a short toast ("Transcript copied to clipboard") and the
//! error notice a failed action produces. Both used to be laid out as one line
//! `text_width + padding` wide, computed inline in each of the three pill
//! crates. That is right until the message is longer than the window: then the
//! banner is wider than the surface under it, the pill clips it at both edges,
//! and a user reading an error loses its beginning and its end.
//!
//! So the banner geometry lives here, once, and every platform asks for it:
//!
//! - the banner never leaves the window it is drawn on, less a safe margin, and
//!   never exceeds a sensible maximum width;
//! - a message that does not fit is wrapped here, measured through the caller's
//!   own text engine, so the break points match the glyphs that get painted;
//! - the height follows the wrapped line count;
//! - the buttons keep their place on the right and the text keeps its padding.
//!
//! Wrapping in this crate rather than in the platform engine is deliberate. The
//! three engines break lines differently by a word or a comma, and the pill is
//! meant to be one product on three systems: driving all three from this one
//! greedy wrap makes the line count, and therefore the banner height, identical
//! everywhere. It also means no platform needs a new wrapped-text draw API; each
//! already knows how to paint one line.
//!
//! Most of this module is pure. Measurement arrives as a callback, exactly as
//! [`crate::text_fit::elide_to_width`] takes it, because the three crates measure
//! through DirectWrite, CoreText and Pango and none of those types can live in a
//! crate with no dependencies.
//!
//! The one impure piece is [`FlashHost`], which writes the banner's own fields
//! and their clearing rule; everything else is a pure function of its inputs.

use std::cell::{Cell, RefCell};

/// The smallest scale the banner shrinks to as it fades in.
pub const BANNER_MIN_SCALE: f64 = 0.5;

/// Vertical padding above and below the banner text.
///
/// Chosen with [`BANNER_TEXT_LINE`] so a single line lands on the banner's
/// established 32px height: 8 + 16 + 8 is 32.0. A short message therefore keeps
/// the compact look it already had, and the height only grows once the text
/// needs a second line.
pub const BANNER_PADDING_V: f64 = 8.0;

/// Line pitch used to size the banner and to place each line.
///
/// This is a layout number rather than a font metric. The platform engines
/// disagree about leading by a few tenths of a pixel, and the banner has to be
/// the same height on all three for the pill to read as one product, so the
/// pitch is fixed here and every line is drawn one pitch below the last. Sixteen
/// pixels is also the natural line box of the banner's 12px text, so a wrapped
/// line keeps the same breathing room a single line always had.
pub const BANNER_TEXT_LINE: f64 = 16.0;

/// The margin a clamp leaves when it has to move the banner to stay inside.
///
/// The pill centres its content, so a banner that passed the ceiling is already
/// inside the window and this never applies. It exists for the case where a
/// future mode offsets the pill, so the clamp cannot put the rounded corner on
/// the clip.
pub const BANNER_MIN_MARGIN: f64 = 2.0;

/// Largest the banner is allowed to grow, however wide the window is.
///
/// A banner that spans a wide display reads as a bar rather than as a notice
/// about the pill, and a wrapped line is harder to track the longer it is, so
/// the width is capped well below the window. 480 is wider than every pill
/// surface the product has (the widest window is 600 less its side margins) and
/// narrow enough that the banner stays a floating card, at the same order as
/// the 440 cap the broadcast transcript already uses.
pub const BANNER_MAX_WIDTH: f64 = 480.0;

/// The absolute most lines the banner will show, whatever room it has.
///
/// This is a backstop, not the bound: the layout fits the ceiling to the room
/// above the pill, so the banner is never taller than the space it hangs in.
/// Twenty lines is 8 + 16 * 20 + 8 = 336 at the canonical metrics -- more than
/// an expanded pill leaves -- so this is only reached on a surface taller than
/// any the product has today, and it exists so a bad `pill_top` cannot ask for
/// an unbounded banner. Anything past the computed ceiling is elided onto the
/// last line kept, the way the transcript already elides.
pub const BANNER_MAX_LINES: usize = 20;

/// Narrowest banner the pill will draw.
///
/// A one-word toast still needs to read as a banner rather than a pill, so the
/// width has a floor. It used to be a `80.0` literal repeated in all three
/// crates; it is here so the floor and the ceiling are decided together.
pub const BANNER_MIN_WIDTH: f64 = 80.0;

/// Everything the banner needs from the caller to answer with a layout.
///
/// The caller owns the constants and the pill's own placement; the window and
/// the pill's layout box are what bound the banner in the first place. All
/// lengths are in drawing units of the caller's content space.
#[derive(Debug, Clone, Copy)]
pub struct FlashBannerSpec {
    /// Width of the surface the banner is painted on, in painter coordinates.
    ///
    /// This is the window, not the pill's own box. The pill draws its content
    /// into a box that can be narrower than the window (dictation is 200 wide in
    /// a 600 wide window) and shifts that box to stay centred, so the drawing
    /// space around the pill's centre extends past the box on both sides. A
    /// long error during dictation has the whole window to read in, and the
    /// window is also what clips, so it is the honest ceiling.
    ///
    /// It is a width and not a right edge: the left edge is
    /// [`Self::available_left`], because a painter's origin is not the surface's
    /// origin. Passing the content box here instead of the surface was a real
    /// defect -- dictation's 200-unit box capped the banner at 196 units inside
    /// a 600-unit window -- and passing the surface's width while assuming it
    /// started at zero would have clamped the rectangle 200 units off its right
    /// edge instead. Both numbers have to describe the same rectangle.
    pub available_width: f64,
    /// Left edge of that surface, in painter coordinates.
    ///
    /// The painters translate the context by `content_offset` before drawing, so
    /// a pill's content box is centred in the window rather than flush with it
    /// and the surface runs from `-offset` to `content_width + offset`. In
    /// dictation that is `-200..400`: the banner may hang past the pill's box on
    /// either side, but it is the window that clips it.
    ///
    /// Zero is the honest value for a caller whose surface and canvas share an
    /// origin, which is every test that does not model a translated painter.
    pub available_left: f64,
    /// How much vertical room the banner's surface has.
    ///
    /// This is how tall the painter's canvas is, and it is what bounds the
    /// banner's height -- not the room above the pill, which is often smaller
    /// than one line on the dictation canvas. The paint scales the banner down
    /// about its centre to fit, and the frame's tests hold the wrap and the line
    /// count across every surface size, so the surface is the honest bound.
    pub available_height: f64,
    /// The pill's horizontal centre, which the banner is centred on.
    pub center_x: f64,
    /// Offset of the pill's top edge, so the banner can keep its gap above it.
    pub pill_top: f64,
    /// Distance the banner keeps above the pill.
    pub gap: f64,
    /// Height of a one-line banner, which is also the floor for a wrapped one.
    pub min_height: f64,
    /// Horizontal padding between the banner edge and its text.
    pub padding_h: f64,
    /// Narrowest the banner is allowed to become.
    pub min_width: f64,
    /// Width the message would take on one unbroken line, before clamping.
    pub preferred_text_width: f64,
    /// Measured width of the action button including its own padding, if the
    /// caller has an action.
    pub action_width: Option<f64>,
    /// Measured width of the reject button including its own padding, if any.
    pub reject_width: Option<f64>,
    /// Gap between the buttons and between the buttons and the text.
    pub action_gap: f64,
    /// Height of the buttons, which is smaller than the banner so it can be
    /// centred inside it.
    pub action_height: f64,
}

/// A pill's own flash constants, as the three crates keep them.
///
/// Every pill crate has these ten numbers in its `constants.rs`, and they are
/// identical on all three. Passing them as a struct rather than as ten
/// arguments keeps the call site to one line and makes it impossible for a pill
/// to drop or reorder one of them.
#[derive(Debug, Clone, Copy)]
pub struct FlashBannerConstants {
    pub gap: f64,
    pub min_height: f64,
    pub padding_h: f64,
    pub min_width: f64,
    pub action_gap: f64,
    pub action_height: f64,
}

impl FlashBannerConstants {
    /// The banner geometry the three pills share.
    ///
    /// Every number here is the same in all three `constants.rs` files: a
    /// toast has always been 32px tall and sat 6px above the pill on macOS,
    /// Windows and GTK alike. They are declared once so the celebration origin
    /// and the paint path cannot be handed different numbers, which is what a
    /// per-crate copy of this list allowed.
    pub fn canonical() -> Self {
        Self {
            gap: 6.0,
            min_height: 32.0,
            padding_h: 16.0,
            min_width: BANNER_MIN_WIDTH,
            action_gap: 8.0,
            action_height: 22.0,
        }
    }
}

impl Default for FlashBannerConstants {
    /// The geometry the three pills share, so a caller that just wants the
    /// standard toast does not have to name the constructor.
    fn default() -> Self {
        Self::canonical()
    }
}

impl FlashBannerSpec {
    /// Builds the spec from a pill's own constants and the widths it measured.
    ///
    /// This is the constructor every draw site uses, so a platform only supplies
    /// the values that genuinely differ: the room it has, where the pill is, and
    /// how wide its text engine measured the message and the buttons.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        surface: BannerSurface,
        available_height: f64,
        center_x: f64,
        pill_top: f64,
        constants: FlashBannerConstants,
        preferred_text_width: f64,
        action_width: Option<f64>,
        reject_width: Option<f64>,
    ) -> Self {
        Self {
            available_width: surface.width,
            available_left: surface.left,
            available_height,
            center_x,
            pill_top,
            gap: constants.gap,
            min_height: constants.min_height,
            padding_h: constants.padding_h,
            min_width: constants.min_width,
            action_width,
            reject_width,
            action_gap: constants.action_gap,
            action_height: constants.action_height,
            // The preferred width sizes the banner before it is clamped, so this
            // is the same number the draw sites used to pass on its own.
            preferred_text_width,
        }
    }

    /// Builds the spec for a toast painted in a pill window.
    ///
    /// Three numbers matter, and conflating them put the banner on the wrong
    /// axis.
    ///
    /// `window_width` is how much room the banner may use. It is the whole
    /// painter surface, so a long error during dictation is not squeezed into
    /// the pill's compact box.
    ///
    /// `pill_center_x` is where the banner must be *centred*. It is the pill's
    /// own centre in painter space -- `pill_position`'s x plus half its width --
    /// not half the window. The drawing context is already translated by
    /// `content_offset` before the banner paints, and that offset centres a
    /// narrow pill inside the wide window, so the window's midpoint is only the
    /// pill's centre when the two are the same width. In dictation the pill is
    /// 200 wide inside a 600-wide surface: centring on 300 left the banner 200
    /// units to the right of the pill for the whole expand animation. The centre
    /// also has to come from `pill_position` rather than a width, because a
    /// dragged pill moves and its banner has to follow it.
    ///
    /// `pill_top` is where the banner hangs from, and the room above it bounds
    /// the height.
    #[allow(clippy::too_many_arguments)]
    pub fn for_window(
        surface: BannerSurface,
        window_height: f64,
        pill_center_x: f64,
        pill_top: f64,
        constants: FlashBannerConstants,
        preferred_text_width: f64,
        action_width: Option<f64>,
        reject_width: Option<f64>,
    ) -> Self {
        Self::new(
            surface,
            window_height,
            pill_center_x,
            pill_top,
            constants,
            preferred_text_width,
            action_width,
            reject_width,
        )
    }
}

/// A rectangle the caller paints into.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BannerRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl BannerRect {
    /// Right edge of the rectangle.
    pub fn right(self) -> f64 {
        self.x + self.w
    }

    /// Bottom edge of the rectangle.
    pub fn bottom(self) -> f64 {
        self.y + self.h
    }

    /// Horizontal centre of the rectangle.
    pub fn center_x(self) -> f64 {
        self.x + self.w / 2.0
    }

    /// Vertical centre of the rectangle.
    pub fn center_y(self) -> f64 {
        self.y + self.h / 2.0
    }

    /// Left edge for a line of `line_width`, centred in the block.
    ///
    /// A banner with no buttons centres the message, which is the compact look
    /// it has always had. A banner with a button left-aligns it against its own
    /// padding, because a centred line beside a button reads as a gap rather
    /// than as a message; the caller passes the block's own left edge in that
    /// case by asking for a full-width line.
    pub fn line_x(self, line_width: f64) -> f64 {
        self.x + ((self.w - sane(line_width)) / 2.0).max(0.0)
    }

    /// Top of the line box at `index`, one line pitch apart.
    ///
    /// The pitch is fixed and a platform's line box is not exactly that tall,
    /// so a line is centred in its own slice of the pitch instead of being
    /// pinned to its top. That is what keeps the 12px text optically centred on
    /// the banner when the platform's leading differs by a fraction.
    pub fn line_top(self, index: usize, line_height: f64) -> f64 {
        self.y + index as f64 * BANNER_TEXT_LINE + (BANNER_TEXT_LINE - sane(line_height)) / 2.0
    }
}

/// The banner, its text block and its buttons, all in the caller's content
/// space.
#[derive(Debug, Clone, PartialEq)]
pub struct FlashBannerLayout {
    /// The banner itself.
    pub banner: BannerRect,
    /// Where the text block starts and how much room it has.
    pub text: BannerRect,
    /// The reject button, to the left of the action button.
    pub reject: Option<BannerRect>,
    /// The action button, on the banner's right edge.
    pub action: Option<BannerRect>,
    /// The wrapped message, one entry per painted line.
    pub lines: Vec<String>,
}

/// Which banner button a rectangle belongs to.
///
/// The painter needs to know whether a rectangle is the accept or the reject
/// button, because each paints a different hit action. Naming them here means
/// the order the layout reports them in, and the action each one registers, are
/// decided once rather than in each of the three draw sites.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BannerButton {
    /// The accept button, on the banner's right edge.
    Action,
    /// The reject button, to the left of the accept button.
    Reject,
}

impl FlashBannerLayout {
    /// The banner's centre, which is the point its scale animation is about and
    /// the point celebration particles launch from.
    pub fn center(&self) -> (f64, f64) {
        (self.banner.center_x(), self.banner.center_y())
    }

    /// The lines to paint, each with the x its baseline starts at.
    ///
    /// The alignment rule and the per-line geometry are the same on every
    /// platform; only the measuring and the painting are not. Resolving the
    /// positions here means a draw site paints a list rather than re-deriving
    /// where each line goes, and a three-line loop is short enough that no
    /// platform's copy of it is a duplicate of another's.
    ///
    /// `measure` returns the width of one painted line.
    pub fn text_runs<F>(&self, measure: F) -> Vec<(usize, &str, f64)>
    where
        F: Fn(&str) -> f64,
    {
        let left_aligned = self.texts_left_aligned();
        self.lines
            .iter()
            .enumerate()
            .filter(|(_, line)| !line.is_empty())
            .map(|(index, line)| {
                let x = if left_aligned {
                    self.text.x
                } else {
                    self.text.line_x(measure(line))
                };
                (index, line.as_str(), x)
            })
            .collect()
    }

    /// Whether the message is left aligned rather than centred.
    ///
    /// A banner with a button left aligns the message against its padding,
    /// because a centred line beside a button reads as a gap; a banner without
    /// one centres it, which is the compact look a short toast has always had.
    pub fn texts_left_aligned(&self) -> bool {
        self.action.is_some() || self.reject.is_some()
    }

    /// The buttons to paint, reject first so it sits left of the accept button.
    ///
    /// Each entry is the rectangle and which button it is; a banner with neither
    /// button yields an empty slice, and one with only a reject yields just that.
    pub fn buttons(&self) -> Vec<(BannerRect, BannerButton)> {
        let mut out = Vec::with_capacity(2);
        if let Some(rect) = self.reject {
            out.push((rect, BannerButton::Reject));
        }
        if let Some(rect) = self.action {
            out.push((rect, BannerButton::Action));
        }
        out
    }
}

/// The rectangle the banner is painted into, in painter coordinates.
///
/// Two numbers, not one, because a painter's origin is not always the surface's
/// origin. The pills translate the drawing context by `content_offset` before
/// anything is painted, so the window that clips the banner starts at a negative
/// x whenever the content box is narrower than the window. In dictation the
/// window spans `-200..400` in painter space; a layout told only `width = 600`
/// clamps against `0..600` and puts the banner 200 units right of where it
/// belongs, and a layout told only `width = 200` -- which is what the three draw
/// sites passed before this type existed -- caps the banner at 196 units inside
/// a window that has room for far more.
///
/// Local values keep the two independent in a test that does not model a
/// translated painter, where `left = 0` is the honest answer.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BannerSurface {
    /// Left edge of the paintable surface, in painter coordinates.
    pub left: f64,
    /// How wide that surface is.
    pub width: f64,
}

impl BannerSurface {
    /// A surface whose painter origin is the surface's own origin.
    pub fn new(width: f64) -> Self {
        Self { left: 0.0, width }
    }

    /// A surface offset from the painter's origin by `left`.
    pub fn offset(left: f64, width: f64) -> Self {
        Self { left, width }
    }

    /// The surface, derived from the transform the painter actually applied.
    ///
    /// Every pill translates its context by `(canvas_width - content_width) / 2`
    /// before painting anything, so the window that clips the banner runs from
    /// `-offset` to `canvas_width - offset` in the space the banner is laid out
    /// in. Taking the offset and the content width rather than the canvas width
    /// keeps this tied to the one number the painter itself used: a constant
    /// here and an offset there could disagree, and then the clamp would guard an
    /// edge the window does not have.
    ///
    /// The content box is what `pill_position` measures within; the canvas is
    /// what clips. Passing the box alone as the surface is the defect this
    /// exists to prevent: a 200-unit box in a 600-unit window capped the banner
    /// at 196 units and wrapped a message that had room for 480.
    pub fn of_painter(content_width: f64, content_offset_x: f64) -> Self {
        let offset = coordinate(content_offset_x);
        let content = sane(content_width);
        Self {
            left: -offset,
            width: content + offset * 2.0,
        }
    }

    /// Right edge of the surface, in painter coordinates.
    pub fn right(self) -> f64 {
        coordinate(self.left) + sane(self.width)
    }
}

/// Collapse a measurement into a width that cannot poison the geometry.
///
/// A missing glyph or a surface that has not been sized can answer `NaN` or a
/// negative width, and either one would propagate into every rectangle below
/// it. An unusable measurement reads as zero, which makes the banner fall back
/// to its minimum width rather than disappear.
fn sane(value: f64) -> f64 {
    if value.is_finite() && value > 0.0 {
        value
    } else {
        0.0
    }
}

/// Keeps a finite coordinate as it is, including a negative one.
///
/// [`sane`] is for *lengths*, where zero is the honest floor: a negative width
/// is not a width. A *position* is different. The pill is drawn in content
/// coordinates and a drag can put it partly or wholly off the canvas, so
/// `pill_top` can be negative while still being a real place. Clamping that to
/// zero would claim the pill is at the very top of the surface, which is the
/// opposite of where it is, and the banner would then be placed below it with
/// no headroom. Only a value that is not a number falls back to zero, because
/// there is no honest position to use.
fn coordinate(value: f64) -> f64 {
    if value.is_finite() {
        value
    } else {
        0.0
    }
}

/// The widest the banner may be, which is the window less its side margins.
///
/// Floored at the caller's minimum: a window narrower than that is not a case
/// the pill can reach, and clamping to zero would produce an unreadable sliver
/// rather than the smallest honest banner.
pub fn banner_max_width(surface: BannerSurface, min_width: f64) -> f64 {
    let usable = sane(surface.width) - BANNER_MIN_MARGIN * 2.0;
    usable.min(BANNER_MAX_WIDTH).max(sane(min_width))
}

/// The height the banner needs for `line_count` lines of text.
///
/// One line gives back `min_height` exactly, so a short message is unchanged.
/// Each further line adds one line of pitch, because the top and bottom padding
/// are already inside the floor.
pub fn banner_height(line_count: usize, min_height: f64, padding_v: f64, line_height: f64) -> f64 {
    let lines = line_count.max(1) as f64;
    let stack = padding_v * 2.0 + lines * line_height;
    sane(min_height).max(stack)
}

/// Yields each word with the run of whitespace that preceded it.
///
/// `split_whitespace` reports the words and throws the gaps away, which forces
/// the wrap to invent a single space between them. A message that says
/// `/tmp/Client  Files` -- two spaces, and a real path a user can be told about --
/// came back as `/tmp/Client Files`, naming something that does not exist. The
/// gap is therefore carried as it was written and only the gap a line break
/// lands on is dropped, which is what a line break means.
///
/// The leading gap of a paragraph is dropped: it is indentation from the source,
/// not part of the sentence, and keeping it would shift the first line right by
/// an amount the caller never asked for. Newlines are never part of a gap here,
/// because paragraphs are already split on them.
fn words_with_gaps(paragraph: &str) -> impl Iterator<Item = (&str, &str)> {
    let mut rest = paragraph.trim_start_matches([' ', '\t']);
    // The gap is found trailing the word it followed, so it is held here until
    // the next word comes back to claim it. A trailing gap is never claimed,
    // which is what drops trailing whitespace.
    let mut pending = "";
    std::iter::from_fn(move || {
        if rest.is_empty() {
            return None;
        }
        let word_end = rest.find([' ', '\t']).unwrap_or(rest.len());
        let (word, after) = rest.split_at(word_end);
        let gap_end = after
            .find(|c: char| c != ' ' && c != '\t')
            .unwrap_or(after.len());
        let (gap, after_gap) = after.split_at(gap_end);
        rest = after_gap;
        let leading = std::mem::replace(&mut pending, gap);
        Some((word, leading))
    })
}

/// Wraps `text` to `max_width`, word first and characters when a word alone
/// will not fit.
///
/// The greedy rule is the one every platform's native wrapper applies, so the
/// line count this returns matches what the pill paints: fill a line until the
/// next word would overrun, then start a new one. An explicit `\n` starts a new
/// line and is not drawn. A word wider than the whole budget is broken across
/// lines instead of being allowed to overrun, which is the case a URL or a long
/// file path reaches. The gaps between words are kept as they were written, so
/// a message that quotes a path still quotes the path.
///
/// `measure` returns the width of a rendered string. It must be monotonic in
/// the length of its argument, which a font's advance widths are.
pub fn wrap_to_width<F>(text: &str, max_width: f64, measure: F) -> Vec<String>
where
    F: Fn(&str) -> f64,
{
    wrap_to_width_bounded(text, max_width, usize::MAX, measure)
}

/// Wraps `text`, stopping once `max_lines` lines exist.
///
/// The stop is the point. A banner shows at most a couple of dozen lines, but the
/// message can be arbitrarily long: an error can carry a transcript, a path list
/// or a whole server response. Wrapping all of it to throw almost all of it away
/// costs one font-engine measurement per word, and the banner is laid out again
/// on every repaint while it is visible, so the waste is paid every frame. The
/// wrap therefore stops one line past what it will keep -- one past, not at it,
/// because the caller needs to know whether text was left over in order to elide
/// the last line it keeps.
///
/// The result is identical to wrapping the whole text and then truncating: the
/// greedy rule means line N depends only on the lines before it.
pub fn wrap_to_width_bounded<F>(
    text: &str,
    max_width: f64,
    max_lines: usize,
    measure: F,
) -> Vec<String>
where
    F: Fn(&str) -> f64,
{
    let budget = sane(max_width);
    // A budget of zero is not a width any glyph fits into, so breaking against
    // it would put one character on every line. That is worse than an overrun
    // the caller can see, so an unusable budget leaves the text whole.
    let can_break = budget > 0.0;
    let mut lines: Vec<String> = Vec::new();

    // `max_lines` of 0 would underflow the `+ 1` below; a caller that wants
    // nothing still gets the one line that says so.
    let stop_after = max_lines.max(1).saturating_add(1);
    'paragraphs: for paragraph in text.split('\n') {
        let mut current = String::new();
        for (word, gap) in words_with_gaps(paragraph) {
            if lines.len() >= stop_after {
                break 'paragraphs;
            }
            if !current.is_empty() {
                let candidate = format!("{current}{gap}{word}");
                if measure(&candidate) <= budget {
                    current = candidate;
                    continue;
                }
                // The gap is what the break lands on: a line does not end in
                // trailing space, and the next one does not start with it.
                lines.push(std::mem::take(&mut current));
            }
            // A word starting a line still has to fit it. One wider than the
            // whole banner is broken on grapheme boundaries, repeatedly, so
            // neither a URL nor a long path can ever overrun the edge.
            let mut rest = word.to_string();
            while can_break && measure(&rest) > budget {
                let (head, tail) = break_word(&rest, budget, &measure);
                if head.is_empty() || tail == rest {
                    // No progress is possible on this word; keep it whole
                    // rather than loop forever.
                    break;
                }
                lines.push(head);
                rest = tail;
                // The same stop as the word loop, for the same reason. A single
                // unbroken token -- a base64 blob, a minified script, a path with
                // no separators -- can be arbitrarily long, and every fragment
                // costs a binary search of font measurements. Once the ceiling
                // plus its overflow line exists there is nothing left to learn
                // from the remainder, so it is kept whole and discarded upstream
                // rather than split into hundreds of lines nobody will see.
                if lines.len() >= stop_after {
                    break 'paragraphs;
                }
            }
            current = rest;
        }
        lines.push(current);
    }

    // Empty paragraphs (a blank line, a trailing newline) collapse rather than
    // rendering as a gap. A message that is entirely blank keeps exactly one
    // line, so the banner does not vanish and does not grow to one line per
    // newline character: `"\n\n\n"` used to come back as four empty lines.
    lines.retain(|line| !line.is_empty());
    if lines.is_empty() {
        lines.push(String::new());
    }
    lines
}

/// Cuts the wrap down to `ceiling` lines, eliding the last one kept.
///
/// `ceiling` is how many lines fit in the room above the pill, never more than
/// [`BANNER_MAX_LINES`]. It is computed by the caller from the room it actually
/// has, because [`BANNER_MAX_LINES`] alone is only safe in the tallest pill
/// window: the same constant is used by a pill that sits lower and has less
/// room above it, and there the banner top went negative -- off the surface,
/// with the first lines invisible.
///
/// The banner hangs above the pill, so a message long enough to need more lines
/// than the ceiling would run off the top of the screen instead of off its
/// sides -- the same failure #374 reports, moved from the edges to the ceiling.
///
/// The lines that fit are kept as they were wrapped, so nothing is re-flowed and
/// no word moves. The last kept line has its own text elided, and the text that
/// its elision displaced is carried into the same call, so a cut never loses
/// more of the message than the one line it is allowed to shorten.
fn elide_to_line_ceiling<F>(
    mut lines: Vec<String>,
    width: f64,
    ceiling: usize,
    measure: F,
) -> Vec<String>
where
    F: Fn(&str) -> f64,
{
    let ceiling = ceiling.clamp(1, BANNER_MAX_LINES);
    if lines.len() <= ceiling {
        return lines;
    }
    // Everything from the last visible line onward becomes one run, so the
    // elision can use the whole width instead of only what the wrapped line had.
    let tail = lines.split_off(ceiling - 1).join(" ");
    lines.push(crate::text_fit::elide_to_width(
        &tail, width, "\u{2026}", measure,
    ));
    lines
}

/// Splits one over-wide word into a head that fits and the remainder.
///
/// Binary search over *grapheme cluster* boundaries rather than a linear scan,
/// for the same reason [`crate::text_fit::elide_to_width`] uses one: each step is
/// a font engine call and the word can be long.
///
/// Clusters, not `char`s, are the unit. A `char` boundary is not a place a font
/// may be cut: splitting there separates a family emoji into two unrelated
/// people, drops the variation selector that makes a glyph emoji-presenting, or
/// strands a combining accent on the wrong base. Each of those renders as a
/// visible defect in the middle of the message, and the pieces do not rejoin
/// when the next line starts.
fn break_word<F>(word: &str, budget: f64, measure: F) -> (String, String)
where
    F: Fn(&str) -> f64,
{
    use unicode_segmentation::UnicodeSegmentation;

    let clusters: Vec<&str> = word.graphemes(true).collect();
    if clusters.len() < 2 {
        return (word.to_string(), String::new());
    }
    let (mut lo, mut hi) = (1usize, clusters.len() - 1);
    let mut best = 1usize;
    while lo <= hi {
        let mid = lo + (hi - lo) / 2;
        let prefix: String = clusters[..mid].concat();
        if measure(&prefix) <= budget {
            best = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    let head: String = clusters[..best].concat();
    let tail: String = clusters[best..].concat();
    (head, tail)
}

/// Builds the whole banner layout from the caller's measurements.
///
/// The spec carries the width the message would take on one unbroken line,
/// used only to size the banner before it is clamped to the window. It is part
/// of the spec rather than a `measure` call because the macOS pill measures its
/// flash text a point larger than it draws it, and that extra margin is part of
/// the banner's current look.
///
/// `measure` returns the width of a string rendered in the font the lines will
/// be painted with. It drives the wrap and the per-line centring, so both agree
/// with the glyphs on screen.
pub fn layout_flash_banner<F>(
    spec: &FlashBannerSpec,
    message: &str,
    measure: F,
) -> FlashBannerLayout
where
    F: Fn(&str) -> f64,
{
    let min_width = sane(spec.min_width);
    let surface = BannerSurface::offset(spec.available_left, spec.available_width);
    let max_width = banner_max_width(surface, min_width);

    let requested_buttons: Vec<f64> = [spec.action_width, spec.reject_width]
        .into_iter()
        .flatten()
        .map(sane)
        .collect();
    // Each button is preceded by a gap, so the space the buttons take is their
    // own widths plus one gap each. Getting this off by one gap would leave the
    // message a gap's worth of room it does not have, and the last word of the
    // first line would sit under the button.
    let gap = sane(spec.action_gap);
    let padding = sane(spec.padding_h);
    // The banner is first made as wide as the buttons ask for, but never wider
    // than the window allows. That settles the width.
    let preferred = (sane(spec.preferred_text_width)
        + padding * 2.0
        + requested_buttons.iter().sum::<f64>()
        + requested_buttons.len() as f64 * gap)
        .max(min_width);
    let banner_w = preferred.min(max_width);

    // Buttons are then held to the room that width actually leaves them. A
    // button that did not fit would be painted past the rounded edge -- still
    // visible, still clickable, no longer part of the message -- and the reject
    // button placed relative to it would be pushed out of the other side. The
    // widths are shared out in proportion so a pair never loses one of itself,
    // and a banner with no room at all gets zero-width buttons rather than
    // negative ones.
    let room_for_buttons =
        (banner_w - padding * 2.0 - requested_buttons.len() as f64 * gap).max(0.0);
    let requested_total: f64 = requested_buttons.iter().sum();
    let button_widths: Vec<f64> = if requested_total > room_for_buttons && requested_total > 0.0 {
        requested_buttons
            .iter()
            .map(|width| width * room_for_buttons / requested_total)
            .collect()
    } else {
        requested_buttons
    };
    let reserved_for_buttons: f64 =
        button_widths.iter().sum::<f64>() + button_widths.len() as f64 * gap;

    // How tall the banner may be is the room above the pill, and only that room.
    //
    // The paint scales the banner down towards `BANNER_MIN_SCALE` while it fades
    // in, but that is a transition, not a licence: a banner at full opacity is
    // drawn at scale 1 and has to fit. So the budget is the room, unscaled.
    //
    // This is deliberately not the surface height. The typing surface is 362
    // tall, but only 306 of it is above the pill, and bounding by the surface
    // let a 336-unit banner through whose top came out at -30 -- the first lines
    // off the canvas, which is the defect this exists to prevent. It also cannot
    // ignore the room entirely: the same code paints into far less room on
    // other surfaces, where a fixed ceiling would overrun by more.
    //
    // A room too small for even one line still yields the one-line floor, so a
    // tiny surface shows a short banner rather than none; `banner_height` floors
    // at `min_height` for exactly that reason.
    let surface_height = sane(spec.available_height);
    let room_above_pill = (coordinate(spec.pill_top) - sane(spec.gap)).max(0.0);
    // Never more than the surface even if the caller reports a room past it, and
    // never more than the room when the room is the smaller of the two.
    let room = if surface_height > 0.0 {
        room_above_pill.min(surface_height)
    } else {
        room_above_pill
    };
    let line_pitch = BANNER_TEXT_LINE.max(1.0);
    let lines_that_fit = ((room - sane(spec.min_height) - BANNER_PADDING_V * 2.0) / line_pitch)
        .floor()
        .max(0.0) as usize
        + 1;

    // The banner width settles first because the text budget depends only on
    // it. Wrapping then decides the line count, and the height follows.
    let text_width = (banner_w - padding * 2.0 - reserved_for_buttons).max(0.0);
    // The wrap is given the ceiling up front so it stops there instead of
    // measuring every word of a message that will mostly be discarded. It stops
    // one line past the ceiling so `elide_to_line_ceiling` still knows there was
    // text left over and can elide the last line it keeps.
    let lines = elide_to_line_ceiling(
        wrap_to_width_bounded(message, text_width, lines_that_fit, &measure),
        text_width,
        lines_that_fit,
        measure,
    );
    let height = banner_height(
        lines.len(),
        spec.min_height,
        BANNER_PADDING_V,
        BANNER_TEXT_LINE,
    );

    // The banner is centred on the pill. That is enough to keep it inside the
    // surface while the pill sits in the middle -- the common case -- because
    // the width above already left a margin on each side. It is not enough once
    // the pill has been dragged: the banner follows the pill, and a pill near an
    // edge would hang its banner off that edge. So the rectangle is also held
    // inside the surface, and only moves when it would otherwise clip.
    //
    // Both limits come from the surface rectangle rather than from zero and a
    // width. The painter is translated by `content_offset`, so on the dictation
    // surface the window spans `-200..400` and a banner held to `0..600` would be
    // clamped to the pill's own box -- which is the defect this fixes -- while
    // one held to `2..598` in a 600-wide window would sit 200 units right of the
    // pill it belongs to.
    let surface = BannerSurface::offset(spec.available_left, spec.available_width);
    let left_limit = coordinate(surface.left) + BANNER_MIN_MARGIN;
    let right_limit = (surface.right() - banner_w - BANNER_MIN_MARGIN).max(left_limit);
    let centered_x = coordinate(spec.center_x) - banner_w / 2.0;
    let x = centered_x.clamp(left_limit, right_limit);
    let y = coordinate(spec.pill_top) - sane(spec.gap) - height;
    let banner = BannerRect {
        x,
        y,
        w: banner_w,
        h: height,
    };

    let text = BannerRect {
        x: banner.x + padding,
        y: banner.y + BANNER_PADDING_V,
        w: text_width,
        h: (height - BANNER_PADDING_V * 2.0).max(0.0),
    };

    let action_h = sane(spec.action_height);
    let action_y = banner.y + (height - action_h) / 2.0;
    let mut widths = button_widths.iter().copied();
    let action = spec.action_width.map(|_| {
        let width = widths.next().unwrap_or(0.0);
        BannerRect {
            x: banner.right() - padding - width,
            y: action_y,
            w: width,
            h: action_h,
        }
    });
    let reject = spec.reject_width.map(|_| {
        let width = widths.next().unwrap_or(0.0);
        let offset = action.map_or(0.0, |rect| rect.w + gap);
        BannerRect {
            x: banner.right() - padding - offset - width,
            y: action_y,
            w: width,
            h: action_h,
        }
    });

    FlashBannerLayout {
        banner,
        text,
        reject,
        action,
        lines,
    }
}

/// The line count a banner starts with, before it has painted once.
///
/// A pill's initial state, and its celebration reset, both need this number.
/// Naming it here means the three state structs do not each spell out the
/// literal, and a change to "a short toast is one line" reaches all of them.
pub const BANNER_LINES_AT_REST: usize = 1;

/// The four fields a pill's fireworks state lives in.
///
/// Separate from [`FlashHost`] because a pill animates its fireworks whether or
/// not it is showing a banner: the group is its own small bundle so the tick can
/// be written once without the banner's eleven fields in the way.
pub trait CelebrationHost {
    /// Whether the burst is running.
    fn fireworks_active(&self) -> &Cell<bool>;
    /// Seconds since the burst started.
    fn fireworks_elapsed(&self) -> &Cell<f64>;
    /// Index of the next rocket to launch.
    fn fireworks_next_launch(&self) -> &Cell<usize>;
    /// The rockets in flight.
    fn fireworks_rockets(&self) -> &RefCell<Vec<crate::fireworks::Rocket>>;

    /// Ends the burst and forgets everything it was doing.
    ///
    /// A celebration's banner and the burst it announces are one lifetime: the
    /// message stays up for `FIREWORKS_TOTAL_DURATION` and so does the burst.
    /// When the banner goes away the burst must not be able to resume later
    /// from state that belongs to a message the user has already seen and lost,
    /// so cancelling resets the clock and the schedule rather than only
    /// clearing a flag.
    fn cancel_celebration(&self) {
        self.fireworks_active().set(false);
        self.fireworks_elapsed().set(0.0);
        self.fireworks_next_launch().set(0);
        self.fireworks_rockets().borrow_mut().clear();
    }

    /// The burst's state as the shared fireworks animation wants it.
    fn fireworks(&self) -> crate::fireworks::Fireworks<'_> {
        crate::fireworks::Fireworks {
            active: self.fireworks_active(),
            elapsed: self.fireworks_elapsed(),
            next_launch: self.fireworks_next_launch(),
            rockets: self.fireworks_rockets(),
        }
    }

    /// Advances the burst one frame from where the banner was last painted.
    ///
    /// A rocket's flight is independent of where the banner is: once one is in
    /// the air it has its own trajectory, and the origin only matters when a
    /// new one launches. So the burst is advanced every tick and the origin is
    /// optional: `None` means "advance, but launch nothing this frame".
    ///
    /// Two review findings meet here. A burst that starts while the banner is
    /// unpainted -- GTK does not paint it while the assistant is open -- used to
    /// wait for an origin that never came, so its elapsed time froze and it
    /// resumed stale when a banner finally painted. And a burst whose banner
    /// expired had nothing to resume from at all.
    fn tick_celebration(&self, dt: f64)
    where
        Self: FlashHost,
    {
        self.fireworks().tick(dt, self.banner_center().get());
    }
}

/// Writes [`CelebrationHost`] for a state whose fireworks fields carry the
/// shared names, so the accessors are generated rather than copied.
#[macro_export]
macro_rules! impl_celebration_host {
    ($ty:ty) => {
        impl $crate::flash_banner::CelebrationHost for $ty {
            fn fireworks_active(&self) -> &std::cell::Cell<bool> {
                &self.fireworks_active
            }
            fn fireworks_elapsed(&self) -> &std::cell::Cell<f64> {
                &self.fireworks_elapsed
            }
            fn fireworks_next_launch(&self) -> &std::cell::Cell<usize> {
                &self.fireworks_next_launch
            }
            fn fireworks_rockets(&self) -> &std::cell::RefCell<Vec<$crate::fireworks::Rocket>> {
                &self.fireworks_rockets
            }
        }
    };
}

/// One painted frame of the banner, resolved from a measured message.
///
/// The draw sites all did the same three things after measuring: lay the banner
/// out, derive the scale and alpha from the fade spring, and publish the line
/// count for the celebration tick that runs before the next paint. Those are
/// the same decisions on every platform, so they are made here once.
#[derive(Debug, Clone, PartialEq)]
pub struct FlashFrame {
    /// Where the banner, its text block and its buttons go.
    pub layout: FlashBannerLayout,
    /// The scale every painted coordinate is multiplied by.
    pub scale: f64,
    /// The alpha every painted colour is multiplied by.
    pub alpha: f64,
}

impl FlashFrame {
    /// Lays the banner out and resolves everything a painter needs.
    ///
    /// The draw sites all did this the same way: ask the pill where it is, build
    /// a spec centred on the window, resolve the frame, then take it apart into
    /// the layout, the two multipliers and the centre. Returning that tuple
    /// directly means a paint site has one call and one `let`, rather than a
    /// block its two siblings would have to repeat word for word.
    ///
    /// The bottom of the return is `FlashBannerWidths` order, not a struct, so
    /// the call stays inside the width the line fits on.
    #[allow(clippy::type_complexity)]
    pub fn resolve_for_window<F>(
        message: &str,
        measure: F,
        (preferred, action, reject): (f64, Option<f64>, Option<f64>),
        (pill_top, surface, window_height, pill_center_x): (f64, BannerSurface, f64, f64),
        fade_t: f64,
        (flash_lines, banner_center): (&Cell<usize>, &Cell<Option<(f64, f64)>>),
    ) -> (FlashBannerLayout, f64, f64, (f64, f64))
    where
        F: Fn(&str) -> f64,
    {
        let spec = FlashBannerSpec::for_window(
            surface,
            window_height,
            pill_center_x,
            pill_top,
            FlashBannerConstants::canonical(),
            preferred,
            action,
            reject,
        );
        let layout = layout_flash_banner(&spec, message, measure);
        flash_lines.set(layout.lines.len());
        let center = layout.center();
        banner_center.set(Some(center));
        (
            layout,
            BANNER_MIN_SCALE + (1.0 - BANNER_MIN_SCALE) * fade_t,
            fade_t,
            center,
        )
    }
}

/// The banner fields a pill's state carries, reachable by one method.
///
/// A pill's `PillState` is platform-specific, but its toast is not: the same
/// eleven fields with the same types and the same clearing rule. Rather than
/// declaring them three times and hoping the copies stay in step, each state
/// implements this once through [`impl_flash_host!`], and everything below is
/// written against the trait.
pub trait FlashHost {
    /// The banner text.
    fn flash_message(&self) -> &RefCell<String>;
    /// Whether the banner is painted as an error.
    fn flash_is_error(&self) -> &Cell<bool>;
    /// Whether the banner is shown at all.
    fn flash_visible(&self) -> &Cell<bool>;
    /// The banner's fade spring position, in `0.0..=1.0`.
    fn flash_t(&self) -> &Cell<f64>;
    /// The fade spring's velocity.
    fn flash_velocity(&self) -> &Cell<f64>;
    /// Seconds the banner stays up.
    fn flash_timer(&self) -> &Cell<f64>;
    /// The accept button's token.
    fn flash_action(&self) -> &RefCell<Option<String>>;
    /// The accept button's label.
    fn flash_action_label(&self) -> &RefCell<Option<String>>;
    /// The reject button's token.
    fn flash_reject_action(&self) -> &RefCell<Option<String>>;
    /// The reject button's label.
    fn flash_reject_action_label(&self) -> &RefCell<Option<String>>;
    /// Lines the banner painted last frame.
    ///
    /// The tick that launches the celebration's particles runs before the paint
    /// that wraps the text, so the painter caches the count for the next tick.
    /// The field itself lives on [`crate::indicator::DictationIndicator`], which
    /// all three states deref to, so the value is declared once rather than
    /// three times.
    fn flash_lines(&self) -> &Cell<usize>;
    /// Where the banner's centre was on the frame it was last painted.
    fn banner_center(&self) -> &Cell<Option<(f64, f64)>>;
    /// Clears every field back to "no toast showing".
    ///
    /// The three pills dismiss a toast from several places: the display
    /// timeout, an explicit `DismissToast`, and clicking either button.
    /// Centralising the reset keeps the six mutable fields from drifting
    /// apart, since forgetting one leaves a stale action wired to whichever
    /// toast appears next.
    fn clear_flash(&self) {
        self.flash_visible().set(false);
        self.flash_timer().set(0.0);
        *self.flash_action().borrow_mut() = None;
        *self.flash_action_label().borrow_mut() = None;
        *self.flash_reject_action().borrow_mut() = None;
        *self.flash_reject_action_label().borrow_mut() = None;
        // A cleared banner has no lines. The celebration reads this, so
        // leaving the count from the message that just went away would launch
        // the next one from a height that banner no longer has.
        self.banner_center().set(None);
        self.flash_lines().set(1);
    }

    /// Shows a celebration's message for `duration` seconds.
    ///
    /// A celebration (a streak flame, a fireworks burst) arrives through its
    /// own message rather than a toast, and it always presents the same way:
    /// the text replaces the banner's text, the banner is not an error, every
    /// button is cleared, and it shows for the celebration's own duration.
    ///
    /// The line count resets to one because a celebration message is always
    /// short, and because the particles launch before the first paint has had
    /// a chance to measure the banner: leaving the count from an error that
    /// was on screen a moment ago would launch them from where that taller
    /// banner used to be.
    fn celebrate(&self, message: &str, duration: f64) {
        *self.flash_message().borrow_mut() = message.to_string();
        self.flash_is_error().set(false);
        *self.flash_action().borrow_mut() = None;
        *self.flash_action_label().borrow_mut() = None;
        *self.flash_reject_action().borrow_mut() = None;
        *self.flash_reject_action_label().borrow_mut() = None;
        self.flash_visible().set(true);
        self.flash_timer().set(duration);
        // Clearing the recorded centre is the same guard as the line count:
        // the burst would otherwise launch from where a taller toast used to
        // sit. It is set again on the frame this message first paints, which
        // is before any rocket is due, so nothing is lost.
        self.banner_center().set(None);
        self.flash_lines().set(1);
    }

    /// Where a celebration launches its particles from.
    ///
    /// The banner grows upward with its line count, so its centre moves with
    /// the wrap. Every pill asks this rather than recomputing the height, which
    /// is the arithmetic that drifted before the count was shared.
    fn celebration_origin(
        &self,
        center_x: f64,
        pill_top: f64,
        constants: FlashBannerConstants,
    ) -> (f64, f64) {
        celebration_origin(
            center_x,
            pill_top,
            constants.gap,
            constants.min_height,
            self.flash_lines().get(),
        )
    }
}

/// Writes [`FlashHost`] for a state whose toast fields carry the shared names.
///
/// The names are the same in all three crates, so the impl is generated
/// instead of copied. A pill that renames a field fails to compile here
/// rather than quietly diverging.
#[macro_export]
macro_rules! impl_flash_host {
    ($ty:ty) => {
        impl $crate::flash_banner::FlashHost for $ty {
            fn flash_message(&self) -> &std::cell::RefCell<String> {
                &self.flash_message
            }
            fn flash_is_error(&self) -> &std::cell::Cell<bool> {
                &self.flash_is_error
            }
            fn flash_visible(&self) -> &std::cell::Cell<bool> {
                &self.flash_visible
            }
            fn flash_t(&self) -> &std::cell::Cell<f64> {
                &self.flash_t
            }
            fn flash_velocity(&self) -> &std::cell::Cell<f64> {
                &self.flash_velocity
            }
            fn flash_timer(&self) -> &std::cell::Cell<f64> {
                &self.flash_timer
            }
            fn flash_action(&self) -> &std::cell::RefCell<Option<String>> {
                &self.flash_action
            }
            fn flash_action_label(&self) -> &std::cell::RefCell<Option<String>> {
                &self.flash_action_label
            }
            fn flash_reject_action(&self) -> &std::cell::RefCell<Option<String>> {
                &self.flash_reject_action
            }
            fn flash_reject_action_label(&self) -> &std::cell::RefCell<Option<String>> {
                &self.flash_reject_action_label
            }
            fn flash_lines(&self) -> &std::cell::Cell<usize> {
                &self.indicator.banner_lines
            }
            fn banner_center(&self) -> &std::cell::Cell<Option<(f64, f64)>> {
                &self.indicator.banner_center
            }
        }
    };
}

/// Answers a toast button, then clears the toast.
///
/// The three pills wove this the same way: read the token for the button that
/// was clicked, send it if there is one, and clear the banner either way. Only
/// the send is the platform's, so it arrives as a callback and the decision
/// order is written once here.
///
/// The clear happens after the send, so a send that fails cannot leave live
/// buttons on a banner that is already on its way out, and the burst is
/// cancelled with the banner because a dismissal and an expiry are the same
/// thing to everything the banner was announcing.
pub fn dismiss_flash<S: FlashHost + CelebrationHost>(
    state: &S,
    reject: bool,
    send: impl FnOnce(&str),
) {
    let token = if reject {
        state.flash_reject_action()
    } else {
        state.flash_action()
    };
    if let Some(action) = token.borrow().clone() {
        send(&action);
    }
    state.clear_flash();
    // A dismissed banner ends its burst exactly as an expired one does. This is
    // the other way a banner goes away, and it was the hole in the first version
    // of this fix: `clear_flash` does not reach the burst's state, so cancelling
    // in the timer's expiry branch alone left a user-dismissed celebration
    // holding its launch schedule and able to fire it under the next banner.
    state.cancel_celebration();
}

/// Which label a painted banner button wants.
///
/// A banner can carry either button, both, or neither, and each paint site holds
/// the two labels separately. Choosing between them is the same rule on every
/// platform, so it is written once here.
///
/// Free rather than a trait method on purpose: it reads nothing from the pill,
/// and an associated function with no receiver on a trait cannot infer `Self`
/// at a call site (E0790), which is how the first attempt at this broke the two
/// paint sites that a Linux host cannot compile.
pub fn button_label<'a>(
    button: BannerButton,
    action: Option<&'a String>,
    reject: Option<&'a String>,
) -> Option<&'a String> {
    match button {
        BannerButton::Action => action,
        BannerButton::Reject => reject,
    }
}

/// Counts a visible banner down, clearing it when its time is up.
///
/// All three pills wrote this out: if the banner is up, subtract the step from
/// its timer, and dismiss it once the timer reaches zero. The rule belongs with
/// the rest of the banner's state, not beside each platform's frame loop.
pub fn tick_banner_timer<S: FlashHost + CelebrationHost>(state: &S, dt: f64) {
    if !state.flash_visible().get() {
        return;
    }
    let remaining = state.flash_timer().get() - dt;
    if remaining <= 0.0 {
        state.clear_flash();
        // The message this burst was announcing is gone, so the burst goes with
        // it. Leaving it active lets it resume into a later banner.
        state.cancel_celebration();
    } else {
        state.flash_timer().set(remaining);
    }
}

/// The banner's centre without wrapping the message.
///
/// The celebration particles launch from the middle of the banner, and they are
/// ticked on a different path from the one that paints it. That path has no
/// layout object and must not pay for a wrap, but the height it launches from
/// has to be the height the banner will actually be painted at, or the rockets
/// appear through the middle of a two-line message. So this resolves the same
/// floor and padding against a line count the caller supplies: the paint path
/// passes its wrapped count, and the tick path passes the count it cached the
/// last time it painted.
pub fn banner_center_y(pill_top: f64, gap: f64, min_height: f64, line_count: usize) -> f64 {
    let height = banner_height(line_count, min_height, BANNER_PADDING_V, BANNER_TEXT_LINE);
    coordinate(pill_top) - sane(gap) - height / 2.0
}

/// Where the celebration particles leave from, in the pill's drawing space.
///
/// The x is the pill's centre, and the y is [`banner_center_y`]. Both are
/// resolved here so a pill's tick is one call with its own four numbers, rather
/// than a seventeen-line tuple that all three of them wrote out.
pub fn celebration_origin(
    pill_center_x: f64,
    pill_top: f64,
    gap: f64,
    min_height: f64,
    line_count: usize,
) -> (f64, f64) {
    (
        pill_center_x,
        banner_center_y(pill_top, gap, min_height, line_count),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A deterministic stand-in for a font: every character is `unit` wide, so
    /// the arithmetic in these assertions is exact and the line count is a
    /// property of the text rather than of a platform's leading.
    fn fixed(unit: f64) -> impl Fn(&str) -> f64 {
        move |text: &str| text.chars().count() as f64 * unit
    }

    /// A pill's toast and celebration fields, in the shape the two traits
    /// expect, so the shared methods can be exercised without a draw site.
    ///
    /// Field names match the three real states so `impl_flash_host!` and
    /// `impl_celebration_host!` generate the impls exactly as they do in a pill.
    #[derive(Default)]
    struct StubState {
        indicator: crate::indicator::DictationIndicator<StubPhase>,
        flash_message: RefCell<String>,
        flash_is_error: Cell<bool>,
        flash_visible: Cell<bool>,
        flash_t: Cell<f64>,
        flash_velocity: Cell<f64>,
        flash_timer: Cell<f64>,
        flash_action: RefCell<Option<String>>,
        flash_action_label: RefCell<Option<String>>,
        flash_reject_action: RefCell<Option<String>>,
        flash_reject_action_label: RefCell<Option<String>>,
        fireworks_active: Cell<bool>,
        fireworks_elapsed: Cell<f64>,
        fireworks_next_launch: Cell<usize>,
        fireworks_rockets: RefCell<Vec<crate::fireworks::Rocket>>,
    }

    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
    struct StubPhase;

    impl crate::indicator::RecordingPhase for StubPhase {
        const IDLE: Self = StubPhase;
        const RECORDING: Self = StubPhase;
        const LOADING: Self = StubPhase;
    }

    impl StubState {
        fn activate_burst(&self) {
            self.fireworks_active.set(true);
        }
    }

    impl_flash_host!(StubState);
    impl_celebration_host!(StubState);

    fn spec() -> FlashBannerSpec {
        FlashBannerSpec {
            available_width: 600.0,
            available_left: 0.0,
            // The typing surface. The fixture uses the window the reviewers
            // measured against, so the room arithmetic is the real one.
            available_height: 362.0,
            center_x: 300.0,
            pill_top: 300.0,
            gap: 6.0,
            min_height: 32.0,
            padding_h: 16.0,
            min_width: BANNER_MIN_WIDTH,
            preferred_text_width: 0.0,
            action_width: None,
            reject_width: None,
            action_gap: 8.0,
            action_height: 22.0,
        }
    }

    fn with_text_width(mut spec: FlashBannerSpec, text_width: f64) -> FlashBannerSpec {
        spec.preferred_text_width = text_width;
        spec
    }

    fn layout(message: &str, text_width: f64, spec: &FlashBannerSpec) -> FlashBannerLayout {
        layout_flash_banner(&with_text_width(*spec, text_width), message, fixed(7.0))
    }

    #[test]
    fn a_short_message_keeps_its_one_line_height_and_centred_placement() {
        let layout = layout("Copied text", 118.0, &spec());
        assert_eq!(layout.banner.h, 32.0, "one line must stay 32px tall");
        assert_eq!(layout.banner.w, 118.0 + 16.0 * 2.0);
        assert_eq!(layout.banner.x, (600.0 - 150.0) / 2.0);
        assert_eq!(layout.banner.y, 300.0 - 6.0 - 32.0);
        assert_eq!(
            layout.banner.center_x(),
            300.0,
            "the banner is centred on the window"
        );
        assert_eq!(layout.lines, vec!["Copied text".to_string()]);
    }

    #[test]
    fn a_message_narrower_than_the_minimum_keeps_the_minimum_width() {
        let layout = layout("ok", 42.0, &spec());
        assert_eq!(layout.banner.w, BANNER_MIN_WIDTH, "the floor is unchanged");
        assert_eq!(layout.banner.h, 32.0);
    }

    #[test]
    fn a_short_message_centres_its_text_block_on_the_banner() {
        let layout = layout("Copied text", 118.0, &spec());
        assert_eq!(
            layout.text.center_y(),
            layout.banner.center_y(),
            "one line sits on the banner's centre line"
        );
    }

    #[test]
    fn a_long_message_wraps_to_several_lines_and_grows_the_banner() {
        let message = "the microphone could not be opened because another \
                       application is already holding the audio device";
        let layout = layout_flash_banner(&with_text_width(spec(), 200.0), message, fixed(7.0));
        assert!(layout.lines.len() > 1, "the message had to wrap");
        assert!(
            layout.banner.h > 32.0,
            "a wrapped banner must grow, got {}",
            layout.banner.h
        );
        assert_eq!(
            layout.banner.h,
            BANNER_PADDING_V * 2.0 + BANNER_TEXT_LINE * layout.lines.len() as f64
        );
        // The gap above the pill is unchanged, so the banner grows upward.
        assert_eq!(layout.banner.bottom(), 300.0 - 6.0);
        for line in &layout.lines {
            assert!(fixed(7.0)(line) <= layout.text.w, "{line:?} overran");
        }
        assert_eq!(
            layout
                .lines
                .join(" ")
                .split_whitespace()
                .collect::<Vec<_>>(),
            message.split_whitespace().collect::<Vec<_>>(),
            "wrapping must not lose or reorder a word"
        );
    }

    #[test]
    fn a_longer_message_makes_a_taller_banner() {
        let short = layout("one line", 200.0, &spec());
        let long = layout(
            "a message long enough that it has to be broken across several lines \
             of the banner before it will fit inside the window at all",
            200.0,
            &spec(),
        );
        assert!(long.lines.len() > short.lines.len());
        assert!(long.banner.h > short.banner.h);
        // Growing upward keeps the pill's own place and the gap intact.
        assert_eq!(long.banner.bottom(), short.banner.bottom());
    }

    #[test]
    fn the_banner_never_leaves_the_window() {
        // A message far wider than the window would once have painted past
        // both edges and been clipped away.
        let narrow = FlashBannerSpec {
            available_width: 200.0,
            center_x: 100.0,
            ..spec()
        };
        let layout = layout_flash_banner(
            &with_text_width(narrow, 4000.0),
            &"word ".repeat(80),
            fixed(7.0),
        );
        assert!(layout.banner.x >= BANNER_MIN_MARGIN, "left edge clipped");
        assert!(
            layout.banner.right() <= 200.0 - BANNER_MIN_MARGIN,
            "right edge clipped"
        );
        assert_eq!(layout.banner.center_x(), 100.0);
        assert!(layout.lines.len() > 4, "the text kept wrapping instead");
    }

    #[test]
    fn a_narrow_window_gives_the_text_a_smaller_budget_and_more_lines() {
        let wide = FlashBannerSpec {
            available_width: 600.0,
            ..spec()
        };
        let narrow = FlashBannerSpec {
            available_width: 320.0,
            center_x: 160.0,
            ..spec()
        };
        let message = "the audio device was disconnected before the recording \
                       could be saved to disk";
        // The preferred width is what the message would take on one line, so a
        // narrower one is a message the banner was already going to wrap.
        let wide = layout_flash_banner(&with_text_width(wide, 400.0), message, fixed(7.0));
        let narrow = layout_flash_banner(&with_text_width(narrow, 200.0), message, fixed(7.0));
        assert!(narrow.banner.w < wide.banner.w);
        assert!(narrow.text.w < wide.text.w);
        assert!(
            narrow.lines.len() > wide.lines.len(),
            "a narrower banner needs more lines: {} vs {}",
            narrow.lines.len(),
            wide.lines.len()
        );
        assert!(narrow.banner.h > wide.banner.h);
    }

    #[test]
    fn a_narrower_window_gives_the_text_a_smaller_budget() {
        let narrow = FlashBannerSpec {
            available_width: 240.0,
            center_x: 120.0,
            ..spec()
        };
        let layout = layout_flash_banner(&with_text_width(narrow, 900.0), "a message", fixed(7.0));
        assert!(layout.text.w < layout.banner.w);
        assert_eq!(
            layout.text.w,
            layout.banner.w - spec().padding_h * 2.0,
            "with no buttons the text owns the banner less its padding"
        );
    }

    #[test]
    fn the_banner_is_centred_on_the_pill_even_when_the_pill_is_off_centre() {
        // Dictation draws the pill in a narrow box inside a wide window. The
        // content space is offset, so the pill's centre is not the window's
        // midpoint; the banner must follow the pill, not the window.
        let offset = FlashBannerSpec {
            available_width: 600.0,
            center_x: 240.0,
            ..spec()
        };
        let layout = layout_flash_banner(
            &with_text_width(offset, 200.0),
            "a short notice",
            fixed(7.0),
        );
        assert_eq!(layout.banner.center_x(), 240.0);
        assert!(layout.banner.x >= BANNER_MIN_MARGIN);
        assert!(layout.banner.right() <= 600.0 - BANNER_MIN_MARGIN);
    }

    /// A pill dragged off the canvas still puts its banner above itself.
    ///
    /// The Wayland path draws the pill in a full-window canvas and translates it
    /// by the drag offset, so `pill_top` can be negative while the pill is still
    /// on screen. Treating that as a length and flooring it at zero claims the
    /// pill is at the top of the surface -- the opposite of where it is -- and
    /// the banner is then laid out with no headroom, below the pill.
    #[test]
    fn a_pill_dragged_off_the_top_takes_its_banner_with_it() {
        let dragged_up = FlashBannerSpec {
            pill_top: -60.0,
            available_width: 600.0,
            center_x: 300.0,
            ..spec()
        };
        let layout = layout_flash_banner(
            &with_text_width(dragged_up, 200.0),
            "dragged upward",
            fixed(7.0),
        );

        // -60 is the pill's real position, so the banner hangs above it, not
        // below a pill that was mistaken for being at zero.
        assert!(
            layout.banner.bottom() <= -60.0,
            "the banner was placed below a pill that is above the canvas: {:?}",
            layout.banner
        );
        assert!(
            layout.banner.y < -60.0,
            "the banner did not move with the dragged pill: {:?}",
            layout.banner
        );
    }

    /// The dictation surface is 86 tall, and its banner still wraps.
    ///
    /// This was raised as a regression: if the line ceiling is computed from the
    /// room above the pill, the small canvas would leave so little of it that a
    /// long message collapsed to one elided line. The arithmetic says otherwise
    /// -- `74 - 6 = 68` units is two lines of 48 -- and this pins it so that a
    /// later change to the floor or the padding cannot quietly take the second
    /// line away without a test failing.
    #[test]
    fn a_banner_on_the_short_dictation_surface_still_wraps() {
        // What `pill_position` computes: bottom-anchored with a 6-unit inset.
        let (wh, pill_h, bottom_inset) = (86.0, 6.0, 6.0);
        let pill_top = wh - bottom_inset - pill_h;
        assert_eq!(pill_top, 74.0, "the fixture has to match the real pill");

        let dictation = FlashBannerSpec {
            available_width: 200.0,
            available_height: wh,
            pill_top,
            center_x: 100.0,
            preferred_text_width: 180.0,
            ..spec()
        };
        let message = "the audio device was disconnected before the recording could be saved";
        let layout = layout_flash_banner(&dictation, message, fixed(7.0));

        assert!(
            layout.lines.len() >= 2,
            "the short surface collapsed the message to {} line(s)",
            layout.lines.len()
        );
        assert!(
            layout.banner.y >= 0.0,
            "the banner left the short surface: {:?}",
            layout.banner
        );
        assert!(
            layout.banner.bottom() <= pill_top,
            "the banner overlaps the pill: {:?}",
            layout.banner
        );
    }

    /// A 200-unit pill box inside a 600-unit canvas: the dictation geometry.
    ///
    /// This is the configuration the whole centring fix exists for, so it is
    /// asserted end to end rather than only through the centre's arithmetic:
    /// the banner is centred on the pill that produced it, it wraps inside the
    /// canvas rather than the pill box, and it stays inside the canvas.
    #[test]
    fn a_narrow_pill_box_inside_a_wide_canvas_centres_and_wraps_inside_the_canvas() {
        // Exactly what the GTK painter computes: pill_x = (600 - 200) / 2,
        // pill_w = 200, so the pill's centre is 300 and its box is 200..400.
        let (canvas, pill_x, pill_w) = (600.0, 200.0, 200.0);
        let dictation = FlashBannerSpec {
            available_width: canvas,
            center_x: pill_x + pill_w / 2.0,
            preferred_text_width: 440.0,
            ..spec()
        };
        let message = "a message long enough to wrap onto several lines inside the banner";
        let layout = layout_flash_banner(&dictation, message, fixed(7.0));

        assert_eq!(
            layout.banner.center_x(),
            300.0,
            "the banner is not centred on the 200-wide pill inside the 600 canvas"
        );
        assert!(
            layout.banner.w > pill_w,
            "the banner was squeezed into the pill's box instead of using the canvas"
        );
        assert!(
            layout.banner.x >= BANNER_MIN_MARGIN - 1e-9
                && layout.banner.right() <= canvas - BANNER_MIN_MARGIN + 1e-9,
            "the banner left the canvas: {:?}",
            layout.banner
        );
        assert!(
            layout.lines.len() > 1,
            "the fixture has to wrap to prove anything"
        );
    }

    /// The dictation toast uses the window, not the pill's 200-unit box.
    ///
    /// This is the wiring, at the geometry the pills actually paint with, and it
    /// is the defect CodeAnt found on the Windows draw site: all three painters
    /// handed the layout `ww` -- the content box `draw_width` springs towards, 200
    /// units in dictation -- as the surface. The banner was therefore capped at
    /// `200 - 2 * 2`, so a long error wrapped into a narrow column inside a
    /// 600-unit window that had room for the 480-unit cap.
    ///
    /// The painter has also translated by `content_offset` before the banner
    /// runs, so the window spans `-200..400` in the space the rectangle is
    /// measured in, not `0..600`. The surface therefore carries its own left
    /// edge; correcting only the width would have clamped the banner into the
    /// leftmost 200 units and pushed it off the pill instead.
    ///
    /// Both halves are asserted: the banner is wider than the box that used to
    /// cap it, and it stays inside the window once the translation is undone.
    #[test]
    fn a_dictation_toast_uses_the_window_the_painter_is_translated_inside() {
        // What the three painters compute for a collapsed dictation pill: the
        // canvas is 600 wide, the content box 200, so `content_offset` is 200 and
        // the surface runs -200..400.
        let (canvas, content, pill_w) = (600.0, 200.0, 200.0);
        let offset = (canvas - content) / 2.0;
        assert_eq!(offset, 200.0, "the fixture has to match the real painters");
        let pill_x = (content - pill_w) / 2.0;

        let dictation = FlashBannerSpec {
            // The surface, not the content box: `of_painter` widens the content
            // width by both offsets, which is what makes it the window.
            available_width: canvas,
            available_left: -offset,
            available_height: 86.0,
            center_x: pill_x + pill_w / 2.0,
            pill_top: 74.0,
            preferred_text_width: 900.0,
            ..spec()
        };
        let message = "the audio device was disconnected before the recording could be saved";
        let layout = layout_flash_banner(&dictation, message, fixed(7.0));

        let box_cap = content - BANNER_MIN_MARGIN * 2.0;
        assert!(
            layout.banner.w > box_cap + 1.0,
            "the banner was still capped at the content box: {:.1} against a {:.1} window",
            layout.banner.w,
            canvas
        );
        assert_eq!(
            layout.banner.w, BANNER_MAX_WIDTH,
            "a long message in a 600-unit window did not reach the readable cap"
        );

        // Undo the painter's translation to see the pixels the window clips.
        let windowed_x = layout.banner.x + offset;
        assert!(
            windowed_x >= BANNER_MIN_MARGIN - 1e-9
                && windowed_x + layout.banner.w <= canvas - BANNER_MIN_MARGIN + 1e-9,
            "the banner left the window once translated: {}..{} in a {canvas}-wide window",
            windowed_x,
            windowed_x + layout.banner.w
        );
        assert_eq!(
            layout.banner.center_x(),
            pill_x + pill_w / 2.0,
            "the banner has to stay on the pill it belongs to"
        );
    }

    /// A banner centred on the pill follows a dragged pill, and is held on the
    /// surface when the pill is near an edge.
    ///
    /// This is the case a width alone cannot express. The pill can be dragged on
    /// Wayland and on macOS, so its centre is not necessarily the window's and
    /// not necessarily the surface's midpoint either. Centring is the rule; the
    /// clamp only overrides it when following the pill would push the banner off
    /// the surface, which is the lesser of the two defects because the text is
    /// still readable and still attached to the pill.
    #[test]
    fn a_banner_follows_a_dragged_pill_and_stays_on_the_surface() {
        // A 200-wide banner centred at 400 still has 100 units of surface to its
        // right, so nothing needs clamping and it stays on the pill.
        let dragged = FlashBannerSpec {
            available_width: 600.0,
            center_x: 400.0,
            ..spec()
        };
        let layout = layout_flash_banner(
            &with_text_width(dragged, 200.0),
            "dragged to the right",
            fixed(7.0),
        );
        assert_eq!(
            layout.banner.center_x(),
            400.0,
            "a banner that fits beside a dragged pill should still be centred on it"
        );

        // Near the edge there is no room to stay centred, so it is clamped in.
        let near_edge = FlashBannerSpec {
            available_width: 600.0,
            center_x: 590.0,
            ..spec()
        };
        let layout = layout_flash_banner(
            &with_text_width(near_edge, 460.0),
            "dragged hard against the right edge of the surface",
            fixed(7.0),
        );
        assert!(
            layout.banner.right() <= 600.0 - BANNER_MIN_MARGIN + 1e-9,
            "the banner hung off the surface: {:?}",
            layout.banner
        );
        assert!(layout.banner.x >= BANNER_MIN_MARGIN - 1e-9);
    }

    #[test]
    fn a_banner_wider_than_the_room_is_clamped_not_centred_off_the_edge() {
        let tight = FlashBannerSpec {
            available_width: 300.0,
            center_x: 150.0,
            ..spec()
        };
        let layout = layout_flash_banner(
            &with_text_width(tight, 900.0),
            "a very long message here",
            fixed(7.0),
        );
        assert!(
            layout.banner.x >= BANNER_MIN_MARGIN - 1e-9 && layout.banner.right() <= 300.0,
            "the banner left its room: {:?}",
            layout.banner
        );
        assert_eq!(layout.banner.w, 300.0 - BANNER_MIN_MARGIN * 2.0);
    }

    #[test]
    fn a_very_wide_window_still_caps_the_banner_at_a_readable_width() {
        let display = FlashBannerSpec {
            available_width: 3840.0,
            center_x: 1920.0,
            ..spec()
        };
        let layout = layout_flash_banner(
            &with_text_width(display, 3000.0),
            &"word ".repeat(200),
            fixed(7.0),
        );
        assert_eq!(layout.banner.w, BANNER_MAX_WIDTH, "the cap must apply");
        assert_eq!(
            layout.banner.center_x(),
            1920.0,
            "and the banner stays on the pill"
        );
        assert!(
            layout.lines.len() > 5,
            "the message wrapped instead of running wide"
        );
    }

    #[test]
    fn a_narrow_window_still_wins_over_the_cap() {
        let cap = banner_max_width(BannerSurface::new(3840.0), BANNER_MIN_WIDTH);
        let narrow = banner_max_width(BannerSurface::new(300.0), BANNER_MIN_WIDTH);
        assert_eq!(cap, BANNER_MAX_WIDTH);
        assert_eq!(narrow, 300.0 - BANNER_MIN_MARGIN * 2.0);
        assert!(narrow < cap);
    }

    #[test]
    fn an_odd_subpixel_room_never_pushes_the_banner_off_centre() {
        // The springs settle on fractional widths, so a half-pixel wide room is
        // a real state, not a hypothetical one.
        let odd = FlashBannerSpec {
            available_width: 452.5,
            center_x: 226.25,
            ..spec()
        };
        let layout = layout_flash_banner(&with_text_width(odd, 400.0), "a message", fixed(7.0));
        assert!((layout.banner.center_x() - 226.25).abs() < 1e-9);
        assert!(layout.banner.right() <= 452.5);
    }

    #[test]
    fn buttons_keep_their_place_and_never_squeeze_the_text_off_the_line() {
        let with_buttons = FlashBannerSpec {
            action_width: Some(74.0),
            reject_width: Some(60.0),
            ..spec()
        };
        let layout = layout_flash_banner(
            &with_text_width(with_buttons, 800.0),
            "delete it",
            fixed(7.0),
        );
        let action = layout.action.expect("an action button was reserved");
        let reject = layout.reject.expect("a reject button was reserved");
        assert_eq!(
            action.right(),
            layout.banner.right() - spec().padding_h,
            "the action button sits on the right padding"
        );
        assert_eq!(
            reject.right() + spec().action_gap,
            action.x,
            "the reject button leaves the gap before the action button"
        );
        assert_eq!(reject.y, action.y, "the buttons share one line");
        assert_eq!(
            action.center_y(),
            layout.banner.center_y(),
            "the buttons are centred on the banner, not on its first line"
        );
        assert!(
            layout.text.w > 0.0,
            "the text still has room beside the buttons"
        );
        assert!(
            layout.text.right() <= reject.x,
            "the text budget must stop before the reject button"
        );
    }

    #[test]
    fn buttons_stay_on_the_banner_when_the_message_wraps() {
        let with_buttons = FlashBannerSpec {
            action_width: Some(74.0),
            ..spec()
        };
        let message = "the file could not be transcribed because the format \
                       is not supported by the installed engine";
        let layout =
            layout_flash_banner(&with_text_width(with_buttons, 800.0), message, fixed(7.0));
        assert!(layout.lines.len() > 1);
        let action = layout.action.expect("the action is still reported");
        assert_eq!(
            action.center_y(),
            layout.banner.center_y(),
            "a taller banner must not leave the button behind"
        );
        assert!(action.bottom() <= layout.banner.bottom());
    }

    #[test]
    fn a_button_and_no_reject_banner_is_wider_than_the_message_alone() {
        // Regression: the preferred width used to add the button widths but no
        // gap, while the wrap budget took a gap off. The banner therefore came
        // out one gap narrower than its own arithmetic, and the text was wrapped
        // for less room than the banner had.
        let with_action = FlashBannerSpec {
            action_width: Some(64.0),
            ..spec()
        };
        let layout = layout_flash_banner(
            &with_text_width(with_action, 300.0),
            "delete the file",
            fixed(7.0),
        );
        assert_eq!(
            layout.banner.w,
            300.0 + 16.0 * 2.0 + 8.0 + 64.0,
            "padding, one gap and the button"
        );
        assert_eq!(
            layout.text.w, 300.0,
            "the message keeps the width it was measured at"
        );
    }

    #[test]
    fn an_action_message_wraps_within_the_room_the_button_leaves() {
        let with_buttons = FlashBannerSpec {
            action_width: Some(74.0),
            ..spec()
        };
        let message = "the transcript could not be inserted into the focused \
                       application because it does not accept pasted text";
        let plain = layout_flash_banner(&with_text_width(spec(), 800.0), message, fixed(7.0));
        let buttoned =
            layout_flash_banner(&with_text_width(with_buttons, 800.0), message, fixed(7.0));
        assert!(
            buttoned.text.w < plain.text.w,
            "the button must come out of the text budget"
        );
        assert!(buttoned.lines.len() >= plain.lines.len());
    }

    /// Buttons wider than the banner are held inside it, not painted past it.
    ///
    /// The reported case: two 230-wide buttons and a normal banner. Reserving
    /// their full widths would leave the message a zero budget and, worse, put
    /// the action button's right edge 224 units past the banner's own right edge
    /// and the reject button outside its left edge. Both are painted from these
    /// rectangles, so both would be visible outside the rounded rectangle.
    #[test]
    fn buttons_too_wide_for_the_banner_are_held_inside_it() {
        let oversized = FlashBannerSpec {
            action_width: Some(230.0),
            reject_width: Some(230.0),
            ..spec()
        };
        let layout = layout_flash_banner(&oversized, "Continue?", fixed(7.0));
        let banner = layout.banner;
        let action = layout.action.expect("the fixture asks for an action");
        let reject = layout.reject.expect("the fixture asks for a reject");

        for (name, button) in [("action", action), ("reject", reject)] {
            assert!(
                button.x >= banner.x - 0.001,
                "the {name} button starts left of the banner: {button:?} against {banner:?}"
            );
            assert!(
                button.right() <= banner.right() + 0.001,
                "the {name} button runs past the banner: {button:?} against {banner:?}"
            );
            assert!(button.w > 0.0, "the {name} button was squeezed to nothing");
        }

        // The two share the room in proportion, so neither is starved.
        assert!(
            (action.w - reject.w).abs() < 0.001,
            "equal buttons were not treated equally: {action:?} and {reject:?}"
        );

        // And the message keeps what is left rather than a negative budget.
        assert!(layout.text.w >= 0.0);
        assert!(!layout.text.w.is_nan());
    }

    #[test]
    fn a_button_wide_enough_to_fill_the_banner_leaves_no_negative_budget() {
        let dominated = FlashBannerSpec {
            action_width: Some(4000.0),
            reject_width: Some(4000.0),
            available_width: 300.0,
            center_x: 150.0,
            ..spec()
        };
        let layout = layout_flash_banner(&with_text_width(dominated, 100.0), "hello", fixed(7.0));
        assert_eq!(layout.text.w, 0.0, "a negative budget must clamp");
        let action = layout.action.expect("the action is still reported");
        assert!(!action.w.is_nan());
        assert!(layout.banner.w <= 300.0 - BANNER_MIN_MARGIN * 2.0);
    }

    #[test]
    fn an_explicit_newline_starts_a_new_line() {
        let lines = wrap_to_width("first\nsecond", 1000.0, fixed(10.0));
        assert_eq!(lines, vec!["first".to_string(), "second".to_string()]);
    }

    #[test]
    fn words_that_fit_are_kept_whole_and_packed_greedily() {
        // 10 units per character and a 100-unit budget: "aaaa bbbb" is 9
        // characters and fits, "aaaa bbbb cccc" is 14 and does not.
        let lines = wrap_to_width("aaaa bbbb cccc", 100.0, fixed(10.0));
        assert_eq!(lines, vec!["aaaa bbbb".to_string(), "cccc".to_string()]);
    }

    #[test]
    fn a_word_wider_than_the_banner_is_broken_rather_than_overrunning() {
        // A path or a URL: one 20-character word against a 50-unit budget.
        let lines = wrap_to_width("abcdefghijklmnopqrst", 50.0, fixed(10.0));
        assert!(lines.len() > 1, "the word had to be broken");
        for line in &lines {
            assert!(
                fixed(10.0)(line) <= 50.0,
                "{line:?} overran the banner budget"
            );
        }
        assert_eq!(lines.concat(), "abcdefghijklmnopqrst", "nothing was lost");
    }

    #[test]
    fn a_multi_byte_word_is_broken_on_a_character_boundary() {
        let text = "日本語日本語日本語";
        let lines = wrap_to_width(text, 40.0, fixed(10.0));
        for line in &lines {
            assert!(
                line.chars().count() <= 4,
                "{line:?} is wider than the 40-unit budget"
            );
        }
        assert_eq!(lines.concat(), text);
    }

    /// The gap between two words survives the wrap as it was written.
    ///
    /// A path reported in a message -- `/tmp/Client  Files` -- is two spaces
    /// wide, and collapsing it to one turns a path the user can open into a
    /// path that does not exist. Only a gap a line break lands on is dropped,
    /// and that is invisible because the break itself says the same thing.
    #[test]
    fn the_gap_between_words_is_kept_exactly() {
        let lines = wrap_to_width("/tmp/Client  Files", 1000.0, fixed(10.0));
        assert_eq!(lines, vec!["/tmp/Client  Files".to_string()]);
    }

    /// And a tab is a gap too, not a word boundary to be normalised away.
    #[test]
    fn a_tab_between_words_is_not_replaced_by_a_space() {
        let lines = wrap_to_width("a\tb", 1000.0, fixed(10.0));
        assert_eq!(lines, vec!["a\tb".to_string()]);
    }

    /// A break consumes the gap it lands on and nothing else.
    #[test]
    fn a_break_drops_the_gap_it_lands_on_and_keeps_the_rest() {
        // Nine characters is 90 units, so 80 fits "aa  bb" (60) but not the
        // whole line. The break lands on the gap between "bb" and "cc" and that
        // gap goes; the interior two-space gap is kept.
        let lines = wrap_to_width("aa  bb  cc", 80.0, fixed(10.0));
        assert_eq!(
            lines,
            vec!["aa  bb".to_string(), "cc".to_string()],
            "the interior gap was collapsed or left dangling"
        );
        for line in &lines {
            assert!(
                !line.starts_with(' ') && !line.ends_with(' '),
                "{line:?} kept whitespace at a line edge"
            );
        }
    }

    /// A wrap never invents or loses a character except the gaps it breaks on.
    #[test]
    fn wrapping_loses_nothing_but_the_gaps_it_breaks_on() {
        let text = "  hello   world this  is a message  ";
        let lines = wrap_to_width(text, 100.0, fixed(10.0));
        let rejoined = lines.join(" ");
        assert_eq!(
            rejoined.split_whitespace().collect::<Vec<_>>(),
            text.split_whitespace().collect::<Vec<_>>(),
            "a word was lost or reordered"
        );
        assert_eq!(lines[0], "hello", "leading indentation was kept");
    }

    /// An over-wide word is broken between grapheme clusters, not characters.
    ///
    /// Splitting on `char`s cuts inside a cluster, and the halves are visibly
    /// broken: a ZWJ family becomes two separate people, a flag becomes two
    /// regional-indicator letters, and a base plus its combining accent are
    /// pulled apart onto different lines. Counting clusters rather than `char`s
    /// keeps every cluster whole across the break.
    #[test]
    fn an_over_wide_word_is_broken_between_grapheme_clusters() {
        use unicode_segmentation::UnicodeSegmentation;

        // Four family emoji: one cluster each, twelve `char`s each.
        let family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}";
        let text = family.repeat(4);
        assert_eq!(
            text.graphemes(true).count(),
            4,
            "the fixture is four clusters"
        );
        assert!(text.chars().count() > 4);

        let lines = wrap_to_width(&text, 30.0, fixed(10.0));
        assert!(lines.len() > 1, "the word had to be broken");
        for line in &lines {
            assert_eq!(
                line.graphemes(true).count(),
                1,
                "{line:?} is not a whole number of clusters, so one was cut"
            );
            assert_eq!(
                line.chars().count(),
                family.chars().count(),
                "{line:?} lost part of its cluster across the break"
            );
        }
        assert_eq!(lines.concat(), text, "nothing was lost");
    }

    /// The same rule for a base plus its combining marks.
    #[test]
    fn combining_marks_stay_with_their_base_across_a_break() {
        use unicode_segmentation::UnicodeSegmentation;

        // e + acute written as a combining sequence, four times: four clusters.
        let text = "e\u{301}e\u{301}e\u{301}e\u{301}";
        assert_eq!(text.graphemes(true).count(), 4);
        assert_eq!(text.chars().count(), 8);

        // A 12-unit budget takes one cluster (one measured unit) at a time, so
        // any split on `char` boundaries shows up as a line ending in a bare
        // base or beginning with a stranded accent.
        let lines = wrap_to_width(text, 12.0, fixed(10.0));
        assert!(lines.len() > 1, "the word had to be broken");
        for line in &lines {
            assert_eq!(
                line.graphemes(true).count(),
                1,
                "{line:?} did not keep its base and combining mark together"
            );
            assert!(
                !line.starts_with('\u{301}'),
                "{line:?} begins with a stranded combining mark"
            );
        }
        assert_eq!(lines.concat(), text);
    }

    #[test]
    fn an_impossible_budget_still_returns_text_rather_than_nothing() {
        // Dropping the message entirely reads as a banner that lost its text.
        let lines = wrap_to_width("hello", 0.0, fixed(10.0));
        assert_eq!(lines.concat(), "hello");
    }

    #[test]
    fn a_blank_message_keeps_its_one_line() {
        assert_eq!(wrap_to_width("", 100.0, fixed(10.0)), vec![String::new()]);
        assert_eq!(
            wrap_to_width("   ", 100.0, fixed(10.0)),
            vec![String::new()]
        );
    }

    #[test]
    fn unusable_measurements_never_produce_a_nan_rectangle() {
        let broken = FlashBannerSpec {
            available_width: f64::NAN,
            center_x: f64::NAN,
            pill_top: f64::NAN,
            action_width: Some(f64::NAN),
            ..spec()
        };
        let layout = layout_flash_banner(&with_text_width(broken, f64::NAN), "hello", fixed(7.0));
        for value in [
            layout.banner.x,
            layout.banner.y,
            layout.banner.w,
            layout.banner.h,
            layout.text.x,
            layout.text.y,
            layout.text.w,
            layout.text.h,
            layout.text.w,
        ] {
            assert!(!value.is_nan(), "a NaN reached the layout");
        }
        assert!(layout.banner.w > 0.0, "the banner survived as a shape");
        assert!(layout.banner.h > 0.0);
    }

    #[test]
    fn a_celebration_launches_from_the_banner_centre_on_the_pill_axis() {
        let layout = layout("Copied text", 118.0, &spec());
        let (x, y) = celebration_origin(300.0, 300.0, 6.0, 32.0, layout.lines.len());
        assert_eq!(x, 300.0, "the celebration shares the pill's centre line");
        assert_eq!(y, layout.banner.center_y());

        let tall = layout_flash_banner(
            &with_text_width(spec(), 200.0),
            "a message long enough that it has to be broken across several lines \
             of the banner before it will fit inside the window at all",
            fixed(7.0),
        );
        assert!(tall.lines.len() > 1);
        assert!(
            celebration_origin(300.0, 300.0, 6.0, 32.0, tall.lines.len()).1
                < celebration_origin(300.0, 300.0, 6.0, 32.0, 1).1,
            "a taller banner puts the launch point higher"
        );
    }

    #[test]
    fn the_centre_matches_the_banner_the_paint_path_draws() {
        let one_line = layout("Copied text", 118.0, &spec());
        assert_eq!(
            banner_center_y(300.0, 6.0, 32.0, one_line.lines.len()),
            one_line.banner.center_y(),
            "the tick path and the paint path must agree on the banner's centre"
        );
        let tall = layout(
            "a message long enough that it has to be broken across several lines \
             of the banner before it will fit inside the window at all",
            200.0,
            &spec(),
        );
        assert!(tall.lines.len() > 1);
        assert_eq!(
            banner_center_y(300.0, 6.0, 32.0, tall.lines.len()),
            tall.banner.center_y()
        );
        assert!(
            banner_center_y(300.0, 6.0, 32.0, 3) < banner_center_y(300.0, 6.0, 32.0, 1),
            "a taller banner puts its centre higher"
        );
    }

    #[test]
    fn a_zero_line_count_is_treated_as_one_line() {
        assert_eq!(banner_height(0, 32.0, 8.0, 16.0), 32.0);
        assert_eq!(banner_height(1, 32.0, 8.0, 16.0), 32.0);
        assert!(banner_height(3, 32.0, 8.0, 16.0) > banner_height(2, 32.0, 8.0, 16.0));
    }

    #[test]
    fn one_line_fills_the_established_banner_height_exactly() {
        // The whole reason the padding and the pitch are these numbers: a short
        // message must not change height, or every existing banner would jump.
        assert_eq!(
            BANNER_PADDING_V * 2.0 + BANNER_TEXT_LINE,
            32.0,
            "one line must still measure the classic 32px banner"
        );
    }

    #[test]
    fn a_line_is_placed_one_pitch_below_the_last() {
        let text = BannerRect {
            x: 10.0,
            y: 20.0,
            w: 100.0,
            h: 40.0,
        };
        assert_eq!(
            text.line_top(0, 10.0),
            20.0 + (BANNER_TEXT_LINE - 10.0) / 2.0
        );
        assert_eq!(text.line_top(2, 10.0), 20.0 + BANNER_TEXT_LINE * 2.0 + 3.0);
        assert_eq!(
            text.line_top(0, BANNER_TEXT_LINE),
            20.0,
            "a platform whose line box matches the pitch starts at the block top"
        );
        assert_eq!(text.line_x(40.0), 10.0 + 30.0);
        assert_eq!(
            text.line_x(400.0),
            10.0,
            "a line wider than the block starts at its edge"
        );
    }

    /// The celebration's launch point, on the wiring.
    ///
    /// STRUCTURAL, for the same reason as the test below: the tick lives on a
    /// different path in each crate and cannot be run from here. The celebration
    /// leaves from the middle of the flash banner, so when the banner's height
    /// started following its line count, a hardcoded `FLASH_HEIGHT / 2.0` there
    /// would have kept launching from where a one-line banner used to be. This
    /// pins that all three ask [`CelebrationHost::tick_celebration`], which
    /// resolves the same centre the paint path does, at the moment it ticks.
    #[test]
    fn all_three_celebration_ticks_launch_from_the_shared_banner_centre() {
        // The paint records the centre it used; the tick reads it back. A pill
        // that re-derived the launch point would disagree with its own banner
        // the moment a message wrapped to a second line, which is the bug this
        // branch exists to fix.
        let manifest = env!("CARGO_MANIFEST_DIR");
        for path in [
            "../rust_gtk_pill/src/pill.rs",
            "../rust_macos_pill/src/app.rs",
            "../rust_windows_pill/src/pill.rs",
        ] {
            let source = std::fs::read_to_string(format!("{manifest}/{path}"))
                .unwrap_or_else(|err| panic!("read {path}: {err}"));
            assert!(
                source.contains(".tick_celebration("),
                "{path} launches the celebration from its own idea of the banner height"
            );
            assert!(
                !source.contains("FLASH_HEIGHT / 2.0"),
                "{path} still halves the fixed one-line height for the launch point"
            );
        }
    }

    /// A new banner must not inherit the centre of the one before it.
    ///
    /// The same hazard as the line count: `celebrate` resets the count because a
    /// celebration message is short, and it has to reset the centre for exactly
    /// the reason it resets the count. Otherwise a burst arriving right after a
    /// tall error toast launches from where that toast's middle used to be.
    #[test]
    fn showing_or_clearing_a_banner_forgets_where_the_last_one_painted() {
        let state = StubState::default();
        state.indicator.banner_center.set(Some((100.0, 12.0)));

        state.celebrate("Streak", 2.5);
        assert_eq!(
            state.indicator.banner_center.get(),
            None,
            "a celebration kept the previous banner's centre, so its burst launches from a stale point"
        );

        state.indicator.banner_center.set(Some((100.0, 40.0)));
        state.clear_flash();
        assert_eq!(
            state.indicator.banner_center.get(),
            None,
            "clearing a toast kept its centre, so the next burst launches from where it used to be"
        );
    }

    /// A burst with nowhere to launch from still advances its clock.
    ///
    /// This is the finding that my first version of this got wrong. The banner is
    /// not painted while GTK's assistant panel is open, so a burst that starts in
    /// that state has no recorded centre. Skipping the tick entirely froze its
    /// elapsed time, and it then resumed stale once a banner finally painted.
    #[test]
    fn a_burst_advances_even_before_any_banner_paints() {
        let state = StubState::default();
        state.activate_burst();
        assert_eq!(state.indicator.banner_center.get(), None);

        state.tick_celebration(0.5);

        assert_eq!(
            state.fireworks_elapsed.get(),
            0.5,
            "the burst's clock did not advance while the banner was unpainted"
        );
        assert!(
            state.fireworks_rockets.borrow().is_empty(),
            "a rocket launched with no origin, so its start point was invented"
        );
    }

    /// Dismissing a banner ends its burst, exactly as letting it expire does.
    ///
    /// The two ways a banner goes away are the timer running out and the user
    /// clicking one of its buttons. The first version of this fix only cancelled
    /// the burst on expiry, which left the dismissal path holding a launch
    /// schedule that could fire under whatever banner came next -- including one
    /// that is not a celebration at all.
    #[test]
    fn dismissing_a_banner_cancels_the_burst_it_announced() {
        let state = StubState::default();
        state.activate_burst();
        state.flash_visible().set(true);
        state.flash_timer().set(5.0);
        *state.flash_action().borrow_mut() = Some("toast-accept".to_string());
        state.tick_celebration(1.0);
        assert!(state.fireworks_active().get(), "the burst was already over");

        let mut sent: Option<String> = None;
        dismiss_flash(&state, false, |action| sent = Some(action.to_string()));

        assert_eq!(
            sent.as_deref(),
            Some("toast-accept"),
            "the token was not sent"
        );
        assert!(!state.flash_visible().get(), "the banner was not cleared");
        assert!(
            !state.fireworks_active().get(),
            "the burst outlived the banner the user dismissed"
        );
        assert_eq!(
            state.fireworks_next_launch().get(),
            0,
            "the schedule survived"
        );
        assert!(
            state.fireworks_rockets().borrow().is_empty(),
            "rockets survived the dismissal"
        );
    }

    /// A burst does not outlive the banner that announced it.
    ///
    /// The other half of the same finding: even with the clock running, a burst
    /// left active after `clear_flash` would wake up under whatever message came
    /// next. The banner's countdown is therefore what ends it.
    #[test]
    fn the_banner_countdown_ends_the_burst() {
        let state = StubState::default();
        state.activate_burst();
        state.flash_visible().set(true);
        state.flash_timer().set(0.1);
        state.tick_celebration(0.5);
        assert!(state.fireworks_active().get(), "the burst was already over");

        tick_banner_timer(&state, 0.2);

        assert!(!state.flash_visible().get(), "the banner did not expire");
        assert!(
            !state.fireworks_active().get(),
            "the burst outlived its banner"
        );
        assert_eq!(
            state.fireworks_elapsed().get(),
            0.0,
            "the clock was left behind"
        );
        assert_eq!(
            state.fireworks_next_launch().get(),
            0,
            "the schedule was left behind"
        );
        assert!(
            state.fireworks_rockets().borrow().is_empty(),
            "rockets were left behind"
        );
    }

    /// And the held launch goes out as soon as there is an origin.
    ///
    /// Withholding the origin must not consume the launch schedule: the rocket
    /// that was due while the banner was unpainted still leaves, from the centre
    /// the first paint recorded.
    #[test]
    fn a_held_launch_leaves_once_the_banner_paints() {
        let state = StubState::default();
        state.activate_burst();

        // Long enough that several launches are due, but nothing can leave yet.
        state.tick_celebration(1.0);
        assert!(
            state.fireworks_rockets.borrow().is_empty(),
            "a rocket left with no recorded centre"
        );
        assert_eq!(
            state.fireworks_next_launch.get(),
            0,
            "the schedule was consumed"
        );

        state.indicator.banner_center.set(Some((300.0, 100.0)));
        state.tick_celebration(1.0 / 60.0);

        let rockets = state.fireworks_rockets.borrow();
        assert!(
            !rockets.is_empty(),
            "the held launch never left after the banner painted"
        );
        assert_eq!(
            rockets[0].trail[0],
            (300.0, 100.0),
            "the held rocket launched from somewhere other than the painted centre"
        );
    }

    /// The wiring, not the arithmetic.
    ///
    /// STRUCTURAL, and labelled. The property that broke was never inside this
    /// module: it was that a draw site had no window bound and no line count, and
    /// no test in the repository could see a draw site, because rendering one
    /// needs Direct2D, CoreText or Cairo and a display. So the call is asserted on
    /// the source of all three, the same instrument `text_fit` uses for the same
    /// reason. It also pins that the old inline arithmetic cannot come back: a
    /// `let flash_w =` in any of the three is the regression this exists to catch.
    #[test]
    fn all_three_draw_sites_lay_the_banner_out_through_this_module() {
        let manifest = env!("CARGO_MANIFEST_DIR");
        for crate_dir in ["rust_gtk_pill", "rust_macos_pill", "rust_windows_pill"] {
            let path = format!("../{crate_dir}/src/draw.rs");
            let source = std::fs::read_to_string(format!("{manifest}/{path}"))
                .unwrap_or_else(|err| panic!("read {path}: {err}"));
            assert!(
                source.contains("flash_banner::FlashFrame::resolve_for_window("),
                "{path} does not lay the flash banner out through the shared module"
            );
            assert!(
                !source.contains("flash_banner::layout_flash_banner("),
                "{path} lays the banner out directly, so the frame's scale and line count are decided there too"
            );
            assert!(
                !source.contains("let flash_w ="),
                "{path} still computes the banner width inline, so there are two definitions again"
            );
            assert!(
                !source.contains("FLASH_HEIGHT - text"),
                "{path} still centres the text against the fixed one-line height"
            );
            assert!(
                !source.contains("FLASH_HEIGHT),"),
                "{path} still paints the banner at the fixed one-line height"
            );
            // The banner is centred on the pill's own centre, in painter space,
            // because the painter has already translated by the content offset.
            // Passing half the window width here is the defect the reviewers
            // found: the pill is 200 wide inside a 600-wide surface, so the
            // banner sat 200 units to its right for the whole expand animation.
            // `wh` is the painter's own canvas height, which is what bounds the
            // banner's height: on the dictation surface that is 86, not the 362
            // of the typing window, and the room above the pill is measured
            // against it. It is passed inline rather than through a named local
            // so each of the three paint sites stays a one-line change; three
            // copies of a comment and a binding were 24 of the 44 duplicated
            // lines Sonar attributed to this PR.
            assert!(
                source.contains("(pill_y, surface, wh, pill_x + pill_w / 2.0),"),
                "{path} does not pass the pill's own centre to the shared layout"
            );
            assert!(
                source.contains("BannerSurface::of_painter("),
                "{path} passes a bare width as the surface, so the banner is \
                 capped at the pill's content box instead of the window that clips it"
            );
            assert!(
                !source.contains("WINDOW_W_TYPING as f64"),
                "{path} still centres the banner on a fixed typing width rather than the live pill"
            );
        }
    }

    /// A very long message cannot grow the banner past the window.
    ///
    /// The banner never grows into the room above the pill, at the real
    /// geometry the pill actually paints with.
    ///
    /// The reported case: the typing window is 362 tall, the expanded pill
    /// occupies its bottom, and only the space above the pill is the banner's.
    /// Twenty lines of banner is 336 tall, which is more than that space, so at
    /// the previous fixed ceiling the banner's top sat above the surface and its
    /// first lines were simply not drawn. The ceiling is now derived from the
    /// room, so this is asserted against the window's own numbers rather than a
    /// number chosen in a test.
    #[test]
    fn the_banner_fits_the_room_above_an_expanded_pill() {
        const WINDOW_H_TYPING: f64 = 362.0;
        const PILL_BOTTOM_INSET: f64 = 8.0;
        const PANEL_BOTTOM_MARGIN: f64 = 10.0;
        const EXPANDED_PILL_HEIGHT: f64 = 32.0;
        let panel_bottom = WINDOW_H_TYPING - PANEL_BOTTOM_MARGIN;
        let pill_top = panel_bottom - PILL_BOTTOM_INSET - EXPANDED_PILL_HEIGHT;
        assert_eq!(pill_top, 312.0, "the fixture has to match the real pill");

        let mut real = spec();
        real.pill_top = pill_top;
        real.available_width = 600.0;
        real.center_x = 300.0;
        real.preferred_text_width = 440.0;
        let message =
            "the audio device was disconnected before the recording could be saved ".repeat(60);
        let layout = layout_flash_banner(&real, &message, fixed(7.0));

        assert!(
            layout.banner.y >= 0.0,
            "the banner starts {} above the surface, so those lines are never drawn: {:?}",
            -layout.banner.y,
            layout.banner
        );
        assert!(
            layout.banner.bottom() <= pill_top,
            "the banner runs into the pill: {:?}",
            layout.banner
        );
        assert!(
            layout.lines.len() <= BANNER_MAX_LINES,
            "the room-derived ceiling exceeded the absolute one"
        );
    }

    /// This is the other half of #374's bug. Before the wrap, a long message made
    /// the banner wider than the window and the pill clipped it at the sides;
    /// wrapping alone moved that failure to the top of the screen, where a few
    /// thousand characters produced a 512px banner in a 362px window. The line
    /// ceiling is what keeps the height inside the room the banner hangs in.
    #[test]
    fn a_very_long_message_stops_at_the_line_ceiling() {
        let unit = 7.0;
        let message =
            "the audio device was disconnected before the recording could be saved ".repeat(60);

        let layout = layout_flash_banner(&spec(), &message, fixed(unit));

        assert!(
            layout.lines.len() <= BANNER_MAX_LINES,
            "the banner grew past its line ceiling, so it would run off the top of the window"
        );
        // The property, not the number: the banner sits entirely above the pill
        // and entirely on the surface. The old assertion pinned 20 lines, which
        // is 336 tall -- more than a 362px pill window has room for once the pill
        // is expanded, so the computed top was negative. The ceiling now comes
        // from the room, so asserting the constant would pin the bug back.
        assert!(
            layout.banner.y >= 0.0,
            "the banner top is off the surface at {:?}",
            layout.banner
        );
        assert!(
            layout.banner.bottom() <= spec().pill_top,
            "the banner overlaps the pill it hangs above: {:?}",
            layout.banner
        );
        assert!(
            layout.banner.h < spec().pill_top,
            "a {}px banner does not fit above the pill",
            layout.banner.h
        );
        let last = layout.lines.last().expect("a banner always has a line");
        assert!(
            last.ends_with('\u{2026}'),
            "the overflow was dropped instead of being elided, so words went missing: {last:?}"
        );
    }

    /// A banner tall enough for its lines also positions its buttons inside it.
    ///
    /// This is the user-visible half of the wrap: a taller banner must not leave
    /// its buttons floating outside the rounded rectangle, and a wrapped message
    /// must not run underneath them. Both follow from the height and the reserved
    /// width, so both are asserted against a banner that actually wrapped.
    #[test]
    fn a_wrapped_banner_contains_its_own_buttons() {
        let mut with_button = spec();
        with_button.preferred_text_width = 900.0;
        with_button.action_width = Some(64.0);
        with_button.reject_width = Some(64.0);

        let message = "a message long enough to wrap onto several lines inside the banner";
        let layout = layout_flash_banner(&with_button, message, fixed(7.0));

        assert!(
            layout.lines.len() > 1,
            "the fixture has to wrap for this to test anything"
        );
        let banner = layout.banner;
        let action = layout
            .action
            .expect("the fixture asks for an action button");
        let reject = layout.reject.expect("the fixture asks for a reject button");

        for (name, button) in [("action", action), ("reject", reject)] {
            assert!(
                button.x >= banner.x && button.right() <= banner.right(),
                "the {name} button is outside the banner: {button:?} against {banner:?}"
            );
            assert!(
                button.y >= banner.y && button.bottom() <= banner.bottom(),
                "the {name} button is outside the banner's height: {button:?} against {banner:?}"
            );
        }
        assert!(
            action.right() <= reject.x || reject.right() <= action.x,
            "the two buttons overlap: {action:?} and {reject:?}"
        );
        let text = layout.text;
        assert!(
            text.right() <= action.x,
            "the wrapped text runs under the action button: {text:?} against {action:?}"
        );
    }

    /// A message that is nothing but newlines makes one empty line.
    ///
    /// Found by probing the wrap rather than by a failing user report: `"\n\n\n"`
    /// split into four paragraphs and came back as four empty lines, so the
    /// banner was four times its one-line height for a message with no text in
    /// it. The comment above the collapse promised one line; now the code does.
    #[test]
    fn a_message_of_only_newlines_is_one_blank_line() {
        for message in ["", "   ", "\n", "\n\n\n", " \n \n "] {
            let lines = wrap_to_width(message, 200.0, fixed(7.0));
            assert_eq!(
                lines.len(),
                1,
                "{message:?} came back as {} lines, so a blank banner would be tall",
                lines.len()
            );
            assert!(
                lines[0].trim().is_empty(),
                "{message:?} produced visible text from whitespace"
            );
        }
    }

    /// No case can exceed the budget it was wrapped to.
    ///
    /// The wrap is what keeps text inside the window, so the property worth
    /// asserting is per-line width rather than a particular line break. The
    /// inputs here are the ones that are easy to get wrong: scripts without
    /// spaces, characters wider than the fixture's unit, tabs, and a single
    /// unbroken run far longer than the budget.
    #[test]
    fn no_wrapped_line_exceeds_its_budget() {
        let budget = 100.0;
        let unit = 7.0;
        let cases = [
            "日本語のとても長いメッセージです",
            "tabs\there\tand\tthere",
            "emoji 👍🏽 and a family 👨‍👩‍👧‍👦",
        ];
        for case in cases {
            for line in wrap_to_width(case, budget, fixed(unit)) {
                assert!(
                    fixed(unit)(&line) <= budget,
                    "{line:?} is {} wide against a {budget} budget",
                    fixed(unit)(&line)
                );
            }
        }
        let long = "a".repeat(500);
        for line in wrap_to_width(&long, budget, fixed(unit)) {
            assert!(
                fixed(unit)(&line) <= budget,
                "an unbroken run produced a {}-wide line",
                fixed(unit)(&line)
            );
        }
    }

    /// The exact shape of the report: a 1960-character error, a 600px window.
    ///
    /// This is the fixture that produced a 512px banner in a 362px window before
    /// the ceiling existed, so it is the one to keep: the banner now stays inside
    /// the room it hangs in.
    #[test]
    fn a_thousands_of_characters_long_error_fits_above_the_pill() {
        let unit = 7.0;
        let message =
            "the audio device was disconnected before the recording could be saved ".repeat(28);

        let mut window = spec();
        window.available_width = 600.0;
        window.preferred_text_width = 4000.0;

        let layout = layout_flash_banner(&window, &message, fixed(unit));
        let height = banner_height(
            layout.lines.len(),
            window.min_height,
            BANNER_PADDING_V,
            BANNER_TEXT_LINE,
        );

        // 362px is the pill window; the banner hangs above the pill, so its
        // bottom sits at the pill's top and its top must stay on screen.
        assert!(
            height <= 362.0 - 20.0,
            "a {height}px banner does not fit above the pill in a 362px window"
        );
        assert!(
            layout.lines.len() <= BANNER_MAX_LINES,
            "the ceiling did not bound the line count"
        );
    }

    /// A huge message is not measured in full before being thrown away.
    ///
    /// `measure` is a font engine call, and the banner is laid out again on every
    /// repaint while it is visible. Wrapping a message that will keep at most a
    /// couple of dozen lines therefore has to stop, not wrap everything and
    /// discard the tail. This counts the calls rather than trusting the reader:
    /// the fixture is 6000 words and the ceiling is two lines, so a full wrap
    /// would be thousands of calls.
    #[test]
    fn a_huge_message_stops_being_measured_at_the_line_ceiling() {
        use std::cell::Cell;

        let calls = Cell::new(0usize);
        let counting = |text: &str| {
            calls.set(calls.get() + 1);
            fixed(7.0)(text)
        };

        let message = "alpha beta gamma delta epsilon ".repeat(1200);
        let words = message.split_whitespace().count();
        assert!(words > 5000, "the fixture has to be big enough to matter");

        // Two lines of room: the surface is short enough that only two lines fit
        // above the pill, so the ceiling is two whatever the text does.
        let mut tiny = spec();
        tiny.available_height = 96.0;
        tiny.pill_top = 76.0;
        tiny.available_width = 120.0;
        tiny.preferred_text_width = 1.0;
        let layout = layout_flash_banner(&tiny, &message, counting);

        assert!(
            layout.lines.len() <= 2,
            "the fixture was supposed to hit a two-line ceiling, got {}",
            layout.lines.len()
        );
        let measured = calls.get();
        assert!(
            measured < words / 4,
            "the wrap measured {measured} times for {words} words, so it did not stop at the ceiling"
        );
    }

    /// One unbroken token is not split in full either.
    ///
    /// A separate case from the word loop: a base64 blob, a minified script or a
    /// path with no separators is a *single* word, so the guard that stops after
    /// the ceiling between words never fires. The inner loop that breaks the word
    /// into fragments has to stop on the same count, or the token is split into
    /// hundreds of lines and all but a couple thrown away -- on every repaint.
    #[test]
    fn one_huge_unbroken_token_stops_being_split_at_the_ceiling() {
        use std::cell::Cell;

        let calls = Cell::new(0usize);
        let counting = |text: &str| {
            calls.set(calls.get() + 1);
            fixed(7.0)(text)
        };

        // A single token of 20000 characters, with no word break anywhere.
        let token = "x".repeat(20_000);
        let mut tiny = spec();
        tiny.available_height = 96.0;
        tiny.pill_top = 76.0;
        tiny.available_width = 120.0;
        tiny.preferred_text_width = 1.0;
        let layout = layout_flash_banner(&tiny, &token, counting);

        assert!(
            layout.lines.len() <= 2,
            "the token produced {} lines, past the two-line ceiling",
            layout.lines.len()
        );
        // Each fragment costs a binary search of measurements; 20000 characters
        // at roughly one character per line would be tens of thousands of calls.
        assert!(
            calls.get() < 200,
            "splitting one token made {} measurement calls, so it did not stop",
            calls.get()
        );
    }

    /// And nothing is swallowed when the ceiling is reached.
    ///
    /// The ceiling keeps the banner's height bounded, and the risk it introduces
    /// is silently dropping the tail. So this compares the elided banner against
    /// the un-elided wrap of the same message word for word: every word up to the
    /// last line must appear in the same order, and the last line must say it was
    /// truncated.
    #[test]
    fn reaching_the_line_ceiling_keeps_every_word_it_shows() {
        let unit = 7.0;
        let message = "alpha beta gamma delta epsilon zeta eta theta iota kappa ".repeat(40);

        // A message wide enough to be capped at the ceiling's width, which is the
        // case a real window reaches. `spec()` on its own is a minimum-width
        // banner of about five characters a line, and the ratio below would then
        // measure the fixture rather than the elision.
        let mut wide = spec();
        wide.preferred_text_width = 1000.0;
        let layout = layout_flash_banner(&wide, &message, fixed(unit));
        let whole = wrap_to_width(&message, layout.text.w, fixed(unit));

        // The ceiling is whatever room this spec leaves, and it is below its
        // maximum here; the property under test is the elision, not the number.
        let ceiling = layout.lines.len();
        assert!(
            (2..=BANNER_MAX_LINES).contains(&ceiling),
            "the fixture needs a ceiling it can overflow, got {ceiling}"
        );
        assert!(
            whole.len() > ceiling,
            "the fixture has to overflow the ceiling for this to test anything"
        );

        let kept = &layout.lines[..ceiling - 1];
        assert_eq!(
            kept,
            &whole[..ceiling - 1],
            "the lines before the ceiling were rewritten, so word order changed"
        );

        let last = layout.lines.last().expect("a banner always has a line");
        assert!(
            last.ends_with('\u{2026}'),
            "the tail was dropped without saying so: {last:?}"
        );
        // Compare on whole lines joined by a space: the wrap's lines are already
        // word-bounded, and the elision trims the space before its own ellipsis,
        // so this is the comparison that is about content rather than spacing.
        let shown = kept
            .iter()
            .chain(std::iter::once(last))
            .cloned()
            .collect::<Vec<_>>()
            .join(" ");
        let shown = shown
            .split_once('\u{2026}')
            .map_or(shown.as_str(), |(head, _)| head)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let all = whole.join(" ");

        assert!(
            all.starts_with(&shown),
            "what the banner shows is not the start of the message, so text was reordered"
        );
        // The last line is the one the elision rewrote, so it is where text can
        // silently vanish. It has to make progress -- keep at least one word --
        // and it still has to fit the text budget, because an elided line that
        // overran would be clipped by the banner's own edge instead.
        assert!(
            !shown.is_empty(),
            "the elision removed everything, so the banner shows no message at all"
        );
        assert!(
            fixed(unit)(last) <= layout.text.w + 1e-9,
            "the elided last line is {} wide against a {} budget",
            fixed(unit)(last),
            layout.text.w
        );
    }

    /// A visible banner counts down, and clears itself when the time is up.
    ///
    /// Three call sites used to run this, so the boundary is what matters: one
    /// step under the duration leaves the banner up for the remainder, a step
    /// that reaches zero dismisses it and the fields go back to "no toast".
    #[test]
    fn a_banner_clears_itself_when_its_timer_reaches_zero() {
        let state = StubState::default();
        state.flash_visible.set(true);
        state.flash_timer.set(1.0);
        *state.flash_action.borrow_mut() = Some(String::from("retry"));

        tick_banner_timer(&state, 0.25);
        assert_eq!(state.flash_timer.get(), 0.75);
        assert!(state.flash_visible.get(), "the banner went away early");

        tick_banner_timer(&state, 0.75);
        assert!(!state.flash_visible.get(), "the banner outlived its timer");
        assert_eq!(state.flash_timer.get(), 0.0);
        assert!(
            state.flash_action.borrow().is_none(),
            "a dismissed banner kept its action wired to the next toast"
        );
    }

    /// And a banner that is not shown is left alone.
    #[test]
    fn a_hidden_banner_is_not_counted_down() {
        let state = StubState::default();
        state.flash_timer.set(1.0);

        tick_banner_timer(&state, 5.0);

        assert_eq!(
            state.flash_timer.get(),
            1.0,
            "a hidden banner's timer moved, so it would expire before it ever showed"
        );
        assert!(!state.flash_visible.get());
    }

    /// `button_label` resolves each button and is callable with no host.
    ///
    /// This is the compile proof for the shape that broke CI: the two paint sites
    /// that cannot compile on a Linux host call exactly this. If the signature
    /// ever needs `Self` again, this stops compiling here first.
    #[test]
    fn button_label_resolves_each_button_without_a_host() {
        let action = String::from("Accept");
        let reject = String::from("Decline");

        assert_eq!(
            button_label(BannerButton::Action, Some(&action), Some(&reject)),
            Some(&action)
        );
        assert_eq!(
            button_label(BannerButton::Reject, Some(&action), None),
            None,
            "a reject rectangle with no reject label must paint nothing"
        );
    }

    /// Every field the generated impls read is declared by all three states.
    ///
    /// `impl_flash_host!` and `impl_celebration_host!` name fields that only the
    /// pill crates declare, so a rename in one of them is a compile error on a
    /// host this suite does not run on. That happened on this branch with the
    /// banner's line count: three declarations had to be edited together, and
    /// nothing here would have noticed one being missed. This asserts the set,
    /// so a divergence fails on the host that can run.
    #[test]
    fn all_three_states_declare_the_fields_the_shared_impls_read() {
        // Exactly the names `impl_flash_host!` and `impl_celebration_host!`
        // reach for, plus the indicator the two caches live on.
        let required = [
            "flash_message",
            "flash_is_error",
            "flash_visible",
            "flash_t",
            "flash_velocity",
            "flash_timer",
            "flash_action",
            "flash_action_label",
            "flash_reject_action",
            "flash_reject_action_label",
            "fireworks_active",
            "fireworks_elapsed",
            "fireworks_next_launch",
            "fireworks_rockets",
            "indicator",
        ];
        let manifest = env!("CARGO_MANIFEST_DIR");
        for crate_dir in ["rust_gtk_pill", "rust_macos_pill", "rust_windows_pill"] {
            let path = format!("../{crate_dir}/src/state.rs");
            let source = std::fs::read_to_string(format!("{manifest}/{path}"))
                .unwrap_or_else(|err| panic!("read {path}: {err}"));
            for field in required {
                // The declaration, not a mere occurrence: a renamed field still
                // contains the old text as a prefix, which is exactly how a weak
                // version of this assertion passed on a mutation.
                let declared = format!("pub(crate) {field}:");
                assert!(
                    source.contains(&declared),
                    "{path} does not declare `{field}`, which the shared impls read, so the \
                     {crate_dir} crate cannot compile"
                );
            }
            assert!(
                source.contains("impl_flash_host!(crate::state::PillState)"),
                "{path} does not wire up the shared flash impl"
            );
            assert!(
                source.contains("impl_celebration_host!(crate::state::PillState)"),
                "{path} does not wire up the shared celebration impl"
            );
        }
    }

    /// A paint site must call only things this module still provides.
    ///
    /// A method that moves off `FlashHost` breaks every caller, and the break is
    /// invisible on a Linux host: the macOS and Windows pills do not compile
    /// here at all, so only CI's per-OS jobs see it. That happened once while
    /// this branch was open -- `button_label` lost its receiver and two paint
    /// sites kept calling it as a method. This pins the call shape that CI
    /// proved, so the next such move fails here first, on the host that can run.
    #[test]
    fn every_paint_site_calls_a_banner_helper_this_module_still_has() {
        let manifest = env!("CARGO_MANIFEST_DIR");
        for crate_dir in ["rust_gtk_pill", "rust_macos_pill", "rust_windows_pill"] {
            let path = format!("../{crate_dir}/src/draw.rs");
            let source = std::fs::read_to_string(format!("{manifest}/{path}"))
                .unwrap_or_else(|err| panic!("read {path}: {err}"));
            assert!(
                !source.contains("state.button_label("),
                "{path} calls button_label as a method, but it takes no receiver"
            );
            // E0790: an associated function with no receiver on a trait cannot
            // infer Self, so naming the trait here does not compile either.
            assert!(
                !source.contains("FlashHost::button_label("),
                "{path} calls button_label through the trait, which cannot infer Self"
            );
            if source.contains("button_label(") {
                assert!(
                    source.contains("flash_banner::button_label("),
                    "{path} resolves a banner button's label some other way"
                );
            }
        }
    }
}
