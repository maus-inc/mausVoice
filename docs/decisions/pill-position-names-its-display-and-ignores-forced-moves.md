# A saved pill position names its display and is never written from a frame the system moved

Date: 2026-11-10
Status: accepted

## Context

`pill-position-is-data-not-a-preference.md` made the pill's parked position a
stored record and resolved it against the connected displays at launch. That
covers the app not running. It does not cover the app running while the layout
changes, which is the common case: laptops dock and undock, external panels are
unplugged, resolution and scale change, and the taskbar moves.

Three defects came out of reviewing it against the code.

1. Nothing reacted to a display change. There was no `WM_DISPLAYCHANGE`,
   `WM_DPICHANGED` or `WM_SETTINGCHANGE` handler on Windows, no
   `didChangeScreenParameters` observer on macOS, and no arrangement watch on
   X11. A pill whose display went away stayed at an origin no display covered:
   running, listening, invisible, with nothing to grab. Its own save path then
   stored that stranded origin over the good one.
2. Display identity was a rectangle. A rectangle cannot identify a monitor: two
   identical panels share one, a resolution change moves the rect of a monitor
   that has not moved, and a replugged panel usually gets a new rect. So a pill
   saved on a panel that came back at a different resolution could restore onto a
   different panel that now covered the old rect.
3. Nothing distinguished a user's drop from the system's move. The operating
   system repositions and rescales pill windows during a display change, and the
   frame it leaves behind is indistinguishable from a drag. Saving it replaced
   the position the user chose with the one the system improvised, and the user's
   choice was then gone from every later launch.

## Decision

**The record names the display.** `ParkedWindow` carries a stable token beside the
display rect: the monitor device path on Windows (built from the EDID, so it
survives reconnects, reboots and port changes), the display UUID from
`CGDisplayCreateUUIDFromDisplayID` on macOS (`CGDirectDisplayID` is reused and
changes across reboots), and manufacturer plus model plus physical size from GDK
on X11. A display that cannot be named is recorded unnamed and matched by
geometry, which is what every build before this did.

Restore matches by token first, and a token match remaps within that display
rather than restoring the stored origin: the rect may have changed, so the origin
may no longer be on it. Geometry still decides when the token matches nothing, so
a connector that changes its name without the panel moving keeps its position.
`SCHEMA_VERSION` moved to 2 because a version 1 row cannot say which display it
meant, and reading it as a version 2 row with no token would silently reintroduce
the defect this fixes.

**A display change reconciles, and each platform has a different signal.** All
three handle their native event and all three also poll a hash of the arrangement
a few times a second. The event alone is not enough: a hidden Windows window
receives no `WM_DPICHANGED` for a live scale change, a macOS app that is not
frontmost can miss the notification, and an unmapped X11 window can miss a RandR
change. The poll cannot miss a change, only notice it late, which is the right
trade for a change that would otherwise strand the pill.

Reconciliation is `rust_pill_shared::layout::reconcile`, pure and tested without
a display. It keeps the window untouched when the whole visible pill is inside a
work area, because a no-op move is still a move and on Windows it costs a
position message that looks like a drag. It clamps when the pill pokes out of a
live display. It re-resolves against the stored record when no display contains
the pill any more, and it reports stranded with nothing connected, so the window
is left alone rather than moved to an origin that explains nothing.

**A save has to be the user's.** `layout::SaveGuard` refuses a save until the
layout has been steady for 1.5 s, and refuses it again for 0.5 s after a drag that
a layout change interrupted. A refused save writes nothing, which keeps the
position the user chose; overwriting it is the failure with no recovery. A pill
that reconciled its own position does store the result, because that move was the
pill's and it is the only place the pill can be: without it the next launch would
restore the stranded origin.

Rejected: matching on geometry alone and comparing a layout signature to decide
whether a display "is" the old one. Both fold a real distinction into a guess. A
panel that comes back at a new resolution and a different panel that fills the old
rect produce the same geometry, and the signature cannot tell them apart because
it is derived from geometry.

Rejected: storing the platform's display id. `CGDirectDisplayID` and
`HMONITOR` are session handles, and `MONITORINFOEXW.szDevice` is a slot name that
Windows reassigns when the arrangement changes. All three name a slot, not a
device, so a saved position would follow whichever panel next took that slot.

## Consequences

A dock and undock now leaves the pill where it was relative to the display that
survived, and a display that comes back at a new resolution is recognised. A
position captured during a burst of display events is dropped rather than stored,
so the worst case is one launch in the previous position instead of a permanently
lost one.

The cost is that a user who drags the pill within 1.5 s of a display change has
that drag dropped. That is deliberate, and the alternative is worse in a way the
user cannot see.

Two X11 limits are real rather than deferred: GDK 0.18 exposes no output name and
no EDID serial, so two panels of the same make and model share a token, and Wayland
still saves nothing because a layer-shell surface has no queryable absolute
position. Neither reintroduces a defect. A shared token remaps within the display
instead of restoring an exact origin, and geometry decides when tokens are
ambiguous; Wayland placement belongs to the compositor.
