---
id: PAT-008
title: Dashboard whose content reflects actual tasks and data
decisions: [feedback-channel, data-resilience, permission-state]
rules: [RULE-003, RULE-015, RULE-016]
components: [Card, CardHeader, CardFooter, Text, Title1, Subtitle1, MessageBar, MessageBarBody, Spinner, Skeleton, SkeletonItem, Badge, Button, ProgressBar]
derived: [application-owned dashboard composition, application-owned data aggregation]
---

# Dashboard whose content reflects actual tasks and data

## User task

See the state of the things they care about and decide what to do next.

## When to use / when not

Use it when several small summaries help the user choose a next action. Do not use a dashboard as
decoration; every tile must reflect real data and lead somewhere or state a status. Do not use it
when the user only needs one focused task.

## Region order

1. Page heading naming the scope, such as the current team or workspace.
2. A durable status message when something needs attention.
3. Summary tiles, ordered by importance.
4. A recent-activity or task list.
5. A persistent link to the full list behind each tile.

## Component mapping

Card and its parts, Badge, ProgressBar, Button, MessageBar, MessageBarBody, Spinner, Skeleton,
SkeletonItem, and text roles are verified exports. The dashboard composition, the tile ordering, and
the data aggregation are application-owned. Fetching and authorization are application
responsibilities.

## Interaction flow

Each tile loads its own data and shows a skeleton until it settles. A tile that fails shows an inline
error with retry and does not blank the whole dashboard. Selecting a tile navigates to the relevant
filtered list. A transient confirmation uses a toast; a condition the user must re-read uses a
MessageBar that persists.

## State ownership

The application owns each tile's data, loading, and error state, plus the permission scope of the
page. Tiles hold no shared state with one another so one failure stays local.

## Responsive behavior

Tiles stack to one column below the project's narrow breakpoint. Tile content keeps its explanation
and action; it never truncates a status into an unlabeled badge.

## Accessibility

Each tile has a heading so it appears in the document outline. Status conveyed by color is paired with
text. Loading and error states are announced, and the dashboard provides a logical heading order from
the page heading down to tile headings.

## Edge cases

A permission-restricted dashboard shows an explanatory state instead of empty tiles. A tile with no
data shows a distinct empty state, not a zero value that looks like real data. A slow tile does not
block the others, and a stale tile shows when it was last updated.

## Rules applied

RULE-003, RULE-015, RULE-016

## Derived decisions

The tile set, the importance ordering, and per-tile loading are application decisions. Data fetching
and authorization are application responsibilities.

## Tests

Fixture dashboard rendering test, per-tile loading and error tests, heading-order test, and a
permission-state test.
