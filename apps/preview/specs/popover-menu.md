# MenuPopover · MenuPopoverBuilder (`popover-menu`)

- Status: **reused** — real components from `apps/desktop/src/components/common/MenuPopover.tsx` + MuiPopover theme.
- Source of truth: `apps/desktop/src/theme.ts` (MuiPopover), `apps/desktop/src/components/common/MenuPopover.tsx`.
- Used in: ConversationListItem, ContextMenu, Header, AppStylingRow, ManualAddStyle, ManualStylingRow, TranscriptionToneMenu.

## Purpose

Anchor menu of ListTile rows + dividers + hover submenus + generic builders.

## Visual tokens

Popover paper uses the shared chrome-menu radius, hairline, rest shadow and background; it scrolls vertically when needed. The default anchor is bottom-center → top-center, and mousedown stops propagation. A submenu anchors to the right of its parent and uses the same paper styling.

## Motion

MUI popover enter/exit; submenu opens on mouseenter, closes on mouseleave (hide-timer ref present).

## States

open / closed / submenu open / item activation (closes via injected close).

## Accessibility

Action rows expose the menuitem role on the focusable control itself; checked style rows expose menuitemcheckbox and their current state. A separate edit action is a sibling, not a nested control. Opening focuses the first action. Up/Down wrap between actions; Home/End move to the ends, Enter/Space activate, Tab closes, and Escape restores the trigger through MUI Popover. A keyboard-opened submenu focuses its first action; ArrowLeft closes it. After keyboard navigation, a stationary pointer does not add a second hover highlight; moving the pointer restores hover feedback. Generic builder content retains its own semantics. Native screen-reader behavior has not been verified.

## Live-spec mapping

Popover radius live. Item/menu logic patch-only → seven call sites.
