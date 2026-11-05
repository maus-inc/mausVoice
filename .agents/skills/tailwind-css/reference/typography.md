# Typography Reference

## Contents
- [Font Family](#font-family)
- [Font Size](#font-size)
- [Font Weight](#font-weight)
- [Font Style](#font-style)
- [Font Smoothing](#font-smoothing)
- [Font Stretch](#font-stretch)
- [Font Variant Numeric](#font-variant-numeric)
- [Line Height (Leading)](#line-height-leading)
- [Letter Spacing (Tracking)](#letter-spacing-tracking)
- [Text Alignment](#text-alignment)
- [Text Color](#text-color)
- [Text Decoration](#text-decoration)
- [Text Transform](#text-transform)
- [Text Overflow](#text-overflow)
- [Text Wrap](#text-wrap)
- [Text Indent](#text-indent)
- [Text Shadow](#text-shadow)
- [Vertical Alignment](#vertical-alignment)
- [White Space](#white-space)
- [Word/Overflow Wrap](#wordoverflow-wrap)
- [Hyphens](#hyphens)
- [Content](#content)
- [List Style](#list-style)

---

## Font Family

- `font-sans` - system sans-serif stack
- `font-serif` - serif stack
- `font-mono` - monospace stack
- `font-(<custom-property>)`: `font-(--my-font)`
- `font-[<value>]`: `font-['Open_Sans']`

Customization: Define in `@theme { --font-display: "Poppins", sans-serif; }`

---

## Font Size

Named sizes (includes default line-height):
- `text-xs` (0.75rem), `text-sm` (0.875rem), `text-base` (1rem)
- `text-lg` (1.125rem), `text-xl` (1.25rem)
- `text-2xl` (1.5rem) through `text-9xl` (8rem)

With custom line-height: `text-sm/6`, `text-lg/8`

Arbitrary: `text-[14px]`, `text-(length:--my-size)`

---

## Font Weight

- `font-thin` (100), `font-extralight` (200), `font-light` (300)
- `font-normal` (400), `font-medium` (500), `font-semibold` (600)
- `font-bold` (700), `font-extrabold` (800), `font-black` (900)
- `font-[<value>]`: `font-[1000]`

---

## Font Style

- `italic` - italicizes text
- `not-italic` - removes italics

---

## Font Smoothing

- `antialiased` - grayscale antialiasing (recommended)
- `subpixel-antialiased` - subpixel antialiasing

---

## Font Stretch

- `font-stretch-{amount}`: `ultra-condensed`, `extra-condensed`, `condensed`, `semi-condensed`, `normal`, `semi-expanded`, `expanded`, `extra-expanded`, `ultra-expanded`
- `font-stretch-<percentage>`: `font-stretch-50%`

Only works with fonts that have multiple width variations.

---

## Font Variant Numeric

- `normal-nums` - resets to normal
- `ordinal` - ordinal glyphs (1st, 2nd)
- `slashed-zero` - zero with slash
- `lining-nums` - baseline-aligned figures
- `oldstyle-nums` - figures with descenders
- `proportional-nums` - proportional widths
- `tabular-nums` - uniform widths (great for tables)
- `diagonal-fractions`, `stacked-fractions`

Composable: `slashed-zero tabular-nums`

---

## Line Height (Leading)

Spacing scale: `leading-<number>` (`leading-6`)

Named:
- `leading-none` (1), `leading-tight` (1.25), `leading-snug` (1.375)
- `leading-normal` (1.5), `leading-relaxed` (1.625), `leading-loose` (2)

Combined with font size: `text-sm/6`

Arbitrary: `leading-[1.5]`

---

## Letter Spacing (Tracking)

- `tracking-tighter` (-0.05em), `tracking-tight` (-0.025em)
- `tracking-normal` (0)
- `tracking-wide` (0.025em), `tracking-wider` (0.05em), `tracking-widest` (0.1em)
- `tracking-[<value>]`: `tracking-[.25em]`

---

## Text Alignment

- `text-left`, `text-center`, `text-right`, `text-justify`
- `text-start` - start (left in LTR)
- `text-end` - end (right in LTR)

---

## Text Color

- `text-{color}`: `text-blue-600`
- `text-inherit`, `text-current`, `text-transparent`
- With opacity: `text-blue-600/75`
- Arbitrary: `text-[#50d71e]`

---

## Text Decoration

**Line**:
- `underline`, `overline`, `line-through`, `no-underline`

**Color**:
- `decoration-{color}`: `decoration-sky-500`
- `decoration-inherit`, `decoration-current`, `decoration-transparent`
- With opacity: `decoration-indigo-500/30`

**Style**:
- `decoration-solid`, `decoration-double`, `decoration-dotted`, `decoration-dashed`, `decoration-wavy`

**Thickness**:
- `decoration-auto`, `decoration-from-font`
- `decoration-<number>`: `decoration-2`, `decoration-4`

**Underline Offset**:
- `underline-offset-<number>`: `underline-offset-2`
- `underline-offset-auto`
- `-underline-offset-<number>` for negative

---

## Text Transform

- `uppercase`, `lowercase`, `capitalize`, `normal-case`

---

## Text Overflow

- `truncate` - ellipsis with nowrap and hidden overflow
- `text-ellipsis` - just ellipsis (needs overflow-hidden)
- `text-clip` - clips at content area

---

## Text Wrap

- `text-wrap` - normal wrapping (default)
- `text-nowrap` - no wrapping
- `text-balance` - even distribution (best for headings, ~6 lines max)
- `text-pretty` - prevents orphans

---

## Text Indent

- `indent-<number>`: `indent-8`
- `-indent-<number>`: negative indent
- `indent-px`, `-indent-px`
- `indent-[<value>]`: `indent-[50%]`

---

## Text Shadow

Sizes: `text-shadow-2xs`, `text-shadow-xs`, `text-shadow-sm`, `text-shadow-md`, `text-shadow-lg`

- `text-shadow-none` - removes shadow
- `text-shadow-{color}`: `text-shadow-sky-300`
- With opacity: `text-shadow-cyan-500/50`
- Arbitrary: `text-shadow-[0_35px_35px_rgb(0_0_0_/_0.25)]`

---

## Vertical Alignment

- `align-baseline`, `align-top`, `align-middle`, `align-bottom`
- `align-text-top`, `align-text-bottom`
- `align-sub`, `align-super`
- `align-[<value>]`: `align-[4px]`

---

## White Space

- `whitespace-normal` - normal wrapping, collapses whitespace
- `whitespace-nowrap` - no wrapping, collapses whitespace
- `whitespace-pre` - preserves whitespace/newlines, no wrap
- `whitespace-pre-line` - preserves newlines, wraps
- `whitespace-pre-wrap` - preserves all, wraps
- `whitespace-break-spaces` - like pre-wrap, trailing spaces wrap

---

## Word/Overflow Wrap

**Word Break**:
- `break-normal` - normal breaking
- `break-all` - break anywhere
- `break-keep` - no breaks in CJK text

**Overflow Wrap**:
- `wrap-normal` - normal wrapping
- `wrap-break-word` - break between letters if needed
- `wrap-anywhere` - break anywhere, affects intrinsic sizing

---

## Hyphens

- `hyphens-none` - no hyphenation
- `hyphens-manual` - only at `&shy;` (default)
- `hyphens-auto` - automatic (requires `lang` attribute)

---

## Content

For `::before` and `::after` pseudo-elements:

- `content-[<value>]`: `after:content-['_↗']`
- `content-none`
- `content-[attr(<name>)]`: `before:content-[attr(data-label)]`

Underscores become spaces. Escape with `\`: `content-['Hello\_World']`

---

## List Style

**Type**:
- `list-disc`, `list-decimal`, `list-none`
- `list-[<value>]`: `list-[upper-roman]`

**Position**:
- `list-inside` - markers inside list item
- `list-outside` - markers outside (default)

**Image**:
- `list-image-[url(...)]`
- `list-image-none`
