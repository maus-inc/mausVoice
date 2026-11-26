# The document never scrolls, and every route owns the scroll its content needs

Date: 2026-11-26
Status: accepted

## Context

Issue #366 reported a second scrollbar on the outer edge of the main window that
appeared on most dashboard routes. The shell already sized itself to the viewport and
hid its overflow, so the chain looked correct and the scrollbar was blamed on the
window box.

The leak was an absolutely positioned element with no offsets. Five such boxes existed,
three of them through `visuallyHidden` and two as inline copies in the heatmap. A clipped
1px box keeps its static position. Portalled to the body, that position sits at the end
of the body's flow, one pixel past the viewport, so the document measured 801 against
800 and the browser painted a scrollbar. Inside a scrolled pane the same box lands past
the pane's bottom while its containing block is still the initial one, so neither the
pane nor the shell clips it. The activity heatmap's hidden list reproduced the document
scrollbar that way at any height below its own position in the page.

Two facts made the fix a decision rather than a patch. A viewport unit is sized as if no
scrollbar exists, so `100vw` on the window box overflows the moment one appears
(css-values-4, "the viewport-percentage lengths are sized assuming that scrollbars do
not exist"). And a shell that hides its overflow only hides what it can reach, because a
descendant whose containing block sits above the shell escapes that clip entirely.

## Decision

The document is a passive canvas. `html` and `body` carry `overflow: hidden` plus
`overscroll-behavior: none` in `MuiCssBaseline`, so no stray child can open a window
scrollbar, and page-level rubber banding cannot move the window under the fixed title
bar.

`AppViewport` is the one viewport-sized box. It takes `height: 100%` and `width: 100%`
from the baseline chain rather than `100dvh` and `100vw`, and it hides its own overflow.
Both entry points render it, the desktop shell and the browser preview.

Every route then owns the scroll its content needs. The dashboard rail, the dashboard
content pane, `PageLayout`'s body, the settings rail, the chat transcript and the
composer shell all keep `overflow-y: auto` on a box that is already constrained. A route
that overflows its window without such a box is a defect in that route, not a reason to
re-enable the document scroller.

Hidden content is pinned. `visuallyHidden` in `styles/a11y.ts` sets `top: 0` and
`left: 0` in addition to clipping to a pixel, and `ActivityHeatmap` imports it instead of
carrying its own copy. A new sighted-silent region imports the helper rather than
copying the declaration set, because the copy is where the offsets went missing.

## Consequences

The window can no longer be scrolled as a whole, which means a route that forgets its
scroll owner clips its content instead of growing a page-level scrollbar. That is the
trade the issue asked for: a visible defect on one route instead of a second scrollbar
everywhere, and the composer's previous clipping became reachable through its own shell
in the same change.

The generated specs under `apps/preview/specs` needed nothing, because the shell is a
property of the entry point rather than of a component's surface. The preview app needed one change of its own,
`100vh` to `100%` on its shell and rail, since the baseline now clips the document there
too.

Two things stay out of reach. A classic scrollbar cannot be measured in the headless
Chromium this repository ships, so the `100vw` half of the reasoning rests on the spec
text and on a synthetic gutter page rather than on a captured frame. And a route that
hides content at a window size below the product minimum (800x600) is invisible to the
user, so the acceptance sweep runs at that minimum and below it only to prove the
mechanism.
