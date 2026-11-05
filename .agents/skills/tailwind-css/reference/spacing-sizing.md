# Spacing & Sizing Reference

## Contents
- [Padding](#padding)
- [Margin](#margin)
- [Space Between](#space-between)
- [Width](#width)
- [Height](#height)
- [Size (Width + Height)](#size)
- [Min/Max Width](#minmax-width)
- [Min/Max Height](#minmax-height)

---

## Padding

All sides: `p-<number>` (`p-4`, `p-8`)

Single sides:
- `pt-<number>` - top
- `pr-<number>` - right
- `pb-<number>` - bottom
- `pl-<number>` - left

Axes:
- `px-<number>` - horizontal (left + right)
- `py-<number>` - vertical (top + bottom)

Logical (RTL-aware):
- `ps-<number>` - start (left in LTR)
- `pe-<number>` - end (right in LTR)

Special values:
- `p-px` - 1px
- `p-0` - no padding

Arbitrary: `pb-[5px]`, `px-(--my-padding)`

---

## Margin

All sides: `m-<number>` (`m-4`, `m-8`)

Single sides: `mt-<number>`, `mr-<number>`, `mb-<number>`, `ml-<number>`

Axes: `mx-<number>`, `my-<number>`

Logical: `ms-<number>`, `me-<number>`

Special values:
- `m-px` - 1px
- `m-auto` - auto margin
- `-m-<number>` - negative margin

Centering: `mx-auto` centers horizontally

Arbitrary: `mb-[5px]`, `mx-(--my-margin)`

---

## Space Between

Adds margin between child elements (not on first/last):

- `space-x-<number>` - horizontal spacing
- `space-y-<number>` - vertical spacing
- `-space-x-<number>`, `-space-y-<number>` - negative spacing
- `space-x-reverse`, `space-y-reverse` - for reversed flex layouts

**Note**: In v4, uses `margin-bottom`/`margin-right` on `:not(:last-child)`.
Prefer `gap` with flex/grid for simpler layouts.

---

## Width

Spacing scale: `w-<number>` (`w-64`)

Percentages: `w-<fraction>` (`w-1/2`, `w-1/3`, `w-2/3`)

Container scale: `w-{size}` (`w-sm`, `w-md`, `w-lg`)
- Sizes: `3xs` (16rem) to `7xl` (80rem)

Keywords:
- `w-auto`
- `w-px` - 1px
- `w-full` - 100%
- `w-screen` - 100vw
- `w-min` - min-content
- `w-max` - max-content
- `w-fit` - fit-content

Viewport units: `w-dvw`, `w-dvh`, `w-lvw`, `w-lvh`, `w-svw`, `w-svh`

Arbitrary: `w-[5px]`, `w-(--my-width)`

---

## Height

Spacing scale: `h-<number>` (`h-64`)

Percentages: `h-<fraction>` (`h-1/2`)

Keywords:
- `h-auto`
- `h-px` - 1px
- `h-full` - 100%
- `h-screen` - 100vh
- `h-min` - min-content
- `h-max` - max-content
- `h-fit` - fit-content

Viewport units: `h-dvh`, `h-dvw`, `h-lvh`, `h-lvw`, `h-svh`, `h-svw`

Arbitrary: `h-[32rem]`, `h-(--my-height)`

---

## Size

Sets both width and height simultaneously:

- `size-<number>` - spacing scale: `size-16`
- `size-<fraction>` - percentage: `size-1/2`
- `size-full` - 100%
- `size-px` - 1px
- `size-auto`
- `size-min`, `size-max`, `size-fit`
- `size-[<value>]`: `size-[50px]`

---

## Min/Max Width

**Min Width**:
- `min-w-<number>` - spacing scale: `min-w-64`
- `min-w-<fraction>` - percentage: `min-w-1/2`
- `min-w-{size}` - container scale: `min-w-xs`
- `min-w-auto`, `min-w-px`, `min-w-full`, `min-w-screen`
- `min-w-min`, `min-w-max`, `min-w-fit`
- Viewport units: `min-w-dvw`, etc.

**Max Width**:
- `max-w-<number>` - spacing scale: `max-w-64`
- `max-w-<fraction>` - percentage: `max-w-1/2`
- `max-w-{size}` - container scale: `max-w-md`
- `max-w-none`, `max-w-px`, `max-w-full`, `max-w-screen`
- `max-w-min`, `max-w-max`, `max-w-fit`
- `container` - matches current breakpoint

Container sizes for max-w: `3xs` (16rem) to `7xl` (80rem)

---

## Min/Max Height

**Min Height**:
- `min-h-<number>` - spacing scale
- `min-h-<fraction>` - percentage
- `min-h-auto`, `min-h-px`, `min-h-full`, `min-h-screen`
- `min-h-min`, `min-h-max`, `min-h-fit`
- Viewport units: `min-h-dvh`, etc.

**Max Height**:
- `max-h-<number>` - spacing scale: `max-h-64`
- `max-h-<fraction>` - percentage: `max-h-1/2`
- `max-h-none`, `max-h-px`, `max-h-full`, `max-h-screen`
- `max-h-min`, `max-h-max`, `max-h-fit`
- Viewport units: `max-h-dvh`, etc.

Arbitrary: `max-h-[220px]`, `min-w-(--my-min)`
