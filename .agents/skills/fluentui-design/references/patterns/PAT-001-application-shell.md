---
id: PAT-001
title: Application shell
decisions: [command-scope, navigation-model]
rules: [RULE-001, RULE-002, RULE-003]
components: [FluentProvider, Nav, NavItem, NavCategory, NavCategoryItem, NavSubItem, NavDrawer, Breadcrumb, BreadcrumbItem, BreadcrumbButton, BreadcrumbDivider, Toolbar, ToolbarButton, Text, Title1]
derived: [application-owned app shell composition, application-owned route binding]
---

# Application shell

## User task

Move between the primary areas of the application and always know where they are, while the
current page keeps its own heading and commands.

## When to use / when not

Use it for any app with more than one destination. Do not add a shell to a single-screen tool, and
do not force a shell when the app is embedded inside a host that already owns navigation.

## Region order

1. Banner with product identity and global actions.
2. Primary navigation (Nav).
3. Breadcrumb for the current path.
4. Page heading and page commands.
5. Main content region.

## Component mapping

Verified exports supply the navigation and command primitives: FluentProvider, Nav and its item
parts, Breadcrumb, Toolbar, and text roles. The shell itself, the route binding, and the layout
grid are application-owned compositions, so they are never presented as v9 exports.

## Interaction flow

The router resolves a route, the shell marks the matching Nav item, the Breadcrumb renders the
path segments, and the routed view renders inside the main region. Clicking a navigation item asks
the application router to navigate; the component does not change the route on its own.

## State ownership

The application owns the route, the expanded navigation categories, and the narrow-width drawer
state. Nav selection is derived from the route rather than stored separately.

## Responsive behavior

At the project's narrow breakpoint the navigation column moves into a NavDrawer triggered from the
banner. The breakpoint is a project convention and must state what it changes at that width.

## Accessibility

The shell provides the banner, navigation, and main landmarks. Exactly one main landmark exists,
the current destination is marked as current, and a skip link lets keyboard users reach the main
region directly.

## Edge cases

Loading a route shows a skeleton in the main region while the shell stays usable. An unauthorized
route renders an explanatory state in the main region without hiding the fact that navigation
exists. A deep link with unknown segments shows a not-found state inside the shell.

## Rules applied

RULE-001, RULE-002, RULE-003

## Derived decisions

The shell composition, the route binding, and the responsive collapse are application decisions.
Routing, authorization, and data fetching are not owned by Fluent and are named here as
application responsibilities.

## Tests

Fixture shell rendering test, landmark structure test, active-route marking test, and a narrow-width
drawer test.
