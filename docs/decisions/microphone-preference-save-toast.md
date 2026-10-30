# Microphone preference saves use the shared success toast

Date: 2026-10-30
Status: accepted and implemented

## Context

The microphone settings dialog lets the user choose a preferred input and save it.
The dialog stays open after saving. Its success acknowledgement should use the
existing global toast, at the screen level, rather than render inside the dialog.
A save failure remains visible in the dialog so the user can correct or retry the
choice. The success copy remains the localized `Preference saved.` string.

`setPreferredMicrophone` normalizes the selected value and awaits the preference
update. `showSnackbar` writes the event to shared app state, and the root
`SnackbarEmitter` sends it to the single Sonner toaster. The canonical toast
position is bottom-right.

The product state decision follows `rule/cover-reachable-states`: pending, saved, and
failed outcomes are distinct reachable states. The existing success wording follows
`rule/success-state-specific`, and the inline failure follows
`rule/error-states-recovery`.

## Decision

- Await `setPreferredMicrophone` before sending success feedback.
- On success, clear the dirty state and call `showSnackbar` with mode `success`.
  Keep the dialog open and let the root toaster render the acknowledgement outside
  the dialog.
- On failure, retain the selected value, set the existing inline error, and return
  without emitting a success toast. Do not show raw exception text.
- Keep the existing localized message. Do not add a dialog-local toaster, a new
  toast provider, or a second inline success alert.
- Keep Sonner's canonical bottom-right placement and shared theme styling unchanged.

## Evidence ledger

The decision rows cross-check product guidance, implementation, tests, and independent
library documentation where each source applies.

| Behavior | Evidence | Finding |
| --- | --- | --- |
| Success follows persisted state | `apps/desktop/src/actions/user.actions.ts:429-438` awaits `updateUserPreferences`; `apps/desktop/src/components/settings/MicrophoneDialog.tsx:55-72` emits only after the await; `apps/desktop/src/components/settings/MicrophoneDialog.test.tsx` holds the save promise unresolved and verifies that no toast appears until it resolves. Product state coverage follows `rule/cover-reachable-states`, and the success message follows `rule/success-state-specific` in `.agents/skills/product-design/references/rules.md`. | The acknowledgement cannot claim success while persistence is pending. |
| Failure stays inline | The user's explicit constraint; `MicrophoneDialog.tsx` catches the failure and sets `saveError`; the same component keeps the error `Alert`; the rejection test verifies the inline message and absence of a Sonner toast. `.agents/skills/product-design/references/rules.md` owns `rule/error-states-recovery`: explain the failure, provide recovery when known, and never expose raw exception text. | The current retry guidance remains in context and storage details do not leak. |
| Toast is global and bottom-right | `apps/desktop/DESIGN.md:96-100` records Sonner at bottom-right; `apps/desktop/src/main.tsx` mounts the shared `SnackbarEmitter` at the app root; `apps/desktop/src/components/root/SonnerToaster.tsx` mounts one `<Toaster position="bottom-right">`; `SonnerToaster.test.tsx` asserts right and bottom position attributes. Sonner v2.0.8 source and types document position and polite live-region semantics. | The toast uses the shared, screen-level surface and does not move focus. |
| Copy remains localized | The previous inline success used the same `defaultMessage`; the new call uses `useIntl().formatMessage` with that descriptor; FormatJS documents `useIntl` and `formatMessage`; `i18n:extract` reported no changes in `en.json`. | No translation key or user-facing wording changed. |
| The preview spec describes the current source | `apps/preview/scripts/write-specs.mjs` now names the Sonner emitter and bottom-right placement; running the generator rewrote `apps/preview/specs/snackbar.md`; the source links in the spec point to the emitter, toaster, app action, and utility. | The generated spec no longer describes the obsolete MUI bottom-center snackbar. |

## Research sources

These references validate library behavior and API usage. Product placement comes
from the repository's design system, not from a library default.

- Sonner v2.0.8 README: https://github.com/emilkowalski/sonner/blob/v2.0.8/README.md
  documents mounting the shared toaster and calling typed toast methods.
- Sonner v2.0.8 source: https://github.com/emilkowalski/sonner/blob/v2.0.8/src/index.tsx
  defines the default position and polite announcement behavior.
- Sonner v2.0.8 types: https://github.com/emilkowalski/sonner/blob/v2.0.8/src/types.ts
  includes `bottom-right`, `closeButton`, and duration options.
- FormatJS React Intl API: https://github.com/formatjs/formatjs/blob/main/docs/src/docs/react-intl/api.mdx
  documents `useIntl` and `formatMessage` with a message descriptor.
- React `useCallback`: https://github.com/reactjs/react.dev/blob/main/src/content/reference/react/useCallback.md
  requires callback dependencies to include referenced reactive values such as `intl`.
- Vitest `expect.poll`: https://github.com/vitest-dev/vitest/blob/main/docs/api/expect.md
  documents the awaited retry assertion used to observe the asynchronously emitted toast.

## Rejected alternatives

- Keep the inline success `Alert`: duplicates the success surface and does not use the
  requested shared toast pattern.
- Mount a toaster in `MicrophoneDialog`: risks nested or duplicate toasts and conflicts
  with the root-level Sonner design.
- Emit success before the persistence promise resolves: could report a save that later
  fails.
- Convert the failure to a global success or generic toast: would hide the recovery
  message from the dialog where the user can act on it.
- Change the copy or close the dialog after saving: neither was requested; the dialog
  remains visible, and its existing localized message is retained.

## Verification

- Focused dialog test: 2 tests passed. The deferred-promise test proves timing and
  placement outside the dialog; the rejection test proves inline failure behavior.
- `SonnerToaster.test.tsx` verifies the shared toaster and bottom-right position.
- Desktop unit tests passed: 230 files, 3,045 Vitest tests, plus 4 Node tests.
- `apps/preview` tests passed: 4 files, 22 tests.
- Desktop `i18n:extract` exited successfully with no `en.json` changes; it reported existing dynamic-ID warnings in tests.
- Root format check, lint, typecheck, and build passed. The build retains existing Vite externalization and large-chunk warnings.
- The root `pnpm test` command was not a complete pass because 54 API-backed eval/integration cases across three files require `GROQ_API_KEY`; the independent desktop unit and preview suites passed.
- Inspected the preview route `#/c/snackbar` at 1440x900 in light and dark mode.
  The recreated toast measured 16px from the right and bottom edges and remained
  readable.
- Mounted the actual `SonnerToaster` in a temporary local harness at 1440x900 in both
  themes. The success toast stayed at the lower-right, used the themed neutral surface,
  and had no failed requests or page errors. The axe-core scan of the toaster subtree
  found no WCAG A/AA violations in either theme.
- A keyboard traversal reached the toast and its `Close toast` button. Both showed a
  visible focus indicator. The touch-size probe at 360x800 measured the shared close
  control at 20x20px, below the 24px fine-pointer floor and 44px touch floor. This is
  existing Sonner styling, not introduced by this call-site change, and was left for a
  separate shared-toaster follow-up to keep this PR focused.
- `MicrophoneDialog` has no preview route, so no rendered save-flow recording is
  claimed. Its pending, success, and error behavior is covered by the focused tests;
  MUI supplies the dialog focus trap and restoration defaults. The repo's pointer-driven
  capture harness is not available in this checkout.
