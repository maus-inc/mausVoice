# PR 288 browser-preview visual evidence

Captured 2026-10-31 from source revision `0b0904654079598b30785a95ee73001c6bddfca9`, using Chromium and the desktop browser preview with **synthetic populated data**. Pages were captured at their initial scroll positions, with reduced motion, in light and dark at 1200×800 and 400×300. Images are evidence of rendered states, not proof of complete functionality or of every changed state. Compact pages and dialogs scroll; screenshots show only the visible portion.

Each route was checked for identifying text and uncaught page errors (see `results-*.json`); a contact sheet of the light desktop and dark compact captures was visually reviewed, as were the overview tooltip and selected dialogs. This is not 56 individually inspected functional cases.

## Screens

| Area             | Light desktop                             | Dark desktop                             | Light compact                           | Dark compact                           |
| ---------------- | ----------------------------------------- | ---------------------------------------- | --------------------------------------- | -------------------------------------- |
| Overview         | [1200×800](overview-light-1200x800.jpg)   | [1200×800](overview-dark-1200x800.jpg)   | [400×300](overview-light-400x300.jpg)   | [400×300](overview-dark-400x300.jpg)   |
| Account          | [1200×800](account-light-1200x800.jpg)    | [1200×800](account-dark-1200x800.jpg)    | [400×300](account-light-400x300.jpg)    | [400×300](account-dark-400x300.jpg)    |
| Dictation        | [1200×800](dictation-light-1200x800.jpg)  | [1200×800](dictation-dark-1200x800.jpg)  | [400×300](dictation-light-400x300.jpg)  | [400×300](dictation-dark-400x300.jpg)  |
| AI and models    | [1200×800](ai-models-light-1200x800.jpg)  | [1200×800](ai-models-dark-1200x800.jpg)  | [400×300](ai-models-light-400x300.jpg)  | [400×300](ai-models-dark-400x300.jpg)  |
| Shortcuts        | [1200×800](shortcuts-light-1200x800.jpg)  | [1200×800](shortcuts-dark-1200x800.jpg)  | [400×300](shortcuts-light-400x300.jpg)  | [400×300](shortcuts-dark-400x300.jpg)  |
| Appearance       | [1200×800](appearance-light-1200x800.jpg) | [1200×800](appearance-dark-1200x800.jpg) | [400×300](appearance-light-400x300.jpg) | [400×300](appearance-dark-400x300.jpg) |
| Privacy and data | [1200×800](privacy-light-1200x800.jpg)    | [1200×800](privacy-dark-1200x800.jpg)    | [400×300](privacy-light-400x300.jpg)    | [400×300](privacy-dark-400x300.jpg)    |
| System           | [1200×800](system-light-1200x800.jpg)     | [1200×800](system-dark-1200x800.jpg)     | [400×300](system-light-400x300.jpg)     | [400×300](system-dark-400x300.jpg)     |
| Home             | [1200×800](home-light-1200x800.jpg)       | [1200×800](home-dark-1200x800.jpg)       | [400×300](home-light-400x300.jpg)       | [400×300](home-dark-400x300.jpg)       |
| History          | [1200×800](history-light-1200x800.jpg)    | [1200×800](history-dark-1200x800.jpg)    | [400×300](history-light-400x300.jpg)    | [400×300](history-dark-400x300.jpg)    |
| Dictionary       | [1200×800](dictionary-light-1200x800.jpg) | [1200×800](dictionary-dark-1200x800.jpg) | [400×300](dictionary-light-400x300.jpg) | [400×300](dictionary-dark-400x300.jpg) |
| Styles           | [1200×800](styles-light-1200x800.jpg)     | [1200×800](styles-dark-1200x800.jpg)     | [400×300](styles-light-400x300.jpg)     | [400×300](styles-dark-400x300.jpg)     |
| Help             | [1200×800](help-light-1200x800.jpg)       | [1200×800](help-dark-1200x800.jpg)       | [400×300](help-light-400x300.jpg)       | [400×300](help-dark-400x300.jpg)       |
| Chat             | [1200×800](chats-light-1200x800.jpg)      | [1200×800](chats-dark-1200x800.jpg)      | [400×300](chats-light-400x300.jpg)      | [400×300](chats-dark-400x300.jpg)      |

## Open dialogs

| Dialog             | Light desktop                                            | Dark compact                                          |
| ------------------ | -------------------------------------------------------- | ----------------------------------------------------- |
| Profile            | [1200×800](dialog-profile-light-1200x800.jpg)            | [400×300](dialog-profile-dark-400x300.jpg)            |
| Clear Data         | [1200×800](dialog-clear-data-light-1200x800.jpg)         | [400×300](dialog-clear-data-dark-400x300.jpg)         |
| Delete Account     | [1200×800](dialog-delete-account-light-1200x800.jpg)     | [400×300](dialog-delete-account-dark-400x300.jpg)     |
| Microphone         | [1200×800](dialog-microphone-light-1200x800.jpg)         | [400×300](dialog-microphone-dark-400x300.jpg)         |
| Audio              | [1200×800](dialog-audio-light-1200x800.jpg)              | [400×300](dialog-audio-dark-400x300.jpg)              |
| Multiple Languages | [1200×800](dialog-multiple-languages-light-1200x800.jpg) | [400×300](dialog-multiple-languages-dark-400x300.jpg) |
| Hotkeys            | [1200×800](dialog-hotkeys-light-1200x800.jpg)            | [400×300](dialog-hotkeys-dark-400x300.jpg)            |
| Style Hotkeys      | [1200×800](dialog-style-hotkeys-light-1200x800.jpg)      | [400×300](dialog-style-hotkeys-dark-400x300.jpg)      |
| Ai Transcription   | [1200×800](dialog-ai-transcription-light-1200x800.jpg)   | [400×300](dialog-ai-transcription-dark-400x300.jpg)   |
| Post Processing    | [1200×800](dialog-post-processing-light-1200x800.jpg)    | [400×300](dialog-post-processing-dark-400x300.jpg)    |
| Assistant          | [1200×800](dialog-assistant-light-1200x800.jpg)          | [400×300](dialog-assistant-dark-400x300.jpg)          |
| Add Dictionary     | [1200×800](dialog-add-dictionary-light-1200x800.jpg)     | [400×300](dialog-add-dictionary-dark-400x300.jpg)     |

## Additional states

- [Overview shortcut tooltip, light](overview-tooltip-light-1200x800.jpg) and [dark](overview-tooltip-dark-1200x800.jpg): hover and arrow placement.
- [Language profile-save failure](language-profile-failure-dark-400x300.png) and [duplicate language shortcuts](language-duplicate-shortcuts-dark-400x300.png): injected/seeded preview states from earlier interaction checks.
- [Welcome](welcome-light-1200x800.jpg) and [onboarding API step](onboarding-light-1200x800.jpg); the preview scenario toolbar remains visible.

## Limitations

- Route checks only confirm identifying text and absence of uncaught page errors. Dialog checks only confirm opening. They do not verify every control, scroll position, translation, onboarding step, failure state, or platform. Earlier interaction checks and remaining gaps are recorded in `reports/pr288-visual-audit.md`.
- The AI transcription dialog displays expected browser-preview errors because native `plugin:shell|spawn` is unavailable; these captures do not validate model downloads or devices. Native WebView, microphone/audio, real IME, global shortcuts, cross-window synchronization and platform-specific behavior were not visually verified here.
- The initial `dialog-results-*.json` shows three failed account selectors; the account actions are whole-row buttons. Corrected selectors and successful captures are recorded in `account-dialog-results-*.json`.
- The requested 140+ individually verified edge cases and 100 distinct issue-derived cases are not established by these captures.

## Settings surface refinement on 2026-11-03

The following captures show the later settings-group depth change, not the
revision named above. The original captures remain for comparison. Chromium
used the populated browser preview and reduced motion.

- Overview in [light](depth-overview-light-1200x800.jpg) and [dark](depth-overview-dark-1200x800.jpg)
- Account in [light](depth-account-light-1200x800.jpg) and [dark](depth-account-dark-1200x800.jpg)
- Dictation in [light](depth-dictation-light-1200x800.jpg) and [dark](depth-dictation-dark-1200x800.jpg)
- [Compact account focus](depth-account-focus-dark-400x300.jpg), scrolled to the profile row

The browser check switched from light to dark without a reload and confirmed
that the profile card's computed shadow changed. At 800×600 and 400×300 the
profile action opened and closed with Escape, with no uncaught page errors.
This does not verify native WebView rendering.

## Review follow-up on 2026-11-04

Chromium used the populated browser preview at 400×600 with reduced motion.
The compact chat list had keyboard focus before a URL change. Focus moved to
Chats and the selected release-notes conversation appeared in both
[light](review-chat-url-focus-light-400x600.jpg) and
[dark](review-chat-url-focus-dark-400x600.jpg). No uncaught page errors were
observed. The profile editor also opened in [light](review-profile-dialog-light-400x600.jpg)
and [dark](review-profile-dialog-dark-400x600.jpg). The browser preview toolbar
covers the bottom of the dialog in these captures, so they do not verify its
footer. They do not verify native keyboard, recording, or WebView behavior.

## Setup and clear failure follow-up

Chromium's populated browser preview was exercised at 1200×800 and 400×600
with reduced motion. The preview runtime was intercepted to reject setup and
listener-stop commands with a fake private diagnostic; the preview window label
was overridden to simulate the main window for the clear flow. The preview-only
scenario toolbar was hidden in compact captures because it otherwise covers the
dialog. The captures show [setup failure at desktop](setup-failure-1200x800.png)
and [compact](setup-failure-400x600.png), and [stop failure at desktop](clear-stop-failure-1200x800.png)
and [compact](clear-stop-failure-400x600.png). The compact dialog scrolls the
error into view without moving focus. No uncaught page errors were observed.
These injected states do not exercise native stopping, elevation or WebView.

## Shortcut loading and cleared binding follow-up

Chromium's populated preview was seeded with a loading status, a load failure,
and an explicitly empty primary dictation binding. The preview toolbar was
hidden. Captures show [loading at desktop](shortcuts-loading-1200x800.png) and
[compact](shortcuts-loading-400x600.png), [failure at desktop](shortcuts-error-1200x800.png)
and [compact](shortcuts-error-400x600.png), and [cleared binding at desktop](shortcuts-empty-1200x800.png)
and [compact](shortcuts-empty-400x600.png). The failure card provides a retry;
its behavior is covered by the component test. No uncaught page errors were
observed in these injected states. Native key registration and WebView were not
visually verified.

## Provider-dependent deep-link follow-up

Chromium's populated preview used a direct provider-setting hash and injected
API-key load states at 1200×800 and 400×600, with the preview toolbar hidden.
See [loading](provider-link-loading-1200x800.png), [failure with retry](provider-link-error-400x600.png),
and [unavailable](provider-link-unavailable-400x600.png); the other viewport
captures are beside them. No uncaught page errors were observed. These checks
simulate the store state and do not verify native provider or WebView behavior.
