# Interactivity Reference

## Contents
- [Cursor](#cursor)
- [Pointer Events](#pointer-events)
- [User Select](#user-select)
- [Touch Action](#touch-action)
- [Scroll Behavior](#scroll-behavior)
- [Scroll Snap](#scroll-snap)
- [Scroll Margin & Padding](#scroll-margin--padding)
- [Resize](#resize)
- [Caret Color](#caret-color)
- [Accent Color](#accent-color)
- [Appearance](#appearance)
- [Field Sizing](#field-sizing)

---

## Cursor

Standard cursors:
- `cursor-auto`, `cursor-default`, `cursor-pointer`, `cursor-wait`
- `cursor-text`, `cursor-move`, `cursor-help`, `cursor-not-allowed`
- `cursor-none`, `cursor-context-menu`, `cursor-progress`, `cursor-cell`
- `cursor-crosshair`, `cursor-vertical-text`, `cursor-alias`, `cursor-copy`
- `cursor-no-drop`, `cursor-grab`, `cursor-grabbing`, `cursor-all-scroll`

Resize cursors:
- `cursor-col-resize`, `cursor-row-resize`
- `cursor-n-resize`, `cursor-e-resize`, `cursor-s-resize`, `cursor-w-resize`
- `cursor-ne-resize`, `cursor-nw-resize`, `cursor-se-resize`, `cursor-sw-resize`
- `cursor-ew-resize`, `cursor-ns-resize`, `cursor-nesw-resize`, `cursor-nwse-resize`

Zoom: `cursor-zoom-in`, `cursor-zoom-out`

Arbitrary: `cursor-[url(hand.cur),_pointer]`

---

## Pointer Events

- `pointer-events-auto` - responds to pointer events (default)
- `pointer-events-none` - ignores pointer events (pass through)

Useful for making overlaid icons non-interactive.

---

## User Select

- `select-none` - prevents text selection
- `select-text` - allows text selection
- `select-all` - selects all on single click
- `select-auto` - default browser behavior

---

## Touch Action

- `touch-auto` - default
- `touch-none` - disables panning and zooming
- `touch-pan-x`, `touch-pan-left`, `touch-pan-right` - horizontal pan only
- `touch-pan-y`, `touch-pan-up`, `touch-pan-down` - vertical pan only
- `touch-pinch-zoom` - zoom only
- `touch-manipulation` - pan + zoom, no double-tap zoom

---

## Scroll Behavior

- `scroll-auto` - instant scrolling (default)
- `scroll-smooth` - smooth scrolling

Affects browser-triggered scrolling (navigation fragments, `scrollIntoView()`).

---

## Scroll Snap

**Container (snap type)**:
- `snap-none` - no snapping
- `snap-x` - horizontal snapping
- `snap-y` - vertical snapping
- `snap-both` - both axes

**Strictness**:
- `snap-mandatory` - forces rest on snap point
- `snap-proximity` - rest on snap point if close

**Child alignment (snap align)**:
- `snap-start` - align start edge
- `snap-end` - align end edge
- `snap-center` - align center
- `snap-align-none` - no alignment

**Stop behavior**:
- `snap-normal` - can skip snap points
- `snap-always` - stops at each snap point

---

## Scroll Margin & Padding

**Scroll Margin** (outset from scrollport for snapping):
- `scroll-m-<number>` - all sides
- `scroll-mt-<number>`, `scroll-mr-<number>`, `scroll-mb-<number>`, `scroll-ml-<number>` - single side
- `scroll-mx-<number>`, `scroll-my-<number>` - axes
- `scroll-ms-<number>`, `scroll-me-<number>` - logical
- Negative: `-scroll-m-<number>`, etc.

**Scroll Padding** (inset from scrollport for snapping):
- `scroll-p-<number>` - all sides
- `scroll-pt-<number>`, `scroll-pr-<number>`, `scroll-pb-<number>`, `scroll-pl-<number>` - single side
- `scroll-px-<number>`, `scroll-py-<number>` - axes
- `scroll-ps-<number>`, `scroll-pe-<number>` - logical
- Negative: `-scroll-p-<number>`, etc.

Arbitrary: `scroll-ml-[24rem]`

---

## Resize

- `resize-none` - cannot be resized
- `resize` - both directions
- `resize-y` - vertical only
- `resize-x` - horizontal only

Common on `<textarea>`.

---

## Caret Color

- `caret-{color}`: `caret-pink-500`
- `caret-inherit`, `caret-current`, `caret-transparent`
- Arbitrary: `caret-[#50d71e]`

---

## Accent Color

Styles native form controls (checkboxes, radio buttons, range, progress):

- `accent-{color}`: `accent-pink-500`
- `accent-inherit`, `accent-current`, `accent-transparent`
- With opacity: `accent-purple-500/75` (Firefox only)
- Arbitrary: `accent-[#50d71e]`

---

## Appearance

- `appearance-none` - removes browser styling (for custom form controls)
- `appearance-auto` - restores default styling

---

## Field Sizing

- `field-sizing-fixed` - form control uses fixed size (default)
- `field-sizing-content` - size adjusts to content

Useful for auto-growing `<textarea>` and `<input>`.
