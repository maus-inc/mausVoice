# Microphone preference saves use the shared success toast

Date: 2026-10-30
Status: accepted and implemented

## Context

The microphone settings dialog lets the user choose a preferred input and save it.
The dialog stays open after saving. Its success acknowledgement should use the
existing screen-level toast, not a visible alert inside the dialog. A save failure
remains visible in the dialog so the user can correct or retry the choice. The
success copy remains the localized `Preference saved.` string.

`setPreferredMicrophone` normalizes the selected value and awaits the preference
update. The state-backed `showSnackbar` bridge stores one pending message, so a
competing update can replace it before the emitter handles it. The success path
therefore calls Sonner directly; the app's single root toaster still supplies its
shared bottom-right position and styling. The preference action suppresses its
generic global error toast for this call because the dialog owns failure recovery.

MUI's modal manager marks the app-root sibling `aria-hidden` while the dialog is
open. Since the root Sonner live region is under that app root, assistive technology
may not receive its announcement. A visually hidden `role="status"` within the
active dialog announces success for screen readers. It is not a second visible toast
or alert; the visible toast remains global and outside the dialog.

The product state decision follows `rule/cover-reachable-states`: pending, saved,
and failed outcomes are distinct reachable states. The success wording follows
`rule/success-state-specific`, and inline failure recovery follows
`rule/error-states-recovery`.

## Decision

- Await `setPreferredMicrophone` before sending success feedback.
- On success, clear the dirty state, update the dialog's hidden polite status region,
  and call `toast.success` directly with the same localized message. Keep the dialog
  open; the root Sonner toaster renders the only visible success surface.
- While persistence is pending, disable the dialog's Close button and ignore Escape
  or backdrop close requests so an inline-only failure cannot be hidden by dismissal.
  Leave microphone-test controls active so an in-progress capture can always be stopped.
- On failure, retain the selected value, show the existing inline error, suppress
  the preference action's global error toast, and return without success feedback.
  Do not show raw exception text.
- Keep the existing localized message. Do not add a dialog-local toaster, a second
  visible success alert, or a new toast provider.
- Keep Sonner's canonical bottom-right placement and shared theme styling unchanged.

## Evidence ledger

The decision rows cross-check product guidance, implementation, tests, and library
behavior where each source applies.

| Behavior | Evidence | Finding |
| --- | --- | --- |
| Success follows persisted state and cannot be coalesced | `apps/desktop/src/actions/user.actions.ts` awaits `updateUserPreferences`; `MicrophoneDialog.tsx` emits only after the await. Its test blocks the actual mocked preferences-repository save, verifies no early toast, then dispatches a competing store-backed snackbar before resolving persistence and verifies both messages survive. The direct Sonner call avoids the single-message app-state bridge. Product state coverage follows `rule/cover-reachable-states`; success wording follows `rule/success-state-specific` in `.agents/skills/product-design/references/rules.md`. | The acknowledgement cannot claim success while persistence is pending or be overwritten by an unrelated pending snackbar event. |
| Failure stays inline without a duplicate global error | `setPreferredMicrophone` passes `{ showErrorToast: false }` to `updateUserPreferences`; the helper retains its default global error behavior for other callers. The dialog test holds the actual repository save pending, verifies Close is disabled, Escape/backdrop cannot dismiss the dialog, and the microphone tester remains enabled; it then rejects the save and asserts the inline recovery copy while `showErrorSnackbar` and Sonner remain unused. `.agents/skills/product-design/references/rules.md` owns `rule/error-states-recovery`: explain the failure, provide recovery when known, and never expose raw exception text. | A pending failure remains recoverable in context, an active microphone capture can be stopped, and the user sees one contextual error without raw exception text. |
| Visible toast is global and bottom-right | `apps/desktop/DESIGN.md:96-100` records Sonner at bottom-right; `apps/desktop/src/main.tsx` mounts the shared `SnackbarEmitter` at the app root; `SonnerToaster.tsx` mounts one `<Toaster position="bottom-right">`; `SonnerToaster.test.tsx` asserts right and bottom position attributes. The dialog test verifies the global success toast is not contained by the dialog. Sonner's public API uses the shared toast store when called directly. | The success toast remains screen-level; it is not nested in the microphone popup. |
| Screen-reader success announcement remains available in the modal | MUI `ModalManager` sets `aria-hidden="true"` on body siblings of an active modal. The dialog test verifies the app root containing Sonner is hidden while a `role="status"`, `aria-live="polite"` region inside the dialog contains the success copy. The live region uses the repo's visually-hidden treatment and does not create a second visible message. | Sighted users get the global toast; assistive technology can hear the success while the dialog remains active. |
| Copy remains localized | The previous inline success used the same `defaultMessage`; the new call uses `useIntl().formatMessage` with that descriptor; FormatJS documents `useIntl` and `formatMessage`; `i18n:extract` reported no changes in `en.json`. | No translation key or user-facing wording changed. |
| The preview spec describes the current source | `apps/preview/scripts/write-specs.mjs` names the Sonner emitter, `snackbar-emit.ts`, toaster, app action, and utility; running the generator updates `apps/preview/specs/snackbar.md`. | The generated spec no longer describes the obsolete MUI bottom-center snackbar and points to the event-mapping implementation. |

## Research sources

These references validate library behavior and API usage. Product placement comes
from the repository's design system, not from a library default.

- Sonner v2.0.8 README: https://github.com/emilkowalski/sonner/blob/v2.0.8/README.md
  documents mounting the shared toaster and calling typed toast methods.
- Sonner v2.0.8 source: https://github.com/emilkowalski/sonner/blob/v2.0.8/src/index.tsx
  defines toast announcement semantics and the toaster component.
- Sonner v2.0.8 types: https://github.com/emilkowalski/sonner/blob/v2.0.8/src/types.ts
  includes `bottom-right`, `closeButton`, and duration options.
- MUI Material `ModalManager` 9.3.1, installed implementation:
  `node_modules/.pnpm/@mui+material@9.3.1_*/node_modules/@mui/material/Modal/ModalManager.js`
  applies `aria-hidden` to modal siblings in the container.
- FormatJS React Intl API: https://github.com/formatjs/formatjs/blob/main/docs/src/docs/react-intl/api.mdx
  documents `useIntl` and `formatMessage` with a message descriptor.
- React `useCallback`: https://github.com/reactjs/react.dev/blob/main/src/content/reference/react/useCallback.md
  requires callback dependencies to include referenced reactive values such as `intl`.
- Vitest `expect.poll`: https://github.com/vitest-dev/vitest/blob/main/docs/api/expect.md
  documents the awaited retry assertion used to observe the asynchronously emitted toast.

## Rejected alternatives

- Keep the inline success `Alert`: duplicates the visible success surface and does not
  use the requested shared toast pattern.
- Mount a toaster in `MicrophoneDialog`: risks nested or duplicate visible toasts and
  conflicts with the root-level Sonner design.
- Emit success through the single-message state bridge: a competing snackbar update
  can replace the event before its emitter effect runs; direct `toast.success` avoids
  this coalescing for the save confirmation.
- Emit success before persistence resolves: could report a save that later fails.
- Send failure through the global toast as well as the inline error: duplicates the
  failure and moves recovery away from the dialog; only this preference action
  suppresses the generic error toast.
- Allow dismissal while saving: if the save then fails, the inline error is hidden
  and the global error is intentionally suppressed; Close, Escape, and backdrop
  dismissal therefore stay blocked until persistence settles.
- Disable the microphone tester while saving: that would also disable Finish for an
  already-running capture and could keep capturing after the user tries to stop.
- Change the copy or close the dialog after saving: neither was requested; the dialog
  remains visible, and its existing localized message is retained.

## Verification

- Focused tests cover the real preference-action error path, deferred persistence,
  dismissal attempts while saving, the microphone tester remaining enabled, the
  concurrent toast case, the accessible in-dialog status, and global placement.
- `SonnerToaster.test.tsx` verifies the shared toaster and bottom-right position.
- Desktop unit tests passed after the review fixes: 230 files, 3,045 Vitest tests,
  plus 4 Node tests.
- `apps/preview` tests passed after the spec-source update: 4 files, 22 tests.
- Root format check, lint, typecheck, and build passed after the review fixes. The
  build retains existing Vite externalization and large-chunk warnings.
- Desktop `i18n:extract` exited successfully with no `en.json` changes; it reported
  existing dynamic-ID warnings in tests.
- The root `pnpm test` command was not a complete pass because 54 API-backed
  eval/integration cases across three files require `GROQ_API_KEY`; the independent
  desktop unit and preview suites passed.
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
  existing Sonner styling, not introduced by this call-site change, and remains a
  separate shared-toaster follow-up to keep this PR focused.
- `MicrophoneDialog` has no preview route, so no rendered desktop save-flow recording
  is claimed. The component test mounts the actual dialog and root toaster; MUI's
  aria-hidden behavior is exercised in JSDOM. The repo's pointer-driven capture
  harness is not available in this checkout.
