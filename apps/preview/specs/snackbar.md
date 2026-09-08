# Snackbar emitter visual (`snackbar`)

- Status: **recreated** — `SnackbarEmitter` reads snackbar* fields from the zustand store. Recreation copies the MUI Snackbar config verbatim.
- Source of truth: `apps/desktop/src/components/root/SnackbarEmitter.tsx`, `apps/desktop/src/utils/app.utils.ts` (setSnackbar).
- Used in: global — any setSnackbar/showErrorSnackbar call site.

## Purpose
Bottom-center transient messages (info/error/success).

## Visual tokens
key=counter (re-mount per message) · #fff message span · small close IconButton (#fff icon, aria “close”) · content style backgroundColor = error/success/primary by mode · anchor bottom-center.

## Motion
MUI snackbar transition (transitionDuration passthrough); auto-hide 3000ms default; clickaway ignored.

## States
info / error / success / dismissed / queued (counter remount).

## Accessibility
Close is labelled; message is plain text. UNKNOWN: no explicit aria-live/role in source — MUI Snackbar defaults apply (verify).

## Live-spec mapping
Docs-only recreation. Persist: edit `SnackbarEmitter.tsx` / `app.utils.ts` → global.

