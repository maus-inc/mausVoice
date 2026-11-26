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
    /// How much horizontal room the banner has around the point it is centred
    /// on.
    ///
    /// This is the window, not the pill's own box. The pill draws its content
    /// into a box that can be narrower than the window (dictation is 200 wide in
    /// a 600 wide window) and shifts that box to stay centred, so the drawing
    /// space around the pill's centre extends past the box on both sides. A
    /// long error during dictation has the whole window to read in, and the
    /// window is also what clips, so it is the honest ceiling.
    pub available_width: f64,
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
        available_width: f64,
        center_x: f64,
        pill_top: f64,
        constants: FlashBannerConstants,
        preferred_text_width: f64,
        action_width: Option<f64>,
        reject_width: Option<f64>,
    ) -> Self {
        Self {
            available_width,
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
    /// The drawing space is shifted by the content offset before a paint runs,
    /// so the pill's centre sits at `window_width / 2` in it while the window
    /// still extends its full typing width around that point. The banner
    /// therefore has the whole window to read in, in every mode, even when the
    /// pill's own box is narrower: a long error during dictation is not
    /// squeezed to the compact width.
    ///
    /// Every pill composed this the same way, and the numbers are the same on
    /// all three, so the composition lives here rather than being written out
    /// at each draw site.
    pub fn for_window(
        window_width: f64,
        pill_top: f64,
        constants: FlashBannerConstants,
        preferred_text_width: f64,
        action_width: Option<f64>,
        reject_width: Option<f64>,
    ) -> Self {
        Self::new(
            window_width,
            window_width / 2.0,
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

/// The widest the banner may be, which is the window less its side margins.
///
/// Floored at the caller's minimum: a window narrower than that is not a case
/// the pill can reach, and clamping to zero would produce an unreadable sliver
/// rather than the smallest honest banner.
pub fn banner_max_width(available_width: f64, min_width: f64) -> f64 {
    let usable = sane(available_width) - BANNER_MIN_MARGIN * 2.0;
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

/// Wraps `text` to `max_width`, word first and characters when a word alone
/// will not fit.
///
/// The greedy rule is the one every platform's native wrapper applies, so the
/// line count this returns matches what the pill paints: fill a line until the
/// next word would overrun, then start a new one. An explicit `\n` starts a new
/// line and is not drawn. A word wider than the whole budget is broken across
/// lines instead of being allowed to overrun, which is the case a URL or a long
/// file path reaches.
///
/// `measure` returns the width of a rendered string. It must be monotonic in
/// the length of its argument, which a font's advance widths are.
pub fn wrap_to_width<F>(text: &str, max_width: f64, measure: F) -> Vec<String>
where
    F: Fn(&str) -> f64,
{
    let budget = sane(max_width);
    // A budget of zero is not a width any glyph fits into, so breaking against
    // it would put one character on every line. That is worse than an overrun
    // the caller can see, so an unusable budget leaves the text whole.
    let can_break = budget > 0.0;
    let mut lines: Vec<String> = Vec::new();

    for paragraph in text.split('\n') {
        let mut current = String::new();
        for word in paragraph.split_whitespace() {
            if !current.is_empty() {
                let candidate = format!("{current} {word}");
                if measure(&candidate) <= budget {
                    current = candidate;
                    continue;
                }
                lines.push(std::mem::take(&mut current));
            }
            // A word starting a line still has to fit it. One wider than the
            // whole banner is broken on character boundaries, repeatedly, so
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
            }
            current = rest;
        }
        lines.push(current);
    }

    // Empty paragraphs (a blank line, a trailing newline) collapse rather than
    // rendering as a gap, but a message that is entirely blank still keeps its
    // one line so the banner does not vanish.
    if lines.iter().any(|line| !line.is_empty()) {
        lines.retain(|line| !line.is_empty());
    }
    lines
}

/// Splits one over-wide word into a head that fits and the remainder.
///
/// Binary search over character boundaries rather than a linear scan, for the
/// same reason [`crate::text_fit::elide_to_width`] uses one: each step is a font
/// engine call and the word can be long. The prefix is taken on a character
/// boundary, so a multi-byte character is never cut in half.
fn break_word<F>(word: &str, budget: f64, measure: F) -> (String, String)
where
    F: Fn(&str) -> f64,
{
    let chars: Vec<char> = word.chars().collect();
    if chars.len() < 2 {
        return (word.to_string(), String::new());
    }
    let (mut lo, mut hi) = (1usize, chars.len() - 1);
    let mut best = 1usize;
    while lo <= hi {
        let mid = lo + (hi - lo) / 2;
        let prefix: String = chars[..mid].iter().collect();
        if measure(&prefix) <= budget {
            best = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    let head: String = chars[..best].iter().collect();
    let tail: String = chars[best..].iter().collect();
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
    let max_width = banner_max_width(spec.available_width, min_width);

    let button_widths: Vec<f64> = [spec.action_width, spec.reject_width]
        .into_iter()
        .flatten()
        .map(sane)
        .collect();
    // Each button is preceded by a gap, so the space the buttons take is their
    // own widths plus one gap each. Getting this off by one gap would leave the
    // message a gap's worth of room it does not have, and the last word of the
    // first line would sit under the button.
    let gap = sane(spec.action_gap);
    let reserved_for_buttons: f64 =
        button_widths.iter().sum::<f64>() + button_widths.len() as f64 * gap;
    let padding = sane(spec.padding_h);
    let preferred =
        (sane(spec.preferred_text_width) + padding * 2.0 + reserved_for_buttons).max(min_width);
    let banner_w = preferred.min(max_width);

    // The banner width settles first because the text budget depends only on
    // it. Wrapping then decides the line count, and the height follows.
    let text_width = (banner_w - padding * 2.0 - reserved_for_buttons).max(0.0);
    let lines = wrap_to_width(message, text_width, &measure);
    let height = banner_height(
        lines.len(),
        spec.min_height,
        BANNER_PADDING_V,
        BANNER_TEXT_LINE,
    );

    // The banner is centred on the pill and the room is symmetric about that
    // point, so any banner that passed the ceiling above is already inside the
    // window and needs no second clamp.
    let x = sane(spec.center_x) - banner_w / 2.0;
    let y = sane(spec.pill_top) - sane(spec.gap) - height;
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
    let action = spec.action_width.map(|width| BannerRect {
        x: banner.right() - padding - sane(width),
        y: action_y,
        w: sane(width),
        h: action_h,
    });
    let reject = spec.reject_width.map(|width| {
        let offset = action.map_or(0.0, |rect| rect.w + sane(spec.action_gap));
        BannerRect {
            x: banner.right() - padding - offset - sane(width),
            y: action_y,
            w: sane(width),
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
    /// The burst's state as the shared fireworks animation wants it.
    fn fireworks(&self) -> crate::fireworks::Fireworks<'_> {
        crate::fireworks::Fireworks {
            active: self.fireworks_active(),
            elapsed: self.fireworks_elapsed(),
            next_launch: self.fireworks_next_launch(),
            rockets: self.fireworks_rockets(),
        }
    }

    /// Advances the burst one frame from this pill's own banner centre.
    fn tick_fireworks(&self, dt: f64, origin: (f64, f64)) {
        self.fireworks().tick(dt, origin);
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
    /// Lay the banner out and derive its fade.
    ///
    /// The line count the celebration needs is published to `flash_lines`
    /// before returning, because the tick that launches the particles runs
    /// before the paint that will measure this banner again.
    pub fn resolve<F>(
        spec: FlashBannerSpec,
        message: &str,
        measure: F,
        fade_t: f64,
        flash_lines: &Cell<usize>,
    ) -> Self
    where
        F: Fn(&str) -> f64,
    {
        let layout = layout_flash_banner(&spec, message, measure);
        flash_lines.set(layout.lines.len());
        Self {
            layout,
            scale: BANNER_MIN_SCALE + (1.0 - BANNER_MIN_SCALE) * fade_t,
            alpha: fade_t,
        }
    }

    /// The point the banner is scaled about.
    pub fn center(&self) -> (f64, f64) {
        self.layout.center()
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
    /// The tick that launches the celebration's particles runs before the
    /// paint that wraps the text, so the painter caches the count here for the
    /// next tick.
    fn flash_lines(&self) -> &Cell<usize>;

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
        self.flash_lines().set(1);
    }

    /// Lays this pill's banner out and resolves the frame its painter needs.
    ///
    /// The draw sites all did this identically, so it is a default method on
    /// the trait: a site supplies what it measured and where its pill sits, and
    /// the trait owns the rest. That also keeps the call itself short, which
    /// matters because three copies of a long call are exactly what a
    /// duplication gate sees.
    #[allow(clippy::type_complexity)]
    fn flash_frame<F>(
        &self,
        message: &str,
        measure: F,
        widths: (f64, Option<f64>, Option<f64>),
        (pill_top, window_width): (f64, f64),
        fade_t: f64,
    ) -> FlashFrame
    where
        F: Fn(&str) -> f64,
    {
        let (preferred, action, reject) = widths;
        let constants = FlashBannerConstants::canonical();
        let spec = FlashBannerSpec::for_window(
            window_width,
            pill_top,
            constants,
            preferred,
            action,
            reject,
        );
        FlashFrame::resolve(spec, message, measure, fade_t, self.flash_lines())
    }

    /// The label of `button`, if the banner is showing that button at all.
    ///
    /// A banner can carry either button, both, or neither, and the caller holds
    /// the two labels separately. Resolving which one a painted rectangle wants
    /// is the same rule on every platform, so it lives here rather than being
    /// repeated at each paint site.
    fn button_label<'a>(
        &self,
        button: BannerButton,
        action: Option<&'a String>,
        reject: Option<&'a String>,
    ) -> Option<&'a String> {
        match button {
            BannerButton::Action => action,
            BannerButton::Reject => reject,
        }
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
                &self.flash_lines
            }
        }
    };
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
    sane(pill_top) - sane(gap) - height / 2.0
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

    fn spec() -> FlashBannerSpec {
        FlashBannerSpec {
            available_width: 600.0,
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
        let cap = banner_max_width(3840.0, BANNER_MIN_WIDTH);
        let narrow = banner_max_width(300.0, BANNER_MIN_WIDTH);
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
    /// pins that all three ask [`FlashHost::celebration_origin`], which resolves
    /// the same height the paint path does.
    #[test]
    fn all_three_celebration_ticks_launch_from_the_shared_banner_centre() {
        let manifest = env!("CARGO_MANIFEST_DIR");
        for path in [
            "../rust_gtk_pill/src/pill.rs",
            "../rust_macos_pill/src/app.rs",
            "../rust_windows_pill/src/pill.rs",
        ] {
            let source = std::fs::read_to_string(format!("{manifest}/{path}"))
                .unwrap_or_else(|err| panic!("read {path}: {err}"));
            assert!(
                source.contains(".celebration_origin("),
                "{path} launches the celebration from its own idea of the banner height"
            );
            assert!(
                !source.contains("FLASH_HEIGHT / 2.0"),
                "{path} still halves the fixed one-line height for the launch point"
            );
        }
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
                source.contains(".flash_frame("),
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
        }
    }
}
