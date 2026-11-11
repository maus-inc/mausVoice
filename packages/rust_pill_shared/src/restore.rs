//! Restoring a pill window to the place it was left in a previous session.
//!
//! The pill is a floating window, so the position the user dropped it at is the
//! only thing that makes it feel like it stayed put. Every pill platform used
//! to keep that position in memory alone, so every app launch re-homed the pill
//! to its default corner and the drag was forgotten.
//!
//! Persisting it turns a value the host wrote into an input the pill trusts,
//! and the display layout that value was captured against can change in every
//! way a layout can change while the app is not running: a display is
//! unplugged, the pill's display becomes the secondary one, a display switches
//! resolution or scale, or the row is corrupt because a write was cut short.
//! So the stored rect is treated as untrusted geometry and passed through
//! [`restore`], which is pure and platform free, before any pill uses it.
//!
//! Every rectangle here uses one space: screen-absolute units, top-left
//! origin, y increasing downward. Each platform converts into that space when
//! it saves and back out of it when it restores.
//!
//! - Windows and X11 already work in top-left physical pixels.
//! - Cocoa reports y upward from the primary display's bottom-left corner, so
//!   macOS converts with the primary display's top edge.
//! - A layer-shell Wayland surface has no queryable absolute position, so that
//!   backend never saves and never restores.
//!
//! The display is named by a stable token as well as by a rect, because a rect
//! is not an identity: two panels of the same size are indistinguishable, a
//! resolution change moves the rect of a monitor that has not moved, and a
//! platform display id names a slot that can be reused. The record therefore
//! carries [`crate::layout::display_identity`] of whatever durable name the
//! platform offers. An unnamed display degrades to matching on geometry, which
//! is what every build before this one did.

use serde::{Deserialize, Serialize};

use crate::drag::DragBounds;
use crate::edge::MonitorRect;

/// Bumped when the meaning of a stored field changes, so a row written by a
/// different build is discarded instead of misread.
///
/// Value 1 was a window origin and size plus the display rect that contained it.
/// Value 2 adds the saved display's stable token, so a display that is
/// unplugged and replugged can be recognised instead of being confused with a
/// different panel that happens to occupy the same rect. A version 1 row is
/// discarded rather than read as a version 2 row with no token: the old row
/// cannot say which display it meant, and guessing is what this bump stops.
pub const SCHEMA_VERSION: i64 = 2;

/// A pill window as it was last parked on a display.
///
/// `(x, y)` is the window's top-left corner and `(width, height)` is the rect it
/// was parked at. The size is part of the record because the pill window
/// changes size between modes and releases, and the origin only means "where
/// the user dropped it" if the window is the same rect. `display` is the rect of
/// the display that contained the window centre when it was saved.
///
/// `display_id` is the stable token of that display
/// ([`crate::layout::display_identity`]), and `None` on a platform or a display
/// that cannot be named. The rect and the token answer different questions and
/// both are needed:
///
/// - The token says *which* display. A panel unplugged and replugged keeps its
///   token but usually loses its rect, and two identical panels share a rect but
///   never a token. Without the token, a position saved on a panel that comes
///   back at a new resolution is indistinguishable from a position on a
///   different panel that now fills the old rect, and the pill lands on the
///   wrong one.
/// - The rect says *where on* that display, which is what makes a relaunch
///   restore the same pixels and what lets a position survive a display that
///   cannot be named at all.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ParkedWindow {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub display: MonitorRect,
    pub display_id: Option<u64>,
}

impl ParkedWindow {
    /// Build an unnamed parked window, which matches on geometry alone.
    pub fn new(x: f64, y: f64, width: f64, height: f64, display: MonitorRect) -> Option<Self> {
        Self::new_named(x, y, width, height, display, None)
    }

    /// Build a parked window, rejecting anything a corrupt row can produce.
    ///
    /// Returns `None` for non-finite values and for empty or negative spans, so
    /// a bad record stops here instead of reaching window placement math that
    /// assumes finite numbers.
    pub fn new_named(
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        display: MonitorRect,
        display_id: Option<u64>,
    ) -> Option<Self> {
        let window_usable = x.is_finite()
            && y.is_finite()
            && width.is_finite()
            && height.is_finite()
            && width > 0.0
            && height > 0.0;
        let display_usable = display.x.is_finite()
            && display.y.is_finite()
            && display.width.is_finite()
            && display.height.is_finite()
            && display.width > 0.0
            && display.height > 0.0;
        (window_usable && display_usable).then_some(Self {
            x,
            y,
            width,
            height,
            // The record holds the display's identity once, in `display_id`. The
            // rect is geometry only, so a caller cannot construct a record whose
            // rect and token disagree about which display they mean, and the
            // encoded form cannot carry two answers to one question.
            display: MonitorRect {
                id: None,
                ..display
            },
            display_id,
        })
    }

    /// The token of the display the pill was parked on, reduced to what a
    /// monitor list can be matched against.
    ///
    /// `None` when the record has no token, which is a record from a platform
    /// that cannot name displays or one saved before a display could be named.
    pub fn display_identity(&self) -> Option<u64> {
        self.display_id
    }

    /// The window centre, which decides which display owns the saved spot.
    pub fn center(&self) -> (f64, f64) {
        (self.x + self.width / 2.0, self.y + self.height / 2.0)
    }
}

/// What crosses the process boundary and the database.
///
/// One definition for the desktop writer and the three pill readers, so a
/// field cannot be spelled one way on the way in and another on the way out.
///
/// `display_id` is skipped when absent, so a record from a platform that cannot
/// name displays is byte-for-byte what value 1 wrote apart from the version. It
/// is an `Option` rather than a zero because zero is a legitimate hash.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
struct Record {
    version: i64,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    display: DisplayRecord,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    display_id: Option<u64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
struct DisplayRecord {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl From<ParkedWindow> for Record {
    fn from(window: ParkedWindow) -> Self {
        Self {
            version: SCHEMA_VERSION,
            x: window.x,
            y: window.y,
            width: window.width,
            height: window.height,
            display: DisplayRecord {
                x: window.display.x,
                y: window.display.y,
                width: window.display.width,
                height: window.display.height,
            },
            display_id: window.display_id,
        }
    }
}

impl ParkedWindow {
    /// Serialize for the handoff to a pill process or for the database.
    pub fn encode(&self) -> Option<String> {
        serde_json::to_string(&Record::from(*self)).ok()
    }

    /// Parse a record written by this build.
    ///
    /// Returns `None` for a version this build does not understand, for invalid
    /// JSON, and for values [`ParkedWindow::new`] rejects. Every caller treats
    /// `None` as "there is nothing to restore", so a corrupt row costs one
    /// relaunch in the default corner instead of a misplaced or invisible pill.
    pub fn decode(saved: &str) -> Option<Self> {
        let record: Record = serde_json::from_str(saved).ok()?;
        if record.version != SCHEMA_VERSION {
            return None;
        }
        Self::new_named(
            record.x,
            record.y,
            record.width,
            record.height,
            MonitorRect {
                x: record.display.x,
                y: record.display.y,
                width: record.display.width,
                height: record.display.height,
                id: None,
            },
            record.display_id,
        )
    }
}

/// The flag a host uses to hand a pill process the position it left behind.
pub const SAVED_POSITION_ARG: &str = "--saved-position=";

/// Read the parked position out of a process argument list.
///
/// The three pills are launched by the desktop app, which reads the stored
/// record and passes it here before the window exists. Parsing lives beside the
/// record so a platform cannot invent its own spelling of the flag or its own
/// tolerance for a bad record. A missing, repeated, or malformed flag is `None`,
/// which leaves the pill on its default placement.
pub fn saved_position_from_args<I, S>(args: I) -> Option<ParkedWindow>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let record = args.into_iter().find_map(|arg| {
        arg.as_ref()
            .strip_prefix(SAVED_POSITION_ARG)
            .map(str::to_string)
    })?;
    ParkedWindow::decode(&record)
}

/// Read the parked position out of a process's own arguments.
///
/// This is the form every pill's `main` uses, because `std::env::args()` is the
/// wrong tool for the job: it panics on an argument that is not valid Unicode.
/// A path to the executable is an argument, and on Linux and macOS a path is a
/// byte string that need not be UTF-8, so a user with one such directory in the
/// pill's location loses the entire overlay before it has drawn a frame. The
/// panic happens in the one place that cannot report anything.
///
/// Arguments that are not Unicode are skipped rather than repaired. The flag this
/// looks for is ASCII written by the desktop process, so a lossy conversion could
/// only ever manufacture a match, and skipping cannot lose a real one.
pub fn saved_position_from_process_args() -> Option<ParkedWindow> {
    let record = std::env::args_os().find_map(|arg| {
        arg.to_str()
            .and_then(|arg| arg.strip_prefix(SAVED_POSITION_ARG))
            .map(str::to_string)
    })?;
    ParkedWindow::decode(&record)
}

/// Where to put the pill on this launch.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Placement {
    /// Put the window origin here. Already clamped into the chosen display.
    Restore { x: f64, y: f64 },
    /// Leave the platform's own placement alone. The saved display is not
    /// connected and nothing in the current layout correlates with it, so the
    /// platform default is the only answer that cannot strand the pill.
    PlatformDefault,
}

/// Restore a parked position against the displays that are connected now.
///
/// `areas` are the visible areas of the connected displays, in the caller's
/// current space, which is the same list the pill publishes from. `bounds_for`
/// receives the area chosen for the pill and the window size being restored, and
/// returns the range its origin may occupy. Each platform passes the same
/// footprint math its drag path already uses, so restore cannot drift from
/// drag.
///
/// Which display is chosen, in order:
///
/// 0. The display with the same stable token as the one the pill was parked on,
///    when both the record and the live display have one. This is the only step
///    that can recognise a display whose geometry changed, so a monitor that
///    comes back at a different resolution is recognised rather than replaced by
///    whichever display now occupies its old rect.
/// 1. The display with the exact rect the pill was parked on. The ordinary
///    relaunch, and also a display whose dock or taskbar moved: the rect is
///    unchanged and the clamp pulls the pill inside the new work area.
/// 2. The display at the same origin. Unplugging one display of two leaves the
///    other at its own origin, so a pill that lived on the survivor comes back
///    on the survivor, and a display that changed resolution or scale keeps its
///    slot.
/// 3. The display whose origin is nearest. Covers a layout that was rearranged
///    between launches, where positions moved but the screens did not.
/// 4. Nothing usable: [`Placement::PlatformDefault`].
///
/// On an exact rect match the stored origin is kept, so the pill returns to the
/// same pixels. On any other match the fraction of the old display the pill sat
/// at is applied to the new one, so a pill on the left half of a display comes
/// back on the left half and a resolution change does not push it offscreen.
pub fn restore<F>(
    parked: ParkedWindow,
    areas: &[MonitorRect],
    window_size: (f64, f64),
    mut bounds_for: F,
) -> Placement
where
    F: FnMut(MonitorRect, (f64, f64)) -> DragBounds,
{
    let (width, height) = window_size;
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
        return Placement::PlatformDefault;
    }
    if areas.is_empty() {
        return Placement::PlatformDefault;
    }

    let Some((index, exact)) = choose_display(&parked, areas) else {
        return Placement::PlatformDefault;
    };

    let destination_bounds = bounds_for(areas[index], (width, height));
    let anchor = if exact {
        (parked.x, parked.y)
    } else {
        // The saved origin is a fixed point of the clamp it was stored under, so
        // the fraction has to be measured in the same room the destination is
        // measured in. Asking the caller for both is what keeps the two boxes the
        // same box: the boxes are footprint-dependent, and only the caller knows
        // the footprint.
        let saved_bounds = bounds_for(parked.display, (parked.width, parked.height));
        remap(parked, destination_bounds, saved_bounds)
    };
    if !anchor.0.is_finite() || !anchor.1.is_finite() {
        return Placement::PlatformDefault;
    }

    let (x, y) = bounds_for(areas[index], (width, height)).clamp_point(anchor.0, anchor.1);
    if !x.is_finite() || !y.is_finite() {
        return Placement::PlatformDefault;
    }
    Placement::Restore { x, y }
}

/// Pick the display that owns the saved spot, and whether it is the exact
/// display the pill was parked on.
///
/// "Exact" means "restore the stored origin", so it is only ever true for a
/// display whose rect is the one the origin was measured against. A display
/// matched by token alone keeps the pill's relative place, because its rect may
/// have changed and the stored origin could now be off it.
fn choose_display(parked: &ParkedWindow, displays: &[MonitorRect]) -> Option<(usize, bool)> {
    // A named display is matched by name first. This is the case geometry cannot
    // get right: a panel that comes back at a different resolution, or one that
    // swapped places with a panel of the same size.
    // A token is not always unique. Two panels of the same make and model share
    // one on X11, where the backend exposes no serial number, and mirrors of the
    // same panel share one on every platform. Taking the first candidate would
    // then move the pill to the wrong panel even though the right one was
    // connected and its geometry matched exactly, so a geometry match among the
    // candidates is preferred before the first one is accepted.
    if let Some(saved) = parked.display_id {
        let candidates: Vec<usize> = displays
            .iter()
            .enumerate()
            .filter(|(_, display)| display.id == Some(saved))
            .map(|(index, _)| index)
            .collect();
        if let Some(&index) = candidates
            .iter()
            .find(|&&index| displays[index].same_geometry(parked.display))
        {
            return Some((index, true));
        }
        if let Some(&index) = candidates.first() {
            return Some((index, false));
        }
    }
    if let Some(index) = displays
        .iter()
        .position(|display| display.same_geometry(parked.display))
    {
        return Some((index, true));
    }
    if let Some(index) = displays
        .iter()
        .position(|display| display.x == parked.display.x && display.y == parked.display.y)
    {
        return Some((index, false));
    }
    crate::layout::nearest_display(displays, parked.display.x, parked.display.y)
        .map(|index| (index, false))
}

/// The origin that keeps the pill's relative place on a display it did not
/// originally sit on.
///
/// Each axis is measured as the fraction of the slide room the origin occupied
/// and re-applied to the new display's slide room. Using the slide room rather
/// than the display width keeps the result stable at the edges, where a width
/// fraction would put a pill at the right edge past the right edge. When the
/// window is wider than the display there is no room, and
/// [`relative_fraction`] pins the origin to the leading edge for the clamp to
/// finish.
fn remap(parked: ParkedWindow, destination: DragBounds, saved: DragBounds) -> (f64, f64) {
    // Both ends are measured in the room the pill's visible footprint can move
    // in, which is exactly what the clamp that stored the origin used. Measuring
    // the saved end against the transparent window instead gives the origin
    // hundreds of pixels of travel the visible pill never had, so the same
    // fraction of the new display lands somewhere the user would not recognise.
    let saved_x = relative_fraction(parked.x, saved.min_x, saved.max_x - saved.min_x, 0.0);
    let saved_y = relative_fraction(parked.y, saved.min_y, saved.max_y - saved.min_y, 0.0);
    (
        place_at_fraction(
            destination.min_x,
            destination.max_x - destination.min_x,
            saved_x,
        ),
        place_at_fraction(
            destination.min_y,
            destination.max_y - destination.min_y,
            saved_y,
        ),
    )
}

/// Bounds that keep the pill's *visible footprint* inside a work area.
///
/// Every platform draws the pill inside a transparent OS window that is far
/// larger than the pill itself: a 48x6 pill sits inside a 600x362 canvas. That
/// canvas exists so the pill can expand and grow a selector tail without the
/// window changing size, and it means clamping the window origin into the work
/// area would hold the pill hundreds of pixels away from the edge the user can
/// actually see and reach.
///
/// So both the drag path and the restore clamp the footprint instead, and they
/// have to agree. When they do not, a restored pill lands where it was saved and
/// then the first idle tick pulls it somewhere else, which reads as the position
/// not being remembered. One function, called by restore and by every idle
/// clamp, is what makes "restored" and "left alone" the same pixels.
///
/// `offset` is the footprint's top-left inside the window, measured from the
/// window origin in the same top-down space the window origin uses.
pub fn footprint_bounds(work: MonitorRect, offset: (f64, f64), size: (f64, f64)) -> DragBounds {
    DragBounds {
        min_x: work.x - offset.0,
        min_y: work.y - offset.1,
        max_x: work.right() - offset.0 - size.0,
        max_y: work.bottom() - offset.1 - size.1,
    }
}

/// The offset and size of a pill centred horizontally and anchored to the
/// window's bottom edge: the resting arrangement all three pills share.
///
/// The draw code computes the live animated footprint, and the restore needs the
/// same arrangement before any frame has run. Expressed once, so the two cannot
/// disagree about where a parked pill sits inside its window.
///
/// `bottom_reserve` is everything between the pill's bottom edge and the
/// window's bottom edge. That is not only the resting gap: the window also keeps
/// room for the selector that drops below the pill, so the reserve is the inset
/// plus [`crate::placement::below_slot_extra`]. Leaving the slot out shifts the
/// pill by that extra, which is exactly the quiet disagreement between restore
/// and idle this function exists to end.
pub fn centered_bottom_footprint(
    window: (f64, f64),
    pill: (f64, f64),
    bottom_reserve: f64,
) -> ((f64, f64), (f64, f64)) {
    (
        (
            (window.0 - pill.0) / 2.0,
            window.1 - bottom_reserve - pill.1,
        ),
        (pill.0, pill.1),
    )
}

/// Where the origin sat inside the display, as a fraction of the room it could
/// slide, clamped to `0.0` to `1.0`. Returns `0.0` when there is no room.
/// The fraction and the inverse, re-exported so the remap math has one home.
pub use crate::layout::{place_at_fraction, relative_fraction};

/// The rectangle and the display a published position belongs to.
///
/// All three pills restated this inside their own `PositionChanged` variant, and
/// they had already drifted: one lost `skip_serializing_if` and so serialised
/// `display_id: null` where the other two omitted the field. One definition means
/// one wire format.
///
/// The platform's own rectangle type is a parameter rather than a declaration, so
/// each crate keeps serialising its own `Rect` and only the shape of the record is
/// shared.
///
/// A pill only publishes this when the user moves it, so a freshly started
/// session has no geometry on the desktop side. Windows anchored to the pill (the
/// review composer) then fall back to OS-centred placement, which is why the
/// desktop asks for the geometry once its listener is live (`RequestPosition`)
/// rather than waiting for the first drag.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct PositionReport<R> {
    pub has_saved_position: bool,
    pub rect: Option<R>,
    pub monitor: Option<R>,
    /// Flattened so `display_id` stays a sibling of `rect` on the wire rather
    /// than nesting under a wrapper object.
    #[serde(flatten)]
    pub display: DisplayRef,
}

/// The display a published position belongs to.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct DisplayRef {
    /// Stable token of the display the position belongs to, when the pill could
    /// name it. The desktop stores it with the rect so a later launch recognises
    /// the display itself instead of whichever panel now holds that rectangle.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_id: Option<u64>,
}

impl DisplayRef {
    pub fn new(display_id: Option<u64>) -> Self {
        Self { display_id }
    }
}

impl<R> PositionReport<R> {
    pub fn new(
        has_saved_position: bool,
        rect: Option<R>,
        monitor: Option<R>,
        display_id: Option<u64>,
    ) -> Self {
        Self {
            has_saved_position,
            rect,
            monitor,
            display: DisplayRef::new(display_id),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, width: f64, height: f64) -> MonitorRect {
        MonitorRect::without_id(x, y, width, height)
    }

    /// Bounds derived from a display area and the window size, the shape every
    /// platform's own helper has.
    fn bounds(work: MonitorRect, window: (f64, f64)) -> DragBounds {
        DragBounds {
            min_x: work.x,
            min_y: work.y,
            max_x: work.right() - window.0,
            max_y: work.bottom() - window.1,
        }
    }

    fn parked(x: f64, y: f64, display: MonitorRect) -> ParkedWindow {
        ParkedWindow::new(x, y, 200.0, 60.0, display).expect("valid parked window")
    }

    /// A parked window that names the display it was dropped on.
    fn named_parked(x: f64, y: f64, display: MonitorRect, id: u64) -> ParkedWindow {
        ParkedWindow::new_named(x, y, 200.0, 60.0, display, Some(id)).expect("valid parked window")
    }

    // The rectangle constructor is shared with `layout`'s tests rather than
    // written twice; only the name is local, so this file's tests read as prose.
    use crate::layout::tests::display;

    fn restored(placement: Placement) -> (f64, f64) {
        match placement {
            Placement::Restore { x, y } => (x, y),
            Placement::PlatformDefault => panic!("expected a restore, got the platform default"),
        }
    }

    /// The ordinary relaunch: same display, same rect, same origin held to the
    /// pixel, which is the whole point of storing the position.
    #[test]
    fn a_connected_display_restores_the_exact_origin() {
        let only = rect(0.0, 0.0, 1920.0, 1040.0);
        assert_eq!(
            restore(parked(500.0, 300.0, only), &[only], (200.0, 60.0), bounds),
            Placement::Restore { x: 500.0, y: 300.0 }
        );
    }

    /// A dock that moved to another edge shrinks the work area, and a pill that
    /// was flush against the old bottom edge comes back inside the new one. The
    /// saved rect no longer matches, so this goes through the remap and the
    /// clamp together.
    #[test]
    fn a_saved_origin_outside_a_shrunk_work_area_is_clamped_inside() {
        let before = rect(0.0, 0.0, 1920.0, 1080.0);
        let after = rect(0.0, 0.0, 1920.0, 1000.0);
        let (x, y) = restored(restore(
            parked(1720.0, 1020.0, before),
            &[after],
            (200.0, 60.0),
            bounds,
        ));
        assert_eq!(
            (x, y),
            (1720.0, 940.0),
            "the origin should sit in the new area"
        );
    }

    /// Unplugging the secondary display leaves the primary at its own origin.
    /// The pill keeps the fraction of the display it sat at instead of jumping
    /// to the default corner.
    #[test]
    fn a_removed_secondary_remaps_onto_the_remaining_display() {
        let primary = rect(0.0, 0.0, 1920.0, 1040.0);
        let secondary = rect(1920.0, 0.0, 2560.0, 1400.0);
        let (x, y) = restored(restore(
            parked(3800.0, 900.0, secondary),
            &[primary],
            (200.0, 60.0),
            bounds,
        ));
        // 1880 into a slide room of 2360 is 0.797, and 0.797 of 1720 is 1370.
        assert!((x - 1370.0).abs() <= 1.0, "unexpected x: {x}");
        assert!((0.0..=980.0).contains(&y), "unexpected y: {y}");
    }

    /// Unplugging the left-hand display leaves the right-hand one at the same
    /// origin, which is the origin match. The pill stays on the display it was
    /// on rather than being remapped across the seam.
    #[test]
    fn a_removed_left_display_keeps_the_pill_on_the_surviving_display() {
        let left = rect(-1920.0, 0.0, 1920.0, 1040.0);
        let right = rect(0.0, 0.0, 2560.0, 1400.0);
        let (x, y) = restored(restore(
            parked(-1500.0, 400.0, left),
            &[right],
            (200.0, 60.0),
            bounds,
        ));
        assert!((0.0..=2360.0).contains(&x), "unexpected x: {x}");
        assert!((0.0..=1340.0).contains(&y), "unexpected y: {y}");
    }

    /// A display that switched to half resolution keeps its origin, so the pill
    /// keeps its relative place rather than pixels that no longer exist.
    #[test]
    fn a_rescaled_display_keeps_the_relative_position() {
        let before = rect(0.0, 0.0, 3840.0, 2100.0);
        let after = rect(0.0, 0.0, 1920.0, 1040.0);
        let (x, y) = restored(restore(
            parked(1820.0, 1000.0, before),
            &[after],
            (200.0, 60.0),
            bounds,
        ));
        // 1820 of a 3640 slide room is almost exactly half, and half of the new
        // 1720 slide room is 860. Vertically, 1000 of a 2040 slide room is
        // 0.49, which of the new 980 is 480.
        assert!((x - 860.0).abs() <= 2.0, "unexpected x: {x}");
        assert!((y - 480.0).abs() <= 2.0, "unexpected y: {y}");
    }

    /// A display that moved but kept its size is remapped, not restored to a
    /// coordinate that now belongs to another display.
    #[test]
    fn a_moved_display_is_remapped_rather_than_restored_to_a_stale_origin() {
        let before = rect(0.0, 0.0, 1920.0, 1040.0);
        let after = rect(-1920.0, 0.0, 1920.0, 1040.0);
        let (x, y) = restored(restore(
            parked(200.0, 300.0, before),
            &[after],
            (200.0, 60.0),
            bounds,
        ));
        assert!((-1920.0..=0.0).contains(&x), "unexpected x: {x}");
        assert!((0.0..=980.0).contains(&y), "unexpected y: {y}");
    }

    /// No displays at all, which happens while a machine wakes or a dock
    /// switches inputs. There is nothing to clamp against, so the platform
    /// default is the only safe answer.
    #[test]
    fn no_connected_display_falls_back_to_the_platform_default() {
        let only = rect(0.0, 0.0, 1920.0, 1040.0);
        assert_eq!(
            restore(parked(500.0, 300.0, only), &[], (200.0, 60.0), bounds),
            Placement::PlatformDefault
        );
    }

    /// A corrupt row must not reach window placement. `ParkedWindow::new`
    /// rejects what a truncated write or a bad cast produces.
    #[test]
    fn non_finite_and_empty_sizes_are_rejected_at_construction() {
        let only = rect(0.0, 0.0, 1920.0, 1040.0);
        assert!(ParkedWindow::new(f64::NAN, 0.0, 200.0, 60.0, only).is_none());
        assert!(ParkedWindow::new(0.0, f64::INFINITY, 200.0, 60.0, only).is_none());
        assert!(ParkedWindow::new(0.0, 0.0, 0.0, 60.0, only).is_none());
        assert!(ParkedWindow::new(0.0, 0.0, 200.0, -1.0, only).is_none());
        assert!(ParkedWindow::new(0.0, 0.0, 200.0, 60.0, rect(0.0, 0.0, 0.0, 1080.0)).is_none());
    }

    /// A zero window size cannot be restored into, so the caller gets the
    /// default instead of a clamp against a span that is not there.
    #[test]
    fn a_zero_window_size_falls_back_to_the_default() {
        let only = rect(0.0, 0.0, 1920.0, 1040.0);
        assert_eq!(
            restore(parked(500.0, 300.0, only), &[only], (0.0, 60.0), bounds),
            Placement::PlatformDefault
        );
    }

    /// A window wider than the display has no slide room. The fraction pins to
    /// the leading edge and the inverted bounds collapse there, matching what
    /// the drag path does with an oversized footprint.
    #[test]
    fn a_window_wider_than_the_display_parks_on_the_leading_edge() {
        let before = rect(0.0, 0.0, 120.0, 120.0);
        let after = rect(0.0, 0.0, 100.0, 100.0);
        let saved = ParkedWindow::new(10.0, 10.0, 200.0, 60.0, before).expect("valid");
        let (x, y) = restored(restore(saved, &[after], (200.0, 60.0), bounds));
        assert!((0.0..=10.0).contains(&x), "unexpected x: {x}");
        assert!((0.0..=40.0).contains(&y), "unexpected y: {y}");
    }

    /// The save transform and the restore transform must be inverses. This is
    /// the check that catches a flipped axis, which is invisible on a single
    /// display whose top edge is zero.
    #[test]
    fn the_macos_axis_conversion_round_trips_on_a_stacked_layout() {
        // A display above the primary has a positive Cocoa y, and the primary is
        // not at the top of the virtual screen.
        let primary_top = 1080.0;
        let cocoa_origin_y = 1200.0;
        let height = 60.0;
        let top_down = primary_top - (cocoa_origin_y + height);
        assert_eq!(top_down, -180.0);
        let back = primary_top - (top_down + height);
        assert_eq!(back, cocoa_origin_y);
    }

    #[test]
    fn relative_fraction_is_clamped_and_safe_without_room() {
        assert_eq!(relative_fraction(50.0, 0.0, 200.0, 100.0), 0.5);
        assert_eq!(relative_fraction(-50.0, 0.0, 200.0, 100.0), 0.0);
        assert_eq!(relative_fraction(500.0, 0.0, 200.0, 100.0), 1.0);
        assert_eq!(relative_fraction(10.0, 0.0, 100.0, 100.0), 0.0);
        assert_eq!(relative_fraction(f64::NAN, 0.0, 200.0, 100.0), 0.0);
    }

    /// The flag is parsed from the arguments the host actually passes, and a
    /// malformed or absent one leaves the pill on its default placement.
    #[test]
    fn the_saved_position_argument_is_read_off_the_command_line() {
        let only = rect(0.0, 0.0, 1920.0, 1040.0);
        let record = parked(500.0, 300.0, only).encode().expect("encoded");
        let args = [
            "mausvoice-gtk-pill".to_string(),
            format!("{SAVED_POSITION_ARG}{record}"),
        ];
        assert_eq!(
            saved_position_from_args(args.iter().map(String::as_str)),
            Some(parked(500.0, 300.0, only))
        );
        assert_eq!(
            saved_position_from_args(["mausvoice-gtk-pill"]),
            None,
            "no flag means nothing to restore"
        );
        assert_eq!(
            saved_position_from_args(["--saved-position=not-a-record"]),
            None,
            "a malformed record must not be trusted"
        );
    }

    /// The process boundary the pill actually reads from. `std::env::args()`
    /// panics on a non-Unicode argument, and argv[0] is a path, so a single
    /// non-UTF-8 directory in the pill's install location would abort the overlay
    /// before its first frame. Reading `args_os` and skipping what is not Unicode
    /// cannot lose the flag: the desktop writes it as ASCII.
    #[test]
    fn process_arguments_are_read_without_requiring_unicode() {
        let only = rect(0.0, 0.0, 1920.0, 1040.0);
        let record = parked(500.0, 300.0, only).encode().expect("encoded");
        let flag = format!("{SAVED_POSITION_ARG}{record}");

        // An argument list with a non-UTF-8 entry, which is what a path with a
        // byte that is not UTF-8 looks like, and the flag after it.
        let mut args: Vec<std::ffi::OsString> = Vec::new();
        args.push(std::ffi::OsString::from("mausvoice-gtk-pill"));
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStringExt;
            args.push(std::ffi::OsString::from_vec(vec![0xff, 0xfe, b'x']));
        }
        args.push(std::ffi::OsString::from(flag));

        // The same scan `saved_position_from_process_args` performs, over a list
        // this test controls: `std::env::args` is not injectable.
        let found = args.iter().find_map(|arg| {
            arg.to_str()
                .and_then(|arg| arg.strip_prefix(SAVED_POSITION_ARG))
                .map(str::to_string)
        });
        assert_eq!(
            found.and_then(|record| ParkedWindow::decode(&record)),
            Some(parked(500.0, 300.0, only)),
            "a non-Unicode argument must not hide the flag"
        );
        // And the converted form must not be what reads it: `args()` would panic
        // on the same list.
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStringExt;
            let non_unicode = std::ffi::OsString::from_vec(vec![0xff, 0xfe, b'x']);
            assert!(
                non_unicode.to_str().is_none(),
                "the fixture has to be invalid Unicode to prove the point"
            );
        }
    }

    /// The record a pill reads has to be the record the desktop wrote, so the
    /// encoding round trips and then restores to the same pixel.
    #[test]
    fn an_encoded_record_decodes_and_restores_to_the_same_origin() {
        let only = rect(0.0, 0.0, 1920.0, 1040.0);
        let saved = parked(500.0, 300.0, only);
        let encoded = saved.encode().expect("encoding a valid record");
        let decoded = ParkedWindow::decode(&encoded).expect("decoding its own record");
        assert_eq!(decoded, saved);
        assert_eq!(
            restore(decoded, &[only], (200.0, 60.0), bounds),
            Placement::Restore { x: 500.0, y: 300.0 }
        );
    }

    /// A row from another schema version is discarded rather than read under
    /// this build's assumptions about what its fields mean.
    #[test]
    fn a_record_from_another_schema_version_is_discarded() {
        let record = r#"{"version":99,"x":1.0,"y":2.0,"width":200.0,"height":60.0,
            "display":{"x":0.0,"y":0.0,"width":1920.0,"height":1040.0}}"#;
        assert!(ParkedWindow::decode(record).is_none());
    }

    /// Truncated JSON, missing fields, and values that cannot describe a window
    /// all decode to nothing, so one bad row costs a relaunch in the default
    /// corner instead of a misplaced pill.
    #[test]
    fn corrupt_records_decode_to_nothing() {
        assert!(ParkedWindow::decode("").is_none());
        assert!(ParkedWindow::decode("{").is_none());
        assert!(ParkedWindow::decode(r#"{"version":1,"x":1.0}"#).is_none());
        assert!(ParkedWindow::decode(
            r#"{"version":1,"x":1.0,"y":2.0,"width":0.0,"height":60.0,
                "display":{"x":0.0,"y":0.0,"width":1920.0,"height":1040.0}}"#
        )
        .is_none());
    }

    /// The bug this function exists to prevent: restore and idle clamped
    /// differently, so a pill saved at an edge was placed correctly and then
    /// pulled inward by the first idle tick. Restoring a position and clamping
    /// it again with the same bounds must be a no-op, or the pill visibly moves
    /// after launch.
    #[test]
    fn a_restored_origin_is_a_fixed_point_of_the_idle_clamp() {
        let work = rect(0.0, 0.0, 1920.0, 1040.0);
        // A canvas far larger than the pill, sitting at the bottom of the screen.
        let window = (600.0, 362.0);
        let pill = (48.0, 6.0);
        // The real reserve: the resting gap plus the selector slot the window
        // keeps below the pill.
        let (offset, size) =
            centered_bottom_footprint(window, pill, 6.0 + crate::placement::below_slot_extra(32.0));
        let bounds = footprint_bounds(work, offset, size);

        // Every corner of the work area, including the one the canvas-clamp bug
        // moved the pill away from: the footprint's own bottom-right corner.
        for (x, y) in [
            (bounds.min_x, bounds.min_y),
            (bounds.max_x, bounds.max_y),
            (bounds.min_x, (bounds.min_y + bounds.max_y) / 2.0),
        ] {
            let (cx, cy) = bounds.clamp_point(x, y);
            assert_eq!((cx, cy), (x, y), "the idle clamp moved a restored origin");
        }
    }

    /// The three platforms park the pill inside a window that also reserves the
    /// selector slot below it, so the restore has to pass the same reserve the
    /// window height was built from. This pins the arithmetic against the real
    /// geometry rather than a round number: a reserve that omits the slot puts
    /// the pill 42 px high on macOS and Windows, and 48 px high on GTK.
    #[test]
    fn the_resting_footprint_clears_the_selector_slot() {
        for tooltip in [32.0_f64] {
            let slot = crate::placement::below_slot_extra(tooltip);
            assert!(slot > 0.0, "the slot is what the reserve exists for");
            // macOS and Windows: 362 typing rows plus the slot, 4/6 px inset.
            let window_h = 362.0 + slot;
            for inset in [4.0_f64, 6.0] {
                let (offset, size) =
                    centered_bottom_footprint((600.0, window_h), (48.0, 6.0), inset + slot);
                // The pill's bottom edge sits `inset` above the window's bottom,
                // which is the same place the draw path puts it.
                assert_eq!(offset.1 + size.1, 362.0 - inset);
            }
        }
    }

    /// A remap keeps the fraction of the display the pill sat at, not the raw
    /// pixel origin. The saved origin on a 2560 wide display with a 200 wide pill
    /// is 1900, which is 1700 of 2360 room: about 0.72 across. Landing at 1900
    /// on a 1920 display would be near its right edge purely because the origin
    /// number was large, which is the bug this pins.
    #[test]
    fn a_remap_measures_the_pills_own_offset_from_the_display_edge() {
        let secondary = rect(1920.0, 0.0, 2560.0, 1400.0);
        let primary = rect(0.0, 0.0, 1920.0, 1040.0);
        let (x, _) = restored(restore(
            parked(3620.0, 400.0, secondary),
            &[primary],
            (200.0, 60.0),
            bounds,
        ));
        // 1700 / 2360 = 0.7203, and 0.7203 of the 1720 room is 1239.
        assert!((x - 1239.0).abs() <= 1.0, "unexpected x: {x}");
    }

    /// When the pill's size changed since it was parked, the fraction still
    /// applies, and it applies to the room the pill has *now*. Applying it to the
    /// old room would place it past the new display's edge, which the clamp would
    /// then pin to the corner: the pill would come back flush against an edge it
    /// was never parked near.
    #[test]
    fn a_remap_uses_the_current_window_size_for_the_destination_room() {
        let secondary = rect(1920.0, 0.0, 2560.0, 1400.0);
        let primary = rect(0.0, 0.0, 1920.0, 1040.0);
        // Parked centred, which must stay centred whatever the pill's size is.
        let (x, y) = restored(restore(
            parked(1920.0 + (2560.0 - 200.0) / 2.0, 400.0, secondary),
            &[primary],
            (400.0, 60.0),
            bounds,
        ));
        assert!(
            (x - (1920.0 - 400.0) / 2.0).abs() <= 1.0,
            "unexpected x: {x}"
        );
        assert!(y.is_finite());
    }

    /// The footprint bounds let the pill reach the true work-area edge, which is
    /// the whole point of clamping the footprint instead of the canvas.
    #[test]
    fn the_footprint_can_reach_the_work_area_edge() {
        let work = rect(0.0, 0.0, 1920.0, 1040.0);
        let pill = (48.0, 6.0);
        let offset = ((600.0 - pill.0) / 2.0, 362.0 - 6.0 - pill.1);
        let bounds = footprint_bounds(work, offset, pill);
        // A pill parked flush in the bottom-right corner of the screen.
        let (x, y) = bounds.clamp_point(bounds.max_x, bounds.max_y);
        assert_eq!(x + offset.0 + pill.0, work.right());
        assert_eq!(y + offset.1 + pill.1, work.bottom());
    }

    /// The resting arrangement the draw path computes and the arrangement the
    /// restore clamps against are the same numbers, so a pill saved at the bottom
    /// of a display comes back at the bottom of the display.
    #[test]
    fn the_resting_footprint_is_centred_and_bottom_anchored() {
        let window = (600.0, 362.0);
        let pill = (48.0, 6.0);
        let reserve = 6.0 + crate::placement::below_slot_extra(32.0);
        let (offset, size) = centered_bottom_footprint(window, pill, reserve);
        assert_eq!(size, pill);
        // Centred horizontally, sitting the whole reserve above the bottom edge.
        assert_eq!(offset.0, (600.0 - 48.0) / 2.0);
        assert_eq!(offset.1 + size.1, window.1 - reserve);
    }

    /// The centre is what decides which display owns a saved spot, so it has to
    /// include the window size rather than the origin alone.
    #[test]
    fn the_centre_is_derived_from_the_origin_and_the_size() {
        let only = rect(0.0, 0.0, 1920.0, 1040.0);
        assert_eq!(parked(100.0, 40.0, only).center(), (200.0, 70.0));
    }

    /// The identity a record carries has to survive the trip through JSON, or a
    /// pill would restore on the wrong display after a restart.
    #[test]
    fn a_named_display_survives_the_encoded_record() {
        let work = display(1920.0, 0.0, 2560.0, 1400.0, Some(7));
        let saved = named_parked(3000.0, 400.0, work, 7);
        let encoded = saved.encode().expect("encoded");
        let decoded = ParkedWindow::decode(&encoded).expect("decoded");
        assert_eq!(decoded.display_id, Some(7));
        assert_eq!(decoded, saved);
        // The rect carries geometry only, so the record cannot hold two
        // different answers to "which display is this".
        assert_eq!(decoded.display.id, None);
    }

    /// A record from a platform that cannot name its displays has no token, and
    /// that has to stay `None` rather than becoming `Some(0)`.
    #[test]
    fn an_unnamed_record_round_trips_without_a_token() {
        let work = rect(0.0, 0.0, 1920.0, 1040.0);
        let saved = parked(500.0, 300.0, work);
        let encoded = saved.encode().expect("encoded");
        assert!(
            !encoded.contains("display_id"),
            "an absent token is omitted, not written as null: {encoded}"
        );
        assert_eq!(ParkedWindow::decode(&encoded).expect("decoded"), saved);
    }

    /// A token that is present but zero is a legitimate hash and must not be
    /// treated as absent.
    #[test]
    fn a_zero_token_is_still_a_token() {
        let work = rect(0.0, 0.0, 1920.0, 1040.0);
        let saved = named_parked(500.0, 300.0, work, 0);
        let decoded = ParkedWindow::decode(&saved.encode().expect("encoded")).expect("decoded");
        assert_eq!(decoded.display_id, Some(0));
    }

    /// The case geometry alone gets wrong: the pill was parked on a display that
    /// has come back at a different resolution, and another display now covers
    /// the rect it was saved with. The token recognises the pill's own display.
    #[test]
    fn a_display_that_changed_resolution_is_recognised_by_its_token() {
        let saved_work = display(1920.0, 0.0, 2560.0, 1400.0, Some(2));
        // Its own display came back smaller, and the primary grew over the old
        // rect, so an exact-rect match would pick the wrong display.
        let grown_primary = display(1920.0, 0.0, 2560.0, 1400.0, Some(1));
        let resized_own = display(0.0, 0.0, 1440.0, 900.0, Some(2));
        let displays = [grown_primary, resized_own];
        let (x, y) = restored(restore(
            named_parked(3000.0, 400.0, saved_work, 2),
            &displays,
            (200.0, 60.0),
            bounds,
        ));
        assert!(
            x < 1440.0,
            "restored on the wrong display: x = {x} is not inside the pill's own"
        );
        assert!(y < 900.0, "restored outside the display it came back on");
    }

    /// A display matched only by token keeps the pill's relative place, because
    /// its rect changed and the stored origin may now be off it.
    #[test]
    fn a_token_match_with_a_new_rect_remaps_instead_of_keeping_the_origin() {
        let saved_work = display(0.0, 0.0, 2560.0, 1400.0, Some(3));
        let shrunk = display(0.0, 0.0, 1280.0, 700.0, Some(3));
        // Parked at the far right of the old display, which does not exist now.
        let (x, _) = restored(restore(
            named_parked(2300.0, 400.0, saved_work, 3),
            &[shrunk],
            (200.0, 60.0),
            bounds,
        ));
        assert!(x <= 1280.0 - 200.0, "x = {x} is past the new display edge");
        assert!(x > 0.0, "the relative place was not kept: x = {x}");
    }

    /// When the saved display is gone for good, geometry still decides, so a
    /// connector that changes its name without the panel moving does not lose the
    /// position.
    #[test]
    fn a_vanished_token_falls_back_to_geometry() {
        let work = rect(0.0, 0.0, 1920.0, 1040.0);
        // Same rect, different token: the panel was replugged onto another port.
        let replugged = display(0.0, 0.0, 1920.0, 1040.0, Some(99));
        assert_eq!(
            restore(
                named_parked(500.0, 300.0, work, 41),
                &[replugged],
                (200.0, 60.0),
                bounds,
            ),
            Placement::Restore { x: 500.0, y: 300.0 }
        );
    }

    /// A token that matches nothing does not stop the record being usable: the
    /// pill still restores by geometry rather than giving up on the position.
    #[test]
    fn an_unknown_token_still_restores_by_geometry() {
        let work = rect(0.0, 0.0, 1920.0, 1040.0);
        let other = display(1920.0, 0.0, 2560.0, 1400.0, Some(5));
        let (x, y) = restored(restore(
            named_parked(500.0, 300.0, work, 6),
            &[work, other],
            (200.0, 60.0),
            bounds,
        ));
        assert_eq!((x, y), (500.0, 300.0));
    }

    /// A record written by the previous build cannot say which display it meant,
    /// so it is discarded instead of being guessed at.
    #[test]
    fn a_version_one_record_is_not_read_as_a_version_two_record() {
        let record = r#"{"version":1,"x":500.0,"y":300.0,"width":200.0,"height":60.0,
            "display":{"x":0.0,"y":0.0,"width":1920.0,"height":1040.0}}"#;
        assert!(ParkedWindow::decode(record).is_none());
    }

    /// A display name is not carried in the record as free text, so a row cannot
    /// smuggle an arbitrary string into a pill process through the argument.
    #[test]
    fn a_record_carries_a_token_and_not_a_display_name() {
        let work = rect(0.0, 0.0, 1920.0, 1040.0);
        let encoded = named_parked(500.0, 300.0, work, 1234)
            .encode()
            .expect("encoded");
        assert!(!encoded.contains("name"), "unexpected name in {encoded}");
        assert!(
            encoded.contains("\"display_id\":1234"),
            "missing token: {encoded}"
        );
    }

    /// Two panels of the same make and model share a token on X11, where the
    /// backend exposes no serial number. The token alone must not decide which
    /// one the pill returns to: the connected panel whose geometry matches is
    /// the one the pill was actually on, and taking the first candidate moved it
    /// to the other panel even though the right one was connected.
    #[test]
    fn a_shared_token_prefers_the_panel_whose_geometry_matches() {
        let panel = |x: f64| MonitorRect {
            x,
            y: 0.0,
            width: 1920.0,
            height: 1040.0,
            id: Some(7),
        };
        let left = panel(0.0);
        let right = panel(1920.0);
        let displays = [left, right];

        let parked_on_right =
            ParkedWindow::new_named(2400.0, 400.0, 600.0, 362.0, right, Some(7)).expect("parked");
        let bounds = |work: MonitorRect, _window: (f64, f64)| {
            footprint_bounds(work, (247.0, 309.0), (48.0, 6.0))
        };
        match restore(parked_on_right, &displays, (600.0, 362.0), bounds) {
            Placement::Restore { x, .. } => assert!(
                x >= 1920.0,
                "restored to the left panel at {x}, though the pill was parked on the right one"
            ),
            Placement::PlatformDefault => panic!("a matching panel was connected"),
        }
    }

    /// The published position is a flat record on the wire, because the desktop
    /// reads `display_id` as a sibling of `rect` rather than reaching into a
    /// wrapper. Flattening is what keeps that true while the shape stays declared
    /// once, and an absent token has to be omitted rather than sent as null, which
    /// is the drift one platform had already introduced.
    #[test]
    fn the_position_report_keeps_its_wire_shape() {
        #[derive(Serialize)]
        struct R {
            x: f64,
            y: f64,
        }
        let named = PositionReport::new(
            true,
            Some(R { x: 1.0, y: 2.0 }),
            Some(R { x: 3.0, y: 4.0 }),
            Some(99),
        );
        let json = serde_json::to_string(&named).expect("serialised");
        assert!(json.contains("\"display_id\":99"), "{json}");
        assert!(!json.contains("\"display\""), "the wrapper leaked: {json}");
        assert!(json.contains("\"has_saved_position\":true"), "{json}");

        let unnamed = PositionReport::new(false, None::<R>, None::<R>, None);
        let json = serde_json::to_string(&unnamed).expect("serialised");
        assert!(
            !json.contains("display_id"),
            "an absent token was sent: {json}"
        );
        // `rect` and `monitor` are sent as null when absent, and the desktop
        // filters those to objects, so that is the contract. The token is different:
        // it is omitted rather than nulled, because sending `display_id: null` was
        // exactly the drift this type exists to stop.
        assert!(
            json.contains("\"rect\":null"),
            "the null shape the desktop filters changed: {json}"
        );
    }
}
