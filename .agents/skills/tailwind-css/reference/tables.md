# Tables Reference

## Table Layout

- `table-auto` - column widths based on content
- `table-fixed` - column widths based on table/column widths (ignores content)

---

## Border Collapse

- `border-collapse` - adjacent borders combine
- `border-separate` - each cell has distinct borders

Use `border-spacing-*` with `border-separate`.

---

## Border Spacing

Requires `border-separate`:

- `border-spacing-<number>` - both axes: `border-spacing-2`
- `border-spacing-x-<number>` - horizontal: `border-spacing-x-3`
- `border-spacing-y-<number>` - vertical
- Arbitrary: `border-spacing-[7px]`

---

## Caption Side

- `caption-top` - caption above table (default)
- `caption-bottom` - caption below table

Apply to `<caption>` elements.

---

## Table Display Values

- `table` - element behaves as table
- `inline-table` - inline-level table
- `table-caption` - table caption
- `table-cell` - table cell
- `table-column` - table column
- `table-column-group` - column group
- `table-footer-group` - table footer
- `table-header-group` - table header
- `table-row-group` - table body
- `table-row` - table row
