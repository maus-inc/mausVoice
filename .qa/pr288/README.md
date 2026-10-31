# PR 288 browser-preview visual evidence

Captured 2026-10-31 from source revision `0b0904654079598b30785a95ee73001c6bddfca9`, using Chromium and the desktop browser preview with **synthetic populated data**. Pages were captured at their initial scroll positions, with reduced motion, in light and dark at 1200×800 and 400×300. Images are evidence of rendered states, not proof of complete functionality or of every changed state. Compact pages and dialogs scroll; screenshots show only the visible portion.

Each route was checked for identifying text and uncaught page errors (see `results-*.json`); a contact sheet of the light desktop and dark compact captures was visually reviewed, as were the overview tooltip and selected dialogs. This is not 56 individually inspected functional cases.

## Screens

| Area | Light desktop | Dark desktop | Light compact | Dark compact |
|---|---|---|---|---|
| Overview | [1200×800](overview-light-1200x800.jpg) | [1200×800](overview-dark-1200x800.jpg) | [400×300](overview-light-400x300.jpg) | [400×300](overview-dark-400x300.jpg) |
| Account | [1200×800](account-light-1200x800.jpg) | [1200×800](account-dark-1200x800.jpg) | [400×300](account-light-400x300.jpg) | [400×300](account-dark-400x300.jpg) |
| Dictation | [1200×800](dictation-light-1200x800.jpg) | [1200×800](dictation-dark-1200x800.jpg) | [400×300](dictation-light-400x300.jpg) | [400×300](dictation-dark-400x300.jpg) |
| AI and models | [1200×800](ai-models-light-1200x800.jpg) | [1200×800](ai-models-dark-1200x800.jpg) | [400×300](ai-models-light-400x300.jpg) | [400×300](ai-models-dark-400x300.jpg) |
| Shortcuts | [1200×800](shortcuts-light-1200x800.jpg) | [1200×800](shortcuts-dark-1200x800.jpg) | [400×300](shortcuts-light-400x300.jpg) | [400×300](shortcuts-dark-400x300.jpg) |
| Appearance | [1200×800](appearance-light-1200x800.jpg) | [1200×800](appearance-dark-1200x800.jpg) | [400×300](appearance-light-400x300.jpg) | [400×300](appearance-dark-400x300.jpg) |
| Privacy and data | [1200×800](privacy-light-1200x800.jpg) | [1200×800](privacy-dark-1200x800.jpg) | [400×300](privacy-light-400x300.jpg) | [400×300](privacy-dark-400x300.jpg) |
| System | [1200×800](system-light-1200x800.jpg) | [1200×800](system-dark-1200x800.jpg) | [400×300](system-light-400x300.jpg) | [400×300](system-dark-400x300.jpg) |
| Home | [1200×800](home-light-1200x800.jpg) | [1200×800](home-dark-1200x800.jpg) | [400×300](home-light-400x300.jpg) | [400×300](home-dark-400x300.jpg) |
| History | [1200×800](history-light-1200x800.jpg) | [1200×800](history-dark-1200x800.jpg) | [400×300](history-light-400x300.jpg) | [400×300](history-dark-400x300.jpg) |
| Dictionary | [1200×800](dictionary-light-1200x800.jpg) | [1200×800](dictionary-dark-1200x800.jpg) | [400×300](dictionary-light-400x300.jpg) | [400×300](dictionary-dark-400x300.jpg) |
| Styles | [1200×800](styles-light-1200x800.jpg) | [1200×800](styles-dark-1200x800.jpg) | [400×300](styles-light-400x300.jpg) | [400×300](styles-dark-400x300.jpg) |
| Help | [1200×800](help-light-1200x800.jpg) | [1200×800](help-dark-1200x800.jpg) | [400×300](help-light-400x300.jpg) | [400×300](help-dark-400x300.jpg) |
| Chat | [1200×800](chats-light-1200x800.jpg) | [1200×800](chats-dark-1200x800.jpg) | [400×300](chats-light-400x300.jpg) | [400×300](chats-dark-400x300.jpg) |

## Open dialogs

| Dialog | Light desktop | Dark compact |
|---|---|---|
| Profile | [1200×800](dialog-profile-light-1200x800.jpg) | [400×300](dialog-profile-dark-400x300.jpg) |
| Clear Data | [1200×800](dialog-clear-data-light-1200x800.jpg) | [400×300](dialog-clear-data-dark-400x300.jpg) |
| Delete Account | [1200×800](dialog-delete-account-light-1200x800.jpg) | [400×300](dialog-delete-account-dark-400x300.jpg) |
| Microphone | [1200×800](dialog-microphone-light-1200x800.jpg) | [400×300](dialog-microphone-dark-400x300.jpg) |
| Audio | [1200×800](dialog-audio-light-1200x800.jpg) | [400×300](dialog-audio-dark-400x300.jpg) |
| Multiple Languages | [1200×800](dialog-multiple-languages-light-1200x800.jpg) | [400×300](dialog-multiple-languages-dark-400x300.jpg) |
| Hotkeys | [1200×800](dialog-hotkeys-light-1200x800.jpg) | [400×300](dialog-hotkeys-dark-400x300.jpg) |
| Style Hotkeys | [1200×800](dialog-style-hotkeys-light-1200x800.jpg) | [400×300](dialog-style-hotkeys-dark-400x300.jpg) |
| Ai Transcription | [1200×800](dialog-ai-transcription-light-1200x800.jpg) | [400×300](dialog-ai-transcription-dark-400x300.jpg) |
| Post Processing | [1200×800](dialog-post-processing-light-1200x800.jpg) | [400×300](dialog-post-processing-dark-400x300.jpg) |
| Assistant | [1200×800](dialog-assistant-light-1200x800.jpg) | [400×300](dialog-assistant-dark-400x300.jpg) |
| Add Dictionary | [1200×800](dialog-add-dictionary-light-1200x800.jpg) | [400×300](dialog-add-dictionary-dark-400x300.jpg) |

## Additional states

- [Overview shortcut tooltip, light](overview-tooltip-light-1200x800.jpg) and [dark](overview-tooltip-dark-1200x800.jpg): hover and arrow placement.
- [Language profile-save failure](language-profile-failure-dark-400x300.png) and [duplicate language shortcuts](language-duplicate-shortcuts-dark-400x300.png): injected/seeded preview states from earlier interaction checks.
- [Welcome](welcome-light-1200x800.jpg) and [onboarding API step](onboarding-light-1200x800.jpg); the preview scenario toolbar remains visible.

## Limitations

- Route checks only confirm identifying text and absence of uncaught page errors. Dialog checks only confirm opening. They do not verify every control, scroll position, translation, onboarding step, failure state, or platform. Earlier interaction checks and remaining gaps are recorded in `reports/pr288-visual-audit.md`.
- The AI transcription dialog displays expected browser-preview errors because native `plugin:shell|spawn` is unavailable; these captures do not validate model downloads or devices. Native WebView, microphone/audio, real IME, global shortcuts, cross-window synchronization and platform-specific behavior were not visually verified here.
- The initial `dialog-results-*.json` shows three failed account selectors; the account actions are whole-row buttons. Corrected selectors and successful captures are recorded in `account-dialog-results-*.json`.
- The requested 140+ individually verified edge cases and 100 distinct issue-derived cases are not established by these captures.
