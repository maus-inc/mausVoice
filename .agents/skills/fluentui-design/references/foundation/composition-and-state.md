# Composition and State

Composition is the part of the design that Fluent UI React v9 does not decide for
you. The library provides parts; your application decides how the parts form a
page, who owns each piece of state, and what happens when the data is not ready.

This reference supports
[PAT-001 application shell](../patterns/PAT-001-application-shell.md) and the
derived decisions every pattern lists. For exact component APIs, use the sibling
`fluentui` skill: [Nav](fluentui:references/components/nav.md).

## The shell is application-owned

Fluent UI React v9 ships components, not an application shell. The shell — the
persistent frame around every page — is a composition you own (RULE-001). A shell
usually contains:

- One `FluentProvider` at the root with an explicit theme and text direction
  (RULE-026). Mount it once; do not nest providers to change one subtree.
- Primary navigation for the top level of the hierarchy, and a breadcrumb or
  page header for position within it (RULE-002).
- A content region whose layout each page pattern defines.

Because the shell is not a single export, treat it as an application-owned
composition and keep it small. A shell that grows business rules has stopped
being a shell.

## Compose with public parts

Build layout with `makeStyles` and the component's own slots (RULE-028). Reach
for the DOM or internal class names only when the public surface cannot express
the layout, and record why. Composing from public parts keeps a design readable
and upgradeable.

## State ownership

Keep application state in the application (RULE-027). Fluent components own
only the state a widget needs to function, such as whether a menu is open.
Everything that outlives a widget belongs in your layer:

| State | Owner |
| --- | --- |
| Fetched records and their cache | Data or query layer |
| Form draft and validation | The form's page or hook |
| Selection and sort in a grid | The list page |
| Open overlay and its focus | The overlay's host component |
| Theme and direction | The root provider |

Lift state only to the lowest common owner. Moving state higher than necessary
couples unrelated regions and makes both harder to test.

## Decide the save model

State the save model before building the form. The common shapes are:

- **Explicit save** for a page form. The user edits a draft and commits with a
  primary action.
- **Immediate apply** for a setting. The change saves as it is made, and success
  or failure is reported at once.
- **Hybrid** for a settings page: immediate for cheap toggles, explicit save for
  a group that must change together.

Each pattern states which model it assumes and what the application still owns.

## Server state versus view state

Separate the two deliberately. Server state is fetched, cached, and possibly
stale. View state is local and cheap. A grid that sorts server data re-queries
when the sort changes (RULE-011); it does not sort only the loaded page. Keeping
that distinction explicit is what makes paging, filtering, and selection
predictable.

## What the application owns

Every pattern ends with the same reminder in different words: routing, data
fetching, validation, authorization, and persistence are application
responsibilities. Fluent UI React v9 renders them well; it does not implement
them. When you explain a tradeoff, attribute those decisions to the application
so no one looks for a component that does not exist.

## Failure and readiness

Design the state of the surface, not only its happy path. Loading, empty,
search-empty, and error are four different states and each needs an explicit
treatment (RULE-016). The composition decision is where each one appears: inside
the content region, replacing the grid, or in a message region above it.

## Related references

- [Styling and tokens](styling-and-tokens.md) for the two-layer token model.
- [Accessibility](accessibility.md) for focus and keyboard composition.
- [Responsive and localization](responsive-and-localization.md) for reflow.
