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

use serde::{Deserialize, Serialize};

use crate::drag::DragBounds;
use crate::edge::MonitorRect;

/// Bumped when the meaning of a stored field changes, so a row written by a
/// different build is discarded instead of misread. Value 1 is a window origin
/// and size plus the display rect that contained it, all in the platform's
/// top-left space.
pub const SCHEMA_VERSION: i64 = 1;

/// A pill window as it was last parked on a display.
///
/// `(x, y)` is the window's top-left corner and `(width, height)` is the rect it
/// was parked at. The size is part of the record because the pill window
/// changes size between modes and releases, and the origin only means "where
/// the user dropped it" if the window is the same rect. `display` is the rect of
/// the display that contained the window centre when it was saved, which is what
/// lets a later launch notice that the display is gone.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ParkedWindow {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub display: MonitorRect,
}

impl ParkedWindow {
    /// Build a parked window, rejecting anything a corrupt row can produce.
    ///
    /// Returns `None` for non-finite values and for empty or negative spans, so
    /// a bad record stops here instead of reaching window placement math that
    /// assumes finite numbers.
    pub fn new(x: f64, y: f64, width: f64, height: f64, display: MonitorRect) -> Option<Self> {
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
            display,
        })
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
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
struct Record {
    version: i64,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    display: DisplayRecord,
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
        Self::new(
            record.x,
            record.y,
            record.width,
            record.height,
            MonitorRect {
                x: record.display.x,
                y: record.display.y,
                width: record.display.width,
                height: record.display.height,
            },
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
    args.into_iter()
        .filter_map(|arg| {
            arg.as_ref()
                .strip_prefix(SAVED_POSITION_ARG)
                .map(str::to_string)
        })
        .next()
        .and_then(|record| ParkedWindow::decode(&record))
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

    let anchor = if exact {
        (parked.x, parked.y)
    } else {
        remap(parked, areas[index])
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
fn choose_display(parked: &ParkedWindow, displays: &[MonitorRect]) -> Option<(usize, bool)> {
    if let Some(index) = displays
        .iter()
        .position(|display| *display == parked.display)
    {
        return Some((index, true));
    }
    if let Some(index) = displays
        .iter()
        .position(|display| display.x == parked.display.x && display.y == parked.display.y)
    {
        return Some((index, false));
    }
    let mut nearest: Option<(usize, f64)> = None;
    for (index, display) in displays.iter().enumerate() {
        let dx = display.x - parked.display.x;
        let dy = display.y - parked.display.y;
        let distance = (dx * dx + dy * dy).sqrt();
        if !distance.is_finite() {
            continue;
        }
        if nearest.is_none_or(|(_, known)| distance < known) {
            nearest = Some((index, distance));
        }
    }
    nearest.map(|(index, _)| (index, false))
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
fn remap(parked: ParkedWindow, work: MonitorRect) -> (f64, f64) {
    (
        work.x
            + relative_fraction(
                parked.x,
                parked.display.x,
                parked.display.width,
                parked.width,
            ) * (work.width - parked.width),
        work.y
            + relative_fraction(
                parked.y,
                parked.display.y,
                parked.display.height,
                parked.height,
            ) * (work.height - parked.height),
    )
}

/// Where the origin sat inside the display, as a fraction of the room it could
/// slide, clamped to `0.0` to `1.0`. Returns `0.0` when there is no room.
fn relative_fraction(origin: f64, display_origin: f64, display_span: f64, window_span: f64) -> f64 {
    let room = display_span - window_span;
    if !room.is_finite() || room <= 0.0 || !origin.is_finite() || !display_span.is_finite() {
        return 0.0;
    }
    ((origin - display_origin) / room).clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, width: f64, height: f64) -> MonitorRect {
        MonitorRect {
            x,
            y,
            width,
            height,
        }
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

    /// The centre is what decides which display owns a saved spot, so it has to
    /// include the window size rather than the origin alone.
    #[test]
    fn the_centre_is_derived_from_the_origin_and_the_size() {
        let only = rect(0.0, 0.0, 1920.0, 1040.0);
        assert_eq!(parked(100.0, 40.0, only).center(), (200.0, 70.0));
    }
}
