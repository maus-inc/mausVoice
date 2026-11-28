# Backgrounds & Borders Reference

## Contents
- [Background Color](#background-color)
- [Background Image & Gradients](#background-image--gradients)
- [Background Position](#background-position)
- [Background Size](#background-size)
- [Background Repeat](#background-repeat)
- [Background Attachment](#background-attachment)
- [Background Clip & Origin](#background-clip--origin)
- [Background Blend Mode](#background-blend-mode)
- [Border Width](#border-width)
- [Border Color](#border-color)
- [Border Style](#border-style)
- [Border Radius](#border-radius)
- [Divide (Border Between)](#divide)
- [Outline](#outline)
- [Ring](#ring)

---

## Background Color

- `bg-{color}`: `bg-indigo-500`
- `bg-inherit`, `bg-current`, `bg-transparent`
- With opacity: `bg-sky-500/75`
- Arbitrary: `bg-[#50d71e]`, `bg-(--my-bg)`

---

## Background Image & Gradients

**Image**:
- `bg-[url(/img/mountains.jpg)]`
- `bg-none` - removes background image

**Linear Gradients**:
Direction: `bg-linear-to-{t|tr|r|br|b|bl|l|tl}`
Angle: `bg-linear-<angle>` (`bg-linear-65`), `-bg-linear-<angle>`

**Radial Gradients**:
- `bg-radial` - basic radial
- `bg-radial-[at_50%_75%]` - with position

**Conic Gradients**:
- `bg-conic` - basic conic
- `bg-conic-<angle>` - with start angle

**Gradient Color Stops**:
- `from-{color}`: starting color (`from-cyan-500`)
- `via-{color}`: middle color (`via-purple-500`)
- `to-{color}`: ending color (`to-blue-500`)
- With opacity: `from-blue-500/50`

**Stop Positions**:
- `from-<percentage>`, `via-<percentage>`, `to-<percentage>`
- Example: `from-10%`, `via-30%`, `to-90%`

**Interpolation Mode**: Add after direction
- `bg-linear-to-r/oklch` (default), `bg-linear-65/hsl`, etc.
- Modes: `srgb`, `hsl`, `oklab`, `oklch`, `longer`, `shorter`

---

## Background Position

- `bg-{position}`: `top-left`, `top`, `top-right`, `left`, `center`, `right`, `bottom-left`, `bottom`, `bottom-right`
- Arbitrary: `bg-position-[center_top_1rem]`

---

## Background Size

- `bg-auto` - default size
- `bg-cover` - cover container
- `bg-contain` - fit within container
- Arbitrary: `bg-size-[auto_100px]`

---

## Background Repeat

- `bg-repeat` - repeat both directions
- `bg-no-repeat` - no repetition
- `bg-repeat-x`, `bg-repeat-y` - single direction
- `bg-repeat-space` - repeat with space between
- `bg-repeat-round` - repeat, stretch to fit

---

## Background Attachment

- `bg-fixed` - fixed to viewport
- `bg-local` - scrolls with content
- `bg-scroll` - scrolls with viewport (default)

---

## Background Clip & Origin

**Clip**:
- `bg-clip-border` - extends to border edge (default)
- `bg-clip-padding` - extends to padding edge
- `bg-clip-content` - extends to content edge
- `bg-clip-text` - clips to text (use with `text-transparent`)

**Origin**:
- `bg-origin-border`, `bg-origin-padding`, `bg-origin-content`

---

## Background Blend Mode

- `bg-blend-{mode}`: `normal`, `multiply`, `screen`, `overlay`, `darken`, `lighten`, `color-dodge`, `color-burn`, `hard-light`, `soft-light`, `difference`, `exclusion`, `hue`, `saturation`, `color`, `luminosity`, `plus-darker`, `plus-lighter`

---

## Border Width

All sides: `border` (1px), `border-<number>` (`border-2`, `border-4`)

Single sides: `border-t`, `border-r`, `border-b`, `border-l`
With width: `border-t-2`, `border-r-4`

Axes: `border-x`, `border-y`

Logical: `border-s` (start), `border-e` (end)

Arbitrary: `border-[2vw]`

---

## Border Color

- `border-{color}`: `border-gray-300`
- `border-inherit`, `border-current`, `border-transparent`
- With opacity: `border-blue-500/50`

Per side: `border-t-{color}`, `border-x-{color}`, etc.

**Note**: Default border color in v4 is `currentColor` (was `gray-200` in v3).

---

## Border Style

- `border-solid`, `border-dashed`, `border-dotted`, `border-double`
- `border-hidden`, `border-none`

---

## Border Radius

All corners: `rounded-{size}`
- Sizes: `xs`, `sm`, `md`, `lg`, `xl`, `2xl`, `3xl`, `4xl`
- `rounded-none` - no radius
- `rounded-full` - pill/circle

**Note**: In v4, `rounded-sm` = old `rounded`, `rounded-xs` = old `rounded-sm`

Sides:
- `rounded-t-{size}`, `rounded-r-{size}`, `rounded-b-{size}`, `rounded-l-{size}`
- `rounded-s-{size}`, `rounded-e-{size}` (logical)

Corners:
- `rounded-tl-{size}`, `rounded-tr-{size}`, `rounded-br-{size}`, `rounded-bl-{size}`
- `rounded-ss-{size}`, `rounded-se-{size}`, `rounded-es-{size}`, `rounded-ee-{size}` (logical)

Arbitrary: `rounded-[2vw]`

---

## Divide

Adds borders between child elements (not first/last):

Width: `divide-x`, `divide-y`, `divide-x-<number>`, `divide-y-<number>`

Color: `divide-{color}`, `divide-{color}/{opacity}`

Style: `divide-solid`, `divide-dashed`, `divide-dotted`, `divide-double`, `divide-none`

Reverse (for flex-*-reverse): `divide-x-reverse`, `divide-y-reverse`

---

## Outline

**Width**:
- `outline` - 1px
- `outline-<number>`: `outline-2`, `outline-4`

**Color**:
- `outline-{color}`: `outline-blue-500`
- With opacity: `outline-blue-500/50`

**Style**:
- `outline-solid`, `outline-dashed`, `outline-dotted`, `outline-double`
- `outline-none` - removes outline completely
- `outline-hidden` - hidden but preserved for forced colors mode (accessibility recommended)

**Offset**:
- `outline-offset-<number>`: `outline-offset-2`
- `-outline-offset-<number>` for negative

---

## Ring

Box-shadow based rings for focus states:

**Width**:
- `ring` - 1px (was 3px in v3, use `ring-3` for old default)
- `ring-<number>`: `ring-2`, `ring-4`

**Color**:
- `ring-{color}`: `ring-blue-500`
- With opacity: `ring-blue-500/50`

**Inset rings**:
- `inset-ring`, `inset-ring-<number>`
- `inset-ring-{color}`

**Note**: Default ring color in v4 is `currentColor` (was `blue-500` in v3).
