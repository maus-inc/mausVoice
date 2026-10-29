# Layout Utilities Reference

## Contents
- [Display](#display)
- [Position](#position)
- [Inset (Top/Right/Bottom/Left)](#inset)
- [Visibility](#visibility)
- [Z-Index](#z-index)
- [Float & Clear](#float--clear)
- [Columns](#columns)
- [Aspect Ratio](#aspect-ratio)
- [Object Fit & Position](#object-fit--position)
- [Overflow](#overflow)
- [Overscroll Behavior](#overscroll-behavior)
- [Box Sizing & Decoration Break](#box-sizing--decoration-break)
- [Isolation](#isolation)

---

## Display

Basic: `block`, `inline-block`, `inline`, `flow-root`

Flex: `flex`, `inline-flex`

Grid: `grid`, `inline-grid`

Table: `table`, `inline-table`, `table-caption`, `table-cell`, `table-column`, `table-column-group`, `table-footer-group`, `table-header-group`, `table-row-group`, `table-row`

Special:
- `contents` - element ignored, children become direct children of parent
- `hidden` - removes from layout (`display: none`)
- `sr-only` - visually hidden but accessible to screen readers
- `not-sr-only` - undoes `sr-only`
- `list-item`

Responsive: `md:flex`, `lg:grid`

---

## Position

- `static` - default, normal flow
- `relative` - positioned relative to normal flow, creates stacking context
- `absolute` - positioned relative to nearest non-static ancestor
- `fixed` - positioned relative to viewport
- `sticky` - relative until threshold, then fixed

Responsive: `md:absolute`

---

## Inset

All sides: `inset-<number>`, `inset-x-<number>`, `inset-y-<number>`

Single sides: `top-<number>`, `right-<number>`, `bottom-<number>`, `left-<number>`

Logical properties:
- `start-<number>` - left in LTR, right in RTL
- `end-<number>` - right in LTR, left in RTL

Values: `<number>` (spacing scale), `<fraction>` (percentage), `px`, `full`, `auto`

Negative: `-top-4`, `-inset-x-full`

Arbitrary: `top-[3px]`, `inset-(--my-offset)`

---

## Visibility

- `visible` - element is visible
- `invisible` - hidden but still affects layout
- `collapse` - hides table rows/columns while preserving layout

---

## Z-Index

`z-<number>`: Sets `z-index`. Example: `z-10`, `z-50`
`-z-<number>`: Negative z-index
`z-auto`: `z-index: auto`

Arbitrary: `z-[100]`

---

## Float & Clear

Float: `float-right`, `float-left`, `float-start`, `float-end`, `float-none`

Clear: `clear-left`, `clear-right`, `clear-both`, `clear-start`, `clear-end`, `clear-none`

---

## Columns

- `columns-<number>` - fixed column count: `columns-3`
- `columns-{size}` - ideal column width: `columns-sm` (24rem)
  - Sizes: `3xs` (16rem) to `7xl` (80rem)
- `columns-auto`
- `columns-[<value>]`: `columns-[30vw]`

Use `gap-*` for spacing between columns.

---

## Aspect Ratio

- `aspect-<ratio>` - ratio format W/H: `aspect-3/2`
- `aspect-square` - 1:1
- `aspect-video` - 16:9
- `aspect-auto`
- `aspect-[<value>]`: `aspect-[calc(4*3+1)/3]`

---

## Object Fit & Position

**Fit** (for `<img>`, `<video>`):
- `object-contain` - fit within container
- `object-cover` - cover container, crop if needed
- `object-fill` - stretch to fit
- `object-none` - original size
- `object-scale-down` - smaller of contain or none

**Position**:
- `object-{position}`: `top-left`, `top`, `top-right`, `left`, `center`, `right`, `bottom-left`, `bottom`, `bottom-right`
- `object-[<value>]`: `object-[25%_75%]`

---

## Overflow

All sides: `overflow-auto`, `overflow-hidden`, `overflow-clip`, `overflow-visible`, `overflow-scroll`

Per axis: `overflow-x-auto`, `overflow-y-scroll`

---

## Overscroll Behavior

- `overscroll-auto` - default, allows parent scrolling
- `overscroll-contain` - prevents parent scrolling but allows bounce
- `overscroll-none` - prevents parent scrolling and bounce

Per axis: `overscroll-x-contain`, `overscroll-y-none`

---

## Box Sizing & Decoration Break

**Box Sizing**:
- `box-border` - includes border/padding in dimensions (default in Preflight)
- `box-content` - border/padding added to dimensions

**Box Decoration Break**:
- `box-decoration-clone` - fragments render as distinct blocks
- `box-decoration-slice` - fragments render as one continuous element

---

## Isolation

- `isolate` - creates new stacking context
- `isolation-auto` - default behavior

Use `isolate` to prevent blending with backdrop elements when using `mix-blend-mode`.
