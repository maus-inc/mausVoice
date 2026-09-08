# AnimateIn · AnimateSwitch (`animate`)

- Status: **reused** — real components from `apps/desktop/src/components/common/AnimateIn.tsx`.
- Source of truth: `apps/desktop/src/components/common/AnimateIn.tsx`, `apps/desktop/src/styles/motion.ts`.
- Used in: `apps/desktop/src/components/settings/AIPostProcessingConfiguration.tsx`, `apps/desktop/src/components/settings/AITranscriptionConfiguration.tsx`.

## Purpose
Appear/disappear wrapper (AnimateIn) and mutually-exclusive section crossfade (AnimateSwitch, `mode="wait"`).

## Visual tokens
No paint of its own; animates opacity/y/scale on a full-width motion.div.

## Motion
AnimateIn: initial `{opacity 0, y 6, scale .99}`, exit `{y −6}`, `springSnappy`; reduced motion → bare opacity fade with `duration.exit`. AnimateSwitch: y 8, same spring; reduced motion renders keyed static div (no AnimatePresence).

## States
visible on/off; activeKey swaps; reduced-motion fallbacks.

## Accessibility
Outgoing content wrapped in `inert` + `aria-hidden` (PresenceGuard) so exiting copies can't be clicked, focused, or read.

## Live-spec mapping
Patch-only (choreography lives in the component). Persist: edit `AnimateIn.tsx` / `motion.ts`, affecting the two settings configurations.

