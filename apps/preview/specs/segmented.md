# SegmentedControl (`segmented`)

- Status: **reused** — real component from `apps/desktop/src/components/common/SegmentedControl.tsx`.
- Source of truth: `apps/desktop/src/components/common/SegmentedControl.tsx`, `apps/desktop/src/styles/motion.ts`.
- Used in: AIAgentMode/AIPostProcessing/AITranscription configurations, MoreSettingsDialog, PillPlacementSetting.

## Purpose
Track of mutually exclusive options (Off/API/Local patterns) with a sliding indicator.

## Visual tokens
Track: inline-flex, action.hover fill, radius 2 (16px), p 0.5, 1px divider border. Tabs: no indicator; tab radius 1.5 (12px), py 1.25 px 2.5, 600, secondary → primary selected; unselected hover primary + white 5% wash. Indicator: absolute inset 0, radius 12, paper fill, `inset 0 1px 3px rgba(0,0,0,.2), 0 1px 2px rgba(0,0,0,.05)`.

## Motion
Shared-layout indicator (`layoutId` per instance via useId) with `springSnappy`; reduced motion renders a static pill. align start/center only changes track self-placement.

## States
selected / unselected / hover / disabled option / keyboard (MUI Tabs arrows) / focus-visible.

## Accessibility
MUI Tabs semantics + `ariaLabel` prop; arrow-key navigation; selected tab exposed via aria-selected.

## Live-spec mapping
Patch-only. Persist: edit `SegmentedControl.tsx` → the five settings call sites.

