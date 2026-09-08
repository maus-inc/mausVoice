# TitleBar · ThemeModeToggle · WindowResizeHandles (`titlebar`)

- Status: **reused** — real components; Tauri calls gated by `isTauriRuntime()` so controls safely no-op in a plain browser.
- Source of truth: `root/TitleBar.tsx`, `ThemeModeToggle.tsx`, `WindowResizeHandles.tsx`, `utils/env.utils.ts`, `src-tauri/capabilities/default.json`.
- Used in: PageLayout (→ AppWrapper).

## Purpose
Frameless custom chrome: drag region + theme toggle + logo + window controls; invisible resize grips (decorations:false removes the OS border).

## Visual tokens
Bar 40px (DESIGN.md says ~46 — code is 40), level1 @ .88/.92 + blur(18px) saturate(1.2) + titleBarShadow, bottom hairline .06/.05, zIndex 20. Controls 16px glyphs in 28px buttons; theme toggle 28×28 radius 12 secondary, menu items 16px icons + check. Drag region full-bleed + double-click toggles maximize.

## Motion
Toggle transitions 150ms easeOut (bg/color/transform); maximize glyph morphs Square↔Copy via MorphNavIcon; no bounce.

## States
light/dark/system · maximized/unmaximized icon · hover/press on controls · drag/double-click (Tauri only) · resize grips (Tauri only).

## Accessibility
Controls are IconButtons with localized labels (verify aria-labels in source); theme menu is a real MUI Menu with checks.

## Live-spec mapping
Docs-only (chrome geometry + Tauri wiring). Persist: edit `TitleBar.tsx` (+ capabilities JSON for new window commands) → PageLayout. NOTE: every window command must be listed in `src-tauri/capabilities/default.json` or controls fail silently.

