//! Noticing that the displays changed while the pill is running.
//!
//! [`crate::restore`] answers "where does the pill go when the app starts".
//! This module answers the harder question that follows: the user unplugs a
//! display, drags the arrangement around, or changes the scale, and the pill is
//! already on screen with a window the operating system may have just moved on
//! its own. Nothing in the startup path runs again, so the pill has to notice
//! the layout changed, work out whether its own position still makes sense, and
//! only then decide whether a move was the user's or the display's.
//!
//! Three pieces, all pure, so each can be tested without a display:
//!
//! - [`display_identity`]: a stable token for a physical display, so a saved
//!   position names the monitor it was parked on rather than a rectangle.
//! - [`reconcile`]: the pill's position, re-resolved against a new layout.
//! - [`SaveGuard`]: when a save is the user's choice rather than the system's
//!   involuntary move.
//!
//! Two failure modes make this worth doing properly.
//!
//! 1. **Stranding.** If the pill's display goes away, its window is left at an
//!    origin no display covers. It is still running, still listening, and
//!    invisible: nothing on screen, so nothing to grab. Worse, the pill's own
//!    save path then writes that stranded origin over the good one, so the
//!    position is lost across the restart too.
//! 2. **Overwriting the user's choice with the OS's.** Windows rescales and
//!    repositions windows when a display changes, macOS relocates them on sleep
//!    and display drop-out, and a window manager can re-place them at any time.
//!    A frame the system forced is indistinguishable from a drag at the frame
//!    level, so saving "wherever the window is now" quietly replaces the place
//!    the user chose with the place the system improvised. The pill has to hold
//!    saves until the layout has been steady, and reconcile its own position
//!    against the new layout in the meantime.

use crate::drag::DragBounds;
use crate::edge::MonitorRect;
use crate::restore::{ParkedWindow, Placement};

/// How long a layout has to stay unchanged before a save is trusted.
///
/// Display changes arrive in bursts: unplugging one panel can produce a
/// disconnect, a resize, a workspace change and a scale change inside a few
/// hundred milliseconds, and Windows sends `WM_DISPLAYCHANGE` once per step. A
/// save that fires in the middle of that burst records a frame the system chose,
/// and once it is stored the user's real position is gone.
///
/// 1.5 s is the shortest settle that covers the bursts seen in the wild while
/// staying under the time a user spends moving their hand away from the pill.
pub const LAYOUT_SETTLE_SECONDS: f64 = 1.5;

/// Extra hold after a layout change for a drag that was in flight.
///
/// A drag that started before the change and ended after it is not a placement
/// decision the user made against the current layout, so it needs a hold of its
/// own measured from the drop, not from the layout event.
pub const DRAG_HOLD_SECONDS: f64 = 0.5;

/// A stable token for one physical display.
///
/// A rectangle cannot identify a monitor. Two identical panels have the same
/// rect on different ports; a resolution change moves the rect of a monitor that
/// has not moved; and platform display ids are reused, so they name a slot
/// rather than a device. Every project that has restored window positions for
/// long enough ends up storing something durable (an EDID string on Windows, a
/// display UUID or vendor/model/serial on macOS, an output name on X11) and
/// matching on that instead.
///
/// The platforms differ in what they can offer, so this takes whatever durable
/// string the platform has and reduces it to a token the record can carry and
/// compare. Hashing rather than storing the string keeps [`ParkedWindow`] cheap
/// to copy and the command line short; the trade is that a diagnostic printout
/// shows a number instead of an EDID, which is why [`display_identity`] is the
/// only place the reduction happens and it is trivially reproducible.
///
/// An empty or unknown identity returns `None`, which makes every caller fall
/// back to matching on geometry: a token that names nothing must not match a
/// different display that also names nothing.
pub fn display_identity(stable_name: &str) -> Option<u64> {
    let trimmed = stable_name.trim();
    if trimmed.is_empty() {
        return None;
    }
    // FNV-1a. No dependency, cannot panic, and the same bytes give the same
    // token in the desktop process and in every pill.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in trimmed.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    Some(hash)
}

/// A cheap identity for a display arrangement.
///
/// Platforms raise events for display changes and all three pills handle them,
/// but an event is not sufficient on its own: a hidden window receives no
/// `WM_DPICHANGED` for a scale change, a macOS app that is not frontmost can miss
/// a display notification, and a window manager can reconfigure an X11 window
/// without a property change the pill sees. Polling a signature cannot miss a
/// change, only notice it late, so it backs up the events rather than replacing
/// them.
///
/// The signature is ordered by geometry, so a renumbered but identical
/// arrangement hashes the same: a display's platform id is allowed to change
/// under the pill without that being a layout change.
pub fn layout_signature(areas: &[MonitorRect]) -> u64 {
    let mut sorted: Vec<(i64, i64, i64, i64)> = areas
        .iter()
        .filter(|area| {
            area.x.is_finite()
                && area.y.is_finite()
                && area.width.is_finite()
                && area.height.is_finite()
        })
        .map(|area| {
            (
                area.x.round() as i64,
                area.y.round() as i64,
                area.width.round() as i64,
                area.height.round() as i64,
            )
        })
        .collect();
    sorted.sort_unstable();
    sorted.dedup();

    // FNV-1a over the rounded rects. Any stable hash would do; this needs no
    // dependency, cannot panic, and is trivially reproducible in a test. The
    // count is folded in first so "no displays" and "one display at the origin"
    // cannot collide through an empty payload.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mut feed = |value: i64| {
        for byte in value.to_le_bytes() {
            hash ^= byte as u64;
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    };
    feed(sorted.len() as i64);
    for (x, y, width, height) in sorted {
        feed(x);
        feed(y);
        feed(width);
        feed(height);
    }
    hash
}

/// What a running pill should do about its position after a layout change.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Relocation {
    /// The pill's display is still connected and the pill is still on it, so the
    /// window is already correct. Do not touch it: a no-op move is still a move,
    /// and on Windows it costs a window-position message that looks like a drag.
    Keep,
    /// Move the window origin here and treat the result as the parked position.
    Move { x: f64, y: f64 },
    /// There is no usable display left. Leave the window alone and stop saving,
    /// so the position the user chose survives the outage.
    Stranded,
}

impl Relocation {
    /// Whether the caller has to move its window as a result.
    pub fn moves(self) -> bool {
        matches!(self, Self::Move { .. })
    }
}

fn area_usable(area: MonitorRect) -> bool {
    area.x.is_finite()
        && area.y.is_finite()
        && area.width.is_finite()
        && area.height.is_finite()
        && area.width > 0.0
        && area.height > 0.0
}

/// The overlap between a rect and the union of the work areas, as a fraction of
/// the rect's own area.
///
/// Used to answer "is any of the pill still reachable", which is the question
/// that decides between keeping a slightly-off position and relocating it.
fn visible_fraction(footprint: MonitorRect, areas: &[MonitorRect]) -> f64 {
    if !area_usable(footprint) {
        return 0.0;
    }
    // Summed per display and clamped, because overlapping work areas (a mirrored
    // pair) would otherwise report more than the whole pill as visible.
    let mut visible = 0.0;
    for area in areas.iter().filter(|area| area_usable(**area)) {
        let left = footprint.x.max(area.x);
        let right = footprint.right().min(area.right());
        let top = footprint.y.max(area.y);
        let bottom = footprint.bottom().min(area.bottom());
        if right > left && bottom > top {
            visible += (right - left) * (bottom - top);
        }
    }
    (visible / (footprint.width * footprint.height)).min(1.0)
}

/// The display whose work area contains a point, if any.
///
/// Deliberately not `nearest`: a point in the gap between two displays is not
/// "on" either of them, and pretending otherwise is what lets a stranded pill
/// look placed.
fn display_containing(areas: &[MonitorRect], x: f64, y: f64) -> Option<usize> {
    if !x.is_finite() || !y.is_finite() {
        return None;
    }
    areas
        .iter()
        .position(|area| x >= area.x && x < area.right() && y >= area.y && y < area.bottom())
}

/// Re-resolve a pill's position against a layout that just changed.
///
/// `areas` are the visible work areas now, in the same space and units as
/// `parked`. `footprint_for` receives the window size the pill publishes and
/// returns the visible pill's offset and size inside that window, so this can
/// measure what the user can actually see rather than the transparent canvas
/// the footprint hides in. `bounds_for` returns the origin range for a work
/// area.
///
/// Three outcomes, decided in this order:
///
/// 1. **Nothing to stand on.** No usable display, so [`Relocation::Stranded`].
///    Moving a window to the origin when there is no screen is worse than
///    leaving it where the user last saw it, and leaving it is what keeps the
///    stored position intact.
/// 2. **Fully visible.** The whole visible pill is inside the work areas, so
///    [`Relocation::Keep`]. This is the common case, and doing nothing is the
///    only answer that cannot make the pill twitch every time a display event
///    arrives. Note that a work area which shrank by a few pixels while the pill
///    stayed inside it lands here, as it should.
/// 3. **Poking out.** The whole footprint is not inside, but the pill's centre
///    is on a live display: the display is there and the pill only pokes past an
///    edge, or under a taskbar, or below a display that shrank. Clamp it in:
///    [`Relocation::Move`]. The place is still meaningful, so the minimal
///    correction preserves where the user put it relative to pixels that still
///    exist.
/// 4. **Gone.** The pill's centre is in dead space between displays, so no
///    display owns it. Re-resolve with [`crate::restore::restore`], which prefers
///    the display that took the old one's slot and otherwise keeps the pill's
///    relative place, so a pill whose monitor was unplugged comes back where the
///    user expects instead of at a corner.
///
/// The distinction between 3 and 4 is "does a display contain the pill", not
/// "did the display list change", because a layout event that changes nothing
/// about this pill's display must not move it, and a display that moved out from
/// under a stationary pill is the same problem as one that was unplugged.
pub fn reconcile<F, B>(
    parked: ParkedWindow,
    areas: &[MonitorRect],
    window_size: (f64, f64),
    footprint_for: F,
    mut bounds_for: B,
) -> Relocation
where
    F: Fn(MonitorRect, (f64, f64)) -> ((f64, f64), (f64, f64)),
    B: FnMut(MonitorRect, (f64, f64)) -> DragBounds,
{
    let usable: Vec<MonitorRect> = areas
        .iter()
        .copied()
        .filter(|area| area_usable(*area))
        .collect();
    if usable.is_empty() {
        return Relocation::Stranded;
    }
    let (width, height) = window_size;
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
        return Relocation::Stranded;
    }

    // The footprint is the pill the user can see, so every decision here is made
    // about it rather than about the window that carries it. The window is a
    // transparent canvas several times the pill's size, and a canvas whose
    // centre is on a display can still have its pill entirely below it.
    let (offset, size) = footprint_for(usable[0], window_size);
    let footprint =
        MonitorRect::without_id(parked.x + offset.0, parked.y + offset.1, size.0, size.1);

    if visible_fraction(footprint, &usable) >= 1.0 {
        return Relocation::Keep;
    }

    // Part of the pill is outside every work area. If its centre is still on a
    // display then the display is there and the pill merely pokes out of it, so
    // the minimal correction is to slide it back in. If the centre is not on a
    // display, no display owns this pill and only the record remembers where it
    // was meant to be.
    let (footprint_centre_x, footprint_centre_y) = (
        footprint.x + footprint.width / 2.0,
        footprint.y + footprint.height / 2.0,
    );
    let Some(owner) = display_containing(&usable, footprint_centre_x, footprint_centre_y) else {
        return relocate_from_scratch(parked, &usable, window_size, bounds_for);
    };

    let (x, y) = bounds_for(usable[owner], window_size).clamp_point(parked.x, parked.y);
    match finite(x, y) {
        Some((x, y)) => Relocation::Move { x, y },
        None => Relocation::Stranded,
    }
}

fn finite(x: f64, y: f64) -> Option<(f64, f64)> {
    (x.is_finite() && y.is_finite()).then_some((x, y))
}

/// Resolve the pill's place from the saved record alone, which is the path for a
/// display that is no longer connected.
fn relocate_from_scratch<B>(
    parked: ParkedWindow,
    areas: &[MonitorRect],
    window_size: (f64, f64),
    bounds_for: B,
) -> Relocation
where
    B: FnMut(MonitorRect, (f64, f64)) -> DragBounds,
{
    match crate::restore::restore(parked, areas, window_size, bounds_for) {
        Placement::Restore { x, y } => match finite(x, y) {
            Some((x, y)) => Relocation::Move { x, y },
            None => Relocation::Stranded,
        },
        // Restore only gives up when the layout is unusable, which the caller
        // already ruled out, but treating it as stranded is the safe reading:
        // the pill stays where it is and the save guard keeps its position.
        Placement::PlatformDefault => Relocation::Stranded,
    }
}

/// Decides when a save reflects the user's choice.
///
/// The pill saves its position when it settles after a drag. That rule is not
/// enough on its own, because the operating system moves pill windows too: a
/// display change rescales and repositions them, a session lock or wake
/// re-clamps them, and a hidden window can be moved without ever receiving the
/// DPI notification that would explain why. All of those arrive as an ordinary
/// frame, and the pill's settle detection cannot tell them from a drop.
///
/// So a save is refused while a layout change is settling, and refused again
/// briefly after a drag that a layout change interrupted. The refusal is
/// deliberately silent: nothing is written, so the previously saved position
/// survives, which is the whole point.
#[derive(Debug, Clone, Copy)]
pub struct SaveGuard {
    /// When the layout last changed, or `None` if it has not changed yet.
    last_layout_change: Option<f64>,
    /// When a drag last ended, for the interrupted-drag hold.
    last_drag_end: Option<f64>,
    /// Whether the pending drag spans a layout change.
    drag_spans_layout_change: bool,
}

impl Default for SaveGuard {
    fn default() -> Self {
        Self::new()
    }
}

impl SaveGuard {
    /// A guard that has seen no changes, so a save is allowed immediately.
    pub fn new() -> Self {
        Self {
            last_layout_change: None,
            last_drag_end: None,
            drag_spans_layout_change: false,
        }
    }

    /// Record that the layout changed at `now` ([`crate::clock::monotonic_now`]).
    ///
    /// Repeating the same event within the settle window is harmless: the window
    /// simply restarts, which is what a burst of display events should do.
    pub fn layout_changed(&mut self, now: f64) {
        self.last_layout_change = Some(now);
    }

    /// Record that a drag start is being tracked, so a layout change during it
    /// can be recognised as interrupting it.
    pub fn drag_started(&mut self) {
        self.drag_spans_layout_change = false;
    }

    /// Record that a layout change landed while a drag was held.
    pub fn layout_changed_during_drag(&mut self, now: f64) {
        self.layout_changed(now);
        self.drag_spans_layout_change = true;
    }

    /// Record that a drag ended at `now`, and therefore that a save is wanted.
    pub fn drag_ended(&mut self, now: f64) {
        self.last_drag_end = Some(now);
    }

    /// Whether the layout has been stable long enough for a save to be trusted.
    pub fn layout_settled(&self, now: f64) -> bool {
        match self.last_layout_change {
            None => true,
            Some(changed) => elapsed_at_least(now, changed, LAYOUT_SETTLE_SECONDS),
        }
    }

    /// Whether a save at `now` should be written.
    ///
    /// Both holds have to expire: the layout settle, and, when the layout moved
    /// under an in-flight drag, the drag hold measured from the drop. Requiring
    /// both is what keeps a drag that a display change interrupted from
    /// recording the position the system forced the window into.
    ///
    /// The drag hold compares `now` to the last drop rather than to the layout
    /// event, so a drag dropped before the layout settled waits for its own
    /// window to pass. A drag that never ended has no settled frame to record
    /// and is refused outright.
    pub fn allows_save(&self, now: f64) -> bool {
        if !self.layout_settled(now) {
            return false;
        }
        if !self.drag_spans_layout_change {
            return true;
        }
        match self.last_drag_end {
            Some(ended) => elapsed_at_least(now, ended, DRAG_HOLD_SECONDS),
            None => false,
        }
    }

    /// Whether the hold has outlived anything the pill could still be reacting
    /// to, so it can be dropped rather than kept as a timestamp forever.
    pub fn hold_expired(&self, now: f64) -> bool {
        match self.last_layout_change {
            None => true,
            Some(changed) => {
                elapsed_at_least(now, changed, LAYOUT_SETTLE_SECONDS + DRAG_HOLD_SECONDS)
            }
        }
    }
}

/// Why an unsaved pill has no stored position.
///
/// "The pill has no saved position" used to be a complete description, and each
/// platform rebuilt the meaning from a different pair of flags: Windows from
/// `reset_strategy`, macOS from `first_placement_done`, GTK from
/// `x11_drag_applied`. That is how one of them came to answer the same question
/// two different ways, and how clearing the stored position started moving the
/// pill instead of leaving it alone.
///
/// The distinction is the whole point: an unsaved pill must be re-homed when it
/// has never been placed, and must be left exactly where it is when the stored
/// position was deliberately dropped. The difference is not in the pill's
/// current position, which is identical in both cases, so it has to be stated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Anchor {
    /// A stored position survived, so the pill belongs there.
    Saved,
    /// The pill has never been placed in this process and no position survived:
    /// it is due a first placement.
    FirstPlacement,
    /// The stored position was dropped, either by a reset the user asked for or
    /// by clearing local data. The pill is already where it should be.
    Cleared,
}

impl Anchor {
    /// Whether the pill is due to be placed somewhere by the platform.
    ///
    /// A cleared pill is not: it is already sitting where the user left it, and
    /// the only thing that changed is that the position is no longer recorded.
    /// Moving it here is what made clearing local data drag the pill to a corner.
    pub fn places(self) -> bool {
        !matches!(self, Self::Cleared)
    }

    /// Whether the pill follows the pointer when it is placed.
    ///
    /// Only a first placement does. A reset names its own destination, and a
    /// cleared pill has nowhere to go at all.
    pub fn follows_pointer(self) -> bool {
        matches!(self, Self::FirstPlacement)
    }
}

/// What the anchor is, given whether a position is stored and how the pill
/// reached this state.
///
/// The reach is what the platforms disagree about, so it is an argument rather
/// than something each one re-derives: a reset or a forget started the pill over,
/// and nothing else did.
pub fn pill_anchor(saved: bool, restarted: bool) -> Anchor {
    if saved {
        Anchor::Saved
    } else if restarted {
        Anchor::Cleared
    } else {
        Anchor::FirstPlacement
    }
}

/// Where a saved position falls in the room its display gives it to slide.
///
/// Zero when the pill cannot slide at all, which is also the answer for a window
/// wider than its display: there is no room, so the leading edge is the only
/// position that means anything and the clamp does the rest. Anything unmeasurable
/// also resolves to `0.0` rather than to the trailing edge: a non-finite sample is
/// a bug, and the leading edge is the one answer that stays predictable next to a
/// clamp that is about to run on the same values.
pub fn relative_fraction(origin: f64, area_origin: f64, area_size: f64, window_size: f64) -> f64 {
    let room = area_size - window_size;
    if !room.is_finite() || room <= 0.0 {
        return 0.0;
    }
    let offset = (origin - area_origin) / room;
    if offset.is_finite() {
        offset.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

/// The inverse of [`relative_fraction`]: a fraction of the room becomes an origin.
///
/// `room` is passed already resolved, because the caller knows it from the
/// footprint it clamps with, and recomputing it from a window size here is what
/// made a remapped origin disagree with the clamp that followed it.
pub fn place_at_fraction(area_origin: f64, room: f64, fraction: f64) -> f64 {
    if !room.is_finite() || room <= 0.0 {
        return area_origin;
    }
    let fraction = if fraction.is_finite() {
        fraction.clamp(0.0, 1.0)
    } else {
        0.0
    };
    area_origin + fraction * room
}

/// The display a point belongs to, or the nearest one when it belongs to none.
///
/// Both halves earn their place. Containment is exact and has to win when it
/// applies, and it fails in two situations that are not errors: a point in the
/// gap between two displays of different heights, and a point outside every
/// display because the arrangement shrank under a pill that has not moved yet.
/// In both, the nearest display is the one the user means, and its work area is
/// what the pill has to be clamped into.
///
/// The nearest tie is broken by index, so the answer is stable frame to frame
/// rather than depending on iteration order.
pub fn display_for_point(areas: &[MonitorRect], x: f64, y: f64) -> Option<usize> {
    if areas.is_empty() {
        return None;
    }
    if let Some(index) = areas
        .iter()
        .position(|area| x >= area.x && x < area.right() && y >= area.y && y < area.bottom())
    {
        return Some(index);
    }
    let mut nearest: Option<(usize, f64)> = None;
    for (index, area) in areas.iter().enumerate() {
        let dx = x - area.x;
        let dy = y - area.y;
        let distance = (dx * dx + dy * dy).sqrt();
        if !distance.is_finite() {
            continue;
        }
        if nearest.is_none_or(|(_, known)| distance < known) {
            nearest = Some((index, distance));
        }
    }
    nearest.map(|(index, _)| index)
}

/// Describe the pill as parked for [`reconcile`], naming the display it is on.
///
/// Three call sites need exactly this, and each one got a piece of it wrong on its
/// own: one reconciled against a stored origin the user had just cleared, one
/// dropped the display token before saving and silently downgraded every later
/// restore to geometry matching, and one built a stand-in rectangle from a stale
/// coordinate when no display contained the pill. One function means one answer.
///
/// `named_id` is the token the record carries. It is honoured only when a display
/// with that token is connected, because a token for a display that is gone must
/// not outlive it; otherwise the display is the one containing the pill's
/// footprint centre, else the nearest one.
pub fn describe_parked(
    areas: &[MonitorRect],
    origin: (f64, f64),
    window: (f64, f64),
    footprint_centre: (f64, f64),
    named_id: Option<u64>,
) -> Option<ParkedWindow> {
    let display = named_id
        .and_then(|id| areas.iter().copied().find(|area| area.id == Some(id)))
        .or_else(|| {
            display_for_point(areas, footprint_centre.0, footprint_centre.1)
                .map(|index| areas[index])
        })
        .unwrap_or_else(|| MonitorRect::without_id(origin.0, origin.1, window.0, window.1));
    ParkedWindow::new_named(origin.0, origin.1, window.0, window.1, display, named_id)
}

/// The display a reconciled origin now belongs to.
///
/// Called after a [`Relocation::Move`] is applied, so the record names the display
/// the pill was actually moved onto rather than the one it left.
pub fn display_id_of(
    areas: &[MonitorRect],
    origin: (f64, f64),
    footprint_centre: (f64, f64),
) -> Option<u64> {
    let _ = origin;
    display_for_point(areas, footprint_centre.0, footprint_centre.1)
        .and_then(|index| areas[index].id)
}

/// Whether a layout poll at `now` should reconcile.
///
/// All three pills poll an arrangement signature because the native notification
/// can be dropped. Each one wrote this same sequence by hand, including the subtle
/// part: the first poll only records a baseline, because reconciling against
/// "nothing seen yet" would treat the launch itself as a display change and move a
/// freshly restored pill off the position it was just restored to.
///
/// Returns the new signature to store, and whether the caller should reconcile.
pub fn poll_should_reconcile(previous: Option<u64>, signature: u64) -> (u64, bool) {
    if previous == Some(signature) {
        return (signature, false);
    }
    (signature, previous.is_some())
}

/// Whether `now` is at least `threshold` after `then`.
///
/// A clock that ran backwards, or a non-finite sample, is never "long enough".
/// Refusing a save keeps the stored position the user chose, which is always
/// recoverable; overwriting it is not.
fn elapsed_at_least(now: f64, then: f64, threshold: f64) -> bool {
    let elapsed = now - then;
    elapsed.is_finite() && elapsed >= threshold
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::restore::{centered_bottom_footprint, footprint_bounds};

    fn rect(x: f64, y: f64, width: f64, height: f64) -> MonitorRect {
        MonitorRect::without_id(x, y, width, height)
    }

    fn display(x: f64, y: f64, width: f64, height: f64, id: Option<u64>) -> MonitorRect {
        MonitorRect {
            x,
            y,
            width,
            height,
            id,
        }
    }

    fn parked(x: f64, y: f64, display: MonitorRect) -> ParkedWindow {
        ParkedWindow::new(x, y, 600.0, 404.0, display).expect("valid parked window")
    }

    /// The resting footprint every pill draws: a 48x6 pill inside a 600x404
    /// window, centred horizontally and anchored above the selector slot.
    fn footprint(window: (f64, f64)) -> ((f64, f64), (f64, f64)) {
        centered_bottom_footprint(
            window,
            (48.0, 6.0),
            6.0 + crate::placement::below_slot_extra(32.0),
        )
    }

    fn bounds(work: MonitorRect, window: (f64, f64)) -> DragBounds {
        let (offset, size) = footprint(window);
        footprint_bounds(work, offset, size)
    }

    fn footprint_for(_work: MonitorRect, window: (f64, f64)) -> ((f64, f64), (f64, f64)) {
        footprint(window)
    }

    /// Where the visible pill ends up for a window origin. This is what the user
    /// can see, so it is what every assertion about reachability is made on.
    fn footprint_at(x: f64, y: f64) -> MonitorRect {
        let (offset, size) = footprint((600.0, 404.0));
        MonitorRect::without_id(x + offset.0, y + offset.1, size.0, size.1)
    }

    /// The invariant every non-stranded relocation has to satisfy: the visible
    /// pill is entirely inside one connected work area, so it is on screen and
    /// reachable whatever branch produced it.
    fn assert_on_a_display(relocation: Relocation, areas: &[MonitorRect]) {
        let Relocation::Move { x, y } = relocation else {
            panic!("expected a move, got {relocation:?}");
        };
        let pill = footprint_at(x, y);
        assert!(
            areas
                .iter()
                .any(|area| visible_fraction(pill, &[*area]) >= 1.0),
            "the pill at ({x}, {y}) is not fully on any display: {pill:?}"
        );
    }

    /// A token has to be stable across processes and distinct between displays,
    /// and a display that cannot be named has to stay unnamed rather than
    /// acquire a token that would match another unnamed display.
    #[test]
    fn a_display_identity_is_derived_from_a_durable_name() {
        let named = display_identity("GSM-5B7F-0x00001234").expect("identity");
        assert_eq!(
            Some(named),
            display_identity("  GSM-5B7F-0x00001234\n"),
            "surrounding whitespace is not part of the device"
        );
        assert_ne!(Some(named), display_identity("GSM-5B7F-0x00001235"));
        assert_eq!(
            Some(named),
            display_identity("GSM-5B7F-0x00001234 "),
            "a name's surrounding whitespace is trimmed, not hashed"
        );
        assert_eq!(display_identity(""), None);
        assert_eq!(display_identity("   "), None);
    }

    #[test]
    fn the_layout_signature_ignores_display_order_and_platform_ids() {
        let a = display(0.0, 0.0, 1920.0, 1040.0, Some(1));
        let b = display(1920.0, 0.0, 2560.0, 1400.0, Some(2));
        let reordered = [display(1920.0, 0.0, 2560.0, 1400.0, Some(9)), a];
        assert_eq!(layout_signature(&[a, b]), layout_signature(&reordered));
    }

    #[test]
    fn the_layout_signature_changes_when_a_display_moves_resizes_or_arrives() {
        let base = [rect(0.0, 0.0, 1920.0, 1040.0)];
        assert_ne!(
            layout_signature(&base),
            layout_signature(&[rect(200.0, 0.0, 1920.0, 1040.0)])
        );
        assert_ne!(
            layout_signature(&base),
            layout_signature(&[rect(0.0, 0.0, 1920.0, 1080.0)])
        );
        assert_ne!(
            layout_signature(&base),
            layout_signature(&[
                rect(0.0, 0.0, 1920.0, 1040.0),
                rect(1920.0, 0.0, 800.0, 600.0)
            ])
        );
        assert_ne!(layout_signature(&[]), layout_signature(&base));
    }

    /// Platforms round reported work areas inconsistently, and a fraction of a
    /// point must not read as a new arrangement or the pill would reconcile on
    /// every poll.
    #[test]
    fn a_subpixel_jitter_is_not_a_layout_change() {
        let base = [rect(0.0, 0.0, 1920.0, 1040.0)];
        let jittered = [rect(0.4, 0.0, 1919.6, 1040.2)];
        assert_eq!(layout_signature(&base), layout_signature(&jittered));
    }

    /// The common case, and the one that must not move the window: nothing about
    /// the layout or the pill changed, so the answer is `Keep`.
    #[test]
    fn an_unchanged_layout_keeps_the_pill_exactly_where_it_is() {
        let work = rect(0.0, 0.0, 1920.0, 1040.0);
        assert_eq!(
            reconcile(
                parked(500.0, 300.0, work),
                &[work],
                (600.0, 404.0),
                footprint_for,
                bounds,
            ),
            Relocation::Keep
        );
        // The resting corner itself is the tightest case: the pill's bottom edge
        // touches the work area's bottom edge and it must still count as visible.
        assert_eq!(
            reconcile(
                parked(300.0, 684.0, work),
                &[work],
                (600.0, 404.0),
                footprint_for,
                bounds,
            ),
            Relocation::Keep
        );
    }

    /// Unplugging the display the pill was on has to move it somewhere visible on
    /// what is left, and it must keep the place it held rather than jumping to a
    /// corner.
    #[test]
    fn losing_the_pills_display_relocates_it_onto_a_connected_one() {
        let primary = rect(0.0, 0.0, 1920.0, 1040.0);
        let secondary = rect(1920.0, 0.0, 2560.0, 1400.0);
        let record = parked(3000.0, 1300.0, secondary);
        let Relocation::Move { x, y } =
            reconcile(record, &[primary], (600.0, 404.0), footprint_for, bounds)
        else {
            panic!("a stranded pill has to be relocated");
        };
        let b = bounds(primary, (600.0, 404.0));
        assert!(
            x >= b.min_x && x <= b.max_x && y >= b.min_y && y <= b.max_y,
            "relocated outside the surviving display: ({x}, {y}) not in {b:?}"
        );
        // The fraction of the old display is preserved: the pill sat near the
        // bottom of a 1400 tall display, so it comes back near the bottom of the
        // 1040 tall survivor rather than at the top.
        assert!(
            y > b.min_y + 400.0,
            "expected the vertical place to be kept"
        );
        assert_on_a_display(Relocation::Move { x, y }, &[primary]);
    }

    /// A taskbar that appears under a parked pill leaves the pill out of bounds
    /// while still on its display. Whatever branch resolves it, the result has to
    /// be fully visible again: a pill half under a taskbar cannot be grabbed.
    #[test]
    fn a_new_taskbar_puts_a_pill_it_landed_under_back_in_view() {
        let full = rect(0.0, 0.0, 1920.0, 1040.0);
        let with_taskbar = rect(0.0, 0.0, 1920.0, 992.0);
        // Flush with the bottom of the work area the user parked it in, which the
        // taskbar now covers.
        let record = parked(300.0, 684.0, full);
        let relocation = reconcile(
            record,
            &[with_taskbar],
            (600.0, 404.0),
            footprint_for,
            bounds,
        );
        assert_on_a_display(relocation, &[with_taskbar]);
    }

    /// A pill straddling the edge of its display, still mostly on it, is pulled
    /// back by exactly the clamp. This is the one case where re-deriving the
    /// relative place would move a pill the user did not touch.
    #[test]
    fn a_pill_straddling_a_display_edge_is_clamped_not_remapped() {
        let work = rect(0.0, 0.0, 1920.0, 1040.0);
        // Eight pixels of the pill hang past the right edge; its centre is on it.
        let record = parked(1604.0, 0.0, work);
        let Relocation::Move { x, y } =
            reconcile(record, &[work], (600.0, 404.0), footprint_for, bounds)
        else {
            panic!("a straddling pill has to be pulled back in");
        };
        let (clamped_x, clamped_y) = bounds(work, (600.0, 404.0)).clamp_point(1604.0, 0.0);
        assert_eq!((x, y), (clamped_x, clamped_y));
        assert!(footprint_at(x, y).right() <= work.right());
    }

    /// A pill inside a work area that merely shrank, still fully visible after the
    /// shrink, is not moved at all.
    #[test]
    fn a_work_area_that_shrank_around_a_pill_does_not_move_it() {
        let after = rect(0.0, 0.0, 1920.0, 1040.0 - 48.0);
        assert_eq!(
            reconcile(
                parked(700.0, 200.0, after),
                &[after],
                (600.0, 404.0),
                footprint_for,
                bounds,
            ),
            Relocation::Keep
        );
    }

    /// No displays at all is not a reason to move a window to the origin: there
    /// is nowhere to move it to, and moving it would strand it further.
    #[test]
    fn an_empty_layout_strands_the_pill_instead_of_moving_it() {
        let work = rect(0.0, 0.0, 1920.0, 1040.0);
        assert_eq!(
            reconcile(
                parked(500.0, 300.0, work),
                &[],
                (600.0, 404.0),
                footprint_for,
                bounds,
            ),
            Relocation::Stranded
        );
    }

    /// A display the platform reports with a zero span cannot hold a window, so it
    /// does not count as somewhere to relocate to.
    #[test]
    fn a_degenerate_display_is_not_a_relocation_target() {
        let work = rect(0.0, 0.0, 1920.0, 1040.0);
        let broken = rect(0.0, 0.0, 0.0, 1040.0);
        assert_eq!(
            reconcile(
                parked(500.0, 300.0, work),
                &[broken],
                (600.0, 404.0),
                footprint_for,
                bounds,
            ),
            Relocation::Stranded
        );
    }

    /// A pill whose centre left every display is not clamped onto the display it
    /// used to be on: no display owns it, so the record decides.
    #[test]
    fn a_pill_whose_centre_left_every_display_is_relocated_from_the_record() {
        let work = rect(0.0, 0.0, 1920.0, 1040.0);
        let record = parked(500.0, 5000.0, work);
        let relocation = reconcile(record, &[work], (600.0, 404.0), footprint_for, bounds);
        assert_on_a_display(relocation, &[work]);
    }

    /// A pill in the dead space between two displays is not "on" either of them,
    /// so it is re-resolved rather than kept or clamped to the nearest edge.
    #[test]
    fn a_pill_in_dead_space_is_relocated() {
        let left = rect(0.0, 0.0, 1920.0, 1040.0);
        // A display above and far to the right, leaving a gap to sit in.
        let above = rect(4000.0, -1200.0, 1920.0, 1200.0);
        let record = parked(1800.0, -1600.0, left);
        let relocation = reconcile(
            record,
            &[left, above],
            (600.0, 404.0),
            footprint_for,
            bounds,
        );
        assert_on_a_display(relocation, &[left, above]);
    }

    #[test]
    fn a_save_is_allowed_immediately_when_nothing_has_changed() {
        let guard = SaveGuard::new();
        assert!(guard.allows_save(0.0));
        assert!(guard.layout_settled(0.0));
        assert!(guard.hold_expired(0.0));
    }

    /// The bug this exists to prevent: the layout changes, the system moves the
    /// window, the pill settles, and the settle is saved as the user's choice.
    #[test]
    fn a_save_inside_the_settle_window_is_refused() {
        let mut guard = SaveGuard::new();
        guard.layout_changed(10.0);
        assert!(!guard.allows_save(10.0));
        assert!(!guard.allows_save(11.0));
        assert!(
            guard.allows_save(10.0 + LAYOUT_SETTLE_SECONDS),
            "the settle window has passed"
        );
    }

    /// A burst of display events restarts the window, so unplugging two displays
    /// does not let the first event's settle expire while the second is landing.
    #[test]
    fn a_burst_of_layout_changes_holds_the_save_until_the_burst_stops() {
        let mut guard = SaveGuard::new();
        guard.layout_changed(10.0);
        guard.layout_changed(10.8);
        assert!(!guard.allows_save(11.6));
        assert!(guard.allows_save(12.3));
    }

    #[test]
    fn a_drag_interrupted_by_a_layout_change_waits_for_the_drop_to_settle() {
        let mut guard = SaveGuard::new();
        guard.drag_started();
        guard.layout_changed_during_drag(10.0);
        // The layout settle has passed, but the drag ended at 11.2 and a drop a
        // fifth of a second after it is not a decision against this layout.
        guard.drag_ended(11.2);
        assert!(!guard.allows_save(11.6));
        assert!(guard.allows_save(11.2 + DRAG_HOLD_SECONDS));
    }

    /// A drag that never ended after a layout change has no settled frame to
    /// record, so nothing is saved however long the pill waits.
    #[test]
    fn a_drag_that_never_ended_after_a_layout_change_never_saves() {
        let mut guard = SaveGuard::new();
        guard.layout_changed_during_drag(10.0);
        assert!(!guard.allows_save(100.0));
    }

    /// A drag that ended before the layout changed is an ordinary save once the
    /// layout settle has passed: the pill's own drop is not suspect.
    #[test]
    fn a_drag_that_ended_before_the_change_saves_after_the_settle() {
        let mut guard = SaveGuard::new();
        guard.drag_started();
        guard.drag_ended(9.0);
        guard.layout_changed(10.0);
        assert!(!guard.allows_save(11.0));
        assert!(guard.allows_save(11.5));
    }

    /// A clock that goes backwards must not be read as "long enough": the safe
    /// answer keeps the stored position instead of overwriting it.
    #[test]
    fn a_backwards_or_invalid_clock_refuses_the_save() {
        let mut guard = SaveGuard::new();
        guard.layout_changed(10.0);
        assert!(!guard.allows_save(9.0));
        assert!(!guard.allows_save(f64::NAN));
        assert!(!guard.allows_save(f64::INFINITY));
    }

    #[test]
    fn the_hold_stops_mattering_once_the_layout_has_been_still_for_a_while() {
        let mut guard = SaveGuard::new();
        guard.layout_changed(10.0);
        assert!(!guard.hold_expired(11.0));
        assert!(guard.hold_expired(10.0 + LAYOUT_SETTLE_SECONDS + DRAG_HOLD_SECONDS));
    }

    /// The relocated position has to be a fixed point of the same clamp, or the
    /// pill would move once at relocation and again on the next idle tick.
    #[test]
    fn a_relocated_position_survives_the_clamp_it_was_resolved_with() {
        let primary = rect(0.0, 0.0, 1920.0, 1040.0);
        let secondary = rect(1920.0, 0.0, 2560.0, 1400.0);
        let record = parked(3000.0, 1300.0, secondary);
        let Relocation::Move { x, y } =
            reconcile(record, &[primary], (600.0, 404.0), footprint_for, bounds)
        else {
            panic!("expected a relocation");
        };
        assert_eq!(
            bounds(primary, (600.0, 404.0)).clamp_point(x, y),
            (x, y),
            "relocation and the idle clamp disagree"
        );
    }

    // -- Anchoring ----------------------------------------------------------

    /// A pill that has never been placed is placed, and follows the pointer while
    /// it is. A pill whose stored position was dropped is not placed at all.
    ///
    /// This is the whole reason the anchor exists. Reading "no saved position" as
    /// one state made every reset and every local-data clear look like a first
    /// launch, which moved a pill the user had deliberately parked.
    #[test]
    fn a_cleared_anchor_neither_places_nor_follows_the_pointer() {
        let first = pill_anchor(false, false);
        assert_eq!(first, Anchor::FirstPlacement);
        assert!(first.places());
        assert!(first.follows_pointer());

        let cleared = pill_anchor(false, true);
        assert_eq!(cleared, Anchor::Cleared);
        assert!(!cleared.places(), "a cleared pill must not be moved");
        assert!(!cleared.follows_pointer());

        // A stored position outranks how the pill got here: a reset followed by a
        // restore has a position again and belongs at it.
        assert_eq!(pill_anchor(true, true), Anchor::Saved);
        assert_eq!(pill_anchor(true, false), Anchor::Saved);
    }

    // -- Fractions ---------------------------------------------------------

    #[test]
    fn a_fraction_is_clamped_and_pinned_without_room() {
        assert_eq!(relative_fraction(50.0, 0.0, 200.0, 100.0), 0.5);
        assert_eq!(relative_fraction(-50.0, 0.0, 200.0, 100.0), 0.0);
        assert_eq!(relative_fraction(500.0, 0.0, 200.0, 100.0), 1.0);
        // No room: the leading edge is the only meaningful position.
        assert_eq!(relative_fraction(10.0, 0.0, 100.0, 100.0), 0.0);
        assert_eq!(relative_fraction(10.0, 0.0, 100.0, 200.0), 0.0);
        // Non-finite input is a bug, not a vote for the trailing edge.
        assert_eq!(relative_fraction(f64::NAN, 0.0, 200.0, 100.0), 0.0);
        assert_eq!(relative_fraction(f64::INFINITY, 0.0, 200.0, 100.0), 0.0);
    }

    /// Placing at a fraction and measuring that placement give back the same
    /// number, which is what lets a remapped origin survive the clamp that
    /// follows it without drifting.
    #[test]
    fn placing_at_a_fraction_round_trips() {
        for step in 0..=10 {
            let fraction = step as f64 / 10.0;
            let placed = place_at_fraction(120.0, 640.0, fraction);
            let measured = relative_fraction(placed, 120.0, 640.0, 0.0);
            assert!((measured - fraction).abs() < 1e-12, "fraction {fraction}");
        }
        // No room falls back to the area origin rather than to a negative offset.
        assert_eq!(place_at_fraction(300.0, 0.0, 0.5), 300.0);
        assert_eq!(place_at_fraction(300.0, -10.0, 0.5), 300.0);
        // A corrupt fraction is clamped, not extrapolated off the display.
        assert_eq!(place_at_fraction(0.0, 100.0, 9.0), 100.0);
        assert_eq!(place_at_fraction(0.0, 100.0, f64::NAN), 0.0);
    }

    // -- Point to display --------------------------------------------------

    /// Containment wins when it applies, and the nearest display answers when it
    /// does not. Both are needed: a pill can sit in the notch between two displays
    /// of different heights, and a shrinking arrangement can leave it outside
    /// every display before anything has moved it.
    #[test]
    fn a_point_resolves_to_its_display_or_the_nearest_one() {
        let areas = [
            MonitorRect::without_id(0.0, 0.0, 1920.0, 1080.0),
            MonitorRect::without_id(1920.0, 0.0, 1280.0, 720.0),
        ];
        assert_eq!(display_for_point(&areas, 100.0, 100.0), Some(0));
        assert_eq!(display_for_point(&areas, 2000.0, 100.0), Some(1));
        // Below the short display: outside every area, nearest is the short one.
        assert_eq!(display_for_point(&areas, 2000.0, 900.0), Some(1));
        // Above both: nearest is still a display rather than nothing.
        assert_eq!(display_for_point(&areas, 100.0, -40.0), Some(0));
        // Negative-origin layouts work because containment is signed.
        let left = [MonitorRect::without_id(-1920.0, 0.0, 1920.0, 1080.0)];
        assert_eq!(display_for_point(&left, -100.0, 100.0), Some(0));
        // No displays at all is `None`, not a panic or a guess.
        assert_eq!(display_for_point(&[], 0.0, 0.0), None);
        // A non-finite point cannot contain anything and has no distance.
        assert_eq!(display_for_point(&areas, f64::NAN, 0.0), None);
    }
}
