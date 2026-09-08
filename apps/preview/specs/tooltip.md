# Tooltip · Conditional · ToolParams · Bouncy (`tooltip`)

- Status: **reused** — real theme + real components.
- Source of truth: `apps/desktop/src/theme.ts` (MuiTooltip), `ConditionalTooltip.tsx`, `ToolParamsTooltip.tsx`, `onboarding/BouncyTooltip.tsx`.
- Used in: global (MuiTooltip); ToolParams in ToolPermissionPrompt; Conditional in PostProcessingDisabledTooltip; Bouncy in TutorialForm.

## Purpose
Hover hints; conditional passthrough; JSON param inspector; onboarding attention bubble.

## Visual tokens
Themed tooltip: 13px/550, radius 10, padding 8/12, premiumSurface.rest. ToolParams: InfoOutlined 16 secondary, cursor help, arrow top, pre-wrapped JSON (reason key stripped), renders null when empty. Bouncy: absolute bottom strip, 8px arrow, primary.main fill + contrast text, px2 py1, radius 8, drop-shadow(0 4px 8px rgba(0,0,0,.2)).

## Motion
MUI tooltip fades. Bouncy: bounce 1s ease-in-out infinite + fadeIn 0.2s ease-out both (bounce dropped under reduced motion); exit fadeOutDown 0.2s forwards; pointer-events only while visible.

## States
hover / placement variants / conditional on-off / empty params null / bouncy show-hide-delay-align.

## Accessibility
MUI tooltips expose via aria on focus/hover. Bouncy is presentational (no role in source).

## Live-spec mapping
Tooltip radius live. Bouncy choreography patch-only → TutorialForm.

