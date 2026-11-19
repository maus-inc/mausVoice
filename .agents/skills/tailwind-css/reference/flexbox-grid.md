# Flexbox & Grid Reference

## Contents
- [Flexbox](#flexbox)
  - [Flex Direction](#flex-direction)
  - [Flex Wrap](#flex-wrap)
  - [Flex](#flex)
  - [Flex Grow & Shrink](#flex-grow--shrink)
  - [Flex Basis](#flex-basis)
  - [Order](#order)
- [Grid](#grid)
  - [Grid Template Columns](#grid-template-columns)
  - [Grid Template Rows](#grid-template-rows)
  - [Grid Column Start/End/Span](#grid-column-startendspan)
  - [Grid Row Start/End/Span](#grid-row-startendspan)
  - [Grid Auto Columns/Rows](#grid-auto-columnsrows)
  - [Grid Auto Flow](#grid-auto-flow)
- [Gap](#gap)
- [Alignment](#alignment)
  - [Justify Content](#justify-content)
  - [Justify Items](#justify-items)
  - [Justify Self](#justify-self)
  - [Align Content](#align-content)
  - [Align Items](#align-items)
  - [Align Self](#align-self)
  - [Place Content/Items/Self](#place-contentitemsself)

---

## Flexbox

### Flex Direction
- `flex-row` - horizontal, left to right
- `flex-row-reverse` - horizontal, right to left
- `flex-col` - vertical, top to bottom
- `flex-col-reverse` - vertical, bottom to top

### Flex Wrap
- `flex-nowrap` - items don't wrap
- `flex-wrap` - items wrap to multiple lines
- `flex-wrap-reverse` - items wrap in reverse

### Flex
- `flex-<number>`: `flex-1` sets `flex: 1`
- `flex-auto`: `flex: 1 1 auto` - grow/shrink from initial size
- `flex-initial`: `flex: 0 1 auto` - shrink but don't grow
- `flex-none`: `flex: none` - no grow/shrink
- `flex-[<value>]`: `flex-[3_1_auto]`

### Flex Grow & Shrink
Grow:
- `grow` - allows growing (`flex-grow: 1`)
- `grow-0` - prevents growing
- `grow-<number>` - specific grow factor

Shrink:
- `shrink` - allows shrinking (`flex-shrink: 1`)
- `shrink-0` - prevents shrinking
- `shrink-<number>` - specific shrink factor

### Flex Basis
- `basis-<number>` - spacing scale: `basis-64`
- `basis-<fraction>` - percentage: `basis-1/3`
- `basis-full` - 100%
- `basis-auto`
- `basis-{size}` - container scale: `basis-sm`
- `basis-[<value>]`: `basis-[30vw]`

### Order
- `order-<number>`: `order-1`, `order-3`
- `-order-<number>`: negative order
- `order-first` - renders first
- `order-last` - renders last
- `order-none` - resets to 0

---

## Grid

### Grid Template Columns
- `grid-cols-<number>` - equal-width columns: `grid-cols-4`
- `grid-cols-none`
- `grid-cols-subgrid` - adopts parent columns
- `grid-cols-[<value>]`: `grid-cols-[200px_minmax(900px,_1fr)_100px]`

### Grid Template Rows
- `grid-rows-<number>` - equal-height rows: `grid-rows-4`
- `grid-rows-none`
- `grid-rows-subgrid` - adopts parent rows
- `grid-rows-[<value>]`: `grid-rows-[200px_minmax(900px,1fr)_100px]`

### Grid Column Start/End/Span
Span: `col-span-<number>`, `col-span-full`
Start: `col-start-<number>`, `-col-start-<number>`, `col-start-auto`
End: `col-end-<number>`, `-col-end-<number>`, `col-end-auto`
Combined: `col-auto`, `col-<number>`, `-col-<number>`
Arbitrary: `col-[16_/_span_16]`

### Grid Row Start/End/Span
Span: `row-span-<number>`, `row-span-full`
Start: `row-start-<number>`, `-row-start-<number>`, `row-start-auto`
End: `row-end-<number>`, `-row-end-<number>`, `row-end-auto`
Combined: `row-auto`, `row-<number>`, `-row-<number>`
Arbitrary: `row-[span_16_/_span_16]`

### Grid Auto Columns/Rows
Columns: `auto-cols-auto`, `auto-cols-min`, `auto-cols-max`, `auto-cols-fr`
Rows: `auto-rows-auto`, `auto-rows-min`, `auto-rows-max`, `auto-rows-fr`
Arbitrary: `auto-cols-[minmax(0,2fr)]`

### Grid Auto Flow
- `grid-flow-row` - fill rows (default)
- `grid-flow-col` - fill columns
- `grid-flow-dense` - dense packing
- `grid-flow-row-dense`
- `grid-flow-col-dense`

---

## Gap

- `gap-<number>` - rows and columns: `gap-4`
- `gap-x-<number>` - column gap only: `gap-x-8`
- `gap-y-<number>` - row gap only: `gap-y-4`
- `gap-[<value>]`: `gap-[10vw]`

---

## Alignment

### Justify Content
(Main axis for flex/grid)
- `justify-start`, `justify-center`, `justify-end`
- `justify-center-safe`, `justify-end-safe` - fall back to start if overflow
- `justify-between` - space between, first/last at edges
- `justify-around` - equal space around items
- `justify-evenly` - equal space between and around
- `justify-stretch`
- `justify-baseline`
- `justify-normal`

### Justify Items
(Grid inline axis)
- `justify-items-start`, `justify-items-center`, `justify-items-end`
- `justify-items-center-safe`, `justify-items-end-safe`
- `justify-items-stretch`, `justify-items-normal`

### Justify Self
- `justify-self-auto`, `justify-self-start`, `justify-self-center`, `justify-self-end`, `justify-self-stretch`

### Align Content
(Cross axis distribution)
- `content-start`, `content-center`, `content-end`
- `content-center-safe`, `content-end-safe`
- `content-between`, `content-around`, `content-evenly`
- `content-stretch`, `content-baseline`

### Align Items
(Cross axis for flex/grid)
- `items-start`, `items-center`, `items-end`
- `items-center-safe`, `items-end-safe`
- `items-baseline`, `items-baseline-last`
- `items-stretch`

### Align Self
- `self-auto`, `self-start`, `self-center`, `self-end`
- `self-center-safe`, `self-end-safe`
- `self-stretch`, `self-baseline`, `self-baseline-last`

### Place Content/Items/Self
(Shorthand for align + justify)

Content: `place-content-center`, `place-content-start`, `place-content-end`, `place-content-between`, `place-content-around`, `place-content-evenly`, `place-content-stretch`, `place-content-baseline`

Items: `place-items-start`, `place-items-center`, `place-items-end`, `place-items-stretch`, `place-items-baseline`

Self: `place-self-auto`, `place-self-start`, `place-self-center`, `place-self-end`, `place-self-stretch`

Safe variants available: `place-content-center-safe`, `place-items-center-safe`, `place-self-center-safe`
