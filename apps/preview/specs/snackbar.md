# Snackbar emitter with Sonner (`snackbar`)

- Status: **recreated**. `SnackbarEmitter` routes store events through Sonner. `SonnerToaster` supplies the shared position and styling.
- Source of truth: `apps/desktop/src/components/root/SnackbarEmitter.tsx`, `apps/desktop/src/components/root/snackbar-emit.ts`, `apps/desktop/src/components/root/SonnerToaster.tsx`, `apps/desktop/src/actions/app.actions.ts`, `apps/desktop/src/utils/app.utils.ts`.
- The emitter handles every `showSnackbar` and `showErrorSnackbar` call site; direct Sonner calls share the root toaster.

## Purpose

Bottom-right transient app messages (info/success/error).

## Visual tokens

A neutral level1 card with a hairline, premium hover shadow, and theme radius. A status icon and tone-on-tone close button keep status clear. All toast types share one surface at the bottom-right.

## Motion

The toaster fallback duration is 4000ms. `showSnackbar` sends 5000ms by default, or 10000ms for messages over 100 characters. The close button is enabled.

## States

Info, success, or error, then dismissed. The emitter sends each new snackbar counter once.

## Accessibility

The close button is enabled. The app emitter does not move focus; Sonner owns toast announcement semantics.

## Live-spec mapping

The preview recreation mirrors production. Persist: edit `apps/desktop/src/components/root/SonnerToaster.tsx` for shared position and styling; edit `apps/desktop/src/components/root/SnackbarEmitter.tsx` / `apps/desktop/src/components/root/snackbar-emit.ts` and `apps/desktop/src/actions/app.actions.ts` / `apps/desktop/src/utils/app.utils.ts` for message behavior.
