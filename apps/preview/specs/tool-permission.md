# ToolPermissionPrompt · ToolPermissionCard (`tool-permission`)

- Status: **recreated** — store-bound (toolInfoById) + actions (resolveToolPermission/setToolAlwaysAllow). Recreation copies both variants’ sx verbatim; real ToolParamsTooltip inside.
- Source of truth: `apps/desktop/src/components/common/ToolPermissionPrompt.tsx`, `apps/desktop/src/components/chats/ToolPermissionCard.tsx`.
- Used in: ToolPermissionCard (chat tool queue).

## Purpose
Allow/deny/always-allow prompt for assistant tool calls, inline in chat or overlaid.

## Visual tokens
Default: row stack, card maxWidth 75% px 2 py 1.5 radius 8, 1px primary.main border, paper fill; title body2/600 + params tooltip + status chip (success/error) when resolved; reason caption secondary; pending chips: Deny outlined, Allow primary, Always-allow outlined borderless. Overlay: px 1.5 py 1 radius 8, white .2 border, white .06 fill; title 13/600 white .92 + 14px tooltip; reason 12 white .5; right-aligned buttons mt .75 firing on mouse-down: Deny (bordered), Allow (white-filled black text), Always allow (ghost); OverlayButton 12/500 px1 py.25, hover white .08 (ghost) / .85 (filled).

## Motion
None (instant mount; hover fills only).

## States
pending / allowed / denied × default / overlay; reason present/absent.

## Accessibility
Real Chips/buttons with localized labels; overlay buttons are `<button>` with mouse-down activation (keyboard path: verify focus/Enter behavior).

## Live-spec mapping
Docs-only recreation. Persist: edit `ToolPermissionPrompt.tsx` → ToolPermissionCard.

