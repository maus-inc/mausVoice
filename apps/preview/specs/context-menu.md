# ContextMenu · useContextMenu (`context-menu`)

- Status: **reused** — real component/hook/provider from `apps/desktop/src/components/common/ContextMenu.tsx`.
- Source of truth: `apps/desktop/src/components/common/ContextMenu.tsx`.
- Used in: ChatMessageBubble, ConversationListItem, DictionaryRow, Root (provider), ManualStylingRow, TranscriptRow.

## Purpose
Right-click menus with viewport clamping, clipboard menu on editables (provider), focus restoration.

## Visual tokens
Constants in source (MENU_OFFSET, PADDING, MENU_MIN_WIDTH, MENU_MAX_HEIGHT, ITEM_HEIGHT — read exact numbers in file). Items: label + optional icon + accelerator; danger = error.main; disabled dimmed. Portal to body at zIndex 1400.

## Motion
Instant open at cursor + offset; no enter animation in source. Closes on click-away, external scroll, blur, Esc.

## States
default / empty list (falls through to native menu) / danger / disabled / divider / autoFocus.

## Accessibility
Menu auto-focuses; arrows/Enter navigate (actionable indices skip dividers); Esc captured + focus restored only when the dismissal keeps focus in-page (click-away/scroll do NOT steal focus back); outgoing focus target prefers the right-clicked element.

## Live-spec mapping
Patch-only (constants + handlers in source). Persist: edit `ContextMenu.tsx` → six call sites.

