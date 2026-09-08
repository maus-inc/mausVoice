# PageLayout · SplitLayout · Section · SettingSection · FadingScrollArea · ScrollListPage (`layout`)

- Status: **reused** — all real components.
- Source of truth: `PageLayout.tsx`, `SplitLayout.tsx`, `Section.tsx`, `SettingSection.tsx`, `FadingScrollArea.tsx`, `ScrollListPage.tsx` (+ `scrollListCollapse.ts`).
- Used in: Apps/Dictionary/Styling/Transcriptions pages (ScrollList); ConversationLayout/ListLayout (Fading); settings dialogs (Section/SettingSection); AppWrapper + ErrorBoundary (PageLayout).

## Purpose
App shell (TitleBar + header + scroll content), weighted panes, settings rows/groups, fading scroller, infinite list template.

## Visual tokens
PageLayout: full-bleed stack level0, header px .5/1 pt .5, content scroll. SplitLayout: weight-fraction columns, zero-weight unmounts (sticky once shown). SettingSection: row spacing 2 center/space-between; title body1/600, desc body2 secondary. Section: h6 bold + optional checkbox (ml 1 pt 1), desc body2 mt 1, children mt 2, mb 4; blocked → 30% opacity + not-allowed tooltip veil overlay. ScrollListPage: header/content maxWidth sm, emptyState, hasMore/onLoadMore.

## Motion
None custom (native scroll; collapse helper animates list collapse — see scrollListCollapse.ts).

## States
header/footer slots · weights · enabled toggle on/off · blocked + reason · fade edges · items/empty/loading-more.

## Accessibility
Section toggle is a clickable Box — UNKNOWN: no checkbox role/keyboard in source (flag as gap; SettingSection actions are caller-provided). ScrollListPage title/action are text + caller nodes.

## Live-spec mapping
Patch-only per component → listed pages/dialogs.

