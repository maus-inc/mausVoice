# Pill-locate row visual verification record

## Result

The Appearance page is captured from two real trees at one route, viewport, device scale
factor and harness state, both seeded with the listener health `connected` — the state a
child reports between connecting and installing its hook, which is the classification this
change makes available. Base `0f15abe` draws the Pill card with two rows; head draws the
same card with three, the new one in the middle, titled "Show pill position with modifier
double-tap" and set to Disabled.

Styling is unchanged on both sides. One thing moves and it is the row itself: the Menu bar
and Celebrations cards sit 85.75px lower on head, the height the Pill card gained, with
their own size, width and styling untouched. Everything above the new row, and the first
row itself, keeps its exact coordinates.

Captured from `0f15abe` served on 5293 and this branch on 5193, at
`/verify-harness/settings.html?page=appearance&theme=<dark|light>`, 1280×900 CSS pixels,
device scale factor 2, `prefers-reduced-motion: reduce`, driven by `scripts/verify/cdp.mjs`
with Chromium outside the tree. No overlay on the page, and no console errors in any
capture. The health seed is a capture-only edit, reverted on this side before the commit.

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

- Both full frames, dark: the row on head, its absence on base, every other surface
  unchanged in styling.
- Both frames at seed `healthy_grab`: the row is present on both, so the difference at
  `connected` comes from the classification, not the harness, the icon language or the
  capture.
- Both frames at 3× while inspecting: the glyph is a target mark at the monitor glyph's
  size, not clipped; title and description keep the neighbours' ink spacing; the select
  sits where the other rows set it.
- The light frames on both sides: same presence, same geometry, nothing scheme-specific.
- The card's upper-left, where glyph, title edge and first rule meet: a row inserted
  between two existing rows does not move them.

## Frames

- Attached: `pr-388-appearance-pill-row.base.dark.png` and `...head.dark.png`, full
  viewport, dark, seed `connected`.
- Captured, inspected and not committed: the light pair, the 3× crops and the two
  `healthy_grab` control frames. Both control frames are byte-identical to the attached
  head frame (`6c8de155…`), so one copy of those bytes is all the control needs.

## Not captured

- The native Windows window: no Windows host in this sandbox, so the claim that the row
  appears there rests on the state machine and the tests. The frames show the same
  component with the state Windows reports.

## Manual flow

1. `pnpm --filter @maus-inc/preview dev`, open
   `http://localhost:5193/verify-harness/settings.html?page=appearance&theme=dark`.
2. At seed `healthy_grab` the Pill card lists three rows, the middle one this row with a
   Disabled select. At seed `connected` this branch keeps it and `0f15abe` drops it.
3. Repeat with `theme=light`.
