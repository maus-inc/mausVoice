# Pill-locate row visual verification record

## Result

The Appearance settings page is captured from two real trees at the same route, viewport, device scale factor and harness state. The base frame shows the Pill card with two rows, Dictation pill visibility and Reset pill position. The head frame shows the same card with three rows, the new one between them, titled "Show pill position with modifier double-tap" and set to Disabled. Nothing else moved: the sidebar, the page heading, the Menu bar card and the Celebrations card are identical in both frames.

The row reads correctly in dark and in light. Its leading glyph sits in the same gutter as the other rows, its title starts on the same label column, and the select is the shipped control with the shipped copy. The pixels did not ask for a code change.

## Source and capture method

- Base frame: `arena/0.1.6-consolidation` at `0f15abe5d4ff8b17685d931e70e46d35f9bbda58`, served from its own worktree on port 5293. Its harness seeds the listener strategy without a health value, so the row is correctly out of reach there.
- Head frame: the branch head of this pull request, served on port 5193. The harness seeds `healthy_grab` after this change, which is the steady state of a listener that is delivering.
- Both trees ran their own `@maus-inc/preview` dev server. The harness URL was `/verify-harness/settings.html?page=appearance&theme=<dark|light>`, driven by `scripts/verify/cdp.mjs` and Chromium 153.0.8010.0 unpacked by `scripts/verify/install-chromium.mjs` into `/tmp/chr`. The browser, the capture script and the frames outside `docs/assets/visual-verification/` all live outside the repository.
- One viewport per claim: 1280×900 CSS pixels, device scale factor 2, `prefers-reduced-motion: reduce` emulated. No overlay is present on this page, and the console reported no errors in any of the four captures.
- The 3× crops use the same viewport and a fixed clip of `x=520, y=250, w=740, h=140`, so the pair can be read side by side.

## Measurements

Read from the DOM at 1280×900 with the row in place, and from the bounding boxes the harness exposes:

| Reading | Value |
| --- | --- |
| Row title box | `x=577, y=294.23, w=446, h=23.25` |
| Row label block | `x=577, y=294.23, w=446, h=65.75` |
| Neighbouring row labels | `x=577` (identical column) |
| Card left edge | `x=520` |
| Gutter from card edge to glyph | 57px to the label column, matching every other row |

In the base frame the same probe finds no element with that title, which is the before side of the claim.

## What was looked at

- Both full frames, dark. The row is present on head and absent on base, and no other surface differs.
- Both 3× crops, dark. The glyph is a target mark, drawn at the same size as the monitor glyph below it, not clipped by its box. The title and the two-line description keep the same 4 to 6px ink spacing as the neighbouring rows. The select is 20px above the description's first baseline, as the other rows set it.
- The light frame on head, inspected with the same attention. The card background, the rule, the glyph and the select all read correctly in light; nothing about this change is scheme-specific, so no light frame is attached.
- The upper-left of the card, where the glyph, the title edge and the first rule meet. Inserting a row does not move them, because the incoming row lands between two existing rows rather than above the first.
- The dialog round trip is not part of this surface. No control on the row opens one.

## Frames attached

- `pr-388-appearance-pill-row.base.dark.png` and `pr-388-appearance-pill-row.head.dark.png`, full viewport, dark.
- `pr-388-appearance-pill-row.base.dark.crop3x.png` and `pr-388-appearance-pill-row.head.dark.crop3x.png`, the same region at 3×.

## Frames looked at and not attached

- The light frames at the same viewport for both trees. They confirm the same presence and the same geometry, and add nothing a reviewer cannot read from the dark pair.

## Surfaces not captured

- The native Windows window. This sandbox has no Windows host, so the claim that the row appears there rests on the state machine and the tests rather than on a screenshot. The frame shows the same component with the state Windows reports.

## Manual visual-check flow

1. `pnpm --filter @maus-inc/preview dev`, then open `http://localhost:5193/verify-harness/settings.html?page=appearance&theme=dark`.
2. The Pill card lists three rows. The middle one is "Show pill position with modifier double-tap" with a Disabled select.
3. Revert `apps/preview/verify-harness/settings.tsx` to the base seed and reload: the middle row is gone, which is the defect this change fixes.
4. Repeat with `theme=light`.
