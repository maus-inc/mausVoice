# Pill-locate row visual verification record

## Result

The Appearance settings page is captured from two real trees at the same route, viewport, device scale factor and harness state. The harness health seed is the same on both sides, `connected`, which is the state a listener reports between the child connecting and its hook installing. The base frame shows the Pill card with two rows, Dictation pill visibility and Reset pill position. The head frame shows the same card with three rows, the new one between them, titled "Show pill position with modifier double-tap" and set to Disabled. Nothing above the new row moves: the sidebar, the page heading, the Pill card's title and its first row sit at the same coordinates in both frames. Styling is unchanged everywhere. The two cards below the Pill card are the exception to "unmoved": they keep their size, width and styling but sit 85.75px lower on head, because the Pill card grew by the height of the incoming row and everything below it follows. That offset is the row, not a layout change.

A control pair with the health seed set to `healthy_grab` shows the row on both revisions, so the difference above comes from the classification change and not from the harness, the icon language or the capture.

The row reads correctly in dark and in light. Its leading glyph sits in the same gutter as the other rows, its title starts on the same label column, and the select is the shipped control with the shipped copy. The pixels did not ask for a code change.

## Source and capture method

- Base frame: `arena/0.1.6-consolidation` at `0f15abe5d4ff8b17685d931e70e46d35f9bbda58`, served from its own worktree on port 5293.
- Head frame: the branch head of this pull request, served on port 5193.
- Both trees ran their own `@maus-inc/preview` dev server. The harness URL was `/verify-harness/settings.html?page=appearance&theme=<dark|light>`, driven by `scripts/verify/cdp.mjs` and Chromium 153.0.8010.0 unpacked by `scripts/verify/install-chromium.mjs` into `/tmp/chr`. The browser, the capture script and every frame outside `docs/assets/visual-verification/` live outside the repository.
- The health seed was set to `connected` in both worktrees for the comparison pair, and to `healthy_grab` in both for the control. This is a capture-only edit to the harness in the throwaway base worktree and, on the head side, a temporary edit that was reverted before the commit; no shipped harness value changed for the capture.
- One viewport per claim: 1280×900 CSS pixels, device scale factor 2, `prefers-reduced-motion: reduce` emulated. No overlay is present on this page, and the console reported no errors in any of the eight captures.
- The 3× crops use the same viewport and a fixed clip of `x=520, y=250, w=740, h=140`, so the pair can be read side by side.

## Measurements

Read from the DOM at 1280×900:

| Reading | Base, seed `connected` | Head, seed `connected` |
| --- | --- | --- |
| Element with that title | absent | present |
| Row title box | none | `x=577, y=294.23, w=446, h=23.25` |
| Row label block | none | `x=577, y=294.23, w=446, h=65.75` |
| Neighbouring row labels | `x=577` | `x=577` |
| Card left edge | `x=520` | `x=520` |
| Menu bar card title | `y=402.98` | `y=488.73` |
| Celebrations card title | `y=566.73` | `y=652.48` |
| Pages above the new row (`Pill` title) | `y=133.23` | `y=133.23` |

With the control seed, both revisions report the same title box at `x=577, y=294.23`, which is the before side of the row's geometry and the after side of the control. Under that seed both trees render the same three-row card, so the two follow-on cards sit at the same height on both sides; the 85.75px offset above appears only in the comparison pair, where head adds the row.

## What was looked at

- Both full frames, dark, at the comparison seed. The row is present on head and absent on base. Every other surface is identical in styling; the Menu bar and Celebrations cards sit 85.75px lower on head, which is the height the Pill card gained.
- Both full frames at the control seed. The row is present on both and sits in the same place, so the pair isolates the classification change.
- Both 3× crops, dark. The glyph is a target mark, drawn at the same size as the monitor glyph below it, not clipped by its box. The title and the two-line description keep the same 4 to 6px ink spacing as the neighbouring rows. The select sits 20px above the description's first baseline, as the other rows set it.
- The light frames on both sides, inspected with the same attention. Same presence, same geometry, nothing scheme-specific, so no light frame is attached.
- The upper-left of the card, where the glyph, the title edge and the first rule meet. Inserting a row does not move them, because the incoming row lands between two existing rows rather than above the first.
- The dialog round trip is not part of this surface. No control on the row opens one.

## Frames attached

- `pr-388-appearance-pill-row.base.dark.png` and `pr-388-appearance-pill-row.head.dark.png`, full viewport, dark, seed `connected`.
- `pr-388-appearance-pill-row.base.dark.crop3x.png` and `pr-388-appearance-pill-row.head.dark.crop3x.png`, the same region at 3×.
- `pr-388-appearance-pill-row.control-base.dark.png` and `pr-388-appearance-pill-row.control-head.dark.png`, the control pair at seed `healthy_grab`.

## Frames looked at and not attached

- The light frames at the same viewport for both trees. They confirm the same presence and geometry and add nothing a reviewer cannot read from the dark pair.

## Surfaces not captured

- The native Windows window. This sandbox has no Windows host, so the claim that the row appears there rests on the state machine and the tests rather than a screenshot. The frames show the same component with the state Windows reports.

## Manual visual-check flow

1. `pnpm --filter @maus-inc/preview dev`, then open `http://localhost:5193/verify-harness/settings.html?page=appearance&theme=dark`.
2. With the harness seed at `healthy_grab`, the Pill card lists three rows and the middle one is "Show pill position with modifier double-tap" with a Disabled select.
3. Set the seed to `connected` on this branch: the row is still there.
4. Set the seed to `connected` on `0f15abe`: the row is gone, which is the defect this change fixes.
5. Repeat with `theme=light`.
