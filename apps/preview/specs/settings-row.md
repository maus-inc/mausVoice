# SettingRow · SettingToggleRow · SettingGroup (`settings-row`)

- Status: **reused** — rendered from `apps/desktop/src/components/settings/SettingRow.tsx` over `setting-row-chassis.tsx`.
- Source of truth: `apps/desktop/src/components/settings/SettingRow.tsx`, `apps/desktop/src/components/settings/setting-row-chassis.tsx`.
- Used in: every page under `apps/desktop/src/components/settings/pages/`, and the overview cards via `SettingSummaryRow.tsx`.

## Purpose

One row chassis for a whole settings surface. A card mixes four shapes: a row that opens a dialog, a row that holds a control, a row that reports a value, and a switch row. They read as one list only because all four lead with a mark in the same lane and put their controls in the same right-hand column.

## Visual tokens

Row: min-height 56, px 2, py 1.25, gap 2, radius 1 (14) on the group card, hairline dividers between rows, level1 face. Label block: glyph lane then text column, gap 2. Glyph lane: `settingGlyphProps` = size 22, strokeWidth 1.9; lane minWidth/minHeight 22, flexShrink 0; colour `text.secondary`, or `error.main` under `iconTone="danger"`. Provider marks use the same 22px box via `ProviderLogo`; the identity row leads with the avatar instead. No tiles, no tinted squares.

## Motion

Static rows do not animate. Interactive rows: background-color 150ms ease on hover, 2px primary outline at offset −2 on focus-visible, disabled rows at 0.5 opacity with `not-allowed`. Switch rows carry no press scale.

## States

static / interactive (hover, focus-visible, active, disabled) / switch on-off / value / action pill (primary, error) / danger group / wide control wrapping below the label block on narrow cards / long title wrapping beside the glyph.

## Accessibility

A row is a `<button>` only when it acts. Switch rows are a `<label>` around the input, named by `aria-labelledby` on the title and described by `aria-describedby` on the description. The glyph is `aria-hidden` in every shape, so the leading icon is never part of the name.

## Live-spec mapping

Patch-only: the glyph size, the lane and the danger tint are constants in `setting-row-chassis.tsx`. Persist there, and every settings page follows.
