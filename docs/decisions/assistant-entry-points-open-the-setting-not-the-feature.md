# An assistant entry point fired while the feature is off opens the setting that turns it on

Date: 2026-11-26
Status: accepted and implemented

## Context

Issue #355 reported the Help page's **Talk to the assistant** card. Its action
navigated to `/dashboard/chats` whether or not Assistant mode was enabled. With
the switch off that route has no rail entry, the composer has no provider, and
nothing on it can do what the card just promised. The person follows a guide and
lands in a feature they cannot use.

The single card was one instance. A sweep of every assistant entry point found
four more of the same shape, each deciding for itself whether the feature
existed — plus one summary row that decides in the way that is right for a
summary:

- `ShortcutsDialog` hid the Assistant dictation key while the switch was off, so
  someone who had already bound that key had nowhere to see or clear it.
- `QuickShortcutsCard` in the settings overview hid the **Open chat** key for
  the same reason, and still does: a summary row is a link to the shortcut
  editor, not an entry point, so the switch governs whether the row belongs in
  the summary at all.
- The `OPEN_CHAT_HOTKEY` handler opened the chat window unconditionally, so the
  key fired into an empty feature.
- The voice assistant's "agent mode disabled" toast offered **Fix**, which set
  `draft.settings.agentModeDialogOpen`. That dialog is mounted by the settings
  root, so from the pill or any other window the action changed state and showed
  nothing at all.

The common cause is that "this feature is off" was answered in five places: the
Help card above, the two shortcut surfaces that hid a control, the hotkey that
fired anyway, and the toast that set a flag nothing mounted. Hiding is right for
a summary of what a person can do; it is wrong for the only listing of a key they
have already bound, and it is wrong for a key that fires.

## Decision

- One address, `ASSISTANT_MODE_SETTINGS_PATH` in `settings-routes.ts`, names the
  Assistant mode row. The settings layout already scrolls a `#setting-<key>`
  hash into view, focuses the row and outlines it, so the link lands somewhere
  that looks like a destination rather than a page.
- One guard, `withAssistantMode` in `actions/assistant-mode.actions.ts`, takes
  the switch and either runs the assistant action or runs the caller's teardown
  and opens the row. Entry points that can fire while the feature is off call it
  instead of branching themselves. The teardown slot exists because opening the
  chat window is also what ends an in-flight recording: routing to settings
  without it left the pill recording behind a page the person was reading, which
  review caught on the first version of this change.
- Tip destinations are resolved in `utils/tips.ts`. A tip declares the switch it
  depends on and the row that turns it on; `tipAction` returns the destination
  and whether it is the setup row. The Help page asks it once instead of reading
  `tip.href` off the table, which is what issue #355 was.
- A control whose destination depends on the switch says so where it is listed.
  The Help card's label becomes **Open settings** while the feature is off, and
  the shortcut rows stay visible and explain that the switch is needed. Hiding a
  key leaves the person who bound it with no way back to it.
- The copy follows what the key really does. **Open chat** opens the row, so its
  hint says so; the Assistant hold key stays disabled while the switch is off,
  so its hint says only that the switch is needed rather than promising a
  recovery the gesture cannot perform. Routing a hold gesture to a settings page
  mid-press would be a worse surprise than a key that does nothing.
- Arriving from another page moves focus too. `useSettingsAnchor` focused the
  row only when a request came from inside settings, which left a link followed
  from Help with focus on `<body>` and a keyboard user at the top of a page they
  did not choose. It now also takes focus when nothing holds it, and still
  leaves a person's own focus alone.
- Controls that reveal state instead of navigating stay put. The quick-access
  summary card, the menu rail entry and the **Open chat** key in Settings still
  update in place as the switch flips.

Rejected: gating on `isSettingAvailable`. That map answers what the current
platform, provider or preferences make renderable, and Assistant mode is
available everywhere; only its switch is off. Using it would have made the row
vanish from the page the link points at.

## Consequences

Easy: a new assistant surface calls one function or declares one gate, and a
test reads the tree so a second hand-built route or dialog write fails. The
dialog's flag has one writer, so the toast and the settings row cannot disagree
about where the dialog lives.

Hard: the switch is read in React, so a caller outside a component reads it from
the store. `DictationSideEffects` already subscribed to it for the agent-hold
shortcut, so this cost nothing there, but a future caller has to remember that
`withAssistantMode` takes a boolean rather than reading the store itself, so it
stays usable from a test and from a non-React path.

## Verification

- `apps/desktop/src/utils/tips.test.ts` pins both destinations and scans the
  source tree for a surface that navigates from `tip.href` directly.
- `apps/desktop/src/components/help/HelpPage.actions.test.tsx` clicks both
  answers through a real router.
- `apps/desktop/src/components/settings/assistant-mode-anchor.test.tsx` renders
  the Help page beside the real settings shell and the real AI models page,
  clicks the action with the feature off, and expects the row to be mounted,
  scrolled into view and outlined.
- `apps/desktop/src/actions/assistant-mode.actions.test.ts` covers the guard,
  the navigation failure, and the one-writer rule for both spellings.
- `apps/desktop/src/components/settings/ShortcutsDialog.test.tsx` reads the
  descriptions in both switch states.
- Reverting the gate in `tips.ts`, reading `tip.href` again in `HelpPage`,
  dropping the Open chat guard or the shortcut description each turned
  assertions red; every mutation was restored and re-run green.
- `actions/assistant-mode.actions.test.ts` also pins the order of the off-path:
  teardown, surface, navigate. A teardown that ran after the navigation would
  pass a test that only checked it was called.
