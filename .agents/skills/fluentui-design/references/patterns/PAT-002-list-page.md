---
id: PAT-002
title: Searchable and filterable list page
decisions: [data-surface, data-processing-location, selection-scope, row-activation, data-resilience, virtualization]
rules: [RULE-010, RULE-011, RULE-012, RULE-016, RULE-031, RULE-032, RULE-033, RULE-034, RULE-035, RULE-036]
components: [DataGrid, DataGridBody, DataGridRow, DataGridCell, DataGridHeader, DataGridHeaderCell, DataGridSelectionCell, createTableColumn, TableResizeHandle, Table, TableHeader, TableRow, TableCell, TableBody, TableCellLayout, Input, Button, MenuButton, Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, Spinner, Skeleton, SkeletonItem, MessageBar, MessageBarBody, Checkbox, Field]
derived: [application-owned FilterBar composition, application-owned query and pagination state]
---

# Searchable and filterable list page

## User task

Find a set of records, narrow them down, act on one or on many, and understand what the current
result set contains.

## When to use / when not

Use it when the user works with a collection of similar records. Use a simple Table when the data is
static and needs no filtering, selection, or sorting. Do not use a grid when the task is really a
narrative detail view.

## Region order

1. Page heading and one primary action.
2. Filter and search controls.
3. Result count and, when server-paged, a pager.
4. The grid or table.
5. Bulk-action bar, shown only while rows are selected.

## Component mapping

DataGrid and its parts provide the controlled, keyboard-navigable surface; Table and its parts
provide native table semantics for simpler cases. Input, Menu, Button, Checkbox, Spinner, Skeleton,
and MessageBar are verified exports. The FilterBar, the query state, and the pager are
application-owned compositions.

## Interaction flow

Typing in search or changing a filter updates application query state. In server mode this issues a
request and shows a pending state in the grid region. Clicking a row opens the record when the row
is the activation target; when a cell contains its own action control, that control handles its own
click and does not also activate the row. Selecting rows reveals the bulk-action bar.

## State ownership

The application owns the query, page, sort, filter, and selected ids. Whether operations run locally
or on the server is explicit in application state, not inferred by the grid.

## Responsive behavior

Below the project's narrow breakpoint, low-priority columns are hidden behind a detail view and
filters collapse into a single control that opens a panel. The grid keeps vertical scrolling; it
never requires two-dimensional scrolling to read a value. When columns can be resized, keep the grid
inside a region that scrolls horizontally so resizing never pushes the page itself into horizontal
scrolling, and prefer hiding low-priority columns over relying on resize at narrow widths.
Virtualize the grid only after measuring a performance need, because virtualization keeps only the
visible rows in the DOM and can break in-page search and predictable focus movement; when it is
used, keep the row renderer stable and the row key constant so the rendered window does not churn.

## Accessibility

The grid uses one tab stop with arrow-key navigation inside it. A cell that contains controls
declares its own focus mode: `group` when it holds several focusable elements so Enter enters the
cell and Escape returns to it, and `none` when it holds exactly one so that control is reached
directly. A sortable header cell stays a single sort button and must not contain nested focusable
controls. Sort state, selection changes, and async result updates are announced through a polite
status region, and every selection control carries an accessible name: the header control states
its selection scope and each row control names the row. The select-all control states whether it
selects the current page or all matching results.

## Edge cases

Loading shows Skeletons in the grid region. No data, no search matches, and a failed load each show a
distinct message; the failed state offers a retry action. A column with no `compare` function stays
unsortable even when sorting is enabled, so a header that looks sortable can silently do nothing.
Because the library does not reliably announce a sort change, add a polite status message when the
result order changes. A server-paged sort re-queries instead of sorting only the loaded page. A
selection that spans pages keeps its ids when the page changes. When virtualization is enabled, keep
a stable row key, expose the row's position and total count to assistive technology, and ensure
focus is not lost when the visible window moves.

## Rules applied

RULE-010, RULE-011, RULE-012, RULE-016, RULE-031, RULE-032, RULE-033, RULE-034, RULE-035, RULE-036

## Derived decisions

The FilterBar composition, the explicit local-versus-server choice, and the activation-versus-
selection split are application decisions. Data fetching, sorting, filtering, and pagination are
application responsibilities; the grid only renders and reports interaction.

## Tests

Fixture list rendering test, keyboard grid navigation test, sort-issues-request test, selection-scope
test, and the four-state (loading, empty, search-empty, error) test.
