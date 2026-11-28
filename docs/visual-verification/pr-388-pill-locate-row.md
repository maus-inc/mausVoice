# Pill-locate row visual verification record

## Result

The Appearance page is captured from two real trees at the same route, viewport, device
scale factor and harness state. Both seed the listener health `connected`, the state a
child reports between connecting and installing its hook, which is the classification
this change makes available.

Base `0f15abe` draws the Pill card with two rows, Dictation pill visibility and Reset
pill position. Head draws the same card with three, the new one in the middle, titled
"Show pill position with modifier double-tap" and set to Disabled.

Styling is unchanged on both sides. One thing moves, and it is the row itself: the Menu
bar and Celebrations cards sit 85.75px lower on head, the height the Pill card gained,
with their own size, width and styling untouched. Everything above the new row — the
sidebar, the page heading, the card title and its first row — keeps its exact
coordinates.

## Capture

- Base: `arena/0.1.6-consolidation` at `0f15abe5d4ff8b17685d931e70e46d35f9bbda58`,
  served from its own worktree on 5293. Head: this branch, served on 5193.
- Harness URL `/verify-harness/settings.html?page=appearance&theme=<dark|light>`, driven
  by `scripts/verify/cdp.mjs` with Chromium unpacked to `/tmp/chr`. The browser and the
  capture script live outside the repository.
- 1280×900 CSS pixels, device scale factor 2, `prefers-reduced-motion: reduce`. No overlay
  on this page, and the console reported no errors across the eight captures.
- The health seed is a capture-only edit in the throwaway base worktree and, on this
  side, a temporary edit reverted before the commit. No shipped harness value changed.

## Measurements

Read from the DOM at 1280×900, seed `connected`:

| Reading | Base | Head |
| --- | --- | --- |
| Element with that title | absent | present |
| Row title box | none | `x=577, y=294.23, w=446, h=23.25` |
| Neighbouring row labels | `x=577` | `x=577` |
| Menu bar card title | `y=402.98` | `y=488.73` |
| Celebrations card title | `y=566.73` | `y=652.48` |

## What was looked at

- Both full frames, dark. The row is present on head and absent on base; every other
  surface keeps its styling, and the two follow-on cards carry the offset above.
- Both frames at seed `healthy_grab`. The row is present on both under that seed, so the
  difference at `connected` comes from the classification rather than from the harness,
  the icon language or the capture.
- Both frames magnified 3× while inspecting. The glyph is a target mark at the same size
  as the monitor glyph below it, not clipped by its box; the title and description keep
  the neighbouring rows' ink spacing; the select sits where the other rows set it.
- The light frames on both sides. Same presence, same geometry, nothing scheme-specific.
- The upper-left of the card, where the glyph, the title edge and the first rule meet.
  Inserting a row between two existing rows does not move them.

## Frames

- Attached: `pr-388-appearance-pill-row.base.dark.png` and
  `pr-388-appearance-pill-row.head.dark.png`, full viewport, dark, seed `connected`.
- Captured and not committed: the light pair, inspected for the statement above; the 3×
  crops, used for the inspection above; and the two `healthy_grab` control frames. Both
  control frames are byte-identical to the attached head frame (`6c8de155…`), which is
  why one copy of those bytes is enough.

## Surfaces not captured

- The native Windows window. This sandbox has no Windows host, so the claim that the row
  appears there rests on the state machine and the tests rather than a screenshot. The
  frames show the same component with the state Windows reports.

## Manual flow

1. `pnpm --filter @maus-inc/preview dev`, then open
   `http://localhost:5193/verify-harness/settings.html?page=appearance&theme=dark`.
2. With the harness seed at `healthy_grab`, the Pill card lists three rows and the middle
   one is "Show pill position with modifier double-tap" with a Disabled select.
3. Set the seed to `connected` on this branch: the row is still there. Set it to
   `connected` on `0f15abe`: the row is gone, which is the defect this change fixes.
4. Repeat with `theme=light`.
