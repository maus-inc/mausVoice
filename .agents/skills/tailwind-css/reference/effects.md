# Effects Reference

## Contents
- [Box Shadow](#box-shadow)
- [Opacity](#opacity)
- [Mix Blend Mode](#mix-blend-mode)
- [Filter](#filter)
- [Backdrop Filter](#backdrop-filter)

---

## Box Shadow

**Outer Shadow**:
Sizes: `shadow-2xs`, `shadow-xs`, `shadow-sm`, `shadow-md`, `shadow-lg`, `shadow-xl`, `shadow-2xl`

**Note**: In v4, scale shifted: `shadow-xs` = old `shadow-sm`, `shadow-sm` = old `shadow`

- `shadow-none` - removes shadow

Color: `shadow-{color}` (`shadow-indigo-500`)
With opacity: `shadow-cyan-500/50`

**Inset Shadow**:
Sizes: `inset-shadow-2xs`, `inset-shadow-xs`, `inset-shadow-sm`
- `inset-shadow-none`

Color: `inset-shadow-{color}`, `inset-shadow-{color}/{opacity}`

Arbitrary: `shadow-[0_35px_35px_rgba(0,0,0,0.25)]`

---

## Opacity

- `opacity-<number>`: percentage (`opacity-75`, `opacity-25`, `opacity-0`)
- Arbitrary: `opacity-[.67]`

Common states: `disabled:opacity-75`, `hover:opacity-100`

---

## Mix Blend Mode

Controls how element blends with background:

- `mix-blend-normal`, `mix-blend-multiply`, `mix-blend-screen`
- `mix-blend-overlay`, `mix-blend-darken`, `mix-blend-lighten`
- `mix-blend-color-dodge`, `mix-blend-color-burn`
- `mix-blend-hard-light`, `mix-blend-soft-light`
- `mix-blend-difference`, `mix-blend-exclusion`
- `mix-blend-hue`, `mix-blend-saturation`, `mix-blend-color`, `mix-blend-luminosity`
- `mix-blend-plus-darker`, `mix-blend-plus-lighter`

Use `isolate` on parent to prevent blending with elements behind.

---

## Filter

Individual filters (composable):

**Blur**:
- `blur-{size}`: `xs` (4px), `sm` (8px), `md` (12px), `lg` (16px), `xl` (24px), `2xl` (40px), `3xl` (64px)
- `blur-none`

**Note**: In v4, `blur-xs` = old `blur-sm`, `blur-sm` = old `blur`

**Brightness**: `brightness-<number>` (percentage): `brightness-50`, `brightness-125`

**Contrast**: `contrast-<number>` (percentage): `contrast-50`, `contrast-125`

**Grayscale**: `grayscale` (100%), `grayscale-<number>`: `grayscale-50`, `grayscale-0`

**Hue Rotate**: `hue-rotate-<number>` (degrees): `hue-rotate-90`, `-hue-rotate-15`

**Invert**: `invert` (100%), `invert-<number>`: `invert-20`, `invert-0`

**Saturate**: `saturate-<number>` (percentage): `saturate-50`, `saturate-150`

**Sepia**: `sepia` (100%), `sepia-<number>`: `sepia-50`, `sepia-0`

**Drop Shadow**:
Sizes: `drop-shadow-xs`, `drop-shadow-sm`, `drop-shadow-md`, `drop-shadow-lg`, `drop-shadow-xl`, `drop-shadow-2xl`
- `drop-shadow-none`
- Color: `drop-shadow-{color}`, `drop-shadow-{color}/{opacity}`

**Note**: In v4, `drop-shadow-xs` = old `drop-shadow-sm`, `drop-shadow-sm` = old `drop-shadow`

**Combined**: `blur-xs grayscale` - multiple filters stack
**Reset**: `filter-none`
Arbitrary: `filter-[url('filters.svg#filter-id')]`

---

## Backdrop Filter

Same filters but apply to area behind element:

**Blur**: `backdrop-blur-{size}`, `backdrop-blur-none`

**Brightness**: `backdrop-brightness-<number>`

**Contrast**: `backdrop-contrast-<number>`

**Grayscale**: `backdrop-grayscale`, `backdrop-grayscale-<number>`

**Hue Rotate**: `backdrop-hue-rotate-<number>`, `-backdrop-hue-rotate-<number>`

**Invert**: `backdrop-invert`, `backdrop-invert-<number>`

**Saturate**: `backdrop-saturate-<number>`

**Sepia**: `backdrop-sepia`, `backdrop-sepia-<number>`

**Opacity**: `backdrop-opacity-<number>`

Example use: Glass effect with `backdrop-blur-md bg-white/30`
