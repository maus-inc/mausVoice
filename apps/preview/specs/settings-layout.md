# SettingsLayout (`settings-layout`)

- Status: **reused** — the production Settings shell.
- Source of truth: `apps/desktop/src/components/settings/SettingsLayout.tsx` and `apps/desktop/src/components/settings/SettingsLayout.test.tsx`.
- Used in: every dashboard Settings route.

## Purpose

Find and move between Settings pages without letting the dashboard sidebar dictate the Settings layout breakpoint. The available Settings content width controls when its navigation becomes a side rail.

## Responsive states

- Below a 680px Settings container width: search sits above navigation; navigation links wrap above the page content. Do not create a horizontal scroll strip.
- At and above 680px: a 208px side rail holds search and vertically stacked page links, separated from the reading column by 32px. The page's 24px total outer inset leaves 416px for content at the threshold.
- Search fills the compact rail width and caps at 360px when the compact Settings surface has more room.

## Visual tokens

- Container query: `settings-layout` at `min-width: 680px`.
- Wide rail: 208px; split gap: 32px; outer inset: 24px total.
- Search placeholder: full-opacity `text.secondary` in both schemes.
- Colors and surfaces come from the desktop theme; this shell adds no independent surface treatment.

## Motion

No custom motion. Page navigation and scroll follow the router and the owning Settings content pane.

## States

- Current page marked with `aria-current="page"`.
- Search: idle, matching results, empty results, keyboard shortcut focus, Escape clears the query.
- Re-entry redirects to the remembered Settings page.

## Accessibility

- Navigation is a labeled `<nav>` of real links with keyboard-operable destinations.
- Search has the accessible name "Search settings" and announces result counts through a status region.
- Navigation remains visible without horizontal scrolling in the compact state; selected page is exposed with `aria-current`.

## Live-spec mapping

`apps/preview/verify-harness/settings.tsx` renders the production shell. Verify Shortcuts and AI and models in light and dark across 800–1000px, including both sides of the 680px container threshold.
