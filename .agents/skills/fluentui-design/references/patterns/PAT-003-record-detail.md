---
id: PAT-003
title: Record detail page
decisions: [permission-state]
rules: [RULE-003, RULE-029]
components: [Card, CardHeader, CardFooter, TabList, Tab, Text, Title1, Subtitle1, Divider, Badge, MessageBar, MessageBarBody, Button, Link]
derived: [application-owned PageHeader composition, application-owned related-records loader]
---

# Record detail page

## User task

Understand one record at a glance, read its details, and reach the actions and related information
that belong to it.

## When to use / when not

Use it for a single addressable record with related data. Do not use it when the user needs to
compare many records, which is the list page's job.

## Region order

1. Page heading naming the record, with status and one primary action.
2. Summary cards for the most important facts.
3. Peer views (overview, related, history) as tabs.
4. Destructive or secondary actions, separated from the primary action.

## Component mapping

Card and its parts, TabList and Tab, Badge, Divider, Button, Link, and text roles are verified
exports. The PageHeader grouping and the related-records loader are application-owned compositions.
Routing, authorization, and fetching are application responsibilities.

## Interaction flow

The route identifies the record; the application loads it and renders the heading. Switching a tab
changes only the tab region. A read-only viewer sees the same structure with action controls omitted
and a visible explanation of the restricted state, rather than an empty page.

## State ownership

The application owns the loaded record, the selected tab, and the permission result. Card and tab
components hold only presentational state such as hover or the selected tab index.

## Responsive behavior

Summary cards stack to one column below the project's narrow breakpoint. Tabs overflow into a menu
rather than scrolling out of reach. Related tables inside a tab follow the list page rules.

## Accessibility

The record name is the single top-level heading. Tabs follow the tablist keyboard model with the
selected tab associated with its panel. A restricted or read-only state is announced and explained
in text, and the current status is not conveyed by color alone.

## Edge cases

A missing record renders a not-found state with a path back to the list. A record the user may not
view shows a permission explanation without revealing whether hidden fields exist. A partially
failed related-data load shows an inline error in that tab only.

## Rules applied

RULE-003, RULE-029

## Derived decisions

The PageHeader composition and the choice of tabs for peer views are application decisions.
Authorization and related-data fetching are named here as application responsibilities.

## Tests

Fixture detail rendering test, tab keyboard test, read-only-state test, and a missing-record test.
