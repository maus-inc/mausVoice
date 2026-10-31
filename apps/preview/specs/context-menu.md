# ContextMenu · useContextMenu (`context-menu`)

- Status: **reused** — real component/hook/provider from `apps/desktop/src/components/common/`.
- Source of truth: `ContextMenu.tsx` (provider), `ContextMenuSurface.tsx` (surface), `useContextMenu.tsx` (hook), and `context-menu.constants.ts`.
- Used in: ChatMessageBubble, ConversationListItem, DictionaryRow, Root (provider), ManualStylingRow, TranscriptRow.

## Purpose

Right-click menus with viewport clamping, clipboard menu on editables (provider), focus restoration.

## Visual tokens

Constants in `context-menu.constants.ts` (MENU_OFFSET, PADDING, MENU_MIN_WIDTH, MENU_MAX_HEIGHT, ITEM_HEIGHT). The surface is capped to the viewport and positioned using its measured dimensions. Items: label + optional icon + accelerator; danger = error.main; disabled dimmed. Portal to body at zIndex 1400.

## Motion

Instant open at cursor + offset; no enter animation in source. Closes on click-away, external scroll, blur, Esc.

## States

default / empty list (falls through to native menu) / danger / disabled / divider / autoFocus.

## Accessibility

Menu auto-focuses without scrolling the page; arrows/Enter navigate (actionable indices skip dividers); Esc captured + focus restored only when the dismissal keeps focus in-page (click-away/scroll do NOT steal focus back); outgoing focus target prefers the right-clicked element. Keyboard navigation reveals the active item within a scrolling menu. Scroll dismissal starts after the opening frame, so a previously queued scroll does not close the menu as it opens.

## Live-spec mapping

Patch-only (constants + handlers in source). Changes apply to all call sites.
