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
        Placement::Restore { x, y, .. } => match finite(x, y) {
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
    ///
    /// Any drop recorded by a previous gesture is cleared here. A finished drag
    /// leaves `last_drag_end` behind so a save refused mid-flight still has a
    /// deadline; if a *new* drag starts, that deadline belongs to a gesture the
    /// user has already finished. Left in place it makes `allows_save` true for
    /// the unfinished drag, and the drop that was waiting is written from the
    /// wrong place.
    pub fn drag_started(&mut self) {
        self.drag_spans_layout_change = false;
        self.last_drag_end = None;
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

    /// When a save refused at `now` can be written, if the drop that caused it
    /// still deserves to be stored.
    ///
    /// A refused save is not a cancelled one. The caller learns the drop once and
    /// cannot learn it again, so without a deadline the drop is simply lost and
    /// the pill reopens at the position it had before the user moved it. The
    /// deadline is the later of the two holds still in force: the layout settle,
    /// and, for an interrupted drag, the drop's own window.
    ///
    /// `None` when no later write is due: the save is allowed now, or there is no
    /// settled frame to record at all.
    pub fn save_due_at(&self, now: f64) -> Option<f64> {
        if self.allows_save(now) {
            return None;
        }
        // A clock that is not a number cannot measure a deadline from itself, and
        // a caller subtracting it from one would schedule a retry at NaN.
        if !now.is_finite() {
            return None;
        }
        let settle = match self.last_layout_change {
            Some(changed) if !self.layout_settled(now) => changed + LAYOUT_SETTLE_SECONDS,
            _ => now,
        };
        let drop = match (self.drag_spans_layout_change, self.last_drag_end) {
            (true, Some(ended)) if !elapsed_at_least(now, ended, DRAG_HOLD_SECONDS) => {
                Some(ended + DRAG_HOLD_SECONDS)
            }
            // An interrupted drag that never ended has nothing to record, and a
            // deadline would only retry a frame that does not exist.
            (true, None) => return None,
            _ => None,
        };
        let at = drop.map_or(settle, |ended| settle.max(ended));
        // A non-finite deadline could never fire, which would leave the caller
        // holding a save forever. Refusing it is the same answer as no deadline.
        at.is_finite().then_some(at)
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

/// Why an unsaved pill has no stored position, and where a due placement goes.
///
/// "The pill has no saved position" used to be a complete description, and each
/// platform rebuilt the meaning from a different pair of flags: Windows from
/// `reset_strategy`, macOS from `first_placement_done`, GTK from
/// `x11_drag_applied`. That is how one of them came to answer the same question
/// two different ways, and how clearing the stored position started moving the
/// pill instead of leaving it alone.
///
/// The destination is part of the reason rather than a second flag beside it,
/// because the two are not independent: a cleared pill has nowhere to go and must
/// never follow the pointer, and a stored one belongs where it was left. Carrying
/// both in one value makes that illegal pair unrepresentable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Anchor {
    /// A stored position survived, so the pill belongs there.
    Saved,
    /// Never placed in this process, so it is due a first placement at the pointer.
    LaunchAtCursor,
    /// The user asked for a reset onto the display the pill already lives on.
    ResetAtCurrent,
    /// The user asked for a reset onto the display under the pointer.
    ResetAtCursor,
    /// The stored position was dropped by clearing local data. The pill is already
    /// where it should be.
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

    /// Whether a due placement follows the pointer.
    ///
    /// A first placement does, and so does a reset that named the cursor. A pill
    /// with a stored position, and one anchored to its own display, do not.
    pub fn follows_pointer(self) -> bool {
        matches!(self, Self::LaunchAtCursor | Self::ResetAtCursor)
    }

    /// The anchor a reset leaves behind, given whether it asked for the cursor.
    pub fn from_reset(follows_pointer: bool) -> Self {
        if follows_pointer {
            Self::ResetAtCursor
        } else {
            Self::ResetAtCurrent
        }
    }

    /// The anchor after clearing local data: nothing is due.
    pub fn from_forget() -> Self {
        Self::Cleared
    }

    /// Whether a relocation the *system* caused should be recorded as a save.
    ///
    /// Only when the pill has a position to keep. After a forget or a reset there
    /// is no stored position and the pill is deliberately unsaved; a display change
    /// that then relocates it must still move the window (it has to stay visible)
    /// but must not invent a saved position, or the row the clear just deleted is
    /// written back by the layout.
    pub fn records_relocation(self) -> bool {
        self.places()
    }
}

/// What the anchor is, given whether a position is stored and whether a restart
/// already consumed the launch placement.
///
/// `restarted` is true once the pill has been placed at least once in this
/// process, so an unsaved pill that has been placed is not due another launch
/// placement. The platforms know that fact under different names; passing it in is
/// what stops each of them re-deriving the rule.
pub fn pill_anchor(saved: bool, restarted: bool) -> Anchor {
    if saved {
        Anchor::Saved
    } else if restarted {
        Anchor::Cleared
    } else {
        Anchor::LaunchAtCursor
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
    nearest_display(areas, x, y)
}

/// The index of the display whose origin is nearest `(x, y)`.
///
/// The fallback half of [`display_for_point`], for the two cases where containment
/// is not an answer: a point in the gap between displays of different heights, and
/// a point outside every display because the arrangement shrank under a pill that
/// has not moved yet. Restore needs the same search for a saved display that is no
/// longer connected, so it is one function rather than two that must agree.
///
/// Ties break by index, so the answer is stable frame to frame instead of
/// depending on iteration order.
pub fn nearest_display(areas: &[MonitorRect], x: f64, y: f64) -> Option<usize> {
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
        .and_then(|id| {
            // A token need not be unique: two panels of the same make and model
            // share one on X11, where no serial number is exposed, and mirrors of
            // one panel share one everywhere. Of the panels carrying the saved
            // token, take the one the pill's footprint is actually on, so a pill
            // parked on the second of them does not record the first one's
            // geometry. With no footprint match the first is all there is.
            let mut named = areas.iter().filter(|area| area.id == Some(id));
            let first = named.next().copied()?;
            let matching = areas
                .iter()
                .filter(|area| area.id == Some(id))
                .copied()
                .find(|area| {
                    footprint_centre.0 >= area.x
                        && footprint_centre.0 < area.right()
                        && footprint_centre.1 >= area.y
                        && footprint_centre.1 < area.bottom()
                });
            Some(matching.unwrap_or(first))
        })
        .or_else(|| {
            display_for_point(areas, footprint_centre.0, footprint_centre.1)
                .map(|index| areas[index])
        })
        .unwrap_or_else(|| MonitorRect::without_id(origin.0, origin.1, window.0, window.1));
    // The record names the display it was actually described against. When the
    // saved token is not connected, `display` came from geometry and carries a
    // different panel's identity -- recording the saved token beside it would
    // store a rectangle and a name that disagree, and the next launch would look
    // for a display that is not the one the geometry describes.
    ParkedWindow::new_named(origin.0, origin.1, window.0, window.1, display, display.id)
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

/// How often the arrangement is re-read when no message arrived.
///
/// A display changes far slower than a frame and far faster than a user notices,
/// so half a second is the whole design: cheap enough to run forever, quick enough
/// that a dropped notification costs a blink rather than a stranded pill.
pub const LAYOUT_POLL_SECONDS: f64 = 0.5;

/// The result of one poll.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PollOutcome {
    /// Still inside the interval, so nothing was read.
    TooSoon,
    /// A signature was read and stored, and it matches the last one.
    Unchanged,
    /// The first signature seen. Stored as the baseline, but not acted on.
    Baseline,
    /// The arrangement changed. The caller should reconcile.
    Changed,
}

/// Advance the layout poll by one tick.
///
/// All three pills poll because the native notification can be dropped. Each one
/// wrote this sequence by hand, and the subtle part is the baseline: the first
/// signature must not be acted on, because reconciling against "nothing seen yet"
/// treats the launch itself as a display change and moves a freshly restored pill
/// off the position it was just restored to.
///
/// Returns the tick time to store, the signature to store, and what to do.
pub fn poll_layout(
    polled_at: f64,
    signature_before: Option<u64>,
    now: f64,
    signature: u64,
) -> (f64, Option<u64>, PollOutcome) {
    if !(now - polled_at).is_finite() || now - polled_at < LAYOUT_POLL_SECONDS {
        return (polled_at, signature_before, PollOutcome::TooSoon);
    }
    match signature_before {
        Some(previous) if previous == signature => (now, Some(signature), PollOutcome::Unchanged),
        Some(_) => (now, Some(signature), PollOutcome::Changed),
        None => (now, Some(signature), PollOutcome::Baseline),
    }
}

/// The two values a poll carries between frames, and the one place they are
/// written.
///
/// All three pills copied the same four lines of bookkeeping around
/// [`poll_layout`]: read the pair, call, store the pair back. That is the shape
/// that goes wrong quietly, because a caller that forgets to store one of the two
/// polls every frame forever while looking correct.
#[derive(Debug, Clone, Copy, Default)]
pub struct LayoutPoll {
    polled_at: f64,
    signature: Option<u64>,
}

impl LayoutPoll {
    /// A poll that has never run, so the first observation is the baseline.
    pub fn new() -> Self {
        Self::default()
    }

    /// A poll resuming from persisted values.
    pub fn from_parts(polled_at: f64, signature: Option<u64>) -> Self {
        Self {
            polled_at,
            signature,
        }
    }

    /// When the arrangement was last read.
    pub fn polled_at(self) -> f64 {
        self.polled_at
    }

    /// The last arrangement signature, if one has been read yet.
    pub fn signature(self) -> Option<u64> {
        self.signature
    }

    /// Read `signature` at `now`, storing both values, and report what changed.
    ///
    /// The baseline rule is the part that is easy to get wrong and invisible when
    /// wrong: acting on the first signature treats the launch as a display change
    /// and moves a pill that had just been restored. Only [`PollOutcome::Changed`]
    /// is a reason to reconcile.
    pub fn observe(&mut self, now: f64, signature: u64) -> PollOutcome {
        let (polled_at, stored, outcome) =
            poll_layout(self.polled_at, self.signature, now, signature);
        self.polled_at = polled_at;
        self.signature = stored;
        outcome
    }
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
pub(crate) mod tests {
    /// The two-panel arrangement the seam and drag tests share: a panel with a
    /// shorter neighbour to its right, which is what makes a seam appear at all.
    pub(crate) fn seam_fixture() -> (MonitorRect, MonitorRect, MonitorRect) {
        let monitor = MonitorRect {
            x: 0.0,
            y: 0.0,
            width: 1200.0,
            height: 1000.0,
            id: None,
        };
        let work = MonitorRect {
            width: 1180.0,
            height: 900.0,
            ..monitor
        };
        let neighbor = MonitorRect {
            x: 1200.0,
            y: 200.0,
            width: 1000.0,
            height: 600.0,
            ..monitor
        };
        (monitor, work, neighbor)
    }

    /// One rectangle for the whole crate's tests. `restore`'s tests import it over
    /// the same shape rather than writing it a second time.
    pub(crate) fn display(x: f64, y: f64, width: f64, height: f64, id: Option<u64>) -> MonitorRect {
        MonitorRect {
            x,
            y,
            width,
            height,
            id,
        }
    }
    use super::*;
    use crate::restore::{centered_bottom_footprint, footprint_bounds};

    fn rect(x: f64, y: f64, width: f64, height: f64) -> MonitorRect {
        MonitorRect::without_id(x, y, width, height)
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

    /// The bug this deadline exists to prevent: the drop is reported once, the
    /// save is refused because the layout has not settled, and nothing ever asks
    /// again, so the position the user chose is lost rather than deferred.
    #[test]
    fn a_refused_save_reports_when_it_can_be_written() {
        let mut guard = SaveGuard::new();
        guard.drag_started();
        guard.layout_changed_during_drag(10.0);
        guard.drag_ended(10.2);
        assert!(!guard.allows_save(10.3));
        // The layout settle outlasts the drop's own window, so that is the
        // deadline: 1.5 s after the change, not 0.5 s after the drop.
        let due = guard.save_due_at(10.3).expect("the save is still owed");
        assert!((due - (10.0 + LAYOUT_SETTLE_SECONDS)).abs() < 1e-9);
        assert!(guard.allows_save(due), "the deadline is when it is allowed");
    }

    /// A new drag does not inherit the deadline of the gesture before it.
    ///
    /// End a drag at 0, start another at 10, and change the layout under it at
    /// 11. Without clearing the old drop time, `allows_save(13)` sees a drop
    /// "0.5 s ago" that belongs to a drag the user already finished, and writes
    /// the unfinished drag's position. The only drop that can satisfy the hold
    /// is this drag's own.
    #[test]
    fn a_new_drag_does_not_inherit_the_previous_drop_deadline() {
        let mut guard = SaveGuard::new();
        guard.drag_started();
        guard.drag_ended(0.0);
        guard.drag_started();
        guard.layout_changed_during_drag(11.0);
        assert!(
            !guard.allows_save(13.0),
            "an unfinished drag cannot be saved using the last gesture's drop time"
        );
        // Its own drop still enables the save, on the usual hold.
        guard.drag_ended(13.0);
        assert!(!guard.allows_save(13.1));
        assert!(guard.allows_save(13.0 + DRAG_HOLD_SECONDS));
    }

    /// A drop that lands after the settle has passed waits only for its own
    /// window, so the pill is not kept waiting for a settle that already passed.
    #[test]
    fn a_drop_after_the_settle_waits_only_for_the_drop_window() {
        let mut guard = SaveGuard::new();
        guard.drag_started();
        guard.layout_changed_during_drag(10.0);
        guard.drag_ended(10.0 + LAYOUT_SETTLE_SECONDS + 0.1);
        let now = 10.0 + LAYOUT_SETTLE_SECONDS + 0.2;
        assert!(!guard.allows_save(now));
        let due = guard.save_due_at(now).expect("the save is still owed");
        let expected = 10.0 + LAYOUT_SETTLE_SECONDS + 0.1 + DRAG_HOLD_SECONDS;
        assert!((due - expected).abs() < 1e-9);
        assert!(guard.allows_save(due));
    }

    /// No deadline when there is nothing left to write, so a caller cannot park a
    /// retry that would fire forever.
    #[test]
    fn there_is_no_deadline_when_no_save_is_owed() {
        let guard = SaveGuard::new();
        assert_eq!(guard.save_due_at(0.0), None, "nothing is being held");

        let mut interrupted = SaveGuard::new();
        interrupted.layout_changed_during_drag(10.0);
        assert_eq!(
            interrupted.save_due_at(10.1),
            None,
            "a drag that never ended has no frame to record"
        );
    }

    /// A clock that jumps backwards leaves a deadline that can never pass, so it
    /// must not be reported as one: the caller would drop the save waiting.
    #[test]
    fn a_deadline_from_a_broken_clock_is_not_reported() {
        let mut guard = SaveGuard::new();
        guard.layout_changed(10.0);
        assert_eq!(guard.save_due_at(f64::NAN), None);
        assert_eq!(guard.save_due_at(f64::INFINITY), None);
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
        assert_eq!(first, Anchor::LaunchAtCursor);
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
        assert!(!Anchor::Saved.follows_pointer());
    }

    /// A reset is due a placement even though the pill has already been placed
    /// once in this process. Reading "no saved position" as one state made a reset
    /// and a launch identical, and the pill the user asked to re-home stayed put.
    #[test]
    fn a_reset_is_due_a_placement_but_a_clear_is_not() {
        let at_cursor = Anchor::from_reset(true);
        assert_eq!(at_cursor, Anchor::ResetAtCursor);
        assert!(at_cursor.places());
        assert!(at_cursor.follows_pointer());

        let at_current = Anchor::from_reset(false);
        assert_eq!(at_current, Anchor::ResetAtCurrent);
        assert!(
            at_current.places(),
            "a reset to the current display still moves"
        );
        assert!(!at_current.follows_pointer());

        let cleared = Anchor::from_forget();
        assert_eq!(cleared, Anchor::Cleared);
        assert!(!cleared.places());
        assert!(!cleared.follows_pointer());
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

    // -- Layout polling ----------------------------------------------------

    /// The first signature is a baseline, never a change. Acting on it would
    /// treat the launch itself as a display change and move a pill that had just
    /// been restored to the position it was restored to.
    #[test]
    fn the_first_poll_only_records_a_baseline() {
        let (at, sig, outcome) = poll_layout(0.0, None, 10.0, 42);
        assert_eq!(outcome, PollOutcome::Baseline);
        assert_eq!(at, 10.0);
        assert_eq!(sig, Some(42));
    }

    #[test]
    fn a_repeat_inside_the_interval_reads_nothing() {
        // Polled at 10.0: 10.2 is too soon, and the stored values stand.
        let (at, sig, outcome) = poll_layout(10.0, Some(42), 10.2, 99);
        assert_eq!(outcome, PollOutcome::TooSoon);
        assert_eq!(at, 10.0, "a too-soon tick must not move the interval");
        assert_eq!(
            sig,
            Some(42),
            "a too-soon tick must not record a new signature"
        );
    }

    #[test]
    fn an_elapsed_interval_reports_a_change_only_when_the_arrangement_moved() {
        let (_, _, unchanged) = poll_layout(10.0, Some(42), 10.6, 42);
        assert_eq!(unchanged, PollOutcome::Unchanged);
        let (_, _, changed) = poll_layout(10.0, Some(42), 10.6, 43);
        assert_eq!(changed, PollOutcome::Changed);
    }

    /// A clock that ran backwards, or a non-finite sample, must not read as
    /// "enough time has passed": that would reconcile on every frame.
    #[test]
    fn a_backwards_or_non_finite_clock_reads_nothing() {
        for now in [f64::NAN, f64::INFINITY, 5.0] {
            let (at, _, outcome) = poll_layout(10.0, Some(42), now, 99);
            assert_eq!(outcome, PollOutcome::TooSoon, "now {now}");
            assert_eq!(at, 10.0);
        }
    }

    /// The reason the pair is one value: the caller cannot store half of it.
    /// Before this, each pill read two cells, called `poll_layout`, and wrote both
    /// back, and a caller that wrote one polled every frame without ever looking
    /// wrong.
    #[test]
    fn observing_stores_both_halves_every_time() {
        let mut poll = LayoutPoll::new();
        assert_eq!(poll.signature(), None);

        assert_eq!(poll.observe(10.0, 42), PollOutcome::Baseline);
        assert_eq!(poll.polled_at(), 10.0);
        assert_eq!(poll.signature(), Some(42));

        // Too soon: neither half moves, so the next real tick still has the
        // interval it thinks it has.
        assert_eq!(poll.observe(10.2, 99), PollOutcome::TooSoon);
        assert_eq!(poll.polled_at(), 10.0);
        assert_eq!(poll.signature(), Some(42));

        // A real change stores the new pair, which is what makes the following
        // tick compare against this arrangement rather than the launch one.
        assert_eq!(poll.observe(10.6, 43), PollOutcome::Changed);
        assert_eq!(poll.polled_at(), 10.6);
        assert_eq!(poll.signature(), Some(43));

        assert_eq!(poll.observe(11.2, 43), PollOutcome::Unchanged);
        assert_eq!(poll.signature(), Some(43));
    }

    /// A poll resumed from stored values must not re-baseline, or a restart would
    /// swallow the first change after it.
    #[test]
    fn a_resumed_poll_keeps_the_signature_it_was_given() {
        let mut poll = LayoutPoll::from_parts(10.0, Some(42));
        assert_eq!(poll.polled_at(), 10.0);
        assert_eq!(poll.signature(), Some(42));
        assert_eq!(
            poll.observe(10.6, 43),
            PollOutcome::Changed,
            "a resumed poll compared against the wrong arrangement"
        );
    }
}
