# Reserve room inside the heatmap scrollport instead of wrapping the plot

Date: 2026-11-26
Status: accepted

## Context

Issue #363 reports that a hovered cell in the Home activity heatmap is cut off
along the box that scrolls the year. The cell grows with `transform:
scale(1.35)` and draws a 1px ring at a 1px offset on the same element.

The viewport asked for `overflow-x: auto` only. A box that scrolls on one axis
cannot leave the other axis visible, so the browser computed the cross axis to
`auto` and the same box clipped the top and bottom rows. Its leading edges held
2px of room and its bottom edge 4px, less than the grown cell and its ring need.

Two things about the arithmetic only the browser settled.

First, the ring scales with the cell. `transform` is applied after layout, so
the 2px ring inset becomes 2.7px at scale 1.35, and the whole treatment reaches
4.45px past the resting cell edge. A reserve of 4px left the ring exactly on
the clip boundary, shaving a painted pixel on all four edges. Both review bots
found this independently.

Second, the fix does not depend on `overflow-y: clip` being supported. Forcing
that property to compute as `auto`, the fallback an engine without `clip`
support gives it, kept every edge clear, while removing the padding broke the
top edge. The reserved room carries the fix and the keyword only names the
clip.

## Decision

Keep one box that scrolls and clips, and reserve the room a grown cell needs
inside it. `activityHeatmapGeometry` derives the reach from the cell size, the
hover scale and the scaled ring inset together, so a retune moves the padding
with the treatment, and both the viewport and the weekday rail read that one
export. The rail carries the same top offset so its labels stay level with the
rows.

Rejected: a wrapper around the plot for the cross-axis clip. It adds a box
without changing a measured outcome, because the clearance comes from the
reserved padding rather than from the overflow keyword, and it would put a
second clip on the path where a later change could silently undo the room.

## Consequences

The viewport is the only box that clips the rows, and the component test
asserts that no descendant of it clips the cross axis. That guard exists
because jsdom has no box model: it can read the computed overflow of each
element but not tell whether one of them clips a painted ring, so the painted
proof stays in a real browser.

Measure and reason from paint, not from layout, for anything a `transform`
grows. `getBoundingClientRect` reports the scaled box, so it understates the
ring, and the clearing distance has to be read from a screenshot differenced
against the resting state rather than from the element rect.

The test derives its expected clearance from the same geometry values the
component renders with. A literal cell size or scale in the test would let the
padding drift away from the treatment it exists to protect.
