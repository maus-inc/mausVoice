# MenuPopover · MenuPopoverBuilder (`popover-menu`)

- Status: **reused** — real components from `apps/desktop/src/components/common/MenuPopover.tsx` + MuiPopover theme.
- Source of truth: `apps/desktop/src/theme.ts` (MuiPopover), `apps/desktop/src/components/common/MenuPopover.tsx`.
- Used in: ConversationListItem, ContextMenu, Header, AppStylingRow, ManualAddStyle, ManualStylingRow, TranscriptionToneMenu.

## Purpose
Anchor menu of ListTile rows + dividers + hover submenus + generic builders.

## Visual tokens
Popover paper: level1, radius 14, hairline, premiumSurface.hover. Anchor bottom-center → transform top-center; mousedown stops propagation. Submenu: fixed box at parent rect right, zIndex 1300, paper fill, overflow hidden, shape radius; items role=menuitem.

## Motion
MUI popover enter/exit; submenu opens on mouseenter, closes on mouseleave (hide-timer ref present).

## States
open / closed / submenu open / item activation (closes via injected close).

## Accessibility
role=menuitem wrappers; ListTile rows are buttons. UNKNOWN: arrow-key traversal across submenu tiers is not implemented in source (hover-driven) — flag as a11y gap.

## Live-spec mapping
Popover radius live. Item/menu logic patch-only → seven call sites.

