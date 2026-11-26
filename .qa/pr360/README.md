# Issue 360 replacement-arrow measurements

Captured 2026-11-26 from `arena/5f0ee725-mausvoice` (base `arena/0.1.6-consolidation`
at `5749ebe`) in Chromium 153.0.8010.0 against the desktop browser preview with
populated preview data, reduced motion, at `http://127.0.0.1:5195/dashboard/dictionary`.

`before` is the base tree with the two files reverted; `after` is the branch. Both
runs used the same browser, machine, viewport and states, so the two columns
differ only by the change.

## Method

`scripts/verify/install-chromium.mjs` unpacked the browser from
`@sparticuz/chromium`; `scripts/verify/cdp.mjs` drove it over the DevTools
protocol. The theme was set through `localStorage["mui-mode"]` and a reload. Each
state was measured with `getBoundingClientRect` and the fields' own resolved
`line-height` and padding, because the arrow's position relative to the _text_
is the thing under review:

- source line centre = input border box top + `padding-top` + `line-height / 2`
- replacement line centre = same, first line of the textarea
- arrow centre = glyph border box top + `height / 2`

Rows were scrolled to the middle of the viewport before capture. Every value is
recorded in [measurements.json](measurements.json), which also records the row
box, both field border boxes, the gaps, `scrollWidth`/`clientWidth`, the computed
arrow colour and any page errors.

## States

| State                 | How it was produced                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| `clean`               | the preview's own `mouse voice → mausVoice` replacement row                                                     |
| `empty-source`        | the original field cleared with a native value setter and an `input` event, so the required-text helper appears |
| `empty-both`          | both fields cleared, so both helpers appear                                                                     |
| `wrapped-destination` | a 110-character replacement typed into the textarea, which grows to ten lines                                   |
| `narrow`              | a fresh load, then `Emulation.setDeviceMetricsOverride` to 400×300 without a reload                             |

## Result

Arrow centre minus the centre of each field's first text line, in CSS pixels.
Negative is too high.

| Tree     | Theme | Viewport | State               | vs original line | vs replacement line | Helper texts |
| -------- | ----- | -------- | ------------------- | ---------------- | ------------------- | ------------ |
| `before` | light | 1200x800 | clean               | -11.28           | -11.75              | 0            |
| `before` | light | 1200x800 | empty-source        | -11.28           | -11.75              | 1            |
| `before` | light | 1200x800 | empty-both          | -11.28           | -11.75              | 2            |
| `before` | light | 1200x800 | wrapped-destination | -11.28           | -11.75              | 1            |
| `before` | light | 1200x800 | narrow              | -11.28           | -11.75              | 0            |
| `after`  | light | 1200x800 | clean               | +0.72            | +0.25               | 0            |
| `after`  | light | 1200x800 | empty-source        | +0.72            | +0.25               | 1            |
| `after`  | light | 1200x800 | empty-both          | +0.72            | +0.25               | 2            |
| `after`  | light | 1200x800 | wrapped-destination | +0.72            | +0.25               | 1            |
| `after`  | light | 1200x800 | narrow              | +0.72            | +0.25               | 0            |
| `after`  | dark  | 1200x800 | clean               | +0.72            | +0.25               | 0            |
| `after`  | dark  | 1200x800 | empty-source        | +0.72            | +0.25               | 1            |
| `after`  | dark  | 1200x800 | empty-both          | +0.72            | +0.25               | 2            |
| `after`  | dark  | 1200x800 | wrapped-destination | +0.72            | +0.25               | 1            |
| `after`  | dark  | 1200x800 | narrow              | +0.72            | +0.25               | 0            |
| `after`  | light | 400x600  | clean               | +0.72            | +0.25               | 0            |
| `after`  | light | 400x600  | empty-source        | +0.72            | +0.25               | 1            |
| `after`  | light | 400x600  | empty-both          | +0.72            | +0.25               | 2            |
| `after`  | light | 400x600  | wrapped-destination | +0.72            | +0.25               | 1            |
| `after`  | light | 400x600  | narrow              | +0.72            | +0.25               | 0            |
| `after`  | dark  | 400x600  | clean               | +0.72            | +0.25               | 0            |
| `after`  | dark  | 400x600  | empty-source        | +0.72            | +0.25               | 1            |
| `after`  | dark  | 400x600  | empty-both          | +0.72            | +0.25               | 2            |
| `after`  | dark  | 400x600  | wrapped-destination | +0.72            | +0.25               | 1            |
| `after`  | dark  | 400x600  | narrow              | +0.72            | +0.25               | 0            |

The base tree put the glyph's top edge exactly on the fields' top edge
(292.28 for a row at 284.28 with `py: 1`), so the glyph's centre sat 11.28 and
11.75 px above the two text lines — the arrow hung off the control's top padding
edge, a little over half a line box above the text it points from. The row's
`& > svg { mt: "12px" }` never reached the browser, because Material UI's Stack
sets `margin: 0` on every direct child with higher specificity (`0,1,2` against
the row's `0,1,1`).

After the change the glyph's centre is within 0.72 px of both lines in every
state, theme and viewport, and the 40 px box moves neither when a helper text
appears nor when the replacement wraps to ten lines.

## Horizontal placement

The gap is measured to each field's _border_ box, not to the text box inside it.
Unchanged by the change:

| Viewport | Field widths | Gap left | Gap right | Row width |
| -------- | ------------ | -------- | --------- | --------- |
| 1200×800 | 231 / 231    | 16       | 16        | 552       |
| 400×600  | 131 / 131    | 16       | 16        | 352       |

`scrollWidth` equalled `clientWidth` on the row in every state, so no capture
shows a squeezed or clipped row.

## Files

Every state has two captures, named
`<tree>-<theme>-<viewport>-<state>.jpg` for the whole viewport and
`...-<state>-row.jpg` for a 2× crop of the replacement row, so the crop is the
one to open when checking the alignment. `before` was captured at 1200×800 in
light only; `after` at 1200×800 and 400×600 in both themes. Compare
`before-light-1200x800-clean-row.jpg` with `after-light-1200x800-clean-row.jpg`
first.

## Limitations

- This measures the browser preview in headless Chromium, not the native
  macOS or Windows WebView. Font rendering, subpixel rounding and device pixel
  ratio can differ there by a fraction of a pixel.
- The glyph box and both control boxes are exact; the text line centre is
  derived from the resolved `line-height` and padding, not from an ink bounding
  box, because a text range inside an `<input>` cannot be measured.
- Only English and the `light`/`dark` modes were captured; no screen-reader,
  keyboard, IME, or right-to-left check was attempted, and none of those is
  affected by a layout box.
