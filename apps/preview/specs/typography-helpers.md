# Overflow · Edit · WithMore · CopyableCommand (`typography-helpers`)

- Status: **reused** — real components.
- Source of truth: `OverflowTypography.tsx`, `EditTypography.tsx`, `TypographyWithMore.tsx`, `CopyableCommand.tsx`.
- Used in: ChatMessageBubble + ListTile (Overflow); TranscriptRow (WithMore); EditTypography + CopyableCommand have no call sites found (reserved).

## Purpose
Ellipsis-with-conditional-tooltip; click-to-edit text/number; clamped prose with More/Less; copyable code block.

## Visual tokens
CopyableCommand: row stack spacing 1, centered, p 1.5, radius 8, action.hover fill; code monospace .8rem break-all lh 1.5; icon 16 (check success.main after copy). WithMore: -webkit-box clamp, localized More/Less button.

## Motion
CopyableCommand icon swap 0.2s ease (transform+opacity); copied check reverts after 2000ms.

## States
fits/overflows · display/edit/commit/cancel/invalid · clamped/expanded · copied/idle.

## Accessibility
EditTypography commits on Enter, cancels on Esc (verify labels at call sites); copy button is a real IconButton (add aria-label at call site — verify).

## Live-spec mapping
Patch-only per component → listed call sites.

