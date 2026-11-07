# SVG & Masks Reference

## Contents
- [Fill](#fill)
- [Stroke](#stroke)
- [Stroke Width](#stroke-width)
- [Mask Image](#mask-image)
- [Mask Position](#mask-position)
- [Mask Size](#mask-size)
- [Mask Repeat](#mask-repeat)
- [Mask Origin & Clip](#mask-origin--clip)
- [Mask Mode & Type](#mask-mode--type)
- [Mask Composite](#mask-composite)

---

## Fill

- `fill-{color}`: `fill-blue-500`
- `fill-none`
- `fill-inherit`
- `fill-current` - inherits text color
- `fill-transparent`
- Arbitrary: `fill-[#243c5a]`

---

## Stroke

**Color**:
- `stroke-{color}`: `stroke-cyan-500`
- `stroke-none`
- `stroke-inherit`
- `stroke-current` - inherits text color
- `stroke-transparent`
- Arbitrary: `stroke-[#243c5a]`

---

## Stroke Width

- `stroke-<number>`: `stroke-1`, `stroke-2`
- Arbitrary: `stroke-[1.5]`

---

## Mask Image

**URL-based**:
- `mask-[url(/img/mask.png)]`
- `mask-none` - removes mask

**Linear Gradient Masks**:
From edges:
- `mask-{t|r|b|l}-from-{value}`, `mask-{t|r|b|l}-to-{value}`
- Example: `mask-b-from-50%`, `mask-l-to-90%`

From both sides:
- `mask-{x|y}-from-{value}`, `mask-{x|y}-to-{value}`
- Example: `mask-x-from-70%`

Angled:
- `mask-linear-<angle>`, `-mask-linear-<angle>`
- Use with `mask-linear-from/to`

**Radial Gradient Masks**:
- `mask-radial-from-{value}`, `mask-radial-to-{value}`
- `mask-radial-{shape}`: `circle`, `ellipse`
- `mask-radial-{size}`: `closest-corner`, `closest-side`, `farthest-corner`, `farthest-side`
- `mask-radial-at-{position}`: `top-left`, `center`, `bottom-right`, etc.

**Conic Gradient Masks**:
- `mask-conic-from-{value}`, `mask-conic-to-{value}`
- `mask-conic-<angle>`, `-mask-conic-<angle>`

Values can be: `<number>` (spacing scale), `<percentage>`, `<color>`, `(<custom-property>)`, `[<value>]`

---

## Mask Position

- `mask-{position}`: `top-left`, `top`, `top-right`, `left`, `center`, `right`, `bottom-left`, `bottom`, `bottom-right`
- Arbitrary: `mask-position-[center_top_1rem]`

---

## Mask Size

- `mask-auto` - default size
- `mask-cover` - cover the layer
- `mask-contain` - fit within layer
- Arbitrary: `mask-size-[auto_100px]`

---

## Mask Repeat

- `mask-repeat` - repeat both directions
- `mask-no-repeat` - no repetition
- `mask-repeat-x`, `mask-repeat-y` - single direction
- `mask-repeat-space` - repeat with space
- `mask-repeat-round` - repeat, stretch to fit

---

## Mask Origin & Clip

**Origin** (positioning reference):
- `mask-origin-border` - border box (default)
- `mask-origin-padding` - padding box
- `mask-origin-content` - content box
- `mask-origin-fill` - object bounding box
- `mask-origin-stroke` - stroke bounding box
- `mask-origin-view` - SVG viewport

**Clip** (clipping boundary):
- `mask-clip-border` - border box (default)
- `mask-clip-padding` - padding box
- `mask-clip-content` - content box
- `mask-clip-fill` - object bounding box
- `mask-clip-stroke` - stroke bounding box
- `mask-clip-view` - SVG viewport
- `mask-no-clip` - no clipping

---

## Mask Mode & Type

**Mode** (what determines visibility):
- `mask-alpha` - alpha channel
- `mask-luminance` - luminance value
- `mask-match` - based on mask source

**Type** (for SVG masks):
- `mask-type-alpha` - alpha channel
- `mask-type-luminance` - luminance value

Grayscale masks recommended for luminance mode.

---

## Mask Composite

How multiple masks combine:
- `mask-add` - adds layers
- `mask-subtract` - subtracts layers
- `mask-intersect` - intersection (default for gradients)
- `mask-exclude` - excludes overlapping areas
